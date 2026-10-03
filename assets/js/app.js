/* =====================================================================
   Cutout Effect Studio: application
   ---------------------------------------------------------------------
   State flows one way:
     controls -> state.settings -> render job (engine) -> result canvas
   Preview, comparison and export all read the same result canvas, and
   export always waits for a full-resolution render of the current
   settings, so what you download is exactly what you see.
   ===================================================================== */
(function () {
  "use strict";

  var VERSION = "1.2.0";
  // "?v=…" from this script's own URL, reused for files loaded later (worker, languages).
  var ASSET_QS = (function () {
    var src = document.currentScript && document.currentScript.src || "";
    var i = src.indexOf("?");
    return i === -1 ? "" : src.slice(i);
  })();
  var Engine = window.CutoutEngine;

  /* Single source of truth for every reset. Change defaults here only. */
  var DEFAULT_SETTINGS = Object.freeze({
    numberOfLevels: 6,
    edgeSimplicity: 4,
    edgeFidelity: 2,
    toneMode: "color",
  });

  var DEFAULT_PREFERENCES = Object.freeze({
    exportFormat: "png",
    jpgQuality: 100,
    fastPreview: true,
    transparencyGrid: true,
  });

  var FILE_RULES = Object.freeze({
    maxBytes: 40 * 1024 * 1024,
    extensions: [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"],
    mimes: ["image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/webp",
      "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
    heifExtensions: [".heic", ".heif"],
    heifMimes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
  });

  /* Where the worker and the HEIC decoder live. The single-file build
     (one index.html) overrides these with embedded copies. */
  var RES = Object.assign({
    worker: "assets/js/engine.worker.js",
    libheifScript: "vendor/libheif/libheif.js",
    libheifSource: null,
    libheifWasm: "vendor/libheif/libheif.wasm",
    i18nBase: "assets/i18n/",
  }, window.CES_RESOURCES || {});

  var MAX_WORKING_EDGE = 4096;        // cap for memory on phones; keeps iPhone photos sharp
  var PROXY_EDGE = 1280;              // fast-preview resolution while dragging
  var PROXY_MIN_PIXELS = 2200000;     // below this, full renders are fast enough on their own
  var STORAGE = { theme: "preferredTheme", lang: "preferredLanguage", prefs: "cutoutStudio.preferences" };

  /* ----------------------------------------------------------- helpers */
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function toParams(s) {
    return { levels: s.numberOfLevels, simplicity: s.edgeSimplicity, fidelity: s.edgeFidelity, tone: s.toneMode };
  }
  function fromParams(p) {
    return { numberOfLevels: p.levels, edgeSimplicity: p.simplicity, edgeFidelity: p.fidelity, toneMode: p.tone };
  }

  function loadPreferences() {
    var prefs = Object.assign({}, DEFAULT_PREFERENCES);
    try {
      var saved = JSON.parse(load(STORAGE.prefs) || "{}");
      if (saved.exportFormat === "png" || saved.exportFormat === "jpg") prefs.exportFormat = saved.exportFormat;
      if (typeof saved.jpgQuality === "number") prefs.jpgQuality = Math.min(100, Math.max(70, Math.round(saved.jpgQuality)));
      if (typeof saved.fastPreview === "boolean") prefs.fastPreview = saved.fastPreview;
      if (typeof saved.transparencyGrid === "boolean") prefs.transparencyGrid = saved.transparencyGrid;
    } catch (e) { /* ignore corrupt data */ }
    return prefs;
  }

  /* ------------------------------------------------------------- state */
  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    prefs: loadPreferences(),
    themePref: "dark",
    lang: "en",
    view: "result",
    split: 50,
    image: null,          // { name, sourceWidth, sourceHeight, width, height, original, proxy }
    renderedKey: null,    // params key of the full-resolution result currently on the canvas
    dragging: false,
  };

  var dom = {
    stageBody: $("stageBody"), dropzone: $("dropzone"), frame: $("frame"), fileInput: $("fileInput"),
    resultCanvas: $("resultCanvas"), originalCanvas: $("originalCanvas"), split: $("split"),
    fileMeta: $("fileMeta"), replaceBtn: $("replaceBtn"), viewSeg: $("viewSeg"),
    levels: $("levels"), simplicity: $("simplicity"), fidelity: $("fidelity"),
    levelsValue: $("levelsValue"), simplicityValue: $("simplicityValue"), fidelityValue: $("fidelityValue"),
    toneSeg: $("toneSeg"), formatSeg: $("formatSeg"), formatSeg2: $("formatSeg2"),
    downloadBtn: $("downloadBtn"), downloadLabel: $("downloadLabel"),
    resetOriginalBtn: $("resetOriginalBtn"), resetAllBtn: $("resetAllBtn"),
    busy: $("busy"), busyText: $("busyText"), toast: $("toast"), toastText: $("toastText"),
    themeBtn: $("themeBtn"), helpBtn: $("helpBtn"), langBtn: $("langBtn"), settingsBtn: $("settingsBtn"), privacyBtn: $("privacyBtn"),
    sheet: $("sheet"), sheetBackdrop: $("sheetBackdrop"), sheetTitle: $("sheetTitle"), sheetBack: $("sheetBack"),
    sheetBackLabel: $("sheetBackLabel"), sheetDone: $("sheetDone"), sheetBody: $("sheetBody"),
    langList: $("langList"),
    fastSwitch: $("fastSwitch"), gridSwitch: $("gridSwitch"),
    jpgQuality: $("jpgQuality"), jpgQualityValue: $("jpgQualityValue"),
    app: $("app"),
  };
  var resultCtx = dom.resultCanvas.getContext("2d");
  var originalCtx = dom.originalCanvas.getContext("2d");

  /* ============================================================== i18n */
  var LANGUAGES = window.CES_LANGUAGES || [];
  // Filled per language as assets/i18n/<code>.js files load (all at once in the single-file build).
  var DICT = window.CES_TRANSLATIONS = window.CES_TRANSLATIONS || {};
  function hasLanguage(code) { return LANGUAGES.some(function (l) { return l.code === code; }); }

  var langLoads = {};
  function loadLanguage(code) {
    if (DICT[code]) return Promise.resolve(true);
    if (!langLoads[code]) {
      langLoads[code] = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = RES.i18nBase + code + ".js" + ASSET_QS;
        s.onload = function () { resolve(!!DICT[code]); };
        s.onerror = function () { delete langLoads[code]; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return langLoads[code];
  }

  function t(key) {
    var d = DICT[state.lang];
    if (d && d[key] != null) return d[key];
    return (DICT.en && DICT.en[key] != null) ? DICT.en[key] : key;
  }

  function detectLanguage() {
    var saved = load(STORAGE.lang);
    if (saved && hasLanguage(saved)) return saved;
    var prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]);
    for (var i = 0; i < prefs.length; i++) {
      var tag = String(prefs[i] || "").toLowerCase();
      var base = tag.split("-")[0];
      if (base === "tl") base = "fil";
      if (hasLanguage(base)) return base;
    }
    return "en";
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label"))); });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });

    dom.downloadLabel.textContent = t(state.prefs.exportFormat === "jpg" ? "downloadJpg" : "downloadPng");
    dom.resultCanvas.setAttribute("aria-label", t("viewResult"));
    updateThemeButton();
    updateSheetChrome();
    refreshBusyText();
    syncControls();
  }

  var langRequest = 0;
  function setLanguage(code, persist) {
    if (!hasLanguage(code)) code = "en";
    var request = ++langRequest;
    return loadLanguage(code).then(function (ok) {
      if (request !== langRequest) return;           // a newer choice won
      if (!ok) return code === "en" ? null : setLanguage("en", persist);
      applyLanguage(code, persist);
    });
  }

  function applyLanguage(code, persist) {
    state.lang = code;
    var lang = LANGUAGES.find(function (l) { return l.code === code; });
    root.setAttribute("lang", code);
    root.setAttribute("dir", lang && lang.rtl ? "rtl" : "ltr");
    if (persist) store(STORAGE.lang, code);
    renderLanguageList();
    applyTranslations();
    root.classList.remove("i18n-wait");
    document.dispatchEvent(new CustomEvent("ces:languagechange", { detail: { lang: code } }));
  }

  function renderLanguageList() {
    var list = dom.langList;
    if (!list.childElementCount) {
      LANGUAGES.forEach(function (lang) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.setAttribute("role", "radio");
        btn.setAttribute("data-lang", lang.code);
        var main = document.createElement("span");
        main.className = "row-main";
        var name = document.createElement("span");
        name.className = "row-label";
        name.setAttribute("lang", lang.code);
        name.setAttribute("dir", lang.rtl ? "rtl" : "ltr");
        name.textContent = lang.name;
        main.appendChild(name); // native name only, e.g. "Türkçe"
        btn.appendChild(main);
        btn.insertAdjacentHTML("beforeend", '<svg class="check" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5l3.5 3.5 7.5-8"/></svg>');
        btn.addEventListener("click", function () { setLanguage(lang.code, true); });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }
    list.querySelectorAll("[data-lang]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-lang") === state.lang));
    });
  }

  /* ============================================================= theme */
  var lightQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function resolveTheme(pref) {
    return pref === "system" ? (lightQuery && lightQuery.matches ? "light" : "dark") : pref;
  }

  function updateThemeButton() {
    var theme = root.getAttribute("data-theme");
    var label = t(theme === "dark" ? "themeToLight" : "themeToDark");
    [dom.themeBtn, document.getElementById("homeThemeBtn")].forEach(function (b) {
      if (!b) return;
      b.setAttribute("aria-label", label);
      b.setAttribute("title", label);
    });
  }

  function setThemePreference(pref, animate) {
    if (pref !== "dark" && pref !== "light" && pref !== "system") pref = "dark";
    state.themePref = pref;
    store(STORAGE.theme, pref);
    var theme = resolveTheme(pref);
    if (root.getAttribute("data-theme") === theme) { updateThemeButton(); return; }

    var apply = function () {
      root.setAttribute("data-theme", theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "light" ? "#f5f5f7" : "#0a0a0b");
      updateThemeButton();
    };
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) { apply(); return; }
    if (typeof document.startViewTransition === "function") {
      try { document.startViewTransition(apply); return; } catch (e) { /* fall through */ }
    }
    root.classList.add("theme-switching");
    apply();
    setTimeout(function () { root.classList.remove("theme-switching"); }, 450);
  }

  /* ======================================================== controls UI */
  function setSegmented(group, attr, value) {
    if (!group) return;
    group.querySelectorAll("[" + attr + "]").forEach(function (b) {
      var on = b.getAttribute(attr) === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function bindSegmented(group, attr, onSelect) {
    var buttons = Array.prototype.slice.call(group.querySelectorAll("[" + attr + "]"));
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { if (!b.disabled) onSelect(b.getAttribute(attr)); });
      b.addEventListener("keydown", function (e) {
        var dir = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
        if (!dir) return;
        if (root.getAttribute("dir") === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) dir = -dir;
        e.preventDefault();
        var next = buttons[(i + dir + buttons.length) % buttons.length];
        if (next.disabled) return;
        next.focus();
        onSelect(next.getAttribute(attr));
      });
    });
  }

  function paintRange(input) {
    var min = Number(input.min), max = Number(input.max), v = Number(input.value);
    input.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
  }

  function syncControls() {
    var s = state.settings;
    [[dom.levels, dom.levelsValue, s.numberOfLevels],
     [dom.simplicity, dom.simplicityValue, s.edgeSimplicity],
     [dom.fidelity, dom.fidelityValue, s.edgeFidelity]].forEach(function (c) {
      c[0].value = String(c[2]);
      c[0].setAttribute("aria-valuetext", String(c[2]));
      c[1].textContent = String(c[2]);
      paintRange(c[0]);
    });
    setSegmented(dom.toneSeg, "data-tone", s.toneMode);
    setSegmented(dom.formatSeg, "data-format", state.prefs.exportFormat);
    setSegmented(dom.formatSeg2, "data-format", state.prefs.exportFormat);
    dom.fastSwitch.setAttribute("aria-checked", String(state.prefs.fastPreview));
    dom.gridSwitch.setAttribute("aria-checked", String(state.prefs.transparencyGrid));
    dom.frame.classList.toggle("grid", state.prefs.transparencyGrid);
    dom.jpgQuality.value = String(state.prefs.jpgQuality);
    dom.jpgQualityValue.textContent = state.prefs.jpgQuality + "%";
    paintRange(dom.jpgQuality);
    dom.downloadLabel.textContent = t(state.prefs.exportFormat === "jpg" ? "downloadJpg" : "downloadPng");
  }

  function savePreferences() { store(STORAGE.prefs, JSON.stringify(state.prefs)); }

  function setPreference(key, value) {
    state.prefs[key] = value;
    savePreferences();
    syncControls();
  }

  /**
   * The only way processing settings change. Values are clamped by the
   * engine's own limits, written to state, mirrored to every control,
   * and then rendered.
   */
  function updateSettings(partial, opts) {
    opts = opts || {};
    var merged = Object.assign({}, state.settings, partial);
    state.settings = fromParams(Engine.normalizeParams(toParams(merged)));
    syncControls();
    if (opts.render !== false) scheduleRender(!!opts.interactive);
  }

  function currentParams() { return Engine.normalizeParams(toParams(state.settings)); }
  function currentKey() { return Engine.paramsKey(currentParams()); }

  /* =========================================================== toasts */
  var toastTimer = null;
  function toast(message, tone) {
    dom.toastText.textContent = message;
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove("show"); }, tone === "error" ? 6000 : 2600);
  }

  /* ============================================================= busy */
  var busy = { load: null, render: false, export: false, timer: null };
  function refreshBusyText() {
    dom.busyText.textContent = busy.load ? t(busy.load) : t("working");
  }
  function refreshBusy() {
    var active = !!(busy.load || busy.render || busy.export);
    refreshBusyText();
    clearTimeout(busy.timer);
    if (active) {
      busy.timer = setTimeout(function () { dom.busy.classList.add("show"); }, 140);
    } else {
      dom.busy.classList.remove("show");
    }
    root.toggleAttribute("data-busy", active);
  }

  /* ========================================================= renderer
     Runs render jobs in a worker (or on the main thread if workers are
     unavailable). At most one job is in flight; newer requests replace
     any queued one, so dragging never builds up a backlog. */
  var renderer = (function () {
    var worker = null;
    var seq = 0;
    var pending = null;
    var inflight = null;
    var source = null;
    var heifCallbacks = {};
    var waiters = [];
    var lastShownId = 0;

    function failOver(reason) {
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
      worker = null;
      if (reason) console.warn("Cutout Effect Studio: worker unavailable, using main thread.", reason);
      Object.keys(heifCallbacks).forEach(function (id) { heifCallbacks[id].reject(new Error("worker failed")); delete heifCallbacks[id]; });
      if (inflight) { var job = inflight; inflight = null; if (!pending) pending = job; }
      pump();
    }

    try {
      worker = new Worker(RES.worker + (RES.worker.indexOf("blob:") === 0 ? "" : ASSET_QS));
      worker.onmessage = function (e) {
        var msg = e.data || {};
        if (msg.type === "rendered") return finish(msg);
        if (msg.type === "heifDecoded" && heifCallbacks[msg.id]) {
          heifCallbacks[msg.id].resolve(msg); delete heifCallbacks[msg.id]; return;
        }
        if (msg.type === "error") {
          if (heifCallbacks[msg.id]) { heifCallbacks[msg.id].reject(new Error(msg.message)); delete heifCallbacks[msg.id]; return; }
          if (inflight && inflight.id === msg.id) {
            // Retry this job on the main thread rather than failing the render.
            var job = inflight; inflight = null;
            runOnMainThread(job);
          }
        }
      };
      worker.onerror = function (e) { e.preventDefault && e.preventDefault(); failOver(e.message || "worker error"); };
    } catch (err) {
      worker = null;
    }

    function postSource() {
      if (!worker || !source) return;
      var full = source.full.data.slice();
      var msg = { type: "source", full: { buffer: full.buffer, width: source.full.width, height: source.full.height }, proxy: null };
      var transfer = [full.buffer];
      if (source.proxy) {
        var px = source.proxy.data.slice();
        msg.proxy = { buffer: px.buffer, width: source.proxy.width, height: source.proxy.height };
        transfer.push(px.buffer);
      }
      worker.postMessage(msg, transfer);
    }

    function runOnMainThread(job) {
      inflight = job;
      setTimeout(function () {
        try {
          var src = job.quality === "proxy" && source.proxy ? source.proxy : source.full;
          var out = Engine.process(src.data, src.width, src.height, job.params);
          finish({ id: job.id, quality: src === source.full ? "full" : "proxy", params: job.params,
            width: src.width, height: src.height, buffer: out.buffer });
        } catch (err) {
          inflight = null;
          console.error(err);
          rejectWaiters(err);
          toast(t("errorProcessing"), "error");
          busy.render = false; refreshBusy();
        }
      }, 0);
    }

    function pump() {
      if (inflight || !pending || !source) return;
      var job = pending;
      pending = null;
      if (worker) {
        inflight = job;
        worker.postMessage({ type: "render", id: job.id, quality: job.quality, params: job.params });
      } else {
        runOnMainThread(job);
      }
    }

    function finish(msg) {
      inflight = null;
      // Ignore results that are older than what is already on screen
      // (or that belong to a previously loaded image).
      if (msg.id > lastShownId) {
        display(msg);
        lastShownId = msg.id;
      }
      pump();
      if (!inflight && !pending) { busy.render = false; refreshBusy(); }
    }

    function display(msg) {
      var data = new Uint8ClampedArray(msg.buffer);
      if (!state.image || msg.width === 0) return;
      var img = new ImageData(data, msg.width, msg.height);
      if (msg.quality === "full" && msg.width === state.image.width && msg.height === state.image.height) {
        resultCtx.putImageData(img, 0, 0);
        state.renderedKey = Engine.paramsKey(msg.params);
        dom.frame.setAttribute("data-rendered", state.renderedKey);
        resolveWaiters(state.renderedKey);
      } else if (msg.quality === "proxy") {
        var tmp = document.createElement("canvas");
        tmp.width = msg.width; tmp.height = msg.height;
        tmp.getContext("2d").putImageData(img, 0, 0);
        resultCtx.imageSmoothingEnabled = true;
        resultCtx.imageSmoothingQuality = "high";
        resultCtx.clearRect(0, 0, state.image.width, state.image.height);
        resultCtx.drawImage(tmp, 0, 0, state.image.width, state.image.height);
        state.renderedKey = null;
        dom.frame.removeAttribute("data-rendered");
      }
    }

    function resolveWaiters(key) {
      waiters = waiters.filter(function (w) {
        if (w.key === key) { w.resolve(); return false; }
        return true;
      });
    }
    function rejectWaiters(err) {
      waiters.forEach(function (w) { w.reject(err); });
      waiters = [];
    }

    return {
      setSource: function (full, proxy) {
        source = { full: full, proxy: proxy };
        pending = null;
        lastShownId = seq;
        rejectWaiters(new Error("source replaced"));
        postSource();
      },
      request: function (params, quality) {
        if (!source) return;
        pending = { id: ++seq, params: params, quality: quality };
        busy.render = true; refreshBusy();
        pump();
      },
      waitForFull: function (key) {
        return new Promise(function (resolve, reject) { waiters.push({ key: key, resolve: resolve, reject: reject }); });
      },
      decodeHeif: function (buffer) {
        if (worker) {
          return new Promise(function (resolve, reject) {
            var id = "h" + (++seq);
            heifCallbacks[id] = { resolve: resolve, reject: reject };
            worker.postMessage({ type: "decodeHeif", id: id, buffer: buffer }, [buffer]);
          }).catch(function (err) {
            console.warn("Cutout Effect Studio: worker HEIF decode failed, trying main thread.", err);
            return null;
          });
        }
        return Promise.resolve(null);
      },
      hasWorker: function () { return !!worker; },
    };
  })();

  var fullTimer = null;
  function scheduleRender(interactive) {
    if (!state.image) return;
    clearTimeout(fullTimer);
    var useProxy = interactive && state.prefs.fastPreview && !!state.image.proxy;
    if (useProxy) {
      renderer.request(currentParams(), "proxy");
      fullTimer = setTimeout(function () { renderer.request(currentParams(), "full"); }, 220);
    } else {
      renderer.request(currentParams(), "full");
    }
  }

  function ensureFullRender() {
    var key = currentKey();
    if (state.renderedKey === key) return Promise.resolve();
    var wait = renderer.waitForFull(key);
    clearTimeout(fullTimer);
    renderer.request(currentParams(), "full");
    return wait;
  }

  /* ======================================================== file input */
  function extensionOf(name) {
    var m = /\.[^.]+$/.exec(String(name || "").toLowerCase());
    return m ? m[0] : "";
  }

  function validateFile(file) {
    if (!file) return { error: "errorNoFile" };
    var ext = extensionOf(file.name);
    var mime = String(file.type || "").toLowerCase();
    var extOk = FILE_RULES.extensions.indexOf(ext) !== -1;
    var mimeOk = FILE_RULES.mimes.indexOf(mime) !== -1;
    // A known image extension or a known image MIME type is enough: HEIC
    // files often arrive with an empty type, and iOS may rename files.
    if (!extOk && !mimeOk) return { error: "errorUnsupportedFile" };
    if (file.size === 0) return { error: "errorEmptyFile" };
    if (file.size > FILE_RULES.maxBytes) return { error: "errorTooLarge" };
    return {
      ok: true,
      heifHint: FILE_RULES.heifExtensions.indexOf(ext) !== -1 || FILE_RULES.heifMimes.indexOf(mime) !== -1,
    };
  }

  function readHead(file, n) {
    return file.slice(0, n).arrayBuffer
      ? file.slice(0, n).arrayBuffer()
      : new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { resolve(r.result); };
          r.onerror = function () { reject(r.error); };
          r.readAsArrayBuffer(file.slice(0, n));
        });
  }

  /* ISO-BMFF "ftyp" box with a HEIF/HEIC brand (major or compatible). */
  function isHeifSignature(buffer) {
    var b = new Uint8Array(buffer);
    if (b.length < 16) return false;
    var str = function (o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); };
    if (str(4) !== "ftyp") return false;
    var size = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0;
    var end = Math.min(b.length, size || b.length);
    var heif = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];
    var major = str(8).toLowerCase();
    if (major === "avif" || major === "avis") return false;
    if (heif.indexOf(major) !== -1) return true;
    for (var o = 16; o + 4 <= end; o += 4) if (heif.indexOf(str(o).toLowerCase()) !== -1 && str(o).toLowerCase() !== "mif1") return true;
    return false;
  }

  function decodeWithImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.decoding = "async";
      img.onload = function () {
        var done = function () {
          if (!img.naturalWidth || !img.naturalHeight) { URL.revokeObjectURL(url); return reject(new Error("empty image")); }
          resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: function () { URL.revokeObjectURL(url); } });
        };
        if (img.decode) img.decode().then(done, done); else done();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image element could not decode")); };
      img.src = url;
    });
  }

  function decodeWithBitmap(file) {
    if (typeof createImageBitmap !== "function") return Promise.reject(new Error("no createImageBitmap"));
    return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
      return { source: bmp, width: bmp.width, height: bmp.height, release: function () { bmp.close && bmp.close(); } };
    });
  }

  function decodeNative(file) {
    // <img> honours EXIF orientation everywhere; ImageBitmap is the backup.
    return decodeWithImageElement(file).catch(function () { return decodeWithBitmap(file); });
  }

  var mainThreadHeif = null;
  function loadHeifOnMainThread() {
    if (!mainThreadHeif) {
      mainThreadHeif = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        var onScript = function () {
          fetch(RES.libheifWasm + (RES.libheifWasm.indexOf("data:") === 0 ? "" : ASSET_QS))
            .then(function (r) { if (!r.ok) throw new Error("wasm " + r.status); return r.arrayBuffer(); })
            .then(function (bin) {
            // The factory returns the module object right away; it is only
            // usable once the runtime reports that it has initialised.
            return new Promise(function (ok, fail) {
              window.libheif({ wasmBinary: bin, onRuntimeInitialized: function () { ok(this); }, onAbort: fail });
            });
          })
            .then(resolve, reject);
        };
        s.onerror = function () { reject(new Error("libheif failed to load")); };
        if (RES.libheifSource) {
          s.textContent = RES.libheifSource;   // embedded copy runs synchronously
          document.head.appendChild(s);
          if (window.libheif) onScript(); else reject(new Error("libheif failed to load"));
        } else {
          s.onload = onScript;
          s.src = RES.libheifScript + ASSET_QS;
          document.head.appendChild(s);
        }
      });
      mainThreadHeif.catch(function () { mainThreadHeif = null; });
    }
    return mainThreadHeif;
  }

  function decodeHeifOnMainThread(buffer) {
    return loadHeifOnMainThread().then(function (lib) {
      var decoder = new lib.HeifDecoder();
      var images = decoder.decode(new Uint8Array(buffer));
      if (!images || !images.length) throw new Error("no image");
      var image = images.find(function (i) { return i.is_primary && i.is_primary(); }) || images[0];
      var w = image.get_width(), h = image.get_height();
      return new Promise(function (resolve, reject) {
        image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, function (out) {
          images.forEach(function (i) { try { i.free(); } catch (e) { /* ignore */ } });
          if (!out) return reject(new Error("decode failed"));
          resolve({ width: w, height: h, buffer: out.data.buffer });
        });
      });
    });
  }

  function decodeHeif(file) {
    return file.arrayBuffer().then(function (buffer) {
      var copy = buffer.slice(0);
      return renderer.decodeHeif(buffer).then(function (res) {
        return res || decodeHeifOnMainThread(copy);
      });
    }).then(function (res) {
      var imageData = new ImageData(new Uint8ClampedArray(res.buffer), res.width, res.height);
      return { source: imageData, width: res.width, height: res.height, release: function () {} };
    });
  }

  function createCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  /* Scales the decoded image to the working size and reads its pixels. */
  function toWorkingPixels(decoded) {
    var w = decoded.width, h = decoded.height;
    var scale = Math.min(1, MAX_WORKING_EDGE / Math.max(w, h));
    var W = Math.max(1, Math.round(w * scale));
    var H = Math.max(1, Math.round(h * scale));

    var src = decoded.source;
    if (src instanceof ImageData) {
      if (scale === 1) return { full: src, canvas: null };
      var tmp = createCanvas(w, h);
      tmp.getContext("2d").putImageData(src, 0, 0);
      src = tmp;
    }
    var canvas = createCanvas(W, H);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, W, H);
    return { full: ctx.getImageData(0, 0, W, H), canvas: canvas };
  }

  function makeProxy(full, canvas) {
    if (full.width * full.height <= PROXY_MIN_PIXELS) return null;
    var scale = PROXY_EDGE / Math.max(full.width, full.height);
    var w = Math.max(1, Math.round(full.width * scale));
    var h = Math.max(1, Math.round(full.height * scale));
    if (!canvas) {
      canvas = createCanvas(full.width, full.height);
      canvas.getContext("2d").putImageData(full, 0, 0);
    }
    var p = createCanvas(w, h);
    var ctx = p.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  var loadToken = 0;
  function openFile(file) {
    var check = validateFile(file);
    if (!check.ok) { toast(t(check.error), "error"); return Promise.resolve(false); }

    var token = ++loadToken;
    busy.load = "opening"; refreshBusy();

    return readHead(file, 64)
      .then(function (head) { return isHeifSignature(head) || check.heifHint; })
      .then(function (heif) {
        if (!heif) return decodeNative(file);
        return decodeNative(file).catch(function () {
          busy.load = "decodingHeic"; refreshBusy();
          return decodeHeif(file).catch(function (err) {
            var e = new Error("heif"); e.i18n = "errorHeicDecode"; e.cause = err; throw e;
          });
        });
      })
      .then(function (decoded) {
        if (token !== loadToken) { decoded.release(); return false; }
        var working;
        try { working = toWorkingPixels(decoded); } finally { decoded.release(); }
        var proxy = makeProxy(working.full, working.canvas);
        setImage(file.name || "image", decoded.width, decoded.height, working.full, proxy);
        toast(t("statusLoaded"), "info");
        return true;
      })
      .catch(function (err) {
        if (token !== loadToken) return false;
        console.warn("Cutout Effect Studio: could not open file.", err);
        toast(t((err && err.i18n) || "errorInvalidImage"), "error");
        return false;
      })
      .then(function (ok) {
        if (token === loadToken) { busy.load = null; refreshBusy(); }
        return ok;
      });
  }

  function setImage(name, sourceWidth, sourceHeight, full, proxy) {
    state.image = {
      name: name, sourceWidth: sourceWidth, sourceHeight: sourceHeight,
      width: full.width, height: full.height, original: full, proxy: proxy,
    };
    state.renderedKey = null;
    dom.frame.removeAttribute("data-rendered");

    dom.resultCanvas.width = full.width; dom.resultCanvas.height = full.height;
    dom.originalCanvas.width = full.width; dom.originalCanvas.height = full.height;
    originalCtx.putImageData(full, 0, 0);
    resultCtx.putImageData(full, 0, 0);

    dom.dropzone.hidden = true;
    dom.frame.hidden = false;
    dom.replaceBtn.hidden = false;
    dom.stageBody.classList.add("has-image");
    dom.downloadBtn.disabled = false;
    dom.viewSeg.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
    dom.fileMeta.textContent = name + "  ·  " + sourceWidth + " × " + sourceHeight;
    dom.fileMeta.title = dom.fileMeta.textContent;

    renderer.setSource(
      { data: full.data, width: full.width, height: full.height },
      proxy ? { data: proxy.data, width: proxy.width, height: proxy.height } : null
    );
    layoutFrame();
    if (proxy) renderer.request(currentParams(), "proxy");
    clearTimeout(fullTimer);
    fullTimer = setTimeout(function () { renderer.request(currentParams(), "full"); }, 0);
  }

  /* ============================================== layout & comparison */
  var compactLayout = window.matchMedia("(max-width: 860px)");
  function layoutFrame() {
    if (!state.image) return;
    var cs = getComputedStyle(dom.stageBody);
    var availW = dom.stageBody.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var availH;
    if (compactLayout.matches) {
      // Narrow screens: the stage grows with the picture, capped so the
      // controls stay within reach below it.
      availH = Math.max(200, window.innerHeight * 0.62);
    } else {
      availH = dom.stageBody.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    }
    if (availW <= 0 || availH <= 0) return;
    // Fit without cropping or distortion. Small images may scale up (to a
    // limit) so they read well; the pixels themselves are never changed.
    var scale = Math.min(availW / state.image.width, availH / state.image.height, 4);
    dom.frame.style.width = Math.max(1, Math.floor(state.image.width * scale)) + "px";
    dom.frame.style.height = Math.max(1, Math.floor(state.image.height * scale)) + "px";
  }

  function setView(view) {
    state.view = view === "compare" ? "compare" : "result";
    setSegmented(dom.viewSeg, "data-view", state.view);
    dom.frame.classList.toggle("comparing", state.view === "compare");
  }

  function setSplit(pct) {
    state.split = Math.min(100, Math.max(0, pct));
    dom.frame.style.setProperty("--split", state.split + "%");
    dom.split.setAttribute("aria-valuenow", String(Math.round(state.split)));
  }

  function bindSplit() {
    var active = false;
    var move = function (e) {
      var rect = dom.frame.getBoundingClientRect();
      setSplit(((e.clientX - rect.left) / rect.width) * 100);
    };
    dom.split.addEventListener("pointerdown", function (e) {
      active = true;
      dom.split.setPointerCapture(e.pointerId);
      move(e);
      e.preventDefault();
    });
    dom.split.addEventListener("pointermove", function (e) { if (active) move(e); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (ev) {
      dom.split.addEventListener(ev, function () { active = false; });
    });
    dom.frame.addEventListener("click", function (e) {
      if (state.view !== "compare" || e.target.closest(".split")) return;
      move(e);
    });
    dom.split.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 10 : 2;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") setSplit(state.split - step);
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") setSplit(state.split + step);
      else if (e.key === "Home") setSplit(0);
      else if (e.key === "End") setSplit(100);
      else return;
      e.preventDefault();
    });
  }

  /* ============================================================ export */
  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("toBlob returned null")); }, type, quality);
      } else {
        try {
          var url = canvas.toDataURL(type, quality);
          fetch(url).then(function (r) { return r.blob(); }).then(resolve, reject);
        } catch (e) { reject(e); }
      }
    });
  }

  function exportBaseName() {
    var name = state.image ? state.image.name.replace(/\.[^.]+$/, "") : "image";
    name = name.replace(/[\\/:*?"<>|]+/g, "").trim() || "image";
    return name + "-cutout";
  }

  function exportImage() {
    if (!state.image) return Promise.resolve(null);
    busy.export = true; refreshBusy();
    var format = state.prefs.exportFormat;
    return ensureFullRender()
      .then(function () {
        var canvas = dom.resultCanvas;
        if (format === "jpg") {
          // JPG has no alpha: flatten onto white so transparent areas don't turn black.
          var flat = createCanvas(canvas.width, canvas.height);
          var fctx = flat.getContext("2d");
          fctx.fillStyle = "#ffffff";
          fctx.fillRect(0, 0, flat.width, flat.height);
          fctx.drawImage(canvas, 0, 0);
          canvas = flat;
        }
        return canvasToBlob(canvas, format === "jpg" ? "image/jpeg" : "image/png",
          format === "jpg" ? state.prefs.jpgQuality / 100 : undefined);
      })
      .then(function (blob) {
        var filename = exportBaseName() + (format === "jpg" ? ".jpg" : ".png");
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        toast(t("statusDownloaded"), "info");
        return { blob: blob, filename: filename };
      })
      .catch(function (err) {
        console.error("Cutout Effect Studio: export failed.", err);
        toast(t("errorExport"), "error");
        return null;
      })
      .then(function (res) { busy.export = false; refreshBusy(); return res; });
  }

  /* ============================================================ resets */
  function resetToOriginal() {
    updateSettings(DEFAULT_SETTINGS);
    setView("result");
    setSplit(50);
    toast(t("statusResetOriginal"), "info");
  }

  function resetAllSettings() {
    state.prefs = Object.assign({}, DEFAULT_PREFERENCES);
    savePreferences();
    updateSettings(DEFAULT_SETTINGS);
    setView("result");
    setSplit(50);
    applyTranslations();
    toast(t("statusResetSettings"), "info");
  }

  /* ============================================================= sheet */
  var TITLES = { settings: "settingsTitle", language: "langLabel", privacy: "privacyTitle", guide: "guideTitle" };
  var sheet = { stack: [], opener: null };

  function pages() { return Array.prototype.slice.call(document.querySelectorAll("[data-page]")); }

  function updateSheetChrome() {
    var top = sheet.stack[sheet.stack.length - 1];
    dom.sheetTitle.textContent = top ? t(TITLES[top]) : "";
    dom.sheetBack.hidden = sheet.stack.length < 2;
    dom.sheetBackLabel.textContent = t("back");
    dom.sheetBack.setAttribute("aria-label", t("back"));
  }

  function showView(name, direction) {
    dom.sheetBody.querySelectorAll(".view").forEach(function (v) {
      var on = v.getAttribute("data-view") === name;
      v.hidden = !on;
      v.classList.remove("enter", "enter-back");
      if (on && direction) { void v.offsetWidth; v.classList.add(direction === "back" ? "enter-back" : "enter"); }
    });
    dom.sheetBody.scrollTop = 0;
    if (name === "language") renderLanguageList();
    updateSheetChrome();
  }

  function openSheet(view) {
    var wasOpen = sheet.stack.length > 0;
    if (!wasOpen) sheet.opener = document.activeElement;
    sheet.stack = [view];
    showView(view, null);
    dom.sheet.classList.add("open");
    dom.sheetBackdrop.classList.add("open");
    dom.sheet.setAttribute("aria-hidden", "false");
    pages().forEach(function (el) { el.inert = true; el.setAttribute("aria-hidden", "true"); });
    root.style.overflow = "hidden";
    setTimeout(function () {
      // Focus the dialog itself: keyboard users can Tab from here, and no
      // focus ring appears on a row or button that nobody pressed.
      dom.sheet.focus({ preventScroll: true });
      if (view === "language") {
        var current = dom.langList.querySelector('[aria-checked="true"]');
        if (current) current.scrollIntoView({ block: "center" });
      }
    }, 30);
  }

  function pushView(view) {
    sheet.stack.push(view);
    showView(view, "forward");
    dom.sheet.focus({ preventScroll: true });
  }

  function popView() {
    if (sheet.stack.length < 2) return;
    sheet.stack.pop();
    showView(sheet.stack[sheet.stack.length - 1], "back");
  }

  function closeSheet() {
    if (!sheet.stack.length) return;
    sheet.stack = [];
    dom.sheet.classList.remove("open");
    dom.sheetBackdrop.classList.remove("open");
    dom.sheet.setAttribute("aria-hidden", "true");
    pages().forEach(function (el) { el.inert = false; el.removeAttribute("aria-hidden"); });
    root.style.overflow = "";
    var back = sheet.opener;
    sheet.opener = null;
    if (back && typeof back.focus === "function") back.focus({ preventScroll: true });
  }

  function trapFocus(e) {
    if (e.key !== "Tab" || !sheet.stack.length) return;
    var focusables = Array.prototype.filter.call(
      dom.sheet.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; }
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ============================================================ events */
  function bindEvents() {
    // Upload: click, keyboard, replace button.
    var pick = function () { dom.fileInput.click(); };
    dom.dropzone.addEventListener("click", pick);
    dom.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    dom.replaceBtn.addEventListener("click", pick);
    dom.fileInput.addEventListener("change", function () {
      var file = dom.fileInput.files && dom.fileInput.files[0];
      if (file) openFile(file);
      dom.fileInput.value = "";
    });

    // Drag and drop onto the whole stage (also replaces a loaded image).
    var depth = 0;
    var hasFiles = function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
    };
    dom.stageBody.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++; dom.stageBody.classList.add("dragging");
    });
    dom.stageBody.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    });
    dom.stageBody.addEventListener("dragleave", function () {
      depth = Math.max(0, depth - 1);
      if (!depth) dom.stageBody.classList.remove("dragging");
    });
    dom.stageBody.addEventListener("drop", function (e) {
      e.preventDefault(); depth = 0; dom.stageBody.classList.remove("dragging");
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) openFile(file); else toast(t("errorNoFile"), "error");
    });
    // A file dropped next to the stage must not navigate away from the app.
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", function (e) { if (hasFiles(e)) e.preventDefault(); });

    // Paste an image from the clipboard.
    document.addEventListener("paste", function (e) {
      if (sheet.stack.length) return;
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length) {
        e.preventDefault();
        if (root.getAttribute("data-route") !== "editor") location.hash = "#/editor";
        openFile(items[0]);
      }
    });

    // Effect sliders.
    [["levels", "numberOfLevels"], ["simplicity", "edgeSimplicity"], ["fidelity", "edgeFidelity"]].forEach(function (pair) {
      var input = dom[pair[0]];
      input.addEventListener("pointerdown", function () { state.dragging = true; });
      input.addEventListener("input", function () {
        var patch = {}; patch[pair[1]] = Number(input.value);
        updateSettings(patch, { interactive: state.dragging });
      });
      input.addEventListener("change", function () {
        state.dragging = false;
        var patch = {}; patch[pair[1]] = Number(input.value);
        updateSettings(patch, { interactive: false });
      });
    });
    window.addEventListener("pointerup", function () { state.dragging = false; });
    window.addEventListener("pointercancel", function () { state.dragging = false; });

    bindSegmented(dom.toneSeg, "data-tone", function (v) { updateSettings({ toneMode: v }); });
    bindSegmented(dom.viewSeg, "data-view", setView);
    bindSegmented(dom.formatSeg, "data-format", function (v) { setPreference("exportFormat", v); });
    bindSegmented(dom.formatSeg2, "data-format", function (v) { setPreference("exportFormat", v); });

    dom.resetOriginalBtn.addEventListener("click", resetToOriginal);
    dom.resetAllBtn.addEventListener("click", resetAllSettings);
    dom.downloadBtn.addEventListener("click", exportImage);

    dom.fastSwitch.addEventListener("click", function () { setPreference("fastPreview", !state.prefs.fastPreview); });
    dom.gridSwitch.addEventListener("click", function () { setPreference("transparencyGrid", !state.prefs.transparencyGrid); });
    dom.jpgQuality.addEventListener("input", function () { setPreference("jpgQuality", Number(dom.jpgQuality.value)); });

    // Toolbar.
    dom.themeBtn.addEventListener("click", function () {
      setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
    });
    dom.settingsBtn.addEventListener("click", function () { openSheet("settings"); });
    dom.helpBtn.addEventListener("click", function () { openSheet("guide"); });
    dom.langBtn.addEventListener("click", function () { openSheet("language"); });
    dom.privacyBtn.addEventListener("click", function () { openSheet("privacy"); });

    // Sheet navigation.
    dom.sheetDone.addEventListener("click", closeSheet);
    dom.sheetBackdrop.addEventListener("click", closeSheet);
    dom.sheetBack.addEventListener("click", popView);
    dom.sheetBody.addEventListener("click", function (e) {
      var push = e.target.closest("[data-push]");
      if (push) pushView(push.getAttribute("data-push"));
    });
    document.addEventListener("keydown", function (e) {
      if (!sheet.stack.length) return;
      if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
      trapFocus(e);
    });

    if (lightQuery) {
      var onScheme = function () { if (state.themePref === "system") setThemePreference("system", true); };
      lightQuery.addEventListener ? lightQuery.addEventListener("change", onScheme) : lightQuery.addListener(onScheme);
    }

    if (window.ResizeObserver) new ResizeObserver(layoutFrame).observe(dom.stageBody);
    window.addEventListener("resize", layoutFrame);
    if (compactLayout.addEventListener) compactLayout.addEventListener("change", layoutFrame);
    bindSplit();
  }

  /* ============================================================== boot */
  function init() {
    var savedTheme = load(STORAGE.theme);
    state.themePref = savedTheme === "light" || savedTheme === "system" || savedTheme === "dark" ? savedTheme : "dark";
    setThemePreference(state.themePref, false);
    setSplit(50);
    setView("result");
    syncControls();
    bindEvents();
    setLanguage(detectLanguage(), false).then(function () {
      root.setAttribute("data-ready", "true");
    });
  }

  // Small, stable surface for automated tests and debugging.
  window.CutoutStudio = Object.freeze({
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PREFERENCES: DEFAULT_PREFERENCES,
    version: VERSION,
    getState: function () {
      return {
        settings: Object.assign({}, state.settings),
        prefs: Object.assign({}, state.prefs),
        renderedKey: state.renderedKey,
        currentKey: currentKey(),
        image: state.image ? { width: state.image.width, height: state.image.height, sourceWidth: state.image.sourceWidth, sourceHeight: state.image.sourceHeight, hasProxy: !!state.image.proxy } : null,
        lang: state.lang, theme: root.getAttribute("data-theme"), themePref: state.themePref, view: state.view,
        worker: renderer.hasWorker(),
      };
    },
    openFile: openFile,
    t: t,
    openSheet: openSheet,
    closeSheet: closeSheet,
    toggleTheme: function () { setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true); },
    exportImage: exportImage,
    whenRendered: ensureFullRender,
  });

  init();
})();
