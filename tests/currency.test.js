// currency on every row, every marketplace (synthetic data only).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false; for (let i = 0; i < txt.length; i++) { const c = txt[i];
  if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
  else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
  row.push(f); out.push(row); return out; };
const cur = (r) => { const [H, ...rows] = parseCsv(r.csv.text.replace(/^﻿/, '')); return rows.map((x) => x[H.indexOf('currency')]); };
const shopeeList = (n) => ({ error: 0, new_data: { order_or_checkout_data: Array.from({ length: n }, (_, i) => ({ order_list_detail: { status: { status_label: { text: 'label_order_completed' } }, info_card: { order_id: 900 + i, final_total: 100000, order_list_cards: [{ shop_info: { shop_id: 1, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: i, model_id: 1, name: 'X', amount: 1, item_price: 100000, order_price: 100000 }] }] } }] } } })), next_offset: -1 } });
const laz = { module: { lifecycle: { pageNum: 1, totalPageNum: 1, pageSize: 1 }, data: { orderItem_1: { id: '1', fields: { tradeOrderId: 'T1', title: 'L', quantity: 1, price: 'RM5.00', delivery: {} } }, orderShop_1: { fields: { tradeOrderLineIds: ['1'], tradeOrderId: 'T1', name: 'S' } } } } };
(async () => {
  for (const [host, want] of [['shopee.sg', 'SGD'], ['shopee.com.my', 'MYR'], ['shopee.co.th', 'THB']]) {
    const r = await run({ src, interceptorSrc, signedOnly: true, host, captureRec: { url: `https://${host}/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=0`, method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(shopeeList(2)) }, pages: (u) => (u.includes('account') ? { error: 0, data: { userid: 100000001 } } : shopeeList(2)) });
    const c = cur(r); assert.ok(c.length && c.every((x) => x === want), `${host}: ${c}`); console.log(host, '->', [...new Set(c)].join());
  }
  for (const [host, want] of [['my.lazada.sg', 'SGD'], ['my.lazada.com.my', 'MYR'], ['my.lazada.vn', 'VND']]) {
    const r = await run({ src, interceptorSrc, host, captureRec: { url: `https://${host}/customer/api/sync/order-list`, method: 'POST', reqHeaders: {}, reqBody: JSON.stringify({ lifecycle: { pageNum: 1 } }), status: 200, body: JSON.stringify(laz) }, pages: () => laz });
    const c = cur(r); assert.ok(c.length && c.every((x) => x === want), `${host}: ${c}`); console.log(host, '->', [...new Set(c)].join());
  }
  // a saved export from before the column existed gets the site currency on restore
  const r = await run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg', preStore: { lzx_result_shopee: { rows: [{ orderId: '1', lineId: 'a', title: 'old', accountId: '100000001' }], origin: 'https://shopee.sg', complete: true } }, noCapture: true, captureRec: {}, cmd: 'status', pages: () => ({}) });
  const c = cur(r); assert.deepStrictEqual(c, ['SGD']); console.log('restored old export ->', c.join());
  console.log('CURRENCY PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
