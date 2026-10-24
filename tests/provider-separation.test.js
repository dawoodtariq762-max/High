'use strict';
/* =====================================================================
   Phase-5 §7 — PROVIDER DATA SEPARATION (real provider vs typed reference)
   ---------------------------------------------------------------------
   Two different things used to be conflated:
     (1) ranges.provider  — the free-text "Provider (reference)" an Admin can
         type on the range form. Informational only: typos and case variants
         are expected and must never appear as a provider.
     (2) the real provider record chosen when numbers are imported, stored as
         ranges.provider_id -> galaxy_providers.id (authoritative).
   Grouping by (1) is what made the summary show a third provider while
   Provider Management held two. This test pins the corrected model:
   the migration is additive, exact-match only, idempotent, never overwrites a
   deliberate assignment, never clears a valid link and never creates records.
   Runs against a throwaway database file — no live data is touched.
   ===================================================================== */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDbPath = path.join(os.tmpdir(), 'test_provider_separation_' + Date.now() + '.sqlite');
process.env.DB_FILE = testDbPath;
const db = require('../backend/db');
db.init(testDbPath);
const { createTables } = require('../backend/schema');
createTables();

const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'schema.js'), 'utf8');
let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }

test('Schema: ranges keeps the reference text and gains an indexed provider_id', () => {
  const cols = db.all('PRAGMA table_info(ranges)').map(c => c.name);
  assert.ok(cols.includes('provider'), 'the informational reference column must be kept');
  assert.ok(cols.includes('provider_id'), 'the authoritative link column must exist');
  assert.ok(db.all('PRAGMA index_list(ranges)').some(i => /idx_ranges_provider_id/.test(i.name)),
    'ranges.provider_id must be indexed (summary/filter queries join on it)');
  assert.match(schemaSrc, /ensureColumn\('ranges', 'provider_id', 'INTEGER'\)/, 'the migration must stay additive');
});

/* Two real providers, five ranges: exact text, case/whitespace variant, typo,
   empty, and a second real provider. Numbers hang off the ranges. */
db.run("INSERT INTO galaxy_providers(name,currency,status,conn_type) VALUES('Lamix','USD','Active','HTTP')");
db.run("INSERT INTO galaxy_providers(name,currency,status,conn_type) VALUES('Nexmo Bridge','USD','Active','SMPP')");
const ranges = [
  ['UK Direct 01', '44770', 'Lamix'],        // exact match
  ['UK Direct 02', '44771', ' lamix '],      // case + whitespace variant
  ['UK Direct 03', '44772', 'Test 01'],      // typed reference, no such provider
  ['UK Direct 04', '44773', ''],             // no reference at all
  ['UK Direct 05', '44774', 'Nexmo Bridge'], // second real provider
];
ranges.forEach(r => db.run('INSERT INTO ranges(name,prefix,provider) VALUES(?,?,?)', r));
[[1, 3], [2, 2], [3, 1], [5, 1]].forEach(([rid, count]) => {
  for (let i = 0; i < count; i++) db.run('INSERT INTO numbers(range_id,number) VALUES(?,?)', [rid, '44' + rid + '00000' + i]);
});
createTables();   // the backfill runs on every startup — prove it is idempotent
const link = id => db.get('SELECT provider_id FROM ranges WHERE id=?', [id]).provider_id;
const ref = id => db.get('SELECT provider FROM ranges WHERE id=?', [id]).provider;

test('Backfill links an exact or case/whitespace-variant reference to the real provider', () => {
  assert.equal(link(1), 1);
  assert.equal(link(2), 1, 'case + surrounding whitespace still match exactly (no fuzzy matching)');
  assert.equal(link(5), 2);
});

test('A typo or empty reference stays unlinked and the reference text is preserved', () => {
  assert.equal(link(3), null, 'an unmatched reference must not be linked to any provider');
  assert.equal(link(4), null);
  assert.equal(ref(3), 'Test 01', 'the informational reference is never rewritten or deleted');
  assert.equal(ref(1), 'Lamix');
});

test('No provider record is created by the migration (no auto-creation, no renaming)', () => {
  const rows = db.all('SELECT id,name FROM galaxy_providers ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'Lamix' }, { id: 2, name: 'Nexmo Bridge' }]);
});

test('Re-running the migration is idempotent', () => {
  const before = db.all('SELECT id,provider,provider_id FROM ranges ORDER BY id');
  createTables(); createTables();
  assert.deepEqual(db.all('SELECT id,provider,provider_id FROM ranges ORDER BY id'), before);
});

test('The phantom-provider bug is gone: text groups are not counted as providers', () => {
  const textGroups = db.get("SELECT COUNT(DISTINCT TRIM(provider)) c FROM ranges WHERE COALESCE(TRIM(provider),'')<>''").c;
  const realGroups = db.get('SELECT COUNT(DISTINCT provider_id) c FROM ranges WHERE provider_id IS NOT NULL').c;
  assert.ok(textGroups > realGroups, 'the fixture must reproduce the old ambiguity (' + textGroups + ' text groups)');
  assert.equal(realGroups, 2, 'exactly the two Provider Management records are providers');
  const perProvider = db.all(`SELECT gp.id, gp.name, COUNT(DISTINCT r.id) ranges, COUNT(nu.id) numbers
      FROM galaxy_providers gp
      LEFT JOIN ranges r ON r.provider_id=gp.id AND COALESCE(r.deleted_at,'')=''
      LEFT JOIN numbers nu ON nu.range_id=r.id GROUP BY gp.id, gp.name ORDER BY gp.id`);
  assert.deepEqual(perProvider.map(p => [p.name, p.ranges, p.numbers]), [['Lamix', 2, 5], ['Nexmo Bridge', 1, 1]]);
  const unlinked = db.get("SELECT COUNT(DISTINCT id) ranges FROM ranges WHERE provider_id IS NULL AND COALESCE(deleted_at,'')=''").ranges;
  assert.equal(unlinked, 2, 'the reference-only and no-reference ranges are reported as unlinked, not as providers');
});

test('A deliberate assignment survives a later edit of the reference text', () => {
  db.run("UPDATE ranges SET provider_id=2 WHERE id=3");      // Admin links it on purpose
  db.run("UPDATE ranges SET provider='Test 01 (renamed)' WHERE id=3");
  createTables();
  assert.equal(link(3), 2, 'syncRangeProviderLinks must never overwrite an explicit assignment');
  db.run("UPDATE ranges SET provider_id=NULL, provider='Test 01' WHERE id=3");   // restore the fixture state
  createTables();
  assert.equal(link(3), null);
});

test('A link is cleared only when its provider record really disappears', () => {
  db.run("UPDATE ranges SET provider_id=2 WHERE id=5");
  createTables();
  assert.equal(link(5), 2, 'a valid link is kept');
  db.run("DELETE FROM galaxy_providers WHERE id=2");
  createTables();
  assert.equal(link(5), null, 'a dangling link is cleared instead of counting a deleted provider');
  db.run("INSERT INTO galaxy_providers(id,name,currency,status,conn_type) VALUES(2,'Nexmo Bridge','USD','Active','SMPP')");
  db.run("UPDATE ranges SET provider_id=2 WHERE id=5");
  createTables();
  assert.equal(link(5), 2);
});

/* ---- the query layer must use the authoritative relationship ---- */
test('Server code exposes the real-provider join and exact-match resolution', () => {
  assert.match(src, /const REAL_PROVIDER_JOIN = ' LEFT JOIN galaxy_providers rp ON rp\.id=r\.provider_id '/);
  assert.match(src, /function resolveRealProvider\(value\)/);
  assert.match(src, /function providerIdForText\(currentId, text\)/);
  assert.match(src, /function syncRangeProviderLinks\(\)/);
  assert.match(src, /LOWER\(TRIM\(gp\.name\)\)=LOWER\(TRIM\(ranges\.provider\)\)/, 'the backfill matches exactly, ignoring case/whitespace only');
  assert.ok(!/LIKE\s*'%'/.test(src.slice(src.indexOf('function resolveRealProvider'), src.indexOf('function cachedJson'))),
    'resolution must not use LIKE/fuzzy matching');
});

test('Provider summary and provider filters group by provider_id, never by the typed text', () => {
  assert.ok(src.includes('LEFT JOIN ranges r ON r.provider_id=gp.id'), 'the summary totals join on the real link');
  const summary = src.slice(src.indexOf("app.get('/api/provider-summary'"), src.indexOf("app.get('/api/providers-info'"));
  assert.match(summary, /r\.provider_id IS NULL/, 'unlinked ranges are reported separately');
  assert.match(summary, /reference_only/, 'a typed reference with no link is listed as reference-only');
  assert.match(summary, /GROUP BY gp\.id, gp\.name/, 'the provider totals group by the real provider record');
  assert.match(summary, /GROUP BY r\.id, r\.name, rp\.name, r\.provider_id, r\.provider/, 'per-range rows carry both the real provider and the reference');
  assert.match(summary, /r\.provider_id IS NULL AND COALESCE\(TRIM\(r\.provider\),''\)<>''/, 'only unlinked ranges can appear in the reference-only list');
  const filterHits = src.match(/where\.push\('r\.provider_id=\?'\)/g) || [];
  assert.ok(filterHits.length >= 2, 'the numbers/SMS provider filters resolve a provider to its id first');
});

test('A range or import can never invent a provider record', () => {
  const createRange = src.slice(src.indexOf("app.post('/api/ranges'"), src.indexOf("app.delete('/api/ranges/:id'"));
  /* §3.8: creating/updating a range now REQUIRES a real provider record and must
     never fall back to storing the typed text as if it were a provider. */
  assert.match(createRange, /requireRealProviderOrThrow\(b\.provider\)/,
    'the create route resolves the provider strictly (no implicit creation)');
  assert.match(src, /function requireRealProviderOrThrow\(providerText\)/);
  assert.match(createRange, /provider_found: false/, 'an unknown provider is rejected with a 400, not accepted');
  assert.ok(!/INSERT INTO galaxy_providers/.test(createRange), 'the range routes must not insert providers');
  const impIdx = src.indexOf("app.post('/api/ranges/import'");
  assert.ok(impIdx > -1, 'the range import route must exist');
  const importRange = src.slice(impIdx, impIdx + 6000);
  assert.ok(!/INSERT INTO galaxy_providers/.test(importRange), 'the import route must not insert providers');
  assert.match(src, /provider_found: false/, 'assign-range rejects a name that is not a real provider');
});

console.log(`${n} tests passed; throwaway database ${path.basename(testDbPath)} only.`);
fs.rmSync(testDbPath, { force: true });
