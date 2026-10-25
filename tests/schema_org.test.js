// schema.org export: standard Order/OrderItem/Offer properties, and the CSV's rows back exactly (synthetic, no real data).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const { rowsFromSchemaOrg } = require(require('path').resolve(E, 'schema-org.js'));
const base = { _shopMatch: 'lineId', 'raw.buyerEmail': 'account1@example.com', shopName: 'Example Shop', sellerId: '900', currency: '' };
const rows = [
  { ...base, orderId: '1000000112345', lineId: '1000000212345', purchasedAt: '2025-01-02 10:00:00', status: 'Completed',
    title: 'Item A', variation: 'Blue', quantity: '2', price: '$5.00', subtotal: '10.00', shippingFee: '1.99', orderTotal: '11.99', paymentMethod: 'Visa ending 1234',
    itemUrl: '//www.lazada.sg/products/a.html', charges: 'Subtotal=$10.00 | Shipping Fee=$1.99 | Total:=$11.99' },
  { ...base, orderId: '1000000112345', lineId: '1000000312345', purchasedAt: '2025-01-02 10:00:00', status: 'Completed', itemStatus: 'Refund issued',
    title: 'Item B', quantity: '1', price: 'FREE', subtotal: '10.00', shippingFee: '1.99', orderTotal: '11.99', paymentMethod: 'Visa ending 1234', charges: 'Subtotal=$10.00 | Shipping Fee=$1.99 | Total:=$11.99' },
  { ...base, orderId: '1000000812345', lineId: '1000000912345', purchasedAt: '2025-03-01 09:00:00', status: 'Cancelled',
    title: 'Item C', quantity: '1', price: '$4.00', subtotal: '4.00', orderTotal: '4.00', charges: '' },
];
const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
  row.push(f); out.push(row); return out; };
(async () => {
  const r = await run({ src, interceptorSrc, host: 'my.lazada.sg', cmd: 'status', noCapture: true, captureRec: {}, cookie: 'lzd_uid=7712345', schemaOrg: true,
    preStore: { lzx_result: { rows, origin: 'https://my.lazada.sg', complete: true, at: 1 } } });
  assert.ok(r.json.name.endsWith('.jsonld') && r.json.mime === 'application/ld+json');
  const doc = JSON.parse(r.json.text);
  assert.ok(!/@example/.test(r.json.text), 'no email anywhere');
  const [o1, o2] = doc['@graph'];
  assert.strictEqual(doc['@graph'].length, 2);
  assert.strictEqual(o1['@type'], 'Order');
  assert.strictEqual(o1.orderNumber, '1000000112345');
  assert.strictEqual(o1.orderDate, '2025-01-02T10:00:00');
  assert.strictEqual(o1.orderStatus, 'https://schema.org/OrderDelivered');
  assert.deepStrictEqual(o1.broker, { '@type': 'Organization', name: 'Lazada', url: 'https://www.lazada.sg' });
  assert.deepStrictEqual(o1.customer, { '@type': 'Person', identifier: '7712345' });
  assert.strictEqual(o1.seller.name, 'Example Shop');
  assert.deepStrictEqual(o1.partOfInvoice.totalPaymentDue, { '@type': 'PriceSpecification', price: 11.99, priceCurrency: 'SGD' });
  assert.strictEqual(o1.orderedItem.length, 2);
  assert.strictEqual(o1.orderedItem[0].orderedItem.name, 'Item A');
  assert.strictEqual(o1.orderedItem[0].orderedItem.description, 'Blue');
  assert.strictEqual(o1.orderedItem[0].orderedItem.url, 'https://www.lazada.sg/products/a.html');
  assert.strictEqual(o1.orderedItem[0].orderQuantity, 2);
  assert.deepStrictEqual(o1.acceptedOffer.map((x) => [x.price, x.priceCurrency, x.eligibleQuantity.value]), [[5, 'SGD', 2], [0, 'SGD', 1]]);
  assert.strictEqual(o2.orderStatus, 'https://schema.org/OrderCancelled');
  // Every CSV row comes back, column for column.
  const csv = await run({ src, interceptorSrc, host: 'my.lazada.sg', cmd: 'status', noCapture: true, captureRec: {}, cookie: 'lzd_uid=7712345',
    preStore: { lzx_result: { rows, origin: 'https://my.lazada.sg', complete: true, at: 1 } } });
  const [H, ...R] = parseCsv(csv.csv.text.replace(/^﻿/, ''));
  const want = R.map((l) => Object.fromEntries(H.map((k, i) => [k, l[i]]).filter(([, v]) => v !== '')));
  const key = (x) => JSON.stringify(Object.keys(x).sort().map((k) => [k, x[k]]));
  assert.deepStrictEqual(rowsFromSchemaOrg(doc).map(key).sort(), want.map(key).sort());
  console.log('SCHEMA ORG PASSED'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
