# WASM Cutout Engine

`cutout_effect.cpp` is an optional performance upgrade for Cutout Effect
Studio. It re-implements the posterize + box-blur effect in C++, compiled to
WebAssembly, so large photos process noticeably faster than the pure-JS
fallback in `index.html`. Both engines produce identical output — this is a
speed upgrade only, never a requirement.

## How it loads

`index.html` already:
1. Tries to load `wasm/dist/cutout_wasm.js` via a `<script defer>` tag.
2. If `window.CutoutWasmModule` exists once the page loads, it instantiates
   the module and uses it for every render.
3. If the file 404s (not built yet), fails to load, or throws at runtime,
   the app transparently falls back to the JS engine — no visible error.

So nothing else needs to change in `index.html` for this to work.

## Building automatically (recommended)

`.github/workflows/build-wasm.yml` builds this file with Emscripten and
commits the output to `wasm/dist/` automatically whenever
`wasm/cutout_effect.cpp` changes on `main`. If your default branch isn't
`main`, update the `branches:` list in that workflow file.

You can also trigger it manually from the **Actions** tab
("Build WASM Cutout Engine" → *Run workflow*) any time.

## Building locally (optional)

Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), then from the repo root:

```bash
mkdir -p wasm/dist
emcc wasm/cutout_effect.cpp \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="CutoutWasmModule" \
  -s EXPORTED_FUNCTIONS="['_applyCutoutEffect','_malloc','_free']" \
  -s EXPORTED_RUNTIME_METHODS="['HEAPU8']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -o wasm/dist/cutout_wasm.js
```

This produces `wasm/dist/cutout_wasm.js` and `wasm/dist/cutout_wasm.wasm`.
Commit both — GitHub Pages serves static files as-is.
