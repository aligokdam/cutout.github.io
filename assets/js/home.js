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
  function routeFromHash() { return /^#\/editor/.test(location.hash) ? "editor" : "home"; }

  function applyRoute(initial) {
    var next = routeFromHash();
    var prev = root.getAttribute("data-route");
    root.setAttribute("data-route", next);
    if (!initial && prev !== next) {
      Studio.closeSheet();
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      var heading = document.getElementById(next === "editor" ? "editorTitle" : "heroTitle");
      if (heading) heading.focus({ preventScroll: true });
      window.dispatchEvent(new Event("resize")); // let the editor re-fit its preview
    }
    if (next === "home") startDemos();
  }
  window.addEventListener("hashchange", function () { applyRoute(false); });

  document.getElementById("homeThemeBtn").addEventListener("click", function () { Studio.toggleTheme(); });
  document.getElementById("homeLangBtn").addEventListener("click", function () { Studio.openSheet("language"); });

  // Hairline under the navigation bar once the page has scrolled.
  var nav = document.getElementById("homeNav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 4); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------- demos */
  var D = Studio.DEFAULT_SETTINGS;
  var DEFAULT_PARAMS = { levels: D.numberOfLevels, simplicity: D.edgeSimplicity, fidelity: D.edgeFidelity, tone: D.toneMode };

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
    container.appendChild(el("span", "demo-divider", { "aria-hidden": "true" }));
    container.style.aspectRatio = a.width + " / " + a.height;
    container.classList.add("compare-static", "ready");
    return under;
  }

  var demos = {
    hero: function (node) {
      return loadImage("assets/img/coffee.jpg").then(function (img) {
        var src = pixelsOf(img, 1440);
        paint(node.querySelector(".demo-original"), src);
        paint(node.querySelector(".demo-result"), cutout(src, {}));
        node.classList.add("ready");
      });
    },

    levels: function (node) {
      return loadImage("assets/img/cat.jpg").then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 2 }), cutout(src, { levels: 8 }), "2", "8");
        r.setAttribute("aria-label", t("levelsLabel") + " 2 / 8");
      });
    },

    simplicity: function (node) {
      return loadImage("assets/img/coffee.jpg").then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 5, simplicity: 0 }), cutout(src, { levels: 5, simplicity: 10 }), "0", "10");
        r.setAttribute("aria-label", t("simplicityLabel") + " 0 / 10");
      });
    },

    fidelity: function (node) {
      return loadImage("assets/img/cat.jpg").then(function (img) {
        var src = pixelsOf(img, 720);
        var r = splitFrame(node, cutout(src, { levels: 4, simplicity: 10, fidelity: 0 }), cutout(src, { levels: 4, simplicity: 10, fidelity: 3 }), "0", "3");
        r.setAttribute("aria-label", t("fidelityLabel") + " 0 / 3");
      });
    },

    strip: function (node) {
      return loadImage("assets/img/cat.jpg").then(function (img) {
        var src = pixelsOf(img, 600);
        node.textContent = "";
        [2, 3, 4, 6, 10, 20].forEach(function (levels) {
          var fig = el("figure", "strip-item");
          var c = el("canvas", null, { role: "img" });
          paint(c, cutout(src, { levels: levels }));
          c.setAttribute("aria-label", t("levelsLabel") + " " + levels);
          var cap = el("figcaption");
          cap.textContent = String(levels);
          fig.appendChild(c);
          fig.appendChild(cap);
          node.appendChild(fig);
        });
      });
    },

    examples: function (node) {
      var items = [
        { src: "assets/img/cat.jpg", edge: 900, params: { levels: 5, simplicity: 3, fidelity: 2, tone: "color" } },
        { src: "assets/img/coffee.jpg", edge: 900, params: { levels: 3, simplicity: 5, fidelity: 2, tone: "mono" } },
        { src: "assets/img/cat.jpg", edge: 900, params: { levels: 3, simplicity: 8, fidelity: 1, tone: "color" } },
      ];
      node.textContent = "";
      return items.reduce(function (chain, item) {
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
            node.appendChild(card);
            translateWithin(card);
          });
        });
      }, Promise.resolve());
    },
  };

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
