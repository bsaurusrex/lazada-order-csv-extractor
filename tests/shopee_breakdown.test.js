const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
// Detail sample shaped like a real response (payment + timing parts only), plus a voucher row and a second order.
const real = {"error": 0, "data": {"info_card": {"subtotal": 2189000, "final_total": 2189000, "parcel_cards": [{"payment_info": {"currency": "SGD", "total_price": 2189000, "info_rows": [{"info_label": {"text": "label_odp_merchandise_subtotal", "tl": false}, "info_value": {"value": "1990000", "type": 5, "style": 0}}, {"info_label": {"text": "label_odp_shipping", "tl": false, "attributes": [{"name": "shipping_carrier", "type": 1, "label": {"text": "Doorstep Delivery", "tl": false}}]}, "info_value": {"value": "199000", "type": 5, "style": 0}}]}}]}, "payment_method": {"payment_method": 1, "payment_channel_name": {"text": "Credit Card/Debit Card", "tl": true}, "can_change_payment_method": false}, "pc_processing_info": {"create_time": 1714560597, "shipping_confirm_time": 1714560654, "pay_time": 1714560653, "delivery_time": 1714736305, "complete_time": 1715646146, "order_payment_method": 1, "paid_amount": 2189000, "order_sn": "240501EXAMPLE5"}}};
const withVoucher = JSON.parse(JSON.stringify(real));
withVoucher.data.info_card.final_total = 1989000;
withVoucher.data.info_card.parcel_cards[0].payment_info.info_rows.push({ info_label: { text: 'label_odp_shop_voucher_applied' }, info_value: { value: '-200000', type: 5 } });
withVoucher.data.pc_processing_info.create_time = 1789463312;
const A = 100000000000101, B = 100000000000201;
const ord = (id, n) => ({ order_list_detail: { status: { status_label: { text: 'label_order_completed' } }, info_card: { order_id: id, subtotal: 2189000, final_total: 2189000, order_list_cards: [{ shop_info: { shop_id: 7, shop_name: 'Example Shop' }, product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 2, name: n, amount: 1, item_price: 1990000, order_price: 1990000 }] }] } }] } } });
const list = { error: 0, new_data: { order_or_checkout_data: [ord(B, 'Item B'), ord(A, 'Item A')], next_offset: -1 } };
// Previous export = the page-fallback rows you have now, already dated (version 3).
const domPrior = [{ _page: 1, _source: 'dom', lineId: `${A}-0`, orderId: String(A), title: 'Item A', price: '$19.90', purchasedAt: '2024-05-01 18:49:57', paidAt: '2024-05-01 18:50:53', paymentMethod: 'Credit Card/Debit Card', detailsVersion: '3' }];
run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg', preStore: { lzx_result_shopee: { rows: domPrior, origin: 'https://shopee.sg', complete: false } },
  captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?_oft=2064&limit=5&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(list) },
  pages: (u) => (u.includes('detail') ? (u.includes(String(A)) ? real : withVoucher) : list),
  after: { capture: { url: `https://shopee.sg/api/v4/order/get_order_detail?_oft=2064&order_id=${A}`, method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(real) } } })
.then((r) => {
  console.log('log:', r.st.log.filter((l) => /Replacing|Updated|Detail pass/.test(l)).join(' || '));
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  for (const l of rows) { const c = l.split(','); console.log('  ', ['_source', 'orderId', 'orderSn', 'title', 'purchasedAt', 'subtotal', 'shippingFee', 'discount', 'orderTotal', 'paymentMethod', 'detailsVersion'].map((k) => `${k}=${c[H.indexOf(k)]}`).join(' ')); }
  assert.ok(r.csv.text.includes('240501EXAMPLE5'), 'orderSn filled'); assert.strictEqual(r.st.rows, 2, 'no duplicate dom rows'); assert.ok(!r.csv.text.includes(',dom,'));
  console.log('BREAKDOWN PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
