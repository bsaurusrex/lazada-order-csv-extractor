// Normalized export: core columns, numbers, dates, statuses, Lazada totals and accountId (synthetic, no real data).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const base = { _shopMatch: 'lineId', 'raw.buyerEmail': 'account1@example.com', 'raw.delivery.email': 'account1@example.com', 'raw.statusColor': '#F78A00',
  'raw.isNonPdp': 'false', shopName: 'Example Shop', detailsVersion: '3', currency: '' };
const rows = [
  // 1: subtotal shown after the item discount, shipping voucher listed twice
  { ...base, orderId: '1000000112345', lineId: '1000000212345', purchasedAt: '2025-01-02 10:00:00', paidAt: '2025-01-02 10:01:00', status: 'Completed',
    title: 'Item A', quantity: '1', price: '$15.00', subtotal: '10.00', shippingFee: '1.99', discount: '11.98', orderTotal: '7.00', 'raw.price': '$15.00',
    charges: 'Subtotal(1 Item)=$10.00 | Shipping Fee=$1.99 | Shipping Fee Voucher=-$1.99 | Total:=$7.00 | Item A=$15.00 | Item Discount=-$5.00 | Lazada Voucher=-$3.00 | Shipping Fee Promotion=-$1.99' },
  // 2: wallet balance, a free gift, never paid placeholder date
  { ...base, orderId: '1000000312345', lineId: '1000000412345', purchasedAt: '2025-02-03 11:00:00', paidAt: '1970-01-01 08:00:00', status: 'Paid',
    title: 'Item B', quantity: '2', price: '$8.30', subtotal: '16.60', shippingFee: '1.75', discount: '', orderTotal: '13.37', 'raw.price': '$8.30',
    charges: 'Subtotal(2 Items)=$16.60 | Shipping Fee=$1.75 | Cashback Balance=-$4.98 | Total:=$13.37' },
  { ...base, orderId: '1000000312345', lineId: '1000000512345', purchasedAt: '2025-02-03 11:00:00', paidAt: '1970-01-01 08:00:00', status: 'Paid',
    title: 'Free gift', quantity: '1', price: 'FREE', subtotal: '16.60', shippingFee: '1.75', discount: '', orderTotal: '13.37', 'raw.price': 'FREE', charges: '' },
  // 3: 2018 order whose summary total went negative (shipping discount shown x100)
  { ...base, orderId: '1000000612345', lineId: '1000000712345', purchasedAt: '2018-09-01 09:00:00', paidAt: '2018-09-01 09:00:00', status: 'Completed',
    title: 'Item C', quantity: '1', price: '$18.50', subtotal: '18.50', shippingFee: '1.49', discount: '298.00', orderTotal: '-133.12', 'raw.price': '$18.50',
    charges: 'Subtotal=$18.50 | Shipping Fee=$1.49 | Total Saving=-$149.00 | Shipping Fee Discount=-$149.00 | Total:=$15.88' },
  // 4: cancelled
  { ...base, orderId: '1000000812345', lineId: '1000000912345', purchasedAt: '2025-03-01 09:00:00', paidAt: '', status: 'Cancelled',
    title: 'Item D', quantity: '1', price: '$4.00', subtotal: '4.00', shippingFee: '', discount: '', orderTotal: '4.00', 'raw.price': '$4.00', charges: '' },
];
const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
  row.push(f); out.push(row); return out; };
const go = (cookie) => run({ src, interceptorSrc, host: 'my.lazada.sg', cmd: 'status', noCapture: true, captureRec: {}, cookie,
  preStore: { lzx_result: { rows, origin: 'https://my.lazada.sg', complete: true, at: 1 } } });
(async () => {
  const r = await go('lzd_uid=7712345');
  const [H, ...R] = parseCsv(r.csv.text.replace(/^﻿/, ''));
  const g = (l, k) => l[H.indexOf(k)]; const byOrder = (id) => R.find((l) => g(l, 'orderId') === id);
  assert.deepStrictEqual(H.slice(0, 5), ['marketplace', 'accountId', 'orderId', 'orderSn', 'lineId']);
  assert.ok(!/@/.test(r.csv.text), 'no email anywhere');
  assert.ok(!H.includes('raw.statusColor') && !H.includes('raw.isNonPdp') && !H.includes('raw.price') && !H.includes('_shopMatch'), 'UI flags, constants and raw copies dropped');
  assert.ok(R.every((l) => g(l, 'marketplace') === 'lazada.sg' && g(l, 'currency') === 'SGD' && g(l, 'accountId') === '7712345'));
  const a = byOrder('1000000112345');
  assert.deepStrictEqual(['price', 'lineTotal', 'subtotal', 'shippingFee', 'discount', 'orderTotal', 'totalsCheck', 'status'].map((k) => g(a, k)),
    ['15.00', '15.00', '15.00', '1.99', '9.99', '7.00', 'ok', 'completed']);
  const b = R.filter((l) => g(l, 'orderId') === '1000000312345');
  assert.deepStrictEqual(b.map((l) => [g(l, 'price'), g(l, 'lineTotal')]), [['8.30', '16.60'], ['0.00', '0.00']]);
  assert.deepStrictEqual(['paidAt', 'status', 'statusDetail', 'giftCardAmount', 'discount', 'totalsCheck'].map((k) => g(b[0], k)), ['', 'paid', '', '4.98', '0.00', 'ok']);
  const c = byOrder('1000000612345');
  assert.deepStrictEqual(['orderTotal', 'discount', 'totalsCheck'].map((k) => g(c, k)), ['15.88', '4.11', 'ok']);
  const d = byOrder('1000000812345');
  assert.deepStrictEqual(['status', 'totalsCheck'].map((k) => g(d, k)), ['cancelled', '']);
  for (const l of R) for (const k of ['price', 'lineTotal', 'subtotal', 'shippingFee', 'discount', 'orderTotal']) assert.ok(g(l, k) === '' || /^-?\d+\.\d\d$/.test(g(l, k)), k + ' numeric');
  // A cookie for another account (different trailing digits) never fills accountId.
  const r2 = await go('lzd_uid=7799999');
  const [H2, ...R2] = parseCsv(r2.csv.text.replace(/^﻿/, ''));
  assert.ok(R2.every((l) => l[H2.indexOf('accountId')] === ''), 'other account: blank');
  console.log('NORMALIZE PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
