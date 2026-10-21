// From-year: a newest-first list stops at the first page that is entirely older (synthetic).
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const ORDERS = Array.from({ length: 23 }, (_, i) => ({ id: String(1123000000000000 + i), lines: 1, status: 'Completed', cur: 'SGD', date: i < 10 ? 'Oct 2, 2026' : i < 20 ? 'Mar 1, 2015' : 'Mar 1, 2014' }));
const sym = (c) => (c === 'USD' ? '$' : 'SG$');
const orderEnt = (o) => ({ type: 'pc_om_list_order', fields: { orderId: o.id, orderDateText: o.date || 'Oct 2, 2026', statusText: o.status, storeName: 'Store', totalPriceText: `${sym(o.cur)}11.19`, currencyCode: o.cur, orderDetailUrl: `//www.aliexpress.com/p/order/detail.html?orderId=${o.id}`,
  orderLines: Array.from({ length: o.lines }, (_, j) => ({ orderLineId: o.id + '9' + j, productId: '328' + j, skuId: '1200' + j, itemTitle: `Item ${j}`, itemPriceText: `${sym(o.cur)}3.80`, quantity: 1, skuAttrs: [{ name: 'Color', text: 'Red' }] })) } });
const page = (n) => {
  const data = { pc_om_list_body_1: { type: 'pc_om_list_body', fields: { hasMore: n * 10 < ORDERS.length, pageIndex: n, pageSize: 10 } }, pc_om_list_header_action_2: { type: 'pc_om_list_header_action', fields: {} } };
  ORDERS.slice((n - 1) * 10, n * 10).forEach((o) => { data['pc_om_list_order_' + o.id] = orderEnt(o); });
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

run({ src, interceptorSrc, host: 'www.aliexpress.com', noCapture: true, captureRec: {}, mtop, pages: () => ({}), preStore: { lzx_from_year: 2020 },
  after: { capture: { url: 'https://www.aliexpress.com/x', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: '{}' } } })
.then((r) => {
  const rows = r.csv.text.replace(/^﻿/, '').split('\n').slice(1);
  console.log('posts', posts.join(' '), 'csv rows', rows.length, '|', r.st.log.filter((l) => /before 2020/.test(l)).join(' '));
  assert.ok(!posts.some((p) => p.startsWith('3:')), 'page 3 never read');
  assert.strictEqual(rows.length, 10, 'only the 2026 orders exported');
  console.log('FROM YEAR AE PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
