#!/usr/bin/env python3
"""
build.py — turns the design-tool "bundle" export (a single 5 MB index.html that
unpacks itself at runtime) into a plain, fast static site.

  python3 tools/build.py <exported-index.html> <output-dir>

What it does
  * pulls the real page markup + assets out of the bundle
  * converts the portfolio PNG screenshots to WebP (~85-90 % smaller)
  * keeps only the Latin font subsets the page actually uses (woff2)
  * rewrites the template's runtime bindings (sc-if / {{ }} / style-hover …)
    into plain HTML + data-attributes that src/app.js drives directly
  * bundles src/app.js + three.js into one minified assets/app.js (esbuild)
"""
import base64, gzip, html as H, io, json, os, re, shutil, subprocess, sys

from PIL import Image
from fontTools.ttLib import TTFont

SRC = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'dist'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = HERE

os.makedirs(f'{OUT}/assets/img', exist_ok=True)
os.makedirs(f'{OUT}/assets/fonts', exist_ok=True)

raw = open(SRC, encoding='utf-8').read()

def island(kind):
    m = re.search(r'<script type="__bundler/%s">\s*(.*?)\s*</script>' % re.escape(kind), raw, re.S)
    if not m:
        sys.exit(f'not a bundle export: missing __bundler/{kind}')
    return json.loads(m.group(1))

manifest = island('manifest')
template = island('template')

# ---------------------------------------------------------------- assets
assets = {}
for uuid, entry in manifest.items():
    data = base64.b64decode(entry['data'])
    if entry.get('compressed'):
        data = gzip.decompress(data)
    assets[uuid] = (entry['mime'], data)

# ---- images -> WebP
img_urls = {}
img_dims = {}
def slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return s or 'image'
for m in re.finditer(r'<img[^>]*src="([0-9a-f-]{36})"[^>]*>', template):
    uuid = m.group(1)
    if uuid not in assets or uuid in img_urls:
        continue
    mime, data = assets[uuid]
    alt = re.search(r'alt="([^"]*)"', m.group(0))
    name = slug(H.unescape(alt.group(1))) if alt else uuid[:8]
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P'):
        # screenshots: alpha is never used, flatten onto the card background
        bg = Image.new('RGB', im.size, (17, 17, 17))
        bg.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[-1])
        im = bg
    else:
        im = im.convert('RGB')
    path = f'assets/img/{name}.webp'
    im.save(f'{OUT}/{path}', 'WEBP', quality=82, method=6)
    img_urls[uuid] = path
    img_dims[uuid] = im.size
    print(f'  img  {name:<28} {len(data)//1024:>4} KB png -> {os.path.getsize(f"{OUT}/{path}")//1024:>3} KB webp')

# ---- fonts: keep the latin subset of each face, as woff2
font_css_src = re.search(r'<style>(/\* [a-z-]+ \*/\s*@font-face.*?)</style>', template, re.S).group(1)
faces = []          # (family, style, weights[], uuid)
seen = {}
for m in re.finditer(r'/\*\s*([a-z-]+)\s*\*/\s*@font-face\s*\{([^}]*)\}', font_css_src, re.S):
    subset, body = m.group(1), m.group(2)
    if subset != 'latin':
        continue
    fam = re.search(r"font-family:\s*'([^']+)'", body).group(1)
    style = re.search(r'font-style:\s*(\w+)', body).group(1)
    weight = int(re.search(r'font-weight:\s*(\d+)', body).group(1))
    uuid = re.search(r'url\("([^"]+)"\)', body).group(1)
    key = (fam, style, uuid)
    if key in seen:
        seen[key]['weights'].append(weight)
    else:
        seen[key] = {'family': fam, 'style': style, 'weights': [weight], 'uuid': uuid}
        faces.append(seen[key])

font_faces_css = []
font_preloads = []
for f in faces:
    mime, data = assets[f['uuid']]
    tt = TTFont(io.BytesIO(data))
    tt.flavor = 'woff2'
    buf = io.BytesIO(); tt.save(buf); data = buf.getvalue()
    variable = 'fvar' in tt
    fname = slug(f['family']) + ('-italic' if f['style'] == 'italic' else '') + ('-var' if variable else f'-{f["weights"][0]}') + '.woff2'
    path = f'assets/fonts/{fname}'
    open(f'{OUT}/{path}', 'wb').write(data)
    if variable:
        lo, hi = min(f['weights']), max(f['weights'])
        wdecl = f'{lo} {hi}'
        css = (f"@font-face{{font-family:'{f['family']}';font-style:{f['style']};font-weight:{wdecl};"
               f"font-display:swap;src:url({path}) format('woff2');}}")
        font_faces_css.append(css)
    else:
        for w in sorted(set(f['weights'])):
            font_faces_css.append(
                f"@font-face{{font-family:'{f['family']}';font-style:{f['style']};font-weight:{w};"
                f"font-display:swap;src:url({path}) format('woff2');}}")
    font_preloads.append(path)
    print(f'  font {fname:<28} {len(data)//1024:>4} KB')

# initial render values (mirror of renderVals() in src/app.js for the first paint: station 0, filter "all")
def initial_vals():
    navc, navbg, rail, railw = {}, {}, {}, {}
    for i in range(8):
        a = i == 0
        navc[str(i)] = '#ffffff' if a else '#bdbab3'; navbg[str(i)] = 'rgba(255,255,255,0.08)' if a else 'transparent'
        rail[str(i)] = 'var(--ac,#D4AF37)' if a else 'rgba(255,255,255,0.3)'; railw[str(i)] = '26px' if a else '8px'
    on = {'bg': 'var(--ac,#D4AF37)', 'fg': '#0b0a08', 'bd': 'transparent'}
    off = {'bg': 'rgba(12,12,16,0.5)', 'fg': '#d9d6cf', 'bd': 'rgba(255,255,255,0.14)'}
    return {'navc': navc, 'navbg': navbg, 'rail': rail, 'railw': railw, 'f': {'all': on, 'int': off, 'loc': off},
            'showLinks': True, 'isMobile': False, 'showRail': True, 'showWordmark': True, 'menuOpen': False,
            'sent': False, 'notSent': True, 'err': '', 'hasErr': False, 'sendLabel': 'Book Consultation'}
INIT = initial_vals()
def lookup(path):
    v = INIT
    for k in path.split('.'):
        v = v[k]
    return v

# ---------------------------------------------------------------- template -> static html
tpl = template
m = re.search(r'<x-dc>(.*)</x-dc>', tpl, re.S)
body = m.group(1)
# drop the <helmet> (viewport + fonts) — rebuilt in <head> below
helmet = re.search(r'<helmet>(.*?)</helmet>', body, re.S)
page_css = re.findall(r'<style>(.*?)</style>', helmet.group(1), re.S)[1].strip()
body = body[helmet.end():]

# component props (the script itself is replaced by src/app.js)
sm = re.search(r'<script type="text/x-dc"([^>]*)>', tpl)
props_raw = json.loads(H.unescape(re.search(r'data-props="([^"]*)"', sm.group(1)).group(1)))
props = {k: v.get('default') for k, v in props_raw.items() if not k.startswith('$')}

# 1. images
def img_sub(m):
    tag = m.group(0)
    uuid = re.search(r'src="([0-9a-f-]{36})"', tag).group(1)
    w, h = img_dims[uuid]
    tag = tag.replace(f'src="{uuid}"', f'src="{img_urls[uuid]}" width="{w}" height="{h}" fetchpriority="low"')
    return tag
body = re.sub(r'<img[^>]*src="[0-9a-f-]{36}"[^>]*>', img_sub, body)

# 2. svg viewBox + encoded raw tags (<sc-raw-select> is the template's spelling of <select>)
body = body.replace('sc-camel-view-box=', 'viewBox=')
body = re.sub(r'<(/?)sc-raw-([a-z]+)', r'<\1\2', body)

# 3. hover / focus pseudo styles -> classes (same trick the runtime used)
pseudo_rules = {}
def pseudo_sub(m):
    kind, css = m.group(1), H.unescape(m.group(2))
    key = (kind, css)
    if key not in pseudo_rules:
        pseudo_rules[key] = f'p{len(pseudo_rules)}'
    return f' data-pc="{pseudo_rules[key]}"'
body = re.sub(r'\sstyle-(hover|focus)="([^"]*)"', pseudo_sub, body)
# merge data-pc markers into class attributes
def merge_classes(m):
    tag = m.group(0)
    classes = re.findall(r'data-pc="([^"]+)"', tag)
    tag = re.sub(r'\sdata-pc="[^"]+"', '', tag)
    if not classes:
        return tag
    cm = re.search(r'\sclass="([^"]*)"', tag)
    if cm:
        return tag[:cm.start(1)] + (cm.group(1) + ' ' + ' '.join(classes)).strip() + tag[cm.end(1):]
    return tag[:-1] + f' class="{" ".join(classes)}">'
body = re.sub(r'<[a-zA-Z][^>]*>', merge_classes, body)
def importantify(css):
    decls = [d.strip() for d in css.split(';') if d.strip()]
    return ';'.join(d if '!important' in d else d + ' !important' for d in decls)
pseudo_css = ''.join(f'.{cls}:{kind}{{{importantify(css)}}}' for (kind, css), cls in pseudo_rules.items())

# 4. event handlers
body = re.sub(r'\ssc-camel-on-click="\{\{ (\w+) \}\}"', lambda m: f' data-on="{m.group(1)}"', body)
body = re.sub(r'\ssc-camel-on-submit="\{\{ (\w+) \}\}"', lambda m: f' data-submit="{m.group(1)}"', body)

# 5. refs
body = re.sub(r'\sref="\{\{ (\w+)Ref \}\}"', lambda m: f' data-ref="{m.group(1)}"', body)

# 6. sc-if -> data-if on the single wrapped element
def if_sub(m):
    name, inner = m.group(1), m.group(2).strip()
    first = re.match(r'<([a-zA-Z][\w-]*)', inner)
    assert first, 'sc-if without element child'
    # must wrap exactly one element: check the closing tag ends the block
    assert inner.endswith(f'</{first.group(1)}>'), f'sc-if {name} wraps more than one element'
    hidden = '' if lookup(name) else ' hidden'
    return inner[:first.end()] + f' data-if="{name}"{hidden}' + inner[first.end():]
# innermost first (hasErr sits inside notSent)
while re.search(r'<sc-if ', body):
    body = re.sub(r'<sc-if value="\{\{ (\w+) \}\}"[^>]*>((?:(?!<sc-if )[\s\S])*?)</sc-if>', if_sub, body, count=1)

# 7. {{ }} inside style attributes -> data-bind
def style_sub(m):
    style = m.group(1)
    if '{{' not in style:
        return m.group(0)
    binds, kept = [], []
    for decl in style.split(';'):
        if '{{' in decl:
            prop, _, val = decl.partition(':')
            val = re.sub(r'\{\{\s*([\w.]+)\s*\}\}', r'{\1}', val.strip())
            binds.append(f'{prop.strip()}:{val}')
            kept.append(prop.strip() + ':' + re.sub(r'\{([\w.]+)\}', lambda mm: str(lookup(mm.group(1))), val))
        elif decl.strip():
            kept.append(decl.strip())
    return f'style="{";".join(kept)}" data-bind="{";".join(binds)}"'
body = re.sub(r'style="([^"]*)"', style_sub, body)

# 8. {{ }} in text -> data-text on the parent element
def text_sub(m):
    open_tag, name, rest = m.group(1), m.group(2), m.group(3)
    return open_tag[:-1] + f' data-text="{name}">' + H.escape(str(lookup(name))) + rest
body = re.sub(r'(<[a-zA-Z][^>]*>)\s*\{\{\s*(\w+)\s*\}\}([\s\S]*?)(?=</)', text_sub, body)
assert '{{' not in body, 'unconverted binding left: ' + body[body.find('{{') - 200: body.find('{{') + 60]

# 9. leftovers
body = re.sub(r'\shint-placeholder-val="[^"]*"', '', body)

# 10. loader starts visible (the static HTML is painted before app.js runs)
body = re.sub(r'(data-ref="loader"[^>]*style="[^"]*?)display:none', r'\1display:flex', body)
# the 3D stage stays invisible until the first laid-out frame — avoids a flash of the flat page
body = re.sub(r'(data-ref="world"[^>]*style=")', r'\1visibility:hidden;', body)

# 11. the loader overlay is the last thing in the root; move it to the top so it is painted with the
#     first chunk of HTML on slow connections (it is position:fixed, so its DOM position is otherwise irrelevant)
li = body.find('<div data-ref="loader"')
depth, j = 0, li
for m in re.finditer(r'<(/?)div\b', body[li:]):
    depth += -1 if m.group(1) else 1
    if depth == 0:
        j = li + body[li + m.start():].find('>') + m.start() + 1
        break
loader_html = body[li:j]
body = body[:li] + body[j:]
root_open = re.search(r'<div data-ref="root"[^>]*>', body)
body = body[:root_open.end()] + '\n' + loader_html + body[root_open.end():]

body = body.strip()

# ---------------------------------------------------------------- head / html
title = re.search(r'<title>(.*?)</title>', tpl, re.S).group(1)
desc = re.search(r'<meta name="description" content="([^"]*)"', tpl).group(1)

head_css = (
    'html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}'
    '[data-if][hidden]{display:none!important}'
    + page_css + ''.join(font_faces_css) + pseudo_css
)
preload_links = '\n'.join(
    f'<link rel="preload" href="{p}" as="font" type="font/woff2" crossorigin>' for p in font_preloads)

html_out = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#070605">
{preload_links}
<script defer src="assets/app.js"></script>
<style>{head_css}</style>
<noscript><style>[data-ref="loader"]{{display:none!important}}[data-ref="world"]{{visibility:visible!important}}</style></noscript>
</head>
<body>
<div id="dc-root"><div class="sc-host">
{body}
</div></div>
<script>window.C2W_CONFIG={json.dumps(props)};</script>
</body>
</html>
'''
open(f'{OUT}/index.html', 'w', encoding='utf-8').write(html_out)
print(f'  html index.html {len(html_out.encode())//1024} KB')

# ---------------------------------------------------------------- app.js bundle
esbuild = os.path.join(ROOT, 'node_modules', '.bin', 'esbuild')
if not os.path.exists(esbuild):
    subprocess.check_call(['npm', 'install', '--no-audit', '--no-fund', 'three@0.184.0', 'esbuild@0.24.2'], cwd=ROOT)
subprocess.check_call([
    esbuild, os.path.join(ROOT, 'src', 'app.js'), '--bundle', '--minify', '--format=iife',
    '--target=es2020', '--legal-comments=none', f'--outfile={OUT}/assets/app.js'])
print(f'  js   assets/app.js {os.path.getsize(f"{OUT}/assets/app.js")//1024} KB')

# static extras
for extra in ['.nojekyll']:
    open(f'{OUT}/{extra}', 'a').close()
print('done ->', OUT)
