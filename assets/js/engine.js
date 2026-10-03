/* =====================================================================
   Cutout Effect Studio: processing engine
   ---------------------------------------------------------------------
   Pure, deterministic pixel pipeline. No DOM access, so the exact same
   code runs inside the Web Worker (normal case) and on the main thread
   (fallback when workers are unavailable, e.g. when opened via file://).
   Preview, comparison and export all read the output of this one
   function, so there is a single source of truth for the result.

   Pipeline, in order:

   1. EDGE SIMPLICITY (0..10)
      A smoothing pass (two stacked box blurs, roughly Gaussian) applied
      to the source before quantization. Larger values merge small
      details into larger, simpler flat shapes. The radius is scaled to
      the working resolution (reference long edge: 1200 px), so a given
      value looks the same on a 1000 px web image and a 4032 px iPhone
      photo. Blurring is alpha-aware (premultiplied), so transparent
      pixels never bleed dark fringes into opaque ones.

   2. EDGE FIDELITY (0..3)
      Blends the sharp original back into the smoothed image:
         mixed = original * w + smoothed * (1 - w)
      with w = FIDELITY_WEIGHTS[fidelity] = 0, 0.25, 0.5, 0.75.
      0 = loose, rounded edges. 3 = edges hug the original contours.
      The maximum stays below 1 on purpose, so Edge Simplicity always
      keeps an effect, even at maximum fidelity. With simplicity 0
      there is nothing to blend, so fidelity has no visible effect.

   3. NUMBER OF LEVELS (2..20)
      Equally spaced tonal quantization. With N levels the output
      values are round(k * 255 / (N - 1)) for k = 0..N-1 and every
      input is snapped to the nearest one. Deterministic, no
      randomness, no image-dependent thresholds.

      - Levels = 2 always produces exactly two tones: pure black (0)
        and pure white (255). It thresholds perceived brightness
        (BT.601 luma) at the midpoint 127.5. Quantizing R, G and B
        separately at 2 levels would yield up to 8 saturated colors
        (red, cyan, yellow...), which is what made the old 2-level
        result look broken. That can no longer happen.
      - Tone mode "color" (default), levels >= 3: each channel is
        quantized with the same N levels (classic posterize look,
        identical to the previous engine at these settings).
      - Tone mode "mono", any level: luma is quantized to N gray
        tones, so 2 -> 20 is a strictly progressive tonal ramp.

      Alpha is always copied unchanged from the source.
   ===================================================================== */
(function (global) {
  "use strict";

  var LIMITS = Object.freeze({
    levels: Object.freeze({ min: 2, max: 20 }),
    simplicity: Object.freeze({ min: 0, max: 10 }),
    fidelity: Object.freeze({ min: 0, max: 3 }),
  });

  var FIDELITY_WEIGHTS = Object.freeze([0, 0.25, 0.5, 0.75]);
  var REFERENCE_LONG_EDGE = 1200;

  function clampInt(value, min, max) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = min;
    return n < min ? min : n > max ? max : n;
  }

  function normalizeParams(p) {
    p = p || {};
    return {
      levels: clampInt(p.levels, LIMITS.levels.min, LIMITS.levels.max),
      simplicity: clampInt(p.simplicity, LIMITS.simplicity.min, LIMITS.simplicity.max),
      fidelity: clampInt(p.fidelity, LIMITS.fidelity.min, LIMITS.fidelity.max),
      tone: p.tone === "mono" ? "mono" : "color",
    };
  }

  function paramsKey(p) {
    var n = normalizeParams(p);
    return n.levels + "/" + n.simplicity + "/" + n.fidelity + "/" + n.tone;
  }

  function blurRadius(simplicity, width, height) {
    if (simplicity <= 0) return 0;
    var scale = Math.max(1, Math.max(width, height) / REFERENCE_LONG_EDGE);
    return Math.max(1, Math.round(simplicity * scale));
  }

  /* Output tone for each level index: round(k * 255 / (N - 1)). */
  function levelTable(levels) {
    var table = new Uint8Array(levels);
    var step = 255 / (levels - 1);
    for (var k = 0; k < levels; k++) table[k] = Math.round(k * step);
    return table;
  }

  function isOpaque(src) {
    for (var i = 3; i < src.length; i += 4) if (src[i] !== 255) return false;
    return true;
  }

  /* One separable box blur pass (edge-clamped sliding window). */
  function boxPass(src, dst, width, height, radius, horizontal) {
    var win = radius * 2 + 1;
    var half = win >> 1;
    var outer = horizontal ? height : width;
    var inner = horizontal ? width : height;
    var stride = horizontal ? 4 : width * 4;
    var last = inner - 1;

    for (var o = 0; o < outer; o++) {
      var base = horizontal ? o * width * 4 : o * 4;
      var sr = 0, sg = 0, sb = 0, sa = 0, k, idx;
      for (k = -radius; k <= radius; k++) {
        idx = base + (k < 0 ? 0 : k > last ? last : k) * stride;
        sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2]; sa += src[idx + 3];
      }
      for (var i = 0; i < inner; i++) {
        var d = base + i * stride;
        dst[d] = ((sr + half) / win) | 0;
        dst[d + 1] = ((sg + half) / win) | 0;
        dst[d + 2] = ((sb + half) / win) | 0;
        dst[d + 3] = ((sa + half) / win) | 0;
        var lo = i - radius; if (lo < 0) lo = 0;
        var hi = i + radius + 1; if (hi > last) hi = last;
        var li = base + lo * stride, hiI = base + hi * stride;
        sr += src[hiI] - src[li];
        sg += src[hiI + 1] - src[li + 1];
        sb += src[hiI + 2] - src[li + 2];
        sa += src[hiI + 3] - src[li + 3];
      }
    }
  }

  /* Vertical pass, row-ordered: keeps one running sum per column so
     memory is read sequentially (much faster than walking columns). */
  function verticalPass(src, dst, width, height, radius) {
    var win = radius * 2 + 1;
    var half = win >> 1;
    var rowLen = width * 4;
    var last = height - 1;
    var sums = new Int32Array(rowLen);
    var j, k, off;
    for (k = -radius; k <= radius; k++) {
      off = (k < 0 ? 0 : k > last ? last : k) * rowLen;
      for (j = 0; j < rowLen; j++) sums[j] += src[off + j];
    }
    for (var y = 0; y < height; y++) {
      var o = y * rowLen;
      for (j = 0; j < rowLen; j++) dst[o + j] = ((sums[j] + half) / win) | 0;
      var lo = y - radius; if (lo < 0) lo = 0;
      var hi = y + radius + 1; if (hi > last) hi = last;
      var loOff = lo * rowLen, hiOff = hi * rowLen;
      for (j = 0; j < rowLen; j++) sums[j] += src[hiOff + j] - src[loOff + j];
    }
  }

  function boxBlur(src, width, height, radius, scratch, out) {
    boxPass(src, scratch, width, height, radius, true);
    verticalPass(scratch, out, width, height, radius);
    return out;
  }

  /* Approximate Gaussian: two box blurs with a matched total variance. */
  function smooth(src, width, height, radius) {
    var opaque = isOpaque(src);
    var input = src;
    var n = src.length, i, a;

    if (!opaque) {
      input = new Uint8ClampedArray(n);
      for (i = 0; i < n; i += 4) {
        a = src[i + 3];
        input[i] = (src[i] * a + 127) / 255;
        input[i + 1] = (src[i + 1] * a + 127) / 255;
        input[i + 2] = (src[i + 2] * a + 127) / 255;
        input[i + 3] = a;
      }
    }

    var scratch = new Uint8ClampedArray(n);
    var out = new Uint8ClampedArray(n);
    if (radius <= 2) {
      boxBlur(input, width, height, radius, scratch, out);
    } else {
      // Two boxes with distinct radii: every radius gives a different,
      // strictly stronger blur than the one below it.
      var ra = Math.max(1, Math.round(radius * Math.SQRT1_2));
      var rb = Math.max(1, radius - ra);
      var mid = new Uint8ClampedArray(n);
      boxBlur(input, width, height, ra, scratch, mid);
      boxBlur(mid, width, height, rb, scratch, out);
    }

    if (!opaque) {
      for (i = 0; i < n; i += 4) {
        a = out[i + 3];
        if (a > 0) {
          out[i] = (out[i] * 255) / a;
          out[i + 1] = (out[i + 1] * 255) / a;
          out[i + 2] = (out[i + 2] * 255) / a;
        } else {
          out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2];
        }
      }
    }
    return out;
  }

  /**
   * Applies the cutout effect.
   * @param {Uint8ClampedArray} src RGBA pixels (never modified)
   * @returns {Uint8ClampedArray} new RGBA pixels
   */
  function process(src, width, height, params) {
    var p = normalizeParams(params);
    var n = width * height * 4;
    if (!src || src.length !== n) throw new Error("Pixel buffer does not match dimensions.");

    var out = new Uint8ClampedArray(n);
    var radius = blurRadius(p.simplicity, width, height);
    var blurred = radius > 0 ? smooth(src, width, height, radius) : null;
    var wO = blurred ? FIDELITY_WEIGHTS[p.fidelity] : 1;
    var wB = 1 - wO;

    var levels = p.levels;
    var step = 255 / (levels - 1);
    var tones = levelTable(levels);
    var monochrome = levels === 2 || p.tone === "mono";
    var i, r, g, b, t;

    for (i = 0; i < n; i += 4) {
      if (blurred) {
        r = src[i] * wO + blurred[i] * wB;
        g = src[i + 1] * wO + blurred[i + 1] * wB;
        b = src[i + 2] * wO + blurred[i + 2] * wB;
      } else {
        r = src[i]; g = src[i + 1]; b = src[i + 2];
      }

      if (monochrome) {
        t = tones[Math.round((r * 0.299 + g * 0.587 + b * 0.114) / step)];
        out[i] = t; out[i + 1] = t; out[i + 2] = t;
      } else {
        out[i] = tones[Math.round(r / step)];
        out[i + 1] = tones[Math.round(g / step)];
        out[i + 2] = tones[Math.round(b / step)];
      }
      out[i + 3] = src[i + 3];
    }
    return out;
  }

  global.CutoutEngine = Object.freeze({
    LIMITS: LIMITS,
    FIDELITY_WEIGHTS: FIDELITY_WEIGHTS,
    normalizeParams: normalizeParams,
    paramsKey: paramsKey,
    blurRadius: blurRadius,
    levelTable: levelTable,
    process: process,
  });
})(typeof self !== "undefined" ? self : this);
