// Lazada multi-package order: shipping and total come from the order-level summary (synthetic).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const laz = (p) => ({ module: { lifecycle: { pageNum: p, totalPageNum: 1, pageSize: 2 }, data: p > 1 ? {} : {
  orderItem_11: { id: '11', fields: { tradeOrderId: '900001', title: 'Laz item a', quantity: 1, price: '$17.90', status: 'Completed', buyerEmail: 'account1@example.com', delivery: { email: 'account1@example.com', method: 'Standard', desc: 'Sent to account1@example.com' } } },
  orderItem_12: { id: '12', fields: { tradeOrderId: '900001', title: 'Laz item b', quantity: 1, price: '$15.15', status: 'Completed' } },
  orderShop_1: { fields: { tradeOrderLineIds: ['11', '12'], tradeOrderId: '900001', name: 'LazShop', status: 'Completed' } } } } });
const detail = (id) => ({ module: { data: {
  package_FP1: { fields: { tradeOrderId: id, gmtCreate: 'Placed on 03 Feb 2025  10:00:00', rows: [{ title: 'Subtotal(1 Item)', value: '$17.90' }, { title: 'Shipping Fee', value: '$1.49' }, { title: 'Total:', value: '$19.39' }] } },
  package_FP2: { fields: { rows: [{ title: 'Subtotal(1 Item)', value: '$15.15' }, { title: 'Shipping Fee', value: '$3.95' }, { title: 'Total:', value: '$19.10' }] } },
  [`totalSummary_${id}`]: { fields: { title: 'Order Summary', fees: [{ key: 'Subtotal', value: '$33.05' }, { key: 'Shipping Fee', value: '$5.44' }, { key: 'Total Saving', value: '-$1.00' }],
    total: '$37.49', payments: [{ key: 'Paid by', value: 'Credit/Debit Card' }] } } } } });
run({ src, interceptorSrc, host: 'my.lazada.sg', cookie: 'lzd_uid=7700001',
  captureRec: { url: 'https://my.lazada.sg/customer/api/sync/order-list', method: 'POST', reqHeaders: {}, reqBody: JSON.stringify({ lifecycle: { pageNum: 1 } }), status: 200, body: JSON.stringify(laz(1)) },
  pages: (url, init) => { const b = JSON.parse(init.body); return url.includes('detail') ? detail(b.tradeOrderId) : laz(b.lifecycle.pageNum); },
  after: { capture: { url: 'https://my.lazada.sg/customer/api/sync/order-detail', method: 'POST', reqHeaders: {}, reqBody: JSON.stringify({ tradeOrderId: '900001' }), status: 200, body: JSON.stringify(detail('900001')) } } })
.then((r) => {
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  const g = (l, k) => l.split(',')[H.indexOf(k)];
  const K = ['accountId', 'subtotal', 'shippingFee', 'discount', 'orderTotal', 'totalsCheck', 'orderSummary', 'detailsVersion', 'purchasedAt'];
  console.log(K.map((k) => `${k}=${g(rows[0], k)}`).join(' '));
  assert.deepStrictEqual(K.slice(0, 6).map((k) => g(rows[0], k)), ['7700001', '33.05', '5.44', '1.00', '37.49', 'ok']);
  assert.strictEqual(g(rows[0], 'detailsVersion'), '4');
  // The JSON export (raw Lazada responses) carries no email, at any depth.
  assert.ok(r.json && r.json.text.length > 100, 'json produced');
  assert.ok(!/@/.test(r.json.text) && !/buyerEmail|"email"/i.test(r.json.text), 'no email in JSON');
  assert.ok(/Laz item a/.test(r.json.text), 'order data kept');
  console.log('LAZADA SUMMARY PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
