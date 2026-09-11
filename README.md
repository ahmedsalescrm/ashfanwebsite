# Click2Website — 3D website (optimized build)

A plain static site: `index.html` + `assets/`. Upload the whole folder to GitHub, connect the
repo to Vercel or Netlify (framework preset **Other**, no build command, publish directory `/`)
and it is live. Every push to `main` redeploys automatically.

## What's in here

| Path | What it is |
|---|---|
| `index.html` | The page (≈100 KB, ≈10 KB compressed on the wire) |
| `assets/app.js` | Site logic + Three.js bundled into one file (≈125 KB compressed) |
| `assets/img/*.webp` | Portfolio screenshots (11 images, 165 KB total — were 3.2 MB of PNG) |
| `assets/fonts/*.woff2` | Onest + Playfair Display, Latin subsets only (95 KB total) |
| `vercel.json`, `_headers` | Cache headers for Vercel / Netlify (optional, harmless elsewhere) |
| `.nojekyll` | Only matters if you ever host on GitHub Pages |
| `click2website-mark.png`, `click2website-logo-lockup-v2.png` | Logo exports (not used by the page) |
| `tools/` | The build pipeline — see below |

## How this differs from the design-tool export

The original `index.html` was a 5 MB self-unpacking bundle: every image and font was base64-encoded
inside it, React and a template runtime were loaded to render an otherwise static page, and
Three.js was fetched from unpkg at runtime. Nothing rendered until the whole 5 MB had downloaded
and been decoded in JavaScript.

This build keeps the design and the 3D scene exactly as they were and changes only the delivery:

* images converted to WebP, fonts trimmed to the Latin subsets the page uses, both served as
  normal cacheable files
* React and the template runtime replaced by ~24 KB of plain JavaScript that drives the same markup
* Three.js bundled locally (tree-shaken) — no third-party CDN at runtime
* WebGL renders at 1× device pixels (the canvas is blurred by CSS anyway, so 2× bought nothing),
  shaders are compiled behind the loading screen, and a frame-time monitor lowers resolution /
  glass blur / shadows automatically on machines that can't hold ~45 fps

Measured on an emulated 4G connection: DOM ready 13.5 s → 1.7 s, 3D scene running 17.3 s → 2.9 s
(uncompressed; real hosting with Brotli is faster still).

## Booking form

Unchanged: submissions go through FormSubmit to **Ashfan354@gmail.com**. The first submission from
the live site triggers a one-time activation email — click **Activate** in it. If the relay is
unreachable the visitor's mail app opens instead.

## Editing text or images

Edit `index.html` directly — it's ordinary HTML with inline styles. To swap a portfolio screenshot,
replace the file in `assets/img/` (keep the same file name, or update the `<img src>`).

The site settings that used to live in the design tool's panel are at the bottom of `index.html`:

```html
<script>window.C2W_CONFIG={"accent": "#D4AF37", "inboxEmail": "...", "quality": "auto", "drift": true};</script>
```

`accent` is the gold colour, `quality` can be `auto` / `high` / `lite`, `drift` toggles the idle
camera motion.

## Rebuilding from a fresh design-tool export (`tools/`)

If you re-export the page from the design tool and want the same optimizations applied again:

```bash
cd tools
npm install                      # once: esbuild + three
pip install pillow fonttools brotli   # once
python3 build.py /path/to/exported-index.html ../   # writes index.html + assets/ one level up
```

`tools/src/app.js` is the page logic. If the 3D scene code changes in the design tool, the same
changes need to be made there (it is a direct port of the component's script, minus React).

## Changelog

**2026-09-11 — fix: page shifted sideways / cut off on Windows laptops.** The 3D layer sized itself
from `window.innerWidth`, which includes the classic 15–17 px scrollbar that Chrome on Windows
draws, while the fixed full-screen "world" it positions does not cover that scrollbar. The half-
scrollbar difference is multiplied by the ×100 scene scale, so every section landed ~800 px off
centre (macOS and Edge use overlay scrollbars, which is why the same page looked fine there). The
layer now measures its own box (`tools/src/app.js` → `viewBox()`), re-centres immediately on any
size change, no longer jumps when a phone's address bar collapses, and a window that opens small
and is maximised later switches out of the phone layout. Rebuilt `assets/app.js`.
