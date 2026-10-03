/* =====================================================================
   Cutout Effect Studio: home page and routing
   ---------------------------------------------------------------------
   Two routes in one document, so moving between them never reloads the
   page or the editor's state:
     #/         home page (also any other hash, e.g. #features)
     #/editor   the editor
   The examples on the home page are not static pictures: they are
   rendered live with the same CutoutEngine.process the editor uses.
   ===================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var Engine = window.CutoutEngine;
  var Studio = window.CutoutStudio;
  var home = document.getElementById("home");
  if (!home || !Engine || !Studio) return;

  function t(key) { return Studio.t(key); }

  /* ------------------------------------------------------------ routing */
  function routeFromHash() {
    if (/^#\/editor/.test(location.hash)) return "editor";
    if (/^#\/terms/.test(location.hash)) return "terms";
    return "home";
  }

  // A plain "#id" hash on the home route scrolls to that section.
  function sectionFromHash() {
    var m = /^#([a-z][\w-]*)$/i.exec(location.hash);
    var target = m && document.getElementById(m[1]);
    return target && home.contains(target) ? target : null;
  }

  function applyRoute(initial) {
    var next = routeFromHash();
    var prev = root.getAttribute("data-route");
    root.setAttribute("data-route", next);
    if (!initial && prev !== next) {
      Studio.closeSheet();
      var section = next === "home" && sectionFromHash();
      if (section) section.scrollIntoView();
      else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      var heading = next === "editor" ? document.getElementById("editorTitle")
        : next === "terms" ? document.querySelector('.terms-main article[data-legal-lang="' + (root.lang === "tr" ? "tr" : "en") + '"] .terms-title')
        : document.getElementById("heroTitle");
      if (heading) heading.focus({ preventScroll: true });
      window.dispatchEvent(new Event("resize")); // let the editor re-fit its preview
    }
    if (next === "home") startDemos();
  }
  window.addEventListener("hashchange", function () { applyRoute(false); });

  document.getElementById("homeThemeBtn").addEventListener("click", function () { Studio.toggleTheme(); });
  document.getElementById("homeLangBtn").addEventListener("click", function () { Studio.openSheet("language"); });
  document.getElementById("homePrivacyBtn").addEventListener("click", function () { Studio.openSheet("privacy"); });
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-open-privacy]")) { Studio.openSheet("privacy"); return; }
    // The logo always takes you to the top of the home page.
    var logo = e.target.closest("a.logo");
    if (logo && routeFromHash() === "home") {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
    }
  });

  // Hairline under the navigation bar once the page has scrolled.
  var nav = document.getElementById("homeNav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 4); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------- demos */
  var D = Studio.DEFAULT_SETTINGS;
  var DEFAULT_PARAMS = { levels: D.numberOfLevels, simplicity: D.edgeSimplicity, fidelity: D.edgeFidelity, tone: D.toneMode };

  var ASSET_QS = (function () {
    var src = document.currentScript && document.currentScript.src || "";
    var i = src.indexOf("?");
    return i === -1 ? "" : src.slice(i);
  })();

  function img(name) {
    var embedded = window.CES_RESOURCES && window.CES_RESOURCES.images;
    return (embedded && embedded[name]) || "assets/img/" + name + ASSET_QS;
  }

  var imageCache = {};
  function loadImage(src) {
    if (!imageCache[src]) {
      imageCache[src] = new Promise(function (resolve, reject) {
        var img = new Image();
        img.decoding = "async";
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("Could not load " + src)); };
        img.src = src;
      });
    }
    return imageCache[src];
  }

  /* Draws the image at the requested long edge (smooth up- or downscale). */
  function pixelsOf(img, longEdge) {
    var scale = longEdge / Math.max(img.naturalWidth, img.naturalHeight);
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function paint(canvas, imageData) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
  }

  function cutout(src, params) {
    var p = Object.assign({}, DEFAULT_PARAMS, params);
    var out = Engine.process(src.data, src.width, src.height, p);
    return new ImageData(out, src.width, src.height);
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function translateWithin(node) {
    node.querySelectorAll("[data-i18n]").forEach(function (n) { n.textContent = t(n.getAttribute("data-i18n")); });
    node.querySelectorAll("[data-i18n-aria-label]").forEach(function (n) { n.setAttribute("aria-label", t(n.getAttribute("data-i18n-aria-label"))); });
  }

  /* A frame with the original (or variant A) clipped to the left half and
     the result (or variant B) underneath. */
  function splitFrame(container, a, b, tagA, tagB) {
    container.textContent = "";
    var under = el("canvas", "demo-result", { role: "img" });
    var over = el("canvas", "demo-original", { "aria-hidden": "true" });
    paint(under, b);
    paint(over, a);
    container.appendChild(under);
    container.appendChild(over);
    var ta = el("span", "demo-tag left"); ta.textContent = tagA;
    var tb = el("span", "demo-tag right"); tb.textContent = tagB;
    container.appendChild(ta);
    container.appendChild(tb);
    var divider = el("span", "demo-divider", { "aria-hidden": "true" });
    var knob = el("span", "demo-knob");
    knob.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4L2 8l4 4M10 4l4 4-4 4"/></svg>';
    divider.appendChild(knob);
    container.appendChild(divider);
    container.style.aspectRatio = a.width + " / " + a.height;
    container.classList.add("compare-static", "ready");
    enableSplit(container, false, tagA + " / " + tagB);
    return under;
  }

  /* Draggable before/after divider. A horizontal drag moves the divider;
     vertical swipes still scroll the page. Inside the hero link a plain
     click still opens the editor, but a drag never does. */
  function enableSplit(node, insideLink, label) {
    if (node.hasAttribute("data-split")) return;
    node.setAttribute("data-split", "");
    node.classList.add("draggable");
    var knob = node.querySelector(".demo-knob");
    var split = 50;
    function set(pct) {
      split = Math.max(0, Math.min(100, pct));
      node.style.setProperty("--split", split + "%");
      if (!insideLink && knob) knob.setAttribute("aria-valuenow", String(Math.round(split)));
    }
    function fromEvent(e) {
      var r = node.getBoundingClientRect();
      set(((e.clientX - r.left) / r.width) * 100);
    }
    if (!insideLink && knob) {
      knob.setAttribute("role", "slider");
      knob.setAttribute("tabindex", "0");
      knob.setAttribute("aria-valuemin", "0");
      knob.setAttribute("aria-valuemax", "100");
      knob.setAttribute("aria-valuenow", "50");
      knob.setAttribute("aria-label", t("compareHandle") + (label ? " (" + label + ")" : ""));
      knob.parentNode.removeAttribute("aria-hidden");
      knob.addEventListener("keydown", function (e) {
        var step = e.shiftKey ? 10 : 4;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(split - step);
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") set(split + step);
        else if (e.key === "Home") set(0);
        else if (e.key === "End") set(100);
        else return;
        e.preventDefault();
      });
    }

    var start = null, dragging = false, swallowClick = false;
    node.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging = false;
      if (e.pointerType === "mouse") e.preventDefault(); // no text selection or link drag
    });
    node.addEventListener("pointermove", function (e) {
      if (!start || e.pointerId !== start.id) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) > 4 && Math.abs(dx) >= Math.abs(dy)) {
          dragging = true;
          node.classList.add("dragging");
          try { node.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        } else if (Math.abs(dy) > 8) {
          start = null; // vertical swipe: let the page scroll
          return;
        }
      }
      if (dragging) fromEvent(e);
    });
    function end() {
      if (dragging) {
        swallowClick = true;
        setTimeout(function () { swallowClick = false; }, 350);
      }
      dragging = false;
      start = null;
      node.classList.remove("dragging");
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("click", function (e) {
      if (swallowClick) {
        swallowClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!insideLink) fromEvent(e); // a click on a feature image moves the divider there
    }, true);
    node.addEventListener("dragstart", function (e) { e.preventDefault(); });
  }

  /* Feature cards: a slider under the image re-renders the right half live
     with the real engine, so each control can be tried on the spot. */
  function liveSlider(node, src, base, key, labelKey, min, max, value) {
    var right = node.querySelector(".demo-result");
    var tag = node.querySelector(".demo-tag.right");
    var wrap = node.nextElementSibling && node.nextElementSibling.classList.contains("feature-slider")
      ? node.nextElementSibling : el("div", "feature-slider");
    var input = el("input", null, { type: "range", min: String(min), max: String(max), step: "1", value: String(value), "data-i18n-aria-label": labelKey });
    input.setAttribute("aria-label", t(labelKey));
    var scale = el("div", "scale", { "aria-hidden": "true" });
    scale.innerHTML = "<span>" + min + "</span><span>" + max + "</span>";
    wrap.textContent = "";
    wrap.appendChild(input);
    wrap.appendChild(scale);
    if (!wrap.parentNode) node.parentNode.insertBefore(wrap, node.nextSibling);

    var pending = false;
    function paintTrack() {
      input.style.setProperty("--p", ((input.value - min) / (max - min)) * 100 + "%");
    }
    function render() {
      pending = false;
      var v = Number(input.value);
      var params = Object.assign({}, base);
      params[key] = v;
      paint(right, cutout(src, params));
      tag.textContent = String(v);
      input.setAttribute("aria-valuetext", String(v));
    }
    input.addEventListener("input", function () {
      paintTrack();
      if (!pending) { pending = true; requestAnimationFrame(render); }
    });
    paintTrack();
  }

  var demos = {
    hero: function (node) {
      return loadImage(img("coffee.jpg")).then(function (img) {
        var src = pixelsOf(img, 1440);
        paint(node.querySelector(".demo-original"), src);
        paint(node.querySelector(".demo-result"), cutout(src, {}));
        node.classList.add("ready");
        enableSplit(node, true);
      });
    },

    levels: function (node) {
      return loadImage(img("cat.jpg")).then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 2 }), cutout(src, { levels: 8 }), "2", "8");
        r.setAttribute("aria-label", t("levelsLabel") + " 2 / 8");
        liveSlider(node, src, {}, "levels", "levelsLabel", 2, 20, 8);
      });
    },

    simplicity: function (node) {
      return loadImage(img("coffee.jpg")).then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 5, simplicity: 0 }), cutout(src, { levels: 5, simplicity: 10 }), "0", "10");
        r.setAttribute("aria-label", t("simplicityLabel") + " 0 / 10");
        liveSlider(node, src, { levels: 5 }, "simplicity", "simplicityLabel", 0, 10, 10);
      });
    },

    fidelity: function (node) {
      return loadImage(img("cat.jpg")).then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 4, simplicity: 10, fidelity: 0 }), cutout(src, { levels: 4, simplicity: 10, fidelity: 3 }), "0", "3");
        r.setAttribute("aria-label", t("fidelityLabel") + " 0 / 3");
        liveSlider(node, src, { levels: 4, simplicity: 10 }, "fidelity", "fidelityLabel", 0, 3, 3);
      });
    },

    strip: function (node) {
      return loadImage(img("cat.jpg")).then(function (img) {
        var src = pixelsOf(img, 600);
        STRIP_LEVELS.forEach(function (levels, i) {
          var c = node.querySelectorAll(".strip-item canvas")[i];
          paint(c, cutout(src, { levels: levels }));
          c.setAttribute("aria-label", t("levelsLabel") + " " + levels);
        });
      });
    },

    examples: function (node) {
      var items = [
        { src: img("cat.jpg"), edge: 900, params: { levels: 5, simplicity: 3, fidelity: 2, tone: "color" } },
        { src: img("coffee.jpg"), edge: 900, params: { levels: 3, simplicity: 5, fidelity: 2, tone: "mono" } },
        { src: img("cat.jpg"), edge: 900, params: { levels: 3, simplicity: 8, fidelity: 1, tone: "color" } },
      ];
      var shells = node.querySelectorAll(".example");
      return items.reduce(function (chain, item, index) {
        return chain.then(function () {
          return loadImage(item.src).then(function (img) {
            var src = pixelsOf(img, item.edge);
            var p = Engine.normalizeParams(Object.assign({}, DEFAULT_PARAMS, item.params));
            var card = el("figure", "example");
            var media = el("div", "example-media");
            var result = el("canvas", "demo-result", { role: "img", "data-i18n-aria-label": "viewResult" });
            var original = el("canvas", "demo-original", { "aria-hidden": "true" });
            paint(result, cutout(src, p));
            paint(original, src);
            var toggle = el("button", "example-toggle", { type: "button", "aria-pressed": "false" });
            toggle.appendChild(el("span", null, { "data-i18n": "labelOriginal" }));
            var setOriginal = function (on) {
              card.classList.toggle("show-original", on);
              toggle.setAttribute("aria-pressed", String(on));
            };
            toggle.addEventListener("click", function () { setOriginal(toggle.getAttribute("aria-pressed") !== "true"); });
            media.appendChild(result);
            media.appendChild(original);
            media.appendChild(toggle);

            var cap = el("figcaption", "example-meta");
            [["levelsLabel", p.levels], ["simplicityLabel", p.simplicity], ["fidelityLabel", p.fidelity],
             ["toneLabel", null, p.tone === "mono" ? "toneMono" : "toneColor"]].forEach(function (row) {
              var line = el("span", "meta-row");
              line.appendChild(el("span", "meta-label", { "data-i18n": row[0] }));
              var v = el("span", "meta-value", row[2] ? { "data-i18n": row[2] } : null);
              if (!row[2]) v.textContent = String(row[1]);
              line.appendChild(v);
              cap.appendChild(line);
            });
            card.appendChild(media);
            card.appendChild(cap);
            shells[index].replaceWith(card);
            translateWithin(card);
          });
        });
      }, Promise.resolve());
    },
  };

  var STRIP_LEVELS = [2, 3, 4, 6, 10, 20];

  /* Reserve the final layout before anything renders, so the page never
     jumps while you scroll or follow a section link. */
  function reserveSpace() {
    var strip = home.querySelector('[data-demo="strip"]');
    if (strip && !strip.children.length) {
      STRIP_LEVELS.forEach(function (levels) {
        var fig = el("figure", "strip-item");
        var c = el("canvas", null, { role: "img", width: "600", height: "399" });
        var cap = el("figcaption");
        cap.textContent = String(levels);
        fig.appendChild(c);
        fig.appendChild(cap);
        strip.appendChild(fig);
      });
    }
    var examples = home.querySelector('[data-demo="examples"]');
    if (examples && !examples.children.length) {
      for (var i = 0; i < 3; i++) {
        var card = el("figure", "example placeholder");
        card.appendChild(el("div", "example-media"));
        var meta = el("figcaption", "example-meta");
        for (var r = 0; r < 4; r++) meta.appendChild(el("span", "meta-row")).textContent = "\u00a0";
        card.appendChild(meta);
        examples.appendChild(card);
      }
    }
  }
  reserveSpace();

  var started = false;
  var queue = Promise.resolve();
  function run(node) {
    var name = node.getAttribute("data-demo");
    if (!demos[name] || node.hasAttribute("data-done")) return;
    node.setAttribute("data-done", "pending");
    // One demo at a time, yielding between them so scrolling stays smooth.
    queue = queue.then(function () {
      return new Promise(function (r) { setTimeout(r, 16); });
    }).then(function () {
      return demos[name](node);
    }).then(function () {
      node.setAttribute("data-done", "true");
    }, function (err) {
      // e.g. opened from file://, where canvas pixels cannot be read.
      node.setAttribute("data-done", "failed");
      console.warn("Cutout Effect Studio: demo '" + name + "' unavailable.", err);
    });
  }

  function startDemos() {
    if (started) return;
    if (root.classList.contains("i18n-wait")) { // wait for the language file, so labels are translated
      document.addEventListener("ces:languagechange", startDemos, { once: true });
      return;
    }
    started = true;
    var nodes = Array.prototype.slice.call(home.querySelectorAll("[data-demo]"));
    run(nodes[0]); // hero first
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); run(e.target); } });
      }, { rootMargin: "600px 0px" });
      nodes.slice(1).forEach(function (n) { io.observe(n); });
    } else {
      nodes.slice(1).forEach(run);
    }
  }

  document.addEventListener("ces:languagechange", function () { translateWithin(home); });

  // Small hook for automated tests: resolves when every demo has finished.
  window.CutoutHome = Object.freeze({
    ready: function () {
      started = true;
      home.querySelectorAll("[data-demo]").forEach(run);
      return queue;
    },
  });

  applyRoute(true);
})();
