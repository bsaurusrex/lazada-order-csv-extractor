// background.js: fetches only eBay order pages, only for this extension's eBay tabs,
// and strips the address, payment and buyer data before answering (synthetic).
const vm = require('vm'); const fs = require('fs'); const path = require('path'); const assert = require('assert');
const E = process.argv[2];
const src = fs.readFileSync(path.join(E, 'background.js'), 'utf8');
const T = (text) => ({ textSpans: [{ text }] });
const pair = (l, v) => ({ labels: [T(l)], values: [T(v)] });
const state = { modules: {
  deliveryAddress: { title: T('Shipping address'), dataItems: [T('1 Example Street')] },
  paymentInfo: { title: T('Payment info'), dataItems: [pair('Card', 'ending in 0000')] },
  orderInfo: { title: T('Order info'), sections: [{ dataItems: [pair('Time placed', 'Nov 30, 2025 at 3:57 PM'), pair('Order number', '11-11111-11111')] }] },
  printerFriendly: { tables: [{ rows: [{ cells: [
    { section: { title: T('Order information'), dataItems: [pair('Buyer', 'account1shopper'), pair('Seller', 'example_seller'), pair('Payment method', 'Card')] } },
    { section: { title: T('Shipping address'), dataItems: [T('1 Example Street'), T('Account One')] } },
    { title: T('Order total'), sections: [{ dataItems: [pair('1 item', '$9.99'), pair('Order total', '$9.99')] }] },
  ] }] }] },
} };
const page = `<html><script>window.__APP_INITIAL_STATE__ = ${JSON.stringify(state)};</script></html>`;
const fetched = [];
let listener;
const ctx = {
  URL, JSON, Promise, Set, String, Array, Object, Error, console,
  fetch: async (url) => { fetched.push(url); const signin = url.includes('signin-me'); return { ok: true, status: 200, url: signin ? 'https://signin.ebay.com/ws/eBayISAPI.dll' : url, text: async () => page }; },
  chrome: { runtime: { id: 'ext1', onMessage: { addListener: (f) => { listener = f; } } } },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const ask = (url, sender) => new Promise((resolve) => { const r = listener({ cmd: 'ebayDetail', url }, sender, resolve); if (r !== true) setTimeout(() => resolve('no async'), 10); });
const tab = { id: 'ext1', tab: { id: 1 }, url: 'https://www.ebay.com/mye/myebay/purchase' };
(async () => {
  const ok = await ask('https://order.ebay.com/ord/show?orderId=11-11111-11111&purchaseOrderId=1', tab);
  assert.ok(ok.ok, 'order page read');
  const out = JSON.stringify(ok.state);
  assert.ok(!/Example Street|Account One|account1shopper|ending in 0000|Payment method/.test(out), 'address, buyer and payment removed');
  assert.ok(!ok.state.modules.deliveryAddress && !ok.state.modules.paymentInfo, 'personal modules dropped');
  assert.ok(/Order total/.test(out) && /example_seller/.test(out) && /Time placed/.test(out), 'order data kept');
  const sg = await ask('https://order.ebay.com.sg/ord/show?orderId=1', { ...tab, url: 'https://www.ebay.com.sg/mye/myebay/purchase' });
  assert.ok(sg.ok, 'ebay.com.sg order host allowed');
  for (const bad of ['https://evil.example.com/ord/show?orderId=1', 'http://order.ebay.com/ord/show?orderId=1', 'https://order.ebay.com/account/settings', 'https://www.ebay.com/ord/show']) {
    const r = await ask(bad, tab);
    assert.ok(!r.ok && /not an eBay order page|bad url/.test(r.error), 'refused: ' + bad);
  }
  const before = fetched.length;
  const other = await ask('https://order.ebay.com/ord/show?orderId=1', { id: 'ext1', tab: { id: 2 }, url: 'https://shopee.sg/user/purchase/' });
  assert.ok(!other.ok && other.error === 'not allowed', 'only eBay tabs may ask');
  const stranger = await ask('https://order.ebay.com/ord/show?orderId=1', { id: 'someone-else', tab: { id: 3 }, url: 'https://www.ebay.com/' });
  assert.ok(!stranger.ok && stranger.error === 'not allowed', 'only this extension may ask');
  assert.strictEqual(fetched.length, before, 'refused requests fetch nothing');
  const signin = await ask('https://order.ebay.com/ord/show?orderId=signin-me', tab);
  assert.deepStrictEqual([signin.ok, signin.error], [false, 'signin']);
  console.log('EBAY BACKGROUND PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
