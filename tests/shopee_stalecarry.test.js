const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const ID = 100000000000401;
const ord = { order_list_detail: { status: { status_label: { text: 'label_order_completed' } }, info_card: { order_id: ID, final_total: 2730000, order_list_cards: [{ shop_info: { shop_id: 1, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 1, name: 'Item C', amount: 1, item_price: 100000, order_price: 100000 }] }] } }] } } };
const list = { error: 0, new_data: { order_or_checkout_data: [ord], next_offset: -1 } };
const detail = { error: 0, data: { pc_shipping: { forder_shipping_info_list: [{ tracking_number: '', masked_carrier: { text: 'Doorstep Delivery' }, tracking_info_list: [{ ctime: 1767863625, milestone: { text: 'Order placed' }, description: 'Order is placed' }] }], num_parcels: 1 },
  info_card: { final_total: 2730000, amount_paid: 2730000 }, payment_method: { payment_channel_name: { text: 'Card' } },
  pc_processing_info: { create_time: 1767863625, pay_time: 1767863629, shipping_confirm_time: 1767863630, delivery_time: 1767867470, complete_time: 1768187953, order_sn: '260108EXAMPLE4' } } };
// Previous export: version 8 with the stale deliveredAt (== shipped time).
const prior = [{ _source: 'shopee-api', accountId: '100000001', orderId: String(ID), lineId: '1-1-0', title: 'Item C', purchasedAt: '2026-01-08 17:13:45', shippedAt: '2026-01-08 18:17:50', deliveredAt: '2026-01-08 18:17:50', detailsVersion: '8' }];
run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg', preStore: { lzx_result_shopee: { rows: prior, origin: 'https://shopee.sg', complete: true } },
  captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(list) },
  pages: (u) => (u.includes('detail') ? detail : list), cmd: 'details',
  after: { capture: { url: `https://shopee.sg/api/v4/order/get_order_detail?_oft=2064&order_id=${ID}`, method: 'GET', reqHeaders: { 'x-api-source': 'pc' }, reqBody: null, status: 200, body: JSON.stringify(detail) } } })
.then((r) => {
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(','); const c = rows[0].split(',');
  const g = (k) => c[H.indexOf(k)];
  console.log(`shippedAt=${g('shippedAt')} deliveredAt="${g('deliveredAt')}" completedAt=${g('completedAt')} detailsVersion=${g('detailsVersion')}`);
  assert.strictEqual(g('deliveredAt'), ''); assert.strictEqual(g('shippedAt'), '2026-01-08 18:17:50'); assert.strictEqual(g('detailsVersion'), '9');
  console.log('STALE-CARRY PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
