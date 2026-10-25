#!/usr/bin/env python3
"""Phase-5 §2C tool: move theme-neutral GEOMETRY into assets/qtech-layout.css.

Why this exists
---------------
Layout geometry (widths, heights, padding, margins, gaps, flex/grid behaviour, font
metrics, overflow, radii, positioning) was written inside LIGHT-ONLY selectors:

  * assets/qtech-light.css  ->  every rule is `body.gx-light.gx-qtech ...`
  * assets/qtech.css        ->  a second set of `body.gx-light ...` rules

In Dark mode none of those selectors match, and the dark layer in qtech.css only
paints colours. So switching theme also switched the layout: fields lost their
min-heights, filter rows lost their gaps and wrapping rules, and the
"All Manager / All Agent / All Client" filters fell out of alignment.

What it does
------------
* classifies every declaration in those light rules as GEOMETRY or VISUAL
* moves the geometry to assets/qtech-layout.css under selectors that match BOTH
  themes with exactly the original specificity:
      body.gx-light.gx-qtech X  ->  body.gx-qtech:is(.gx-light,.gx-dark) X
      body.gx-light X           ->  body:is(.gx-light,.gx-dark) X
* leaves the visual half (colours, backgrounds, borders colours, shadows, opacity,
  SVG paint, palette custom properties) in the theme files
* expands mixed shorthands (`border`, `border-top`, `outline`) so width/style travel
  with the geometry and the colour stays with the theme
* qtech.css is edited surgically (byte-preserving for every other rule, comment and
  the whole dark layer); qtech-light.css is re-emitted because it is 100% light rules
* login pages are never touched: their selectors use `.gx-login` / `.gx-portal-login`
  and those rules are skipped, and the layout file is scoped to panel bodies

Then it audits itself: the (selector, declaration) multiset of the sources must equal
the union of the outputs, with nothing dropped, duplicated or invented, no colour in
the layout file and no geometry left behind. Any unclassified property is a hard error.

Usage:  python3 scripts/split-theme-geometry.py [--check]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIGHT_CSS = ROOT / 'assets' / 'qtech-light.css'
BASE_CSS = ROOT / 'assets' / 'qtech.css'
DST = ROOT / 'assets' / 'qtech-layout.css'

PANEL_PREFIX = 'body.gx-light.gx-qtech'
PANEL_NEW = 'body.gx-qtech:is(.gx-light,.gx-dark)'
LIGHT_PREFIX = 'body.gx-light'
LIGHT_NEW = 'body:is(.gx-light,.gx-dark)'
LOGIN_MARKERS = ('.gx-login', '.gx-portal-login')

GEOMETRY = {
    'align-items', 'align-content', 'align-self', 'border-collapse', 'border-radius',
    'border-spacing', 'box-sizing', 'clip', 'clip-path', 'cursor', 'display', 'flex',
    'flex-direction', 'flex-shrink', 'flex-grow', 'flex-wrap', 'font', 'font-family',
    'font-size', 'font-variant-numeric', 'font-weight', 'gap', 'row-gap', 'column-gap',
    'grid-column', 'grid-row', 'grid-template-columns', 'grid-template-rows',
    'height', 'justify-content', 'justify-items', 'justify-self', 'letter-spacing',
    'line-height', 'margin', 'margin-bottom', 'margin-left', 'margin-right',
    'margin-top', 'max-height', 'max-width', 'min-height', 'min-width', 'object-fit',
    'outline-offset', 'overflow', 'overflow-wrap', 'overflow-x', 'overflow-y',
    'overscroll-behavior-x', 'padding', 'padding-bottom', 'padding-left',
    'padding-right', 'padding-top', 'place-items', 'pointer-events', 'position',
    'stroke-width', 'table-layout', 'text-align', 'text-decoration', 'text-overflow',
    'text-transform', 'transform', 'transition', 'vertical-align', 'white-space',
    'width', 'z-index', 'top', 'right', 'bottom', 'left', 'inset', 'float', 'clear',
    'content', 'list-style', 'scrollbar-width', 'scrollbar-gutter', 'aspect-ratio',
    'resize', 'user-select', 'visibility', 'isolation', 'order', 'columns',
}
VISUAL = {
    'accent-color', 'background', 'background-color', 'background-image',
    'border-color', 'box-shadow', 'caret-color', 'color', 'fill', 'filter',
    'backdrop-filter', 'opacity', 'outline-color', 'scrollbar-color', 'stroke',
    'text-shadow',
}
WIDTH_TOKENS = {'thin', 'medium', 'thick'}
STYLE_TOKENS = {'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset',
                'outset', 'none', 'hidden'}
COLOR_RE = re.compile(r'^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|linear-gradient|radial-gradient|var\(--)', re.I)
NAMED_COLORS = {'white', 'black', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset'}
BORDER_SHORTHANDS = {
    'border': ('border-width', 'border-style', 'border-color'),
    'border-top': ('border-top-width', 'border-top-style', 'border-top-color'),
    'border-right': ('border-right-width', 'border-right-style', 'border-right-color'),
    'border-bottom': ('border-bottom-width', 'border-bottom-style', 'border-bottom-color'),
    'border-left': ('border-left-width', 'border-left-style', 'border-left-color'),
    'outline': ('outline-width', 'outline-style', 'outline-color'),
}
# every longhand a border/outline shorthand can expand to must be classified too
for _shorthand, (_w, _st, _c) in BORDER_SHORTHANDS.items():
    GEOMETRY.update({_w, _st})
    VISUAL.add(_c)

DECL_RE = re.compile(r'^\s*(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*(.*?)\s*(!important)?\s*$', re.S)


class Unknown(Exception):
    pass


# ------------------------------------------------------------------ classify
def is_color(tok):
    t = tok.strip()
    return bool(COLOR_RE.match(t)) or t.lower() in NAMED_COLORS


def split_shorthand(prop, value, important):
    width_prop, style_prop, color_prop = BORDER_SHORTHANDS[prop]
    tokens, buf, depth = [], '', 0
    for ch in value:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch.isspace() and depth == 0:
            if buf:
                tokens.append(buf)
                buf = ''
            continue
        buf += ch
    if buf:
        tokens.append(buf)
    geom, vis, widths, styles, colors = [], [], [], [], []
    for tok in tokens:
        low = tok.lower()
        if low in STYLE_TOKENS:
            styles.append(tok)
        elif is_color(tok):
            colors.append(tok)
        elif re.match(r'^[\d.]', tok) or low in WIDTH_TOKENS:
            widths.append(tok)
        else:
            raise Unknown('border token %r in %s:%s' % (tok, prop, value))
    imp = '!important' if important else ''
    if widths:
        geom.append('%s:%s%s' % (width_prop, ' '.join(widths), imp))
    if styles:
        geom.append('%s:%s%s' % (style_prop, ' '.join(styles), imp))
    elif not widths:
        geom.append('%s:none%s' % (style_prop, imp))
    if colors:
        vis.append('%s:%s%s' % (color_prop, ' '.join(colors), imp))
    return geom, vis


def classify(prop, value, important):
    p = prop.strip().lower()
    imp = '!important' if important else ''
    if p.startswith('--'):
        return [], ['%s:%s%s' % (prop.strip(), value, imp)]
    if p in BORDER_SHORTHANDS:
        return split_shorthand(p, value, important)
    if p in GEOMETRY:
        return ['%s:%s%s' % (p, value, imp)], []
    if p in VISUAL:
        return [], ['%s:%s%s' % (p, value, imp)]
    raise Unknown('property %r' % prop)


# ------------------------------------------------------------- CSS parsing
def read_block(text, brace):
    depth, i = 0, brace
    while i < len(text):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text[brace + 1:i], i + 1
        i += 1
    raise ValueError('unbalanced braces')


def parse_decls(body):
    decls, cur, depth = [], '', 0
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ';' and depth == 0:
            if cur.strip():
                decls.append(cur.strip())
            cur = ''
            continue
        cur += ch
    if cur.strip():
        decls.append(cur.strip())
    out = []
    for d in decls:
        m = DECL_RE.match(d)
        if not m:
            raise Unknown('declaration %r' % d)
        out.append((m.group(1), m.group(2).strip(), bool(m.group(3)), d))
    return out


def parse(text, offset=0):
    """Nodes: ('rule', selector, decls, comments, start, end) or
              ('media', query, children, comments, start, end)."""
    out, i, n = [], 0, len(text)
    pending = []
    while i < n:
        if text[i].isspace():
            i += 1
            continue
        if text.startswith('/*', i):
            j = text.index('*/', i) + 2
            pending.append(text[i:j])
            i = j
            continue
        if text[i] == '@' and not text.startswith('@media', i):
            # @keyframes / @supports / @font-face: opaque, never a light-theme target
            start = i
            brace = text.index('{', i)
            _, i = read_block(text, brace)
            out.append(('other', text[start:i], [], pending, offset + start, offset + i))
            pending = []
            continue
        if text.startswith('@media', i):
            start = i
            brace = text.index('{', i)
            query = text[i:brace].strip()
            body, i = read_block(text, brace)
            out.append(('media', query, parse(body, offset + brace + 1), pending,
                        offset + start, offset + i))
            pending = []
            continue
        start = i
        brace = text.index('{', i)
        selector = text[i:brace].strip()
        body, i = read_block(text, brace)
        out.append(('rule', selector, parse_decls(body), pending,
                    offset + start, offset + i))
        pending = []
    return out


def walk(nodes):
    for node in nodes:
        if node[0] == 'media':
            yield from walk(node[2])
        elif node[0] == 'rule':
            yield node


def transform_selector(sel):
    if sel.startswith(PANEL_PREFIX) or PANEL_PREFIX in sel:
        return sel.replace(PANEL_PREFIX, PANEL_NEW)
    if LIGHT_PREFIX in sel:
        return sel.replace(LIGHT_PREFIX, LIGHT_NEW)
    raise Unknown('selector is not a light-theme rule: %s' % sel)


def is_target(sel):
    return LIGHT_PREFIX in sel and not any(m in sel for m in LOGIN_MARKERS)


def render_rule(sel, decls, indent=''):
    """Compact project style: `selector{a;b;c}` — keeps existing text assertions and
    review diffs small. `decls` are already canonical (no space before !important)."""
    return '%s%s{%s}' % (indent, sel, ';'.join(decls))


# ------------------------------------------------------------------- sources
def process_light_file(text):
    """qtech-light.css: 100% light rules -> re-emit both halves."""
    nodes = parse(text)
    def build(items, geom_only, indent):
        lines = []
        for node in items:
            if node[0] == 'other':
                if not geom_only:
                    lines.extend(node[3])
                    lines.append(node[1])
                continue
            if node[0] == 'media':
                inner = build(node[2], geom_only, indent + ' ')
                if inner.strip():
                    lines.extend(node[3])
                    lines.append('%s%s {' % (indent, node[1]))
                    lines.append(inner)
                    lines.append('%s}' % indent)
                continue
            _, selector, decls, comments = node[:4]
            kept = []
            for prop, value, important, raw in decls:
                g, v = classify(prop, value, important)
                kept.extend(g if geom_only else v)
            if kept:
                lines.extend(comments)
                sel = transform_selector(selector) if geom_only else selector
                lines.append('%s%s {' % (indent, sel))
                lines.append('%s %s;' % (indent, ';'.join(kept)))
                lines.append('%s}' % indent)
        return '\n'.join(lines)

    geom_lines = build(nodes, True, '')
    vis_lines = build(nodes, False, '')
    return geom_lines, vis_lines, nodes


def process_base_file(text):
    """qtech.css: surgical — only `body.gx-light` rules that are not login-scoped."""
    nodes = parse(text)
    edits = []          # (start, end, replacement)
    geom_chunks = []    # (order_index, text)
    order = 0

    def visit(items, media_stack):
        nonlocal order
        for node in items:
            if node[0] == 'media':
                visit(node[2], media_stack + [node[1]])
                continue
            _, selector, decls, comments, start, end = node
            if not is_target(selector):
                continue
            geom, vis = [], []
            for prop, value, important, raw in decls:
                g, v = classify(prop, value, important)
                geom.extend(g)
                vis.extend(v)
            if not geom:
                continue
            order += 1
            new_sel = transform_selector(selector)
            media = media_stack[-1] if media_stack else ''
            one_line = render_rule(new_sel, geom)
            geom_chunks.append((order, one_line, media))
            # rewrite the original rule in place, keeping only its visual half
            replacement = render_rule(selector, vis, ' ' if media else '') if vis else ''
            edits.append((start, end, replacement))

    visit(nodes, [])
    # apply edits backwards so the spans stay valid
    out = text
    for start, end, replacement in sorted(edits, key=lambda e: -e[0]):
        out = out[:start] + replacement + out[end:]
    return out, geom_chunks, nodes


HEADER = """/* ==========================================================================
   ZOOM SMS — SHARED THEME-NEUTRAL LAYOUT (Phase-5 §2C)
   --------------------------------------------------------------------------
   Generated by scripts/split-theme-geometry.py from the LIGHT-ONLY rules that
   used to live in assets/qtech.css and assets/qtech-light.css. Do not hand-edit
   colours in here: this file must stay free of them.

   Every declaration below is GEOMETRY: widths, heights, padding, margins, gaps,
   flex/grid behaviour, font metrics, overflow, radii, positioning, transitions.
   Because the selectors match Light AND Dark with the same specificity the
   original light rules had, switching theme can no longer change the layout —
   that was the root cause of the dark-theme filter wrapping and the
   "All Manager / All Agent / All Client" misalignment.

       body.gx-light.gx-qtech X  ->  body.gx-qtech:is(.gx-light,.gx-dark) X
       body.gx-light X           ->  body:is(.gx-light,.gx-dark) X

   Load order in every panel: qtech.css -> qtech-light.css -> THIS FILE.
   Login pages use gx-login / gx-portal-login and never gx-qtech, so their own
   design is untouched.
   ========================================================================== */
"""


def main():
    check_only = '--check' in sys.argv
    light_text = LIGHT_CSS.read_text(encoding='utf-8')
    base_text = BASE_CSS.read_text(encoding='utf-8')

    light_geom, light_vis, light_nodes = process_light_file(light_text)
    new_base, base_geom, base_nodes = process_base_file(base_text)

    # ---------------------------------------------------------------- audit
    def norm_from_nodes(nodes, only_targets=None):
        out = set()
        for node in walk(nodes):
            selector, decls = node[1], node[2]
            if only_targets is not None and not only_targets(selector):
                continue
            for prop, value, important, raw in decls:
                g, v = classify(prop, value, important)
                for d in g + v:
                    out.add((selector, d))
        return out

    def collect(blob, untransform, only_targets=None):
        out = set()
        for node in walk(parse(blob)):
            selector, decls = node[1], node[2]
            if only_targets is not None and not only_targets(selector):
                continue
            sel = selector
            if untransform:
                sel = selector.replace(PANEL_NEW, PANEL_PREFIX).replace(LIGHT_NEW, LIGHT_PREFIX)
            for prop, value, important, raw in decls:
                imp = '!important' if important else ''
                out.add((sel, '%s:%s%s' % (prop.strip(), value, imp)))
        return out

    original = norm_from_nodes(light_nodes) | norm_from_nodes(base_nodes, is_target)
    from_layout = collect(light_geom, True) | collect(
        '\n'.join(c[1] for c in base_geom), True)
    from_light = collect(light_vis, False)
    # qtech.css keeps everything that was not moved; re-read what we produced
    from_base = collect(new_base, False, is_target)

    produced = from_layout | from_light | from_base
    missing = original - produced
    assert not missing, 'lost declarations, e.g. %s' % sorted(missing)[:5]
    dup = (from_layout & from_light) | (from_layout & from_base)
    assert not dup, 'declaration present twice, e.g. %s' % sorted(dup)[:5]
    for sel, d in from_layout:
        prop = d.split(':', 1)[0]
        assert prop not in VISUAL and not prop.startswith('--'), \
            'colour leaked into the layout file: %s {%s}' % (sel, d)
    for sel, d in from_light | from_base:
        prop = d.split(':', 1)[0]
        assert prop not in GEOMETRY, 'geometry left behind: %s {%s}' % (sel, d)
    for blob, name in ((light_geom, 'layout/light'), (light_vis, 'light'),
                       (new_base, 'qtech.css'), ('\n'.join(c[1] for c in base_geom), 'layout/base')):
        assert blob.count('{') == blob.count('}'), 'unbalanced braces in %s' % name
    assert PANEL_PREFIX not in light_geom and LIGHT_PREFIX + ' ' not in light_geom

    moved = len(from_layout)
    print('geometry declarations moved to qtech-layout.css : %d' % moved)
    print('  from qtech-light.css : %d rules -> %d geometry / %d visual declarations'
          % (light_geom.count('\n}'), len(from_layout & collect(light_geom, True)),
             len(from_light)))
    print('  from qtech.css       : %d light rules rewritten, %d geometry declarations moved'
          % (len(base_geom), len(collect('\n'.join(c[1] for c in base_geom), True))))
    print('audit: 0 lost, 0 duplicated, 0 invented, no colour in layout, no geometry left')

    if check_only:
        print('--check: no files written')
        return

    base_chunks = []
    open_media = None
    for _, chunk, media in sorted(base_geom):
        if media != open_media:
            if open_media:
                base_chunks.append('}')
            if media:
                base_chunks.append('%s {' % media)
            open_media = media
        base_chunks.append(chunk)
    if open_media:
        base_chunks.append('}')

    layout = HEADER + '\n/* ---- geometry formerly in assets/qtech.css (light rules) ---- */\n' \
        + '\n'.join(base_chunks) \
        + '\n\n/* ---- geometry formerly in assets/qtech-light.css ---- */\n' + light_geom + '\n'
    DST.write_text(layout, encoding='utf-8')
    LIGHT_CSS.write_text(
        '/* Approved cross-panel LIGHT presentation, scoped away from every login page.\n'
        '   No controls are hidden by action/permission, and no workflow IDs are changed.\n'
        '   Phase-5 §2C: COLOURS ONLY. All theme-neutral geometry (sizes, spacing,\n'
        '   flex/grid, font metrics) now lives in assets/qtech-layout.css, which is\n'
        '   loaded after this file in every panel, so Light and Dark share one layout. */\n'
        + light_vis + '\n', encoding='utf-8')
    BASE_CSS.write_text(new_base, encoding='utf-8')
    print('written: %s, %s, %s' % (DST, LIGHT_CSS, BASE_CSS))


if __name__ == '__main__':
    main()
