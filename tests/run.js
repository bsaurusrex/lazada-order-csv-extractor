// Runs every tests/*.test.js against extension/ and reports pass/fail.
// Usage: npm test   (or: node tests/run.js [filter])
// Tests run in Singapore time: expected timestamps are written in it.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const filter = process.argv[2] || '';
// A few older tests take the path to content.js instead of the folder.
const TAKES_FILE = new Set(['core.test.js', 'shopee_offsets.test.js', 'shopee_details.test.js']);

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const arg = TAKES_FILE.has(f) ? path.join(ext, 'content.js') : ext;
  const res = spawnSync(process.execPath, [path.join(__dirname, f), arg], {
    env: { ...process.env, TZ: 'Asia/Singapore' }, encoding: 'utf8', timeout: 120000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n');
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${f}${ok ? '' : `\n${out.slice(-15).map((l) => `      ${l}`).join('\n')}`}`);
}
console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
