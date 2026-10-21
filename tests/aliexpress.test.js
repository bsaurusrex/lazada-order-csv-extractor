const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const ORDERS = Array.from({ length: 23 }, (_, i) => ({ id: String(1123000000000000 + i), lines: i % 4 === 1 ? 2 : 1, status: i === 5 ? 'Canceled ' : 'Completed', cur: i > 18 ? 'USD' : 'SGD' }));
const sym = (c) => (c === 'USD' ? '$' : 'SG$');
const orderEnt = (o) => ({ type: 'pc_om_list_order', fields: { orderId: o.id, orderDateText: 'Oct 2, 2026', statusText: o.status, storeName: 'Store', totalPriceText: `${sym(o.cur)}11.19`, currencyCode: o.cur, orderDetailUrl: `//www.aliexpress.com/p/order/detail.html?orderId=${o.id}`,
  orderLines: Array.from({ length: o.lines }, (_, j) => ({ orderLineId: o.id + '9' + j, productId: '328' + j, skuId: '1200' + j, itemTitle: `Item ${j}`, itemPriceText: `${sym(o.cur)}3.80`, quantity: 1, skuAttrs: [{ name: 'Color', text: 'Red' }] })) } });
const page = (n) => {
  const data = { pc_om_list_body_1: { type: 'pc_om_list_body', fields: { hasMore: n * 10 < ORDERS.length, pageIndex: n, pageSize: 10 } }, pc_om_list_header_action_2: { type: 'pc_om_list_header_action', fields: {} } };
  ORDERS.slice((n - 1) * 10, n * 10).forEach((o) => { data['pc_om_list_order_' + o.id] = orderEnt(o); });
  if (n === 2) data['pc_om_list_order_' + ORDERS[9].id] = orderEnt(ORDERS[9]);   // page-edge repeat, as seen live
  return { ret: ['SUCCESS::ok'], data: { data, linkage: { signature: 'sig' + n }, hierarchy: { structure: {} }, endpoint: { mode: 'pc' } } };
};
const posts = [];
const mtop = (o) => {
  if (o.api === 'mtop.aliexpress.trade.buyer.order.list') {
    if (o.type !== 'POST') return page(1);
    const p = JSON.parse(o.data.params); const pi = JSON.parse(p.data).pc_om_list_body_1.fields.pageIndex;
    posts.push(`${pi}:${JSON.parse(p.linkage).signature}`); return page(pi);
  }
  if (o.api === 'mtop.aliexpress.trade.buyer.order.detail') return { ret: ['SUCCESS::ok'], data: { data: {
    a: { type: 'detail_simple_order_info_component', fields: { orderCreatTime: 'Oct 2, 2026', payTime: 'Oct 2, 2026', orderShipTime: 'Oct 5, 2026', orderEndTime: 'Oct 12, 2026', paymentMethod: 'Credit/Debit card', addressVO: { detailAddress: 'SECRET ADDRESS' } } },
    b: { type: 'detail_order_price_block', fields: { priceDetails: [{ title: 'Subtotal', value: 'SG$7.60' }, { title: 'Shipping', value: 'SG$2.67' }, { title: 'Tax', value: 'SG$0.92' }], totalPrice: { value: 'SG$11.19' } } } } } };
  if (o.api === 'mtop.ae.ld.querydetail') return { ret: ['SUCCESS::ok'], data: { module: { trackingDetailLineList: [{ mailNo: 'SPQSHK000000001', logisticsCarrierName: 'AliExpress Selection Standard', detailList: [
    { time: 1791542543000, trackingDetailDesc: 'Package delivered.', trackingPrimaryCode: 'AE_GTMS_SIGNED' }, { time: 1790912799239, trackingDetailDesc: "Your order's been created" }] }] } } };
  return { ret: ['FAIL'] };
};
run({ src, interceptorSrc, host: 'www.aliexpress.com', noCapture: true, captureRec: {}, mtop, pages: () => ({}),
  after: { capture: { url: 'https://www.aliexpress.com/x', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: '{}' } } })
.then((r) => {
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  const g = (l, k) => l.split(',')[H.indexOf(k)];
  console.log('LOG:', r.st.log.slice(-5).join(' || '));
  console.log('rows', r.st.rows, 'orders', r.st.orders, 'undated', r.st.undated, '| posts', posts.join(' '), '| files', r.downloads.join(' '));
  console.log('row:', ['purchasedAt', 'paidAt', 'shippedAt', 'deliveredAt', 'completedAt', 'carrier', 'trackingNumber', 'subtotal', 'shippingFee', 'tax', 'orderTotal'].map((k) => `${k}=${g(rows[0], k)}`).join(' '));
  const cx = rows.find((l) => g(l, 'status') === 'cancelled' && g(l, 'statusDetail') === 'Canceled');
  assert.strictEqual(r.st.rows, ORDERS.reduce((n, o) => n + o.lines, 0)); assert.strictEqual(r.st.orders, 23); assert.strictEqual(r.st.undated, 0);
  assert.deepStrictEqual(posts, ['2:sig1', '3:sig2']); assert.ok(!/SECRET ADDRESS/.test(r.csv.text));
  assert.ok(cx && g(cx, 'cancelledAt') === '2026-10-12' && g(cx, 'completedAt') === '');
  console.log('ALIEXPRESS PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
