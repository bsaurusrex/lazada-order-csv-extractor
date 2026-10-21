// amazon.com: an order charged in SGD with USD item prices, plus a plain USD order (synthetic, no real data).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const CUST = 'A1EXAMPLEACCT2';
const IDS = ['111-1000001-2000001', '111-1000002-2000002'];
const list = `<html><head><script>var cfg={"customerID":"${CUST}"};</script></head><body>
  <select><option value="year-2026">2026</option></select>
  ${IDS.map((id) => `<div data-csa-c-slot-id="amzn1.yourorders.order-card.${id}"></div>`).join('')}</body></html>`;
const item = (t, p) => `<div class="a-fixed-left-grid"><div data-component="itemTitle"><a href="/dp/B0EXAMPLE9">${t}</a></div>
  <div data-component="unitPrice">${p}</div><div data-component="quantity"></div><div data-component="orderedMerchant">Sold by: Example Seller</div></div>`;
const sgd = `<html><body><div data-component="orderDate">5 April 2026</div><div data-component="shipments">${item('Example gadget', '$19.98')}</div>
  <div data-component="chargeSummary">
    <div class="a-row">Item(s) Subtotal: S$26.97</div><div class="a-row">Shipping &amp; Handling: S$8.00</div>
    <div class="a-row">Free Shipping -S$8.00</div><div class="a-row">Exchange rate guarantee fee: S$0.81</div>
    <div class="a-row">Total before tax: S$27.78</div><div class="a-row">Estimated tax to be collected: S$2.43</div>
    <div class="a-row">Grand Total: S$30.21</div>
    <div class="a-row">Exchange rate</div><div class="a-row">1 USD = 1.3500 SGD</div>
    <div class="a-row">Payment Grand Total: S$30.21</div></div></body></html>`;
const usd = `<html><body><div data-component="orderDate">6 April 2026</div><div data-component="shipments">${item('Example cable', '$9.99')}</div>
  <div data-component="chargeSummary">
    <div class="a-row">Item(s) Subtotal: $9.99</div><div class="a-row">Shipping &amp; Handling: $5.00</div>
    <div class="a-row">Free Shipping -$5.00</div><div class="a-row">Amazon Move Promo: -$1.00</div><div class="a-row">Import Fees Deposit: $1.20</div>
    <div class="a-row">Grand Total: $10.19</div></div></body></html>`;
run({ src, interceptorSrc, host: 'www.amazon.com', noCapture: true, captureRec: {}, cookie: '',
  pageHtml: `<script>var cfg={"customerID":"${CUST}"};</script>`,
  pages: (u) => { const url = new URL(u); if (url.pathname.includes('order-details')) return url.searchParams.get('orderID') === IDS[0] ? sgd : usd; return list; } })
.then((r) => {
  const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false;
    for (let i = 0; i < txt.length; i++) { const c = txt[i];
      if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
    row.push(f); out.push(row); return out; };
  const [H, ...rows] = parseCsv(r.csv.text.replace(/^﻿/, '')).filter((l) => l.length > 1);
  const g = (l, k) => l[H.indexOf(k)];
  const K = ['orderId', 'price', 'subtotal', 'shippingFee', 'tax', 'discount', 'otherFees', 'orderTotal', 'currency', 'itemCurrency', 'exchangeRate', 'amountPaid', 'paymentCurrency'];
  for (const l of rows) console.log(K.map((k) => `${k}=${g(l, k)}`).join(' '));
  const a = rows.find((l) => g(l, 'orderId') === IDS[0]); const b = rows.find((l) => g(l, 'orderId') === IDS[1]);
  assert.strictEqual(g(a, 'currency'), 'SGD'); assert.strictEqual(g(a, 'itemCurrency'), 'USD');
  assert.strictEqual(g(a, 'exchangeRate'), '1.3500 USD->SGD'); assert.strictEqual(g(a, 'otherFees'), '0.81');
  assert.strictEqual(g(a, 'discount'), '8.00'); assert.strictEqual(g(a, 'tax'), '2.43');
  assert.strictEqual(g(a, 'amountPaid'), '30.21'); assert.strictEqual(g(a, 'paymentCurrency'), 'SGD');
  assert.strictEqual(g(b, 'currency'), 'USD'); assert.strictEqual(g(b, 'itemCurrency'), ''); assert.strictEqual(g(b, 'exchangeRate'), '');
  assert.strictEqual(g(b, 'discount'), '6.00'); assert.strictEqual(g(b, 'shippingFee'), '5.00'); assert.strictEqual(g(b, 'otherFees'), '1.20');
  for (const l of [a, b]) { const f = (k) => Number(g(l, k) || 0);
    assert.ok(Math.abs(f('subtotal') + f('shippingFee') + f('tax') + f('otherFees') - f('discount') - f('giftCardAmount') - f('orderTotal')) < 0.011, 'reconciles ' + g(l, 'orderId')); }
  assert.ok(!/A1EXAMPLEACCT2/.test('') && rows.every((l) => g(l, 'accountId') === CUST));
  console.log('AMAZON US PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
