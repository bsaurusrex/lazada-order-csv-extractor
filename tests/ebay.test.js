// eBay: purchase list (JSON) + order details via the background worker (synthetic, no real data).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const T = (text) => ({ textSpans: [{ text }] });
const PUBLIC_ID = 'aB3dE5fG7hJ';   // shaped like eBay's publicUserId
const USERNAME = 'account1shopper';  // the page also carries the username: must never be used
const DETAIL = (id) => `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(id)}&purchaseOrderId=1`;

// List entries, newest first. 1: new-style id, one line, quantity 2. 2: two items.
// 3: legacy id, cancelled. Plus an entry with no itemCards (page furniture).
const card = (id, listingId, title, value, qty, extra = []) => ({
  listingId, title: T(title), additionalPrice: { ...T(`US $${value.toFixed(2)}`), value: { value, currency: 'USD' } },
  aspectValuesList: [T(`Quantity : ${qty}`), ...extra.map(T)], image: { URL: `https://example.com/${listingId}.jpg` },
  __myb: { orderId: id, sellerInfo: [T('Sold by: '), T('example_seller')], deliveryMessage: { title: T(' Delivered on Sun, Dec 14 ') } },
});
const entry = (id, status, date, total, cards) => ({
  itemCards: cards, primaryMessage: [T(status)],
  secondaryMessage: [T('Order date:'), T(date), T('Order total:'), T(`US $${total}`)],
  actions: [{ text: 'View order details', action: { type: 'NAV', URL: DETAIL(id) } }],
});
const O1 = '11-11111-11111', O2 = '22-22222-22222', O3 = '100000000001-2000000000001';
const page1 = [entry(O1, 'Delivered', 'Nov 30, 2025', '184.51', [card(O1, '100000000101', 'Example remote controller', 184.51, 2)]),
  { heading: T('Recently viewed') },
  entry(O2, 'Delivered', 'Mar 3, 2024', '30.50', [card(O2, '100000000201', 'Example cable', 10, 1, ['Colour: Black']), card(O2, '100000000202', 'Example adapter', 15, 1)])];
const page2 = [entry(O3, 'Canceled', 'Jun 1, 2017', '9.99', [card(O3, '100000000001', 'Example old item', 9.99, 1)])];
const listJson = (items) => ({ isSignin: true, modules: { RIVER: [{ data: { items } }] } });
const pages = (u) => { const p = Number(new URL(u).searchParams.get('page')); return listJson(p === 1 ? page1 : p === 2 ? page2 : []); };

// Detail states as background.js returns them (address, payment and buyer already removed).
const pair = (l, v) => ({ labels: [T(l)], values: [T(v)] });
const detail = (placed, totalRows, itemRows, extra = {}) => ({ modules: {
  orderInfo: { title: T('Order info'), sections: [{ dataItems: [pair('Time placed', placed), pair('Order number', 'x')] }] },
  shipment: { containers: [{ title: T('Tracking details'), dataItems: [pair('Number', extra.tracking || 'TRACK0000000001')] }, { text: 'Delivered on Sun, Dec 14, 2025' }] },
  printerFriendly: { tables: [{ rows: [{ cells: [
    { section: { title: T('Order information'), dataItems: [pair('Seller', 'example_seller'), pair('Placed on', placed.replace(/ at .*/, '')), pair('Paid on', placed.replace(/ at .*/, ''))] } },
    { title: T('Order total'), sections: [{ dataItems: totalRows.map(([l, v]) => pair(l, v)) }] },
  ] }, { cells: [{ table: { header: { cells: [T('Quantity'), T('Item name'), T('Shipping service'), T('Item price')] },
    rows: itemRows.map(([q, n, p]) => ({ cells: [T(String(q)), T(n), T('Example Shipping'), T(p)] })) } }] }] }] },
} });
const details = {
  [O1]: detail('Nov 30, 2025 at 3:57 PM', [['2 items', '$118.00'], ['Item discount', '-$5.90'], ['Shipping', '$57.17'], ['GST*', '$15.24'], ['Order total', '$184.51']],
    [[2, 'Example remote controller', '$118.00']]),
  [O2]: detail('Mar 3, 2024 at 9:05 AM', [['2 items', '$25.00'], ['Shipping', '$5.50'], ['Order total', '$30.50']],
    [[1, 'Example cable', '$10.00'], [1, 'Example adapter', '$15.00']]),
  [O3]: detail('Jun 1, 2017 at 11:00 PM', [['1 item', '$9.99'], ['Order total', '$9.99']], [[1, 'Example old item', '$9.99']]),
};
let failO2Once = true;
const runtimeSend = (msg) => {
  assert.strictEqual(msg.cmd, 'ebayDetail');
  const id = new URL(msg.url).searchParams.get('orderId');
  if (id === O2 && failO2Once) { failO2Once = false; return { ok: false, error: 'HTTP 503' }; }
  return { ok: true, state: JSON.parse(JSON.stringify(details[id])) };
};

const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
  row.push(f); out.push(row); return out; };

run({ src, interceptorSrc, host: 'www.ebay.com', noCapture: true, captureRec: {}, cookie: '', runtimeSend, pages,
  pageHtml: `<script>var a={"userId":"${USERNAME}"};var b="fullSiteExperience=true,publicUserId=${PUBLIC_ID},ip=0.0.0.0";</script>`,
  // The re-read pass for the order whose detail failed during the export.
  after: { capture: { url: 'https://www.ebay.com/x', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: '{}' } } })
.then(async (r) => {
  const [H, ...rows] = parseCsv(r.csv.text.replace(/^﻿/, '')).filter((l) => l.length > 1);
  const g = (l, k) => l[H.indexOf(k)];
  const K = ['orderId', 'purchasedAt', 'status', 'quantity', 'price', 'lineTotal', 'subtotal', 'shippingFee', 'tax', 'discount', 'orderTotal', 'totalsCheck', 'currency', 'trackingNumber', 'shopName'];
  for (const l of rows) console.log(K.map((k) => `${k}=${g(l, k)}`).join(' '));
  assert.strictEqual(rows.length, 4, 'four item rows, page furniture skipped');
  assert.ok(rows.every((l) => g(l, 'marketplace') === 'ebay.com' && g(l, 'accountId') === PUBLIC_ID), 'publicUserId on every row');
  assert.ok(!r.csv.text.includes(USERNAME), 'username never exported');
  const one = rows.find((l) => g(l, 'orderId') === O1);
  assert.deepStrictEqual(['purchasedAt', 'quantity', 'price', 'lineTotal', 'subtotal', 'shippingFee', 'tax', 'discount', 'orderTotal', 'totalsCheck', 'currency', 'deliveredAt', 'trackingNumber', 'status']
    .map((k) => g(one, k)), ['2025-11-30 15:57:00', '2', '59.00', '118.00', '118.00', '57.17', '15.24', '5.90', '184.51', 'ok', 'USD', '2025-12-14', 'TRACK0000000001', 'delivered']);
  const two = rows.filter((l) => g(l, 'orderId') === O2);
  assert.deepStrictEqual(two.map((l) => [g(l, 'title'), g(l, 'lineTotal'), g(l, 'variation')]), [['Example cable', '10.00', 'Colour: Black'], ['Example adapter', '15.00', '']]);
  assert.ok(two.every((l) => g(l, 'totalsCheck') === 'ok' && g(l, 'purchasedAt') === '2024-03-03 09:05:00'), 're-read after the detail failed');
  const old = rows.find((l) => g(l, 'orderId') === O3);
  assert.deepStrictEqual(['status', 'statusDetail', 'purchasedAt'].map((k) => g(old, k)), ['cancelled', 'Canceled', '2017-06-01 23:00:00']);
  assert.strictEqual(r.st.undated, 0);
  // From 2020 on: the 2017 order is never read, and the list stops at the page that is all older.
  const asked = [];
  const r2 = await run({ src, interceptorSrc, host: 'www.ebay.com', noCapture: true, captureRec: {}, cookie: '', pages,
    runtimeSend: (msg) => { asked.push(new URL(msg.url).searchParams.get('orderId')); return { ok: true, state: JSON.parse(JSON.stringify(details[new URL(msg.url).searchParams.get('orderId')])) }; },
    pageHtml: `<script>var b="publicUserId=${PUBLIC_ID},x";</script>`, preStore: { lzx_from_year: 2020 } });
  const listPages = r2.fetched.map((f) => String(f.url)).filter((u) => /purchase\/mp\/get/.test(u)).map((u) => new URL(u).searchParams.get('page'));
  console.log('from 2020: detail reads', asked.length, 'list pages', listPages.join(','));
  assert.ok(!asked.includes(O3) && !r2.csv.text.includes(O3), '2017 order skipped');
  assert.deepStrictEqual(listPages, ['1', '2'], 'stops at the page that is all older');
  console.log('EBAY PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
