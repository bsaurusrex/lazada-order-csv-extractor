// Runs extension/content.js in a VM with stubbed browser APIs and a fake API.
const vm = require('vm'), fs = require('fs');
module.exports = async function run({ schemaOrg, src, host, captureRec, pages, cmd = 'run', domCards, after, interceptorSrc, signedOnly, preStore, noCapture, mtop, cookie, cmd2, pageHtml }) {
  const listeners = { message: [] }; let onMsg; const downloads = []; const fetched = [];
  const loc = new URL(`https://${host}/user/purchase/`);
  const store = Object.assign({}, preStore || {});
  const win = {
    name: '', addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    postMessage: (data, _o, ports) => setTimeout(() => { for (const f of (listeners.message || []).slice()) f({ source: win, data, ports: ports || [] }); }, 0),
    scrollTo: () => {},
  };
  win.top = win;
  const doc = { cookie: cookie ?? `SPC_U=100000001; aep_usuc_f=${encodeURIComponent('site=glo&x_alimid=100000001')}`, querySelectorAll: () => [], querySelector: () => null, documentElement: { scrollHeight: 1000, appendChild(){}, innerHTML: (typeof pageHtml === 'string' ? pageHtml : '') }, createElement: () => ({ click(){ downloads.push(this.download); }, style:{}, setAttribute(){}, remove(){} }) };
  const ctx = {
    window: win, document: doc, location: loc, console, URL, URLSearchParams, Blob: class { constructor(p){ this.p=p; } },
    setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set, Number, String, RegExp, Array, Object, Error, CSS: { escape: (s) => s },
    chrome: { storage: { local: { set(o){ Object.assign(store,o); }, get(k,cb){ cb({[k]:store[k]}); }, remove(k,cb){ for (const x of [].concat(k)) delete store[x]; cb(); } }, onChanged: { addListener(){} } },
              runtime: { onMessage: { addListener: (f) => { onMsg = f; } }, getURL: (x) => x } },
    // Direct (isolated-world) fetch: a Shopee-like host rejects it unsigned.
    fetch: async (url, init) => { fetched.push({ url, init, via: 'direct' }); const body = signedOnly ? { error: 90309999, error_msg: '' } : pages(url, init); return { status: 200, url: String(url), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; },
  };
  // The page's own fetch, as wrapped by the site's signing SDK.
  win.fetch = async (url, init) => { fetched.push({ url: new URL(url, loc.href).toString(), init, via: 'page' }); const body = pages(new URL(url, loc.href).toString(), init); return { status: 200, text: async () => JSON.stringify(body), clone() { return this; } }; };
  ctx.URL.createObjectURL = () => 'blob:x'; ctx.URL.revokeObjectURL = () => {};
  vm.createContext(ctx);
  ctx.MessageChannel = MessageChannel;
  ctx.DOMParser = new (require('jsdom').JSDOM)('').window.DOMParser;
  ctx.performance = { getEntriesByType: () => [] };
  if (mtop) win.lib = { mtop: { request: async (opts) => { fetched.push({ url: opts.api, init: opts, via: 'mtop' }); return JSON.parse(JSON.stringify(mtop(opts))); } } };
  if (interceptorSrc) vm.runInContext(interceptorSrc, ctx);
  ctx.module = undefined;
  const schemaOrgSrc = require('path').join(__dirname, '..', 'extension', 'schema-org.js');
  if (fs.existsSync(schemaOrgSrc)) { vm.runInContext(fs.readFileSync(schemaOrgSrc, 'utf8'), ctx); win.__LZX_SCHEMA_ORG__ = ctx.__LZX_SCHEMA_ORG__; }
  vm.runInContext(src, ctx);
  const send = (m) => new Promise((r) => onMsg(m, {}, r));
  // Deliver the recorded request as the interceptor would.
  captureRec.ts = Date.now() + 5;
  await new Promise((r) => setTimeout(r, 60));
  if (!noCapture) for (const f of listeners.message) f({ source: win, data: { __lzx: 'capture', rec: captureRec } });
  const st0 = await send({ cmd: 'status' });
  await send({ cmd, opts: { startPage: 1, endPage: 0, delayMs: 0 } });
  let st; for (let i = 0; i < 2000; i++) { await new Promise((r) => setTimeout(r, 30)); st = await send({ cmd: 'status' }); if (!st.running) break; }
  if (after) {
    const rec = after.capture; rec.ts = Date.now();
    for (const f of listeners.message) f({ source: win, data: { __lzx: 'capture', rec } });
    await send({ cmd: 'details', delayMs: 0 });
    for (let i = 0; i < 1000; i++) { await new Promise((r) => setTimeout(r, 30)); st = await send({ cmd: 'status' }); if (!st.running) break; }
  }
  if (cmd2) { await send({ cmd: cmd2 }); await new Promise((r) => setTimeout(r, 50)); }
  const csv = await send({ cmd: 'csv' });
  const json = await send({ cmd: 'json', schemaOrg });
  ctx.__store = store;
  return { st0, st, fetched, downloads, csv: csv.file, json: json && json.file, store, ctx };
};
