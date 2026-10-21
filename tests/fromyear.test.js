// From-year setting: Amazon skips earlier years; saved rows are left out, not deleted (synthetic).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const CUST = 'A1EXAMPLEACCT1';
const ID = (n) => `111-${String(1000000 + n)}-${String(2000000 + n)}`;
const YEARS = { 2026: 12, 2025: 3 };   // 12 -> two list pages
const all = []; for (const [y, n] of Object.entries(YEARS)) for (let i = 0; i < n; i++) all.push({ y, id: ID(Number(y) * 100 + i) });
const listPage = (y, start) => {
  const ids = all.filter((o) => o.y === String(y)).slice(start, start + 10);
  // card bodies are encrypted on the real site: only the slot id is plain
  return `<html><head><script>var cfg={"marketplaceID":"AEXAMPLEMKT01","customerID":"${CUST}"};</script></head><body>
    <select name="timeFilter"><option value="last30">x</option><option value="year-2026">2026</option><option value="year-2025">2025</option></select>
    ${ids.map((o) => `<div class="order-card js-order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.${o.id}"><script>/* Siege ciphertext */ var x="captcha";</script></div>`).join('')}
  </body></html>`;
};
const freshDetail = () => `<html><body>
  <div id="ufpo-order-status-primary">Arriving today</div>
  <div id="ufpo-order-status-secondary">Amazon Fresh delivery Ordered on Friday, 13 March 2026</div>
  <div id="ufpo-od-item-list-section"><div class="a-row ufpo-item-list-table">
    <div class="a-row"><span>Example grocery item, 6 x 1l</span><div class="a-column">2</div><span id="B0EXAMPLE3-item-total-price">S$10.00</span></div>
    <div class="a-row"><span>Example snack, 100g</span><div class="a-column">1</div><span id="B0EXAMPLE4-item-total-price">S$3.00</span></div>
    <div class="a-row"><span>Example out-of-stock item</span><div class="a-column">1</div><span id="B0EXAMPLE5-item-total-price">S$3.00</span></div>
  </div></div>
  <div id="ufpo-cancel-order-failure-alert" class="a-alert-content">Sorry, your order could not be cancelled.</div>
  <div class="a-row"><span>OOS (1)</span><span>-S$3.00</span></div>
  <div class="a-row"><span>Item(s) Subtotal:</span><span>S$13.00</span></div>
  <div class="a-row"><span>Delivery fee:</span><span>S$4.00</span></div>
  <div class="a-row"><span>Total Before GST:</span><span>S$17.00</span></div>
  <div class="a-row"><span>GST:</span><span>S$1.53</span></div>
  <div class="a-row"><span>Deals and Discounts</span><span>-S$1.00</span></div>
  <div class="a-row"><span>Grand Total:</span><span class="a-text-bold">S$17.53</span></div>
</body></html>`;
const detail = (id) => {
  if (id.endsWith('2202502')) return freshDetail();
  const n = Number(id.slice(-2));
  const qty = n % 3 === 0 ? 2 : 1;
  const cancelled = n === 1;
  const sub = (12.5 * qty) + 3.0;
  return `<html><body>
    ${cancelled ? '<div data-component="alerts"><div class="a-alert-content">This order has been cancelled.</div></div>' : ''}
    <div data-component="orderDate">12 March 2026</div>
    <div data-component="shippingAddress">Account One<br>1 Example Street</div>
    <div data-component="shipments">
      <div class="a-fixed-left-grid"><div class="a-fixed-left-grid-col img-col"><img src="https://example.com/x.jpg"><div class="od-item-view-qty"><span>${qty > 1 ? qty : ''}</span></div></div>
      <div class="a-fixed-left-grid-col"><div data-component="itemTitle"><a href="/dp/B0EXAMPLE1?ref=x">Example item one</a></div>
        <div data-component="unitPrice"><span class="a-offscreen">S$12.50</span><span>S$12.50</span></div><div data-component="quantity"></div>
        <div data-component="orderedMerchant">Sold by: Example Seller</div></div></div>
      <div class="a-fixed-left-grid-col"><div data-component="itemTitle"><a href="/dp/B0EXAMPLE2">Example item two</a></div>
        <div data-component="unitPrice">S$3.00</div><div data-component="quantity"></div><div data-component="orderedMerchant">Sold by: Amazon</div></div>
    </div>
    <div data-component="chargeSummary">
      <div class="a-row">Item(s) Subtotal: S$${sub.toFixed(2)}</div><div class="a-row">Delivery: S$2.00</div>
      <div class="a-row">Total Before GST: S$${(sub + 2).toFixed(2)}</div><div class="a-row">Estimated GST: S$1.50</div>
      <div class="a-row">Promotion(s) Applied: -S$2.00</div><div class="a-row">Gift Card Amount: -S$1.00</div>
      <div class="a-row">Grand Total: S$${(sub + 2 + 1.5 - 2 - 1).toFixed(2)}</div></div>
  </body></html>`;
};

const pages = (u) => { const url = new URL(u); if (url.pathname.includes('order-details')) return detail(url.searchParams.get('orderID'));
  const tf = url.searchParams.get('timeFilter'); return listPage(tf ? tf.slice(5) : 2026, Number(url.searchParams.get('startIndex') || 0)); };
(async () => {
  const r = await run({ src, interceptorSrc, host: 'www.amazon.sg', noCapture: true, captureRec: {}, cookie: '',
    pageHtml: `<script>var cfg={"customerID":"${CUST}"};</script>`, pages, preStore: { lzx_from_year: 2026 } });
  const listed = r.fetched.map((f) => String(f.url || f)).filter((u) => /timeFilter=year-/.test(u));
  console.log('orders', r.st.orders, 'year pages read', [...new Set(listed.map((u) => u.match(/year-(\d{4})/)[1]))].join(','), 'log', r.st.log.filter((l) => /Skipping/.test(l)).join(''));
  assert.ok(!listed.some((u) => /year-2025/.test(u)), '2025 never listed');
  assert.ok(!r.fetched.some((f) => /orderID=111-12025\d\d-/.test(String(f.url || f))), 'no 2025 detail read');
  assert.strictEqual(r.st.orders, 12);
  const saved = r.store.lzx_result_amazon_sg;
  assert.ok(saved.complete === true && saved.coveredFrom === 2026, 'complete from 2026 on');
  // Saved rows from a wider export: rows before the cutoff are left out of the CSV, kept in storage.
  const rows = [
    { orderId: 'A1', lineId: 'A1', purchasedAt: '2015-06-01', price: '1.00', quantity: '1', currency: 'SGD' },
    { orderId: 'A2', lineId: 'A2', purchasedAt: '2017-01-01', price: '2.00', quantity: '1', currency: 'SGD' },
    { orderId: 'A3', lineId: 'A3', purchasedAt: '', price: '3.00', quantity: '1', currency: 'SGD' },
  ];
  const r2 = await run({ src, interceptorSrc, host: 'www.amazon.sg', cmd: 'status', noCapture: true, captureRec: {}, cookie: '',
    preStore: { lzx_from_year: 2017, lzx_result_amazon_sg: { rows, origin: 'https://www.amazon.sg', complete: true, at: 1 } } });
  const ids = r2.csv.text.split('\n').slice(1).map((l) => l.split(',')[2]);
  console.log('csv orders', ids.join(','), 'status leftOut', r2.st0.leftOut, 'fromYear', r2.st0.fromYear);
  assert.deepStrictEqual(ids, ['A2', 'A3'], '2015 left out, undated kept');
  assert.strictEqual(r2.store.lzx_result_amazon_sg.rows.length, 3, 'nothing deleted');
  assert.strictEqual(r2.st0.leftOut, 1);
  const r3 = await run({ src, interceptorSrc, host: 'www.amazon.sg', cmd: 'status', noCapture: true, captureRec: {}, cookie: '',
    preStore: { lzx_result_amazon_sg: { rows, origin: 'https://www.amazon.sg', complete: true, at: 1 } } });
  assert.strictEqual(r3.csv.text.split('\n').length - 1, 3, 'no setting: all rows');
  console.log('FROM YEAR PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
