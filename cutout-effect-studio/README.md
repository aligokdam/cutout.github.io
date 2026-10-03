# Cutout Effect Studio

Turn photos into flat, clean-edged cutout artwork, directly in your browser.
All processing happens locally. Images are never uploaded or stored.

Live demo: https://aligokdam.github.io/cutout.github.io/

## Features

- Home page with live examples (rendered in the page by the real engine), feature overview and GitHub section
- Two routes in one page, no reloads: `#/` home, `#/editor` editor. The logo always returns home; Create and the app card open the editor
- Classic cutout / posterize effect with **Number of Levels (2 to 20)**, **Edge Simplicity (0 to 10)** and **Edge Fidelity (0 to 3)**
- Level 2 is a true two-tone result: pure black and pure white only
- Color or Mono tone mode (Mono gives a strictly progressive gray ramp from 2 to 20 tones)
- PNG, JPG, JPEG, WEBP, HEIC and HEIF input, up to 40 MB
- HEIC/HEIF works in every browser (native decoding on Safari, bundled libheif WebAssembly elsewhere)
- Before/after comparison with a draggable divider
- PNG and JPG export, pixel-identical to the preview
- Dark and light themes, 24 languages, right-to-left support
- Processing runs in a Web Worker, with a fast low-resolution preview while dragging large images

## Project structure

```text
index.html                 App shell and markup
assets/css/app.css         Design tokens (dark + light) and components
assets/js/engine.js        Deterministic processing engine (no DOM)
assets/js/engine.worker.js Background worker: rendering + HEIC decoding
assets/js/app.js           Editor: state, UI, file loading, export
assets/js/home.js          Home page, routing and live examples
assets/img/                Sample photos for the home page (CC0 / public domain, see CREDITS.md)
assets/js/i18n.js          Translations (24 languages)
vendor/libheif/            libheif 1.x WebAssembly build (LGPL-3.0, see LICENSE there)
```

Defaults for every reset live in one place: `DEFAULT_SETTINGS` in `assets/js/app.js`.

## Running locally

Workers and WebAssembly need an HTTP origin, so serve the folder instead of
opening the file directly:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

If opened via `file://`, the app still works with the main-thread fallback,
but HEIC decoding needs an HTTP origin.

## License

MIT for the app. `vendor/libheif` is distributed under LGPL-3.0.
