// AliExpress: "Spend & save" is a discount; a hidden, uncharged shipping line is not charged (synthetic).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const row = (o) => ({ accountId: '100000001', currency: 'SGD', status: 'Completed', quantity: '1', detailsVersion: 'ae1', ...o });
const rows = [
  row({ orderId: '800000000000001', lineId: '1', price: '44.13', lineTotal: '44.13', subtotal: '44.13', shippingFee: '0.00', tax: '3.20', discount: '', orderTotal: '43.14',
    charges: 'Subtotal=S$44.13 | Shipping=Free shipping | Spend & save=-S$4.19 | Tax=S$3.20' }),
  row({ orderId: '800000000000002', lineId: '2', price: '47.56', lineTotal: '47.56', subtotal: '47.56', shippingFee: '0.02', tax: '4.28', discount: '', orderTotal: '51.84',
    charges: 'Subtotal=S$47.56 | Shipping=S$0.02 | Tax=S$4.28' }),
  row({ orderId: '800000000000003', lineId: '3', price: '20.00', lineTotal: '20.00', subtotal: '20.00', shippingFee: '1.50', tax: '1.80', discount: '', orderTotal: '23.30',
    charges: 'Subtotal=S$20.00 | Shipping=S$1.50 | Tax=S$1.80' }),
];
run({ src, interceptorSrc, host: 'www.aliexpress.com', cmd: 'status', noCapture: true, captureRec: {},
  preStore: { lzx_result_aliexpress: { rows, origin: 'https://www.aliexpress.com', complete: true, at: 1 } } })
.then((r) => {
  const [h, ...R] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  const g = (id, k) => { const l = R.map((x) => x.split(',')).find((c) => c[H.indexOf('orderId')] === id); return l[H.indexOf(k)]; };
  assert.deepStrictEqual(['discount', 'totalsCheck'].map((k) => g('800000000000001', k)), ['4.19', 'ok']);
  assert.deepStrictEqual(['shippingFee', 'totalsCheck'].map((k) => g('800000000000002', k)), ['0.00', 'ok']);
  assert.deepStrictEqual(['shippingFee', 'discount', 'totalsCheck'].map((k) => g('800000000000003', k)), ['1.50', '', 'ok'], 'charged shipping kept, no discount stays blank');
  console.log('AE NORMALIZE PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
