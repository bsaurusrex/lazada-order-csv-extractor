#!/usr/bin/env node
// Converts saved exports (the normalized CSV, 2.8.0 on) to schema.org JSON-LD,
// exactly as Save schema.org JSON would have saved them, so nothing needs
// fetching again. Writes <name>.jsonld beside each file.
// Usage: node tools/csv-to-jsonld.js <export.csv> [more.csv ...]
const fs = require('fs');
const path = require('path');
const { toSchemaOrg, rowsFromSchemaOrg } = require('../extension/schema-org.js');

function parseCsv(text) {
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); out.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  return out.filter((r) => r.some((v) => v !== ''));
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/csv-to-jsonld.js <export.csv> [more.csv ...]'); process.exit(2); }
let failed = 0;
for (const file of files) {
  const [header, ...lines] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!header || !header.includes('marketplace') || !header.includes('orderId')) {
    console.error(`skip  ${file}: not a normalized export (no marketplace/orderId columns)`); failed++; continue;
  }
  // Blank cells are left out, as the extension leaves out columns a row doesn't have.
  const rows = lines.map((l) => Object.fromEntries(header.map((k, i) => [k, l[i] ?? '']).filter(([, v]) => v !== '')));
  const doc = toSchemaOrg(rows);
  // Check the file gives the same rows back before writing it.
  const back = rowsFromSchemaOrg(doc);
  const key = (r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
  // Rows come back grouped by order, so compare them as sets.
  const want = rows.filter((r) => r.orderId).map(key).sort();
  const got = back.map(key).sort();
  const same = got.length === want.length && got.every((k, i) => k === want[i]);
  if (!same) { console.error(`FAIL  ${file}: the JSON-LD does not give the same rows back`); failed++; continue; }
  const target = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.jsonld`);
  fs.writeFileSync(target, JSON.stringify(doc, null, 2));
  console.log(`ok    ${file} -> ${path.basename(target)} (${doc['@graph'].length} orders, ${rows.length} rows)`);
}
process.exit(failed ? 1 : 0);
