// Amazon end to end with synthetic pages shaped like amazon.sg (no real data).
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
run({ src, interceptorSrc, host: 'www.amazon.sg', noCapture: true, captureRec: {}, cookie: '',
  pageHtml: `<script>var cfg={"marketplaceID":"AEXAMPLEMKT01","customerID":"${CUST}"};</script>`,
  pages: (u) => { const url = new URL(u); if (url.pathname.includes('order-details')) return detail(url.searchParams.get('orderID'));
    const tf = url.searchParams.get('timeFilter'); return listPage(tf ? tf.slice(5) : 2026, Number(url.searchParams.get('startIndex') || 0)); } })
.then((r) => {
  // Proper CSV parsing: titles can contain commas.
  const parseCsv = (txt) => { const out = []; let row = [], f = '', q = false;
    for (let i = 0; i < txt.length; i++) { const c = txt[i];
      if (q) { if (c === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else f += c; }
    row.push(f); out.push(row); return out; };
  const [H, ...rows] = parseCsv(r.csv.text.replace(/^\uFEFF/, ''));
  const g = (l, k) => l[H.indexOf(k)];
  console.log('log:', r.st.log.filter((l) => /Using|Page|Done/.test(l)).map((l) => l.slice(l.indexOf('  ') + 2)).join(' || '));
  console.log('rows', r.st.rows, 'orders', r.st.orders, 'undated', r.st.undated, 'files', r.downloads.join(' '), 'popup', r.st.account);
  console.log('row:', ['accountId', 'orderId', 'purchasedAt', 'title', 'itemId', 'quantity', 'price', 'lineTotal', 'shopName', 'subtotal', 'shippingFee', 'tax', 'discount', 'giftCardAmount', 'orderTotal', 'currency', 'status'].map((k) => `${k}=${g(rows[0], k)}`).join(' '));
  assert.strictEqual(r.st.orders, 15); assert.strictEqual(r.st.rows, 31); assert.strictEqual(r.st.undated, 0);
  const fr = rows.filter((l) => g(l, 'statusDetail') === 'Amazon Fresh');
  assert.strictEqual(fr.length, 3, 'fresh items read');
  console.log('fresh:', fr.map((l) => ['purchasedAt','status','orderTotal','tax','subtotal','shippingFee','charges'].map((k) => k + '=' + g(l, k)).join(' ')).join(' || '));
  assert.ok(fr.every((l) => g(l, 'purchasedAt') === '2026-03-13' && g(l, 'status') === '' && g(l, 'orderTotal') === '17.53' && g(l, 'tax') === '1.53' && g(l, 'discount') === '1.00' && g(l, 'refundAmount') === '3.00'), 'fresh date/total/tax/discount/OOS, hidden alert ignored');
  assert.deepStrictEqual(fr.map((l) => `${g(l, 'itemId')}x${g(l, 'quantity')}@${g(l, 'price')}`), ['B0EXAMPLE3x2@5.00', 'B0EXAMPLE4x1@3.00', 'B0EXAMPLE5x1@3.00']);
  assert.ok(rows.every((l) => g(l, 'accountId') === CUST), 'customer ID on every row, not the marketplace ID');
  assert.ok(!/Example Street|Account One|AEXAMPLEMKT01/.test(r.csv.text), 'no address, no marketplace id');
  for (const id of [...new Set(rows.map((l) => g(l, 'orderId')))]) {
    const rs = rows.filter((l) => g(l, 'orderId') === id); const f = (k) => Number(g(rs[0], k) || 0);
    assert.ok(Math.abs(rs.reduce((s, l) => s + Number(g(l, 'lineTotal')), 0) - f('refundAmount') - f('subtotal')) < 0.011, 'lines - OOS = subtotal ' + id);
    assert.ok(Math.abs(f('subtotal') + f('shippingFee') + f('tax') - f('discount') - f('giftCardAmount') - f('orderTotal')) < 0.011, 'reconciles ' + id);
  }
  assert.strictEqual(rows.filter((l) => g(l, 'status') === 'cancelled').length, 4, 'two cancelled orders flagged (2 items each)');
  assert.ok(rows.some((l) => g(l, 'quantity') === '2'));
  console.log('AMAZON PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
