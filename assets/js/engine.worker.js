/* Cutout Effect Studio: background worker.
   Runs the processing engine and the HEIC/HEIF decoder off the main
   thread so the interface stays responsive. Everything stays local:
   pixel data only moves between this worker and the page. */
"use strict";

var QS = self.location.protocol === "blob:" ? "" : self.location.search; // same "?v=" as the page
if (!self.CutoutEngine) importScripts("engine.js" + QS);

var sources = { full: null, proxy: null };
var heifModulePromise = null;

function loadHeif() {
  if (!heifModulePromise) {
    heifModulePromise = new Promise(function (resolve, reject) {
      try {
        if (!self.libheif) importScripts("../../vendor/libheif/libheif.js" + QS);
        // Fetch the binary ourselves: same origin, explicit, and works the
        // same in every browser regardless of how the script was loaded.
        fetch(self.CES_WASM_URL || new URL("../../vendor/libheif/libheif.wasm" + QS, self.location.href).href)
          .then(function (r) { if (!r.ok) throw new Error("wasm " + r.status); return r.arrayBuffer(); })
          .then(function (bin) {
            // The factory returns the module object right away; it is only
            // usable once the runtime reports that it has initialised.
            return new Promise(function (ok, fail) {
              self.libheif({ wasmBinary: bin, onRuntimeInitialized: function () { ok(this); }, onAbort: fail });
            });
          })
          .then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
    heifModulePromise.catch(function () { heifModulePromise = null; });
  }
  return heifModulePromise;
}

function decodeHeif(buffer) {
  return loadHeif().then(function (lib) {
    var decoder = new lib.HeifDecoder();
    var images = decoder.decode(new Uint8Array(buffer));
    if (!images || !images.length) throw new Error("No image found in HEIF container.");

    // The primary image is the one the camera intends to be shown.
    var image = images[0];
    for (var i = 0; i < images.length; i++) {
      if (typeof images[i].is_primary === "function" && images[i].is_primary()) { image = images[i]; break; }
    }
    var width = image.get_width();
    var height = image.get_height();
    return new Promise(function (resolve, reject) {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width: width, height: height }, function (out) {
        for (var j = 0; j < images.length; j++) { try { images[j].free(); } catch (e) { /* ignore */ } }
        if (!out) return reject(new Error("HEIF decode failed."));
        resolve({ width: width, height: height, buffer: out.data.buffer });
      });
    });
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === "source") {
      sources.full = { data: new Uint8ClampedArray(msg.full.buffer), w: msg.full.width, h: msg.full.height };
      sources.proxy = msg.proxy
        ? { data: new Uint8ClampedArray(msg.proxy.buffer), w: msg.proxy.width, h: msg.proxy.height }
        : null;
      return;
    }

    if (msg.type === "render") {
      var src = msg.quality === "proxy" && sources.proxy ? sources.proxy : sources.full;
      if (!src) throw new Error("No source image.");
      var out = self.CutoutEngine.process(src.data, src.w, src.h, msg.params);
      self.postMessage(
        { type: "rendered", id: msg.id, quality: src === sources.full ? "full" : "proxy",
          params: msg.params, width: src.w, height: src.h, buffer: out.buffer },
        [out.buffer]
      );
      return;
    }

    if (msg.type === "decodeHeif") {
      decodeHeif(msg.buffer).then(
        function (res) {
          self.postMessage({ type: "heifDecoded", id: msg.id, width: res.width, height: res.height, buffer: res.buffer }, [res.buffer]);
        },
        function (err) {
          self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
        }
      );
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
