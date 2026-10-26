'use strict';
/* ============================================================================
   ZOOM SMS — dark + gold theme generator
   ----------------------------------------------------------------------------
   The app already ships a complete dark theme: 567 rules scoped to `.gx-dark`
   across five stylesheets. Those rules are correct in STRUCTURE but are painted
   in a cool navy/cyan palette (#0b1220 / #38bdf8).

   The reference design is warm near-black with a gold accent. Rather than
   hand-overriding 567 rules (fragile, easy to miss some), this script parses
   the shipped stylesheets, pulls out every `.gx-dark` rule, replaces its colours
   through a single mapping table, and emits one override stylesheet.

   Guarantees:
     * Originals are never modified. This only ever appends a new file.
     * Coverage is complete by construction — a colour cannot be missed, because
       every rule that mentions .gx-dark is carried over and re-mapped.
     * The dark treatment is applied to ALL theme roots (light, dark, login,
       portal-login) so the design is the default everywhere, not a toggle a
       user has to find.
     * Specificity is raised by one element (`html ` prefix) and !important is
       preserved, so the emitted rules win the cascade against both qtech.css
       and qtech-light.css when loaded last.

   Run: node tools/build-zoom-theme.js
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const SOURCES = [
  'qtech.css',
  'qtech-layout.css',
  'qtech-ds.css',
  'qtech-chrome.css',
  'qtech-sidebar-unify.css',
  /* The login pages are styled by their own sheet, which barely mentions
     .gx-dark (4 rules) but carries 118 rules keyed to .gx-login. Matching only
     on .gx-dark left the entire login page on its original navy palette. */
  'qtech-login-anim.css',
];
/* A rule qualifies if it is scoped to ANY theme root, not just the dark one. */
const ROOT_CLASS_RE = /gx-dark|gx-login|gx-portal-login/;

/* ---------------------------------------------------------------------------
   COLOUR MAPPING
   Source values are the navy/cyan dark theme actually shipped.
   Target values are measured from the supplied login reference (image-1.png):
     background  near-black, warm olive cast   #0b0b0b #171614 #1c1910 #080808
     button      gold gradient, hue 45deg      #d9b543 -> #e9c869
     body text   near-white                    #fcfcfc
     muted text  mid grey                      #8b8b8b
   ------------------------------------------------------------------------- */
const MAP = {
  /* --- surfaces: navy -> warm near-black --------------------------------- */
  '#0b1220': '#0a0908', // page background, sidebar gradient
  '#0f172a': '#100e0c', // background level 2
  '#111c2e': '#141210', // panels, cards, rows
  '#0f1a2b': '#12100e', // card head, toolbar, topbar
  '#16233a': '#1c1a16', // hover state
  '#1d2c42': '#221f1a', // table cell borders
  '#24344d': '#2a2621', // borders
  '#31445f': '#3a352c', // strong borders, input borders
  '#334155': '#2e2a23',
  '#111827': '#141210',
  '#0a101c': '#080706', // sidebar gradient end
  '#0d1728': '#0d0b09', // sidebar gradient start

  /* --- text ramp: cool grey -> warm grey --------------------------------- */
  '#e2e8f0': '#f2efe8', // primary text
  '#cbd5e1': '#cfc9be', // secondary text
  '#94a3b8': '#9a9287', // muted
  '#64748b': '#7d7568', // placeholder / dim
  '#475569': '#5c554b',
  '#c5d0e6': '#c9c3b7',

  /* --- accent: cyan/blue -> gold (hue 45deg) ----------------------------- */
  '#38bdf8': '#e0bc4f', // primary accent
  '#0ea5e9': '#d4af43', // accent 2
  '#7dd3fc': '#e9c869', // accent light (mgr)
  '#22d3ee': '#d9b543', // cyan (cli)
  '#0284c7': '#bf9a33',
  '#2563eb': '#b8912f', // blue
  '#1d4ed8': '#a8842a', // blue dark
  '#1e40af': '#967623', // blue darker
  '#3b82f6': '#c9a63c',
  '#60a5fa': '#d9b543',
  '#93c5fd': '#e9c869',
  '#818cf8': '#c9a63c', // indigo
  '#a5b4fc': '#ddc06a',
  '#0088cc': '#c9a63c', // legacy blues
  '#0054b8': '#967623',
  '#007acc': '#c9a63c',
  '#0068ad': '#b8912f',

  /* --- accent tints (soft backgrounds behind accent text) ---------------- */
  '#eff6ff': '#1e1a10',
  '#dbeafe': '#241f14',
  '#bfdbfe': '#2b2519',
  '#eaf1ff': '#1e1a10',
  '#e0f2fe': '#1e1a10',
  '#cffafe': '#1e1a10',

  /* --- semantic: kept, only nudged for the warmer canvas ----------------- */
  '#f87171': '#e8876b', // danger, softened off pure red
  '#fca5a5': '#f0a98f',
  '#fecaca': '#3a1f18',
  '#b42318': '#e8876b',
  '#991b1b': '#8a3a2a',
  '#4ade80': '#6fcf7f', // ok
  '#bbf7d0': '#1d2e1f',
  '#166534': '#4f9a5c',
  '#f0fdf4': '#131a14',
  '#fbbf24': '#e0a33e', // amber, pushed orange so it reads apart from gold
  '#fcd34d': '#e8b955',
  '#fde68a': '#f2d79a',
  '#92400e': '#b8791f',
  '#7ea6c8': '#b09a6a', // nav icon stroke

  /* --- neutral whites used as text on dark surfaces ---------------------- */
  '#f8fafc': '#f5f2ec',
  '#f1f5f9': '#f0ece4',
};

/* rgb()/rgba() forms of the same palette, used by a few rules. */
const RGB_MAP = [
  [/rgba?\(\s*15\s*,\s*23\s*,\s*42\s*/gi, 'rgba(16,14,12'],   // #0f172a
  [/rgba?\(\s*11\s*,\s*18\s*,\s*32\s*/gi, 'rgba(10,9,8'],     // #0b1220
  [/rgba?\(\s*17\s*,\s*28\s*,\s*46\s*/gi, 'rgba(20,18,16'],   // #111c2e
  [/rgba?\(\s*56\s*,\s*189\s*,\s*248\s*/gi, 'rgba(224,188,79'], // #38bdf8
  [/rgba?\(\s*37\s*,\s*99\s*,\s*235\s*/gi, 'rgba(184,145,47'],  // #2563eb
];

/* ---------------------------------------------------------------------------
   CSS rule extraction
   Uses a real CSS parser (postcss) rather than hand-rolled brace counting.
   An earlier hand-written walker emitted media-query rules without their
   @media wrapper, which unbalanced the output. postcss gives the enclosing
   at-rule chain for each rule, so nesting survives intact.
   ------------------------------------------------------------------------- */
const postcss = require('postcss');

function extractRules(css, file) {
  const out = [];
  let root;
  try {
    root = postcss.parse(css, { from: file });
  } catch (e) {
    console.warn('  ! could not parse ' + file + ': ' + e.message);
    return out;
  }
  root.walkRules((rule) => {
    if (!ROOT_CLASS_RE.test(rule.selector)) return;
    if (!rule.nodes || !rule.nodes.length) return;
    /* Enclosing at-rule chain, outermost first, so a rule inside
       `@media (max-width:900px)` is re-emitted inside the same query. */
    const media = [];
    let p = rule.parent;
    while (p && p.type !== 'root') {
      if (p.type === 'atrule') media.unshift('@' + p.name + (p.params ? ' ' + p.params : ''));
      p = p.parent;
    }
    const body = rule.nodes.map((n) => n.toString()).join(';');
    out.push({ file, sel: rule.selector, body, media });
  });
  return out;
}

/* ---------------------------------------------------------------------------
   Re-target a selector:
     body.gx-dark .card  ->  html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) .card
   - `.gx-dark` is widened so the treatment is the default in every theme state.
   - the `html ` prefix adds one element of specificity, which (with !important
     preserved) lets the emitted sheet beat both qtech.css and qtech-light.css.
   ------------------------------------------------------------------------- */
const ALL_ROOTS = ':is(.gx-dark,.gx-light,.gx-login,.gx-portal-login)';

/* Substitute `.gx-dark` only at paren depth 0.
   Some shipped selectors already contain a group such as
   `:is(.gx-light,.gx-dark)`; substituting inside the parentheses produced
   nested `:is(:is(...))` and corrupted the selector. */
function replaceTopLevel(sel, re, rep) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(') { depth++; out += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += ch; continue; }
    if (depth === 0 && (i === 0 || /[\s,>+~]/.test(sel[i - 1]))) {
      const rest = sel.slice(i);
      const m = rest.match(re);
      if (m && m.index === 0) {
        /* Expand $1..$n from the match. The caller passes replacement strings
           such as `$1:is(...)`; without this they would be emitted verbatim
           and produce an invalid selector containing a literal `$1`. */
        out += rep.replace(/\$(\d)/g, (_, d) => m[Number(d)] || '');
        i += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/* Prefix that raises a selector above the app's own theme rules.
   Specificity, not source order, is what decides these fights: qtech-light.css
   uses `body.gx-light.gx-qtech` (0,2,1) and qtech-ds.css reaches
   `html body.gx-qtech.qd:is(.gx-light,.gx-dark)` (0,3,2). A plain `html body:…`
   prefix is only (0,1,2) and loses to both, which is exactly what happened on
   the first pass — the admin panel stayed light despite the sheet loading last.
   `html:root` contributes one extra pseudo-class AND one extra element, taking
   every emitted selector one notch above its source rule. */
const SCOPE = 'html:root ';

function retarget(sel) {
  let out = sel;
  // `html.gx-dark` / `body.gx-dark` / `:root.gx-dark` -> widened root
  out = replaceTopLevel(out, /^(html|body|:root)\.gx-dark/, `$1${ALL_ROOTS}`);
  // bare `.gx-dark` used as a root class
  out = replaceTopLevel(out, /^\.gx-dark(?![\w-])/, ALL_ROOTS);
  if (/^html/.test(out)) out = 'html:root' + out.slice(4);
  else out = SCOPE + out;
  return out;
}

/* ---------------------------------------------------------------------------
   SYSTEMATIC WARMING FALLBACK
   The hand-written MAP above names the colours the dark theme uses most, but
   the stylesheets contain ~99 further cool-toned values (navy surfaces, indigo
   and violet accents) that no hand list can be expected to catch — and a single
   survivor is enough to make a whole panel read blue. #101c33 alone, left in a
   body gradient, tinted the entire login page.

   So after the explicit map runs, every remaining colour in the blue / indigo /
   violet band (hue 170-320) is converted on the basis of what it is FOR:

     saturated + mid/light  -> gold accent, lightness preserved
     dark / desaturated     -> warm near-black surface ramp
     green / red / orange   -> untouched: those carry meaning (ok, danger, warn)

   Lightness is preserved in both branches so contrast relationships survive.
   ------------------------------------------------------------------------- */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

/* Warm surface ramp, indexed by lightness. Matches the palette measured from
   the reference: near-black with a faint warm cast, never blue. */
const RAMP = [
  [0.045, '#050505'], [0.070, '#080706'], [0.100, '#0a0908'],
  [0.130, '#0d0b09'], [0.165, '#100e0c'], [0.200, '#141210'],
  [0.240, '#181614'], [0.290, '#1c1a16'], [0.340, '#221f1a'],
  [0.400, '#2a2621'], [0.480, '#322e27'], [0.560, '#3a352c'],
  [0.650, '#5c554b'], [0.740, '#7d7568'], [0.820, '#9a9287'],
  [0.900, '#c9c3b7'], [1.010, '#f2efe8'],
];

function warmify(hex) {
  const { h, s, l } = hexToHsl(hex);
  /* Leave warm hues and semantic reds/greens/oranges alone — they carry meaning. */
  if (h < 170 || h > 320) return null;
  /* A saturated mid/light blue is doing accent work: answer with gold. */
  if (s > 0.40 && l > 0.26) {
    if (l < 0.48) return '#b8912f';
    if (l < 0.60) return '#c9a63c';
    if (l < 0.72) return '#d4af43';
    if (l < 0.84) return '#e0bc4f';
    return '#e9c869';
  }
  /* Otherwise it is surface or text: walk the warm ramp by lightness. */
  for (const [lim, val] of RAMP) if (l < lim) return val;
  return '#f2efe8';
}

function remap(body) {
  let out = body;
  for (const [from, to] of Object.entries(MAP)) {
    if (out.toLowerCase().includes(from.toLowerCase())) {
      out = out.replace(new RegExp(from.replace(/[#]/g, '#'), 'gi'), to);
    }
  }
  for (const [re, to] of RGB_MAP) out = out.replace(re, to);
  /* Fallback pass: anything still cool becomes warm. */
  out = out.replace(/#[0-9a-fA-F]{6}\b/g, (m) => {
    const hex = m.toLowerCase();
    if (MAP[hex]) return MAP[hex];       // already handled
    return warmify(hex) || m;
  });
  /* The same pass for rgba(r,g,b,a). The login backdrop is built almost
     entirely from translucent navy — rgba(20,24,52,.72) and friends — which a
     hex-only pass cannot see. Alpha is preserved so the layering still reads. */
  out = out.replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/gi,
    (m, r, g, b, a) => {
      const hex = '#' + [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
      if (MAP[hex]) return swapRgba(m, MAP[hex], a);
      const warm = warmify(hex);
      return warm ? swapRgba(m, warm, a) : m;
    });
  return out;
}

/* Rewrite an rgba()/rgb() call to a new colour, keeping the original alpha. */
function swapRgba(original, hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (alpha === undefined) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ============================== build ==================================== */
const all = [];
for (const f of SOURCES) {
  const p = path.join(ASSETS, f);
  if (!fs.existsSync(p)) { console.warn('  skip (missing): ' + f); continue; }
  const css = fs.readFileSync(p, 'utf8');
  const r = extractRules(css, f);
  all.push(...r);
  console.log('  %s: %d gx-dark rules', f.padEnd(26), r.length);
}

// dedupe identical (selector, body) pairs
const seen = new Set();
const uniq = [];
for (const r of all) {
  const key = r.sel + '||' + r.body;
  if (seen.has(key)) continue;
  seen.add(key);
  uniq.push(r);
}

const out = [];
out.push('/* ============================================================================');
out.push('   ZOOM SMS — DARK + GOLD THEME');
out.push('   ----------------------------------------------------------------------------');
out.push('   GENERATED FILE — do not edit by hand.');
out.push('   Regenerate with:  node tools/build-zoom-theme.js');
out.push('');
out.push('   Produced from the ' + uniq.length + ' rules that the shipped stylesheets already');
out.push('   scope to .gx-dark, with every colour re-mapped from the navy/cyan palette to');
out.push('   the warm near-black + gold palette measured from the supplied design reference:');
out.push('');
out.push('     page background   #0a0908  (warm near-black)');
out.push('     panel / card      #141210');
out.push('     border            #2a2621');
out.push('     primary text      #f2efe8');
out.push('     muted text        #9a9287');
out.push('     accent (gold)     #e0bc4f   hover #e9c869   pressed #967623');
out.push('');
out.push('   Loading order matters: this file must come AFTER qtech-light.css,');
out.push('   qtech-layout.css and /branding/runtime.css so it wins the cascade.');
out.push('   ========================================================================== */');
out.push('');
out.push('/* ---------------------------------------------------------------------------');
out.push('   TOKENS');
out.push('   Declared on every theme root so the design is the DEFAULT in the admin,');
out.push('   manager, agent, client, management, payment, panel-sharing and branding');
out.push('   panels and on all five login pages — not a toggle the user must find.');
out.push('   ------------------------------------------------------------------------- */');
out.push('html:root' + ALL_ROOTS + ',');
out.push(SCOPE + 'body' + ALL_ROOTS + ' {');
out.push('  --bg:#0a0908; --bg2:#100e0c; --panel:#141210; --panel2:#12100e; --row:#141210;');
out.push('  --text:#f2efe8; --text-2:#cfc9be; --muted:#9a9287; --text-muted:#9a9287; --ice:#f2efe8;');
out.push('  --border:#2a2621; --border2:#3a352c;');
out.push('  --blue:#e0bc4f; --accent:#e0bc4f; --accent2:#d4af43;');
out.push('  --sidebar:#0a0908; --topbar:#12100e;');
out.push('  --red:#e8876b; --danger:#e8876b; --green:#6fcf7f; --ok:#6fcf7f;');
out.push('  --amber:#e0a33e; --indigo:#c9a63c; --sky:#e0bc4f; --cyan:#d9b543;');
out.push('  --mgr:#e9c869; --agt:#e0bc4f; --cli:#d9b543;');
out.push('  --grad:linear-gradient(90deg,#d4af43,#e9c869);');
out.push('  --shadow:0 1px 3px rgba(0,0,0,.45);');
out.push('  color-scheme:dark;');
out.push('}');
out.push('');
out.push('/* Base canvas + text for every theme state. */');
out.push('html:root' + ALL_ROOTS + ' { background:#0a0908 !important; }');
out.push(SCOPE + 'body' + ALL_ROOTS + ' { background:#0a0908 !important; color:#f2efe8 !important; }');
out.push('');

// group by media wrapper, emitting ungrouped rules first
const plain = uniq.filter((r) => !r.media.length);
const medias = uniq.filter((r) => r.media.length);

out.push('/* ---------------------------------------------------------------------------');
out.push('   RE-MAPPED COMPONENT RULES (' + plain.length + ' unwrapped)');
out.push('   ------------------------------------------------------------------------- */');
for (const r of plain) {
  out.push(retarget(r.sel) + ' {' + remap(r.body) + '}');
}

if (medias.length) {
  const groups = new Map();
  for (const r of medias) {
    const k = r.media.join(' && ');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  out.push('');
  out.push('/* ---------------------------------------------------------------------------');
  out.push('   Same rules inside their original media queries (' + medias.length + ')');
  out.push('   ------------------------------------------------------------------------- */');
  for (const [header, list] of groups) {
    out.push(header + ' {');
    for (const r of list) out.push(retarget(r.sel) + ' {' + remap(r.body) + '}');
    out.push('}');
  }
}

/* ---------------------------------------------------------------------------
   HAND-TUNED REFINEMENTS
   The rules above are a mechanical colour swap: structurally correct, but a
   few states need designing rather than translating. Active navigation, the
   primary button and form focus are the three places a gold theme either
   looks deliberate or looks like a recolour, so they are written out here.
   ------------------------------------------------------------------------- */
const TUNE_RAW = String.raw`
/* ---------------------------------------------------------------------------
   DESIGN-SYSTEM TOKENS (--ds-*)
   The admin, manager, agent, client and management panels are driven by the
   design system in qtech-ds.css, which publishes its palette as --ds-* custom
   properties. That file defines them TWICE: a light set on
   'html body.gx-qtech.qd:is(.gx-light,.gx-dark)' and a dark set on
   'html body.gx-dark.gx-qtech.qd'.

   Because the dark set is keyed to a gx-dark class and the light set is not,
   a light-mode page picked up the light values and stayed light no matter what
   the generic tokens said. These are therefore re-declared explicitly, at the
   same specificity as the design system's own rule and later in the cascade.
   ------------------------------------------------------------------------- */
html:root body.gx-qtech.qd:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) {
  --ds-bg:#0a0908;      --ds-surface:#141210;  --ds-ink:#f2efe8;
  --ds-text:#e2ddd3;    --ds-muted:#9a9287;
  --ds-line:#2a2621;    --ds-line2:#3a352c;
  --ds-brand:#e0bc4f;   --ds-brand-d:#c9a63c;  --ds-brand-t:#241f14;
  --ds-side:#0d0b09;    --ds-side2:#080706;    --ds-side-hi:#1c1a16;
  --ds-s2:#12100e;      --ds-hov:#1c1a16;      --ds-row2:#181614;
  --ds-ok:#6fcf7f;      --ds-warn:#e0a33e;     --ds-bad:#e8876b;
  --ds-icon:#e0bc4f;
  --ds-gbg:#132a1d; --ds-gfg:#6fcf7f;
  --ds-rbg:#33191a; --ds-rfg:#e8876b;
  --ds-abg:#2e2411; --ds-afg:#e8b955;
  --ds-pbg:#1e1a10; --ds-cbg:#132428;
  --accent:#e0bc4f;
  --border:#2a2621; --border2:#3a352c;
  --text:#e2ddd3;   --muted:#9a9287;
  --bg2:#141210;    --row:#141210;
  --ds-sh:0 1px 2px rgba(0,0,0,.45),0 4px 14px rgba(0,0,0,.30);
  color-scheme:dark;
}
/* Panels that are NOT .qd still need the generic tokens pointed at gold. */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) {
  --accent:#e0bc4f; --blue:#e0bc4f; --accent2:#d4af43;
  --bg:#0a0908; --bg2:#100e0c; --panel:#141210; --panel2:#12100e; --row:#141210;
  --text:#f2efe8; --text-2:#cfc9be; --muted:#9a9287; --text-muted:#9a9287;
  --border:#2a2621; --border2:#3a352c;
  --sidebar:#0d0b09; --topbar:#12100e;
  --grad:linear-gradient(90deg,#d4af43,#e9c869);
}

/* ---------------------------------------------------------------------------
   PRIMARY ACTION — the gold button.
   Measured from the reference: the button fill runs along hue 45deg from
   #d4af43 to #e9c869. Its label is dark because gold is a light colour; white
   on gold fails contrast, near-black on gold is comfortably AA.
   ------------------------------------------------------------------------- */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .btn,.btn-primary,button[type=submit],.login-card .btn,.submit-btn,.primary-btn
) {
  background: linear-gradient(90deg,#d4af43 0%,#e9c869 100%) !important;
  border: 1px solid #b8912f !important;
  color: #17140a !important;
  font-weight: 600 !important;
  box-shadow: none !important;
  transition: filter .08s linear !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .btn,.btn-primary,button[type=submit],.login-card .btn,.submit-btn,.primary-btn
):hover { filter: brightness(1.08) !important; }
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .btn,.btn-primary,button[type=submit],.login-card .btn,.submit-btn,.primary-btn
):active { filter: brightness(.93) !important; }

/* The generated sheet above also carries a re-mapped rule for
   form > .btn on the login page (originally a blue gradient). It sits at a
   higher specificity than the generic button rule and would otherwise win with
   a flat, dark gold fill and white text. Matched here at equal-or-higher
   specificity and placed later so the real gold gradient with dark text wins. */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login).gx-login form > .btn,
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login).gx-portal-login form > .btn,
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) form button[type=submit],
/* the two portal logins use a bare <button> with no class at all */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) form button:not([class]) {
  background: linear-gradient(90deg,#d4af43 0%,#e9c869 100%) !important;
  background-image: linear-gradient(90deg,#d4af43 0%,#e9c869 100%) !important;
  border: 1px solid #b8912f !important;
  color: #17140a !important;
  box-shadow: none !important;
  text-shadow: none !important;
}

/* Secondary / ghost buttons: quiet outline, gold only on interaction. */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .btn.ghost,.btn.secondary,.btn:not(.primary):not([type=submit])
) {
  background: #1c1a16 !important;
  border: 1px solid #3a352c !important;
  color: #cfc9be !important;
  box-shadow: none !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .btn.ghost,.btn.secondary,.btn:not(.primary):not([type=submit])
):hover { border-color: #e0bc4f !important; color: #e9c869 !important; }

/* ---------------------------------------------------------------------------
   SIDEBAR / NAVIGATION
   ------------------------------------------------------------------------- */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .sidebar,.rail,.rail-nav,.sb-nav,.side,.appbar
) {
  background: #0d0b09 !important;
  border-right: 1px solid #2a2621 !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .nav-item,.ritem,.navtab,.side .item,.sidebar .tab,.sub-item,.rsubitem,.dropitem
).active,
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .nav-item,.ritem,.navtab,.side .item,.sidebar .tab,.sub-item,.rsubitem,.dropitem
).active:hover {
  background: #241f14 !important;
  color: #e9c869 !important;
  box-shadow: inset 3px 0 0 #e0bc4f !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .nav-item,.ritem,.navtab,.side .item,.sidebar .tab,.sub-item,.rsubitem,.dropitem
).active svg { stroke: #e9c869 !important; color: #e9c869 !important; }

html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .nav-item,.ritem,.navtab,.side .item,.sidebar .tab,.sub-item,.rsubitem,.dropitem
):hover { background: #1c1a16 !important; color: #f2efe8 !important; }

/* The design system in qtech-ds.css reaches (0,6,2) with
   html body.gx-qtech.qd:is(.gx-light,.gx-dark) .nav-item.active, which is far
   above the generic rule above — so a .qd panel kept white active labels.
   Repeated under the same .gx-qtech.qd scope to win it back. */
html:root body.gx-qtech.qd:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login)
  :is(.nav-item,.sub-item,.ritem,.navtab,.side .item,.sidebar .tab,.rsubitem,.dropitem).active,
html:root body.gx-qtech.qd:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login)
  :is(.nav-item,.sub-item,.ritem,.navtab,.side .item,.sidebar .tab,.rsubitem,.dropitem).active:hover {
  background: #241f14 !important;
  color: #e9c869 !important;
  box-shadow: inset 3px 0 0 #e0bc4f !important;
}
html:root body.gx-qtech.qd:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login)
  :is(.nav-item,.sub-item,.ritem,.navtab,.side .item,.sidebar .tab).active svg {
  stroke: #e9c869 !important; color: #e9c869 !important;
}
html:root body.gx-qtech.qd:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login)
  :is(.nav-item,.sub-item).active > * { color: #e9c869 !important; }

/* ---------------------------------------------------------------------------
   FORMS
   ------------------------------------------------------------------------- */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  input:not([type=checkbox]):not([type=radio]):not([type=hidden]),
  select,textarea,.sd-trigger,.input-wrap
) {
  background: #100e0c !important;
  border: 1px solid #3a352c !important;
  color: #f2efe8 !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  input:not([type=checkbox]):not([type=radio]):not([type=hidden]),
  select,textarea
):focus {
  border-color: #e0bc4f !important;
  outline: none !important;
  box-shadow: 0 0 0 2px rgba(224,188,79,.22) !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  input::placeholder,textarea::placeholder
) { color: #7d7568 !important; }

/* ---------------------------------------------------------------------------
   TABLES / PAGINATION
   ------------------------------------------------------------------------- */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(th) {
  background: #12100e !important;
  color: #b09a6a !important;
  border-bottom: 1px solid #3a352c !important;
  font-weight: 600 !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(td) {
  border-bottom: 1px solid #221f1a !important;
  color: #e2ddd3 !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) tbody tr:hover td { background: #1c1a16 !important; }
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) .pagination button.active,
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) .pagination button:hover:not(:disabled) {
  background: #e0bc4f !important; border-color: #e0bc4f !important; color: #17140a !important;
}

/* ---------------------------------------------------------------------------
   DASHBOARD STAT CARDS
   qtech.css gives the metric cards four unrelated brand gradients — indigo
   (#4338ca), pink (#db2777), purple (#7c3aed) and orange (#f59e0b). They are
   the most saturated thing on the dashboard and they fight a gold theme.
   They are re-voiced as four STEPS OF THE SAME GOLD/AMBER FAMILY: still
   distinguishable from one another at a glance, but unmistakably one palette.
   ------------------------------------------------------------------------- */
html:root body :is(.qt-card.qt-indigo) {
  background: linear-gradient(135deg,#7a5f1e 0%,#a8842a 100%) !important;
}
html:root body :is(.qt-card.qt-purple) {
  background: linear-gradient(135deg,#a8842a 0%,#d4af43 100%) !important;
}
html:root body :is(.qt-card.qt-orange) {
  background: linear-gradient(135deg,#b8791f 0%,#e0a33e 100%) !important;
}
html:root body :is(.qt-card.qt-pink) {
  background: linear-gradient(135deg,#8a5a2a 0%,#c08a3e 100%) !important;
}
/* White-on-gradient labels are kept, but softened so the cards read as one set. */
html:root body :is(.qt-card.qt-indigo,.qt-card.qt-purple,.qt-card.qt-orange,.qt-card.qt-pink)
  :is(.qt-label,.qt-value) { color: #fff8e6 !important; }

/* ---------------------------------------------------------------------------
   LOGIN SHELL
   qtech-login-anim.css:616 paints the login shell navy with
   html body.gx-light.gx-login .shell{background:#0c1028!important} at
   (0,3,2). It is the single largest surface on the login page, so leaving it
   navy made the whole page read blue. Rematched one class higher.
   ------------------------------------------------------------------------- */
html:root body.gx-light.gx-login .shell,
html:root body.gx-light.gx-portal-login .shell,
html:root body.gx-light.gx-portal-login > .card,
html:root body:is(.gx-dark,.gx-login,.gx-portal-login) .shell {
  background: #0a0908 !important;
  border-color: #2a2621 !important;
}

/* ---------------------------------------------------------------------------
   LOGIN CARD — the reference design
   ------------------------------------------------------------------------- */
html body:is(.gx-login,.gx-portal-login) .login-card,
html:root body:is(.gx-dark,.gx-light) .login-card {
  background: #141210 !important;
  border: 1px solid #2a2621 !important;
  border-radius: 14px !important;
  box-shadow: 0 10px 30px rgba(0,0,0,.5) !important;
}
html body:is(.gx-login,.gx-portal-login) .field label { color: #b09a6a !important; }
html body:is(.gx-login,.gx-portal-login) a,
html:root body:is(.gx-dark,.gx-light) a { color: #e0bc4f !important; }
html body:is(.gx-login,.gx-portal-login) .m-brand-t b,
html body:is(.gx-login,.gx-portal-login) .login-head h2 { color: #f2efe8 !important; }
html body:is(.gx-login,.gx-portal-login) .footer,
html body:is(.gx-login,.gx-portal-login) .m-brand-t span { color: #9a9287 !important; }

/* ---------------------------------------------------------------------------
   SURFACES
   ------------------------------------------------------------------------- */
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .card,.panel,.table-wrap,.toolbar,.modal-box,.ms-modal,.box,.qt-chart-card,.qt-wcard
) {
  background: #141210 !important;
  border-color: #2a2621 !important;
  box-shadow: 0 1px 3px rgba(0,0,0,.45) !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .card-head,.modal-head,.ms-modal-head,.toolbar,.table-controls,.table-foot,.topbar,.appbar
) {
  background: #12100e !important;
  border-color: #2a2621 !important;
}
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  h1,h2,h3,h4,b,strong,.title,.nm,.tb-title,.t1,.pt
) { color: #f2efe8 !important; }
html:root body:is(.gx-dark,.gx-light,.gx-login,.gx-portal-login) :is(
  .muted,.hint,.sub,.breadcrumb,.card-head .sub
) { color: #9a9287 !important; }

/* ---------------------------------------------------------------------------
   PORTAL LOGIN BUTTONS
   The payment and panel-sharing logins use a bare <button> with no class.
   A re-mapped rule body.gx-light.gx-portal-login form button was winning
   with a flat dark-gold fill and WHITE text — poor contrast on mid-gold.
   Rematched at equal specificity and placed last so gold + near-black wins.
   ------------------------------------------------------------------------- */
html:root body.gx-light.gx-portal-login :is(form > .btn, form button),
html:root body.gx-light.gx-login :is(form > .btn, form button),
html:root body.gx-dark.gx-portal-login :is(form > .btn, form button),
html:root body.gx-dark.gx-login :is(form > .btn, form button) {
  background: linear-gradient(90deg,#d4af43 0%,#e9c869 100%) !important;
  color: #17140a !important;
}

`;

out.push('');
out.push('/* ============================================================================');
out.push('   HAND-TUNED REFINEMENTS');
out.push('   States that need designing rather than colour-translating.');
out.push('   ========================================================================== */');
out.push(TUNE_RAW.trim());

const dest = path.join(ASSETS, 'zoom-theme.css');
fs.writeFileSync(dest, out.join('\n') + '\n');
const bytes = fs.statSync(dest).size;
console.log('\n  extracted %d gx-dark rules, %d after dedupe', all.length, uniq.length);
console.log('  wrote %s (%d bytes, %.1f KB)', path.relative(ROOT, dest), bytes, bytes / 1024);
