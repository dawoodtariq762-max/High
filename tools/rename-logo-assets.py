#!/usr/bin/env python3
"""
Rename the logo assets so the URL itself changes.

A query-string cache-buster (?v=...) only works if every reference moves to the
new string. The generated /branding/runtime.js advertises its own copy of the
logo URL, so a deployment that updates the PNGs but not backend/branding.js
keeps pointing browsers at the OLD query string - which they have cached, so
the old logo keeps appearing even though the file on disk is new.

Changing the FILENAME guarantees a fresh URL from every code path, including
one that still carries an old ?v= string, because that old URL simply stops
existing.
"""
import os, re, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENAMES = [
    ('zoom-logo-transparent.png', 'zoom-logo-transparent-v2.png'),
    ('zoom-logo-square.png',      'zoom-logo-square-v2.png'),
    ('zoom-logo.png',             'zoom-logo-v2.png'),
    ('zoom-favicon.png',          'zoom-favicon-v2.png'),
]

# copy, never move: the old files are left in place to be deleted later
for src, dst in RENAMES:
    s = os.path.join(root, 'assets', src)
    d = os.path.join(root, 'assets', dst)
    if os.path.exists(s):
        with open(s, 'rb') as f: data = f.read()
        with open(d, 'wb') as f: f.write(data)
        print('  %-30s -> %-32s (%d bytes)' % (src, dst, len(data)))
    else:
        print('  MISSING %s' % src)

# rewrite references everywhere
changed = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git', 'dist', 'build')]
    for fn in filenames:
        if not fn.endswith(('.html', '.js', '.css')):
            continue
        fp = os.path.join(dirpath, fn)
        try:
            with open(fp, encoding='utf-8', errors='replace') as f: t = f.read()
        except Exception:
            continue
        orig = t
        for src, dst in RENAMES:
            # match the bare filename, with or without a query string
            t = re.sub(re.escape(src) + r'(\?[A-Za-z0-9_\-=.]*)?', dst, t)
        if t != orig:
            with open(fp, 'w', encoding='utf-8') as f: f.write(t)
            changed += 1
            print('  updated %s' % os.path.relpath(fp, root))
print('  %d file(s) rewritten' % changed)
