const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const row = (t, v) => ({ info_label: { text: t }, info_value: { value: String(v), type: 8 } });
const money = (t, v) => ({ info_label: { text: t }, info_value: { value: String(v), type: 5 } });
const NEW = 100000000000201, CXL = 100000000000301, OLD = 100000000000101;
const details = {
  [NEW]: { error: 0, data: { status: { status_label: { text: 'label_order_completed' } },
    shipping: { fulfilment_carrier: { text: 'Express Doorstep Delivery (International)' }, tracking_number: 'SPXSG000000000001', tracking_info: { ctime: 1789979004, description: 'Your parcel has been delivered' }, num_parcels: 1 },
    info_card: { final_total: 557000, amount_paid: 557000, parcel_cards: [{ payment_info: { info_rows: [money('label_odp_merchandise_subtotal', 557000), money('label_odp_shipping', 199000), money('label_odp_shipping_discount_subtotal', -199000)] } }] },
    payment_method: { payment_channel_name: { text: 'Credit/Debit Card' } },
    processing_info: { order_sn: '260915EXAMPLE1', info_rows: [row('label_odp_order_time', 1789463312), row('label_odp_payment_time', 1789463315), row('label_odp_ship_time', 1789536408), row('label_odp_completed_time', 1790586037)] } } },
  [CXL]: { error: 0, data: { status: { status_label: { text: 'label_order_cancelled' }, header_text: { text: 'order_status_text_cancelled_by_system' }, list_view_extra_cancel_info: { cancel_reason: { text: 'label_cancel_order_reason_admin_100' } } },
    shipping: { masked_carrier: { text: 'Doorstep Delivery' }, tracking_number: '', tracking_info: { ctime: 0, description: '' }, num_parcels: 1 },
    info_card: { final_total: 2000000, amount_paid: 0, parcel_cards: [{ payment_info: { info_rows: [money('label_odp_merchandise_subtotal', 2000000), money('label_odp_shipping', 199000), money('label_odp_shipping_discount_subtotal', -199000)] } }] },
    payment_method: { payment_channel_name: { text: 'Credit Card/Debit Card' } },
    processing_info: { order_sn: '251123EXAMPLE2', info_rows: [row('label_odp_order_time', 1763866897), row('label_odp_cancelled_time', 1763881298)] } } },
  // Older layout, shaped like a real detail response (payment + timing + shipping parts).
  [OLD]: { error: 0, data: { status: { status_label: { text: 'label_order_completed' } },
    pc_shipping: { forder_shipping_info_list: [{ tracking_number: 'NV123', fulfilment_carrier: { text: 'Ninja Van (Home Delivery)' }, masked_carrier: { text: 'Doorstep Delivery' }, tracking_info_list: [{ ctime: 1714800000, milestone: { text: 'Delivered' }, description: 'Your parcel has been delivered' }, { ctime: 1714760000, milestone: { text: 'In transit' }, description: 'Out for delivery' }, { ctime: 1714560597, milestone: { text: 'Order placed' }, description: 'Order is placed' }] }], num_parcels: 1, masked_carrier: { text: 'Doorstep Delivery' }, fulfilment_carrier: { text: 'Ninja Van (Home Delivery)' } },
    info_card: { subtotal: 2189000, final_total: 2189000, amount_paid: 2189000, parcel_cards: [{ payment_info: { info_rows: [money('label_odp_merchandise_subtotal', 1990000), money('label_odp_shipping', 199000)] } }] },
    payment_method: { payment_channel_name: { text: 'Credit Card/Debit Card' } }, coins: { coin_earn: 150000000 },
    pc_processing_info: { create_time: 1714560597, shipping_confirm_time: 1714560654, pay_time: 1714560653, delivery_time: 1714736305, complete_time: 1715646146, paid_amount: 2189000, order_sn: '240501EXAMPLE3' } } },
};
const ord = (id, st) => ({ order_list_detail: { status: { status_label: { text: st } }, info_card: { order_id: id, final_total: 557000, order_list_cards: [{ shop_info: { shop_id: 1, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 1, name: 'X', amount: 1, item_price: 100000, order_price: 100000 }] }] } }] } } });
const list = { error: 0, new_data: { order_or_checkout_data: [ord(NEW, 'label_order_completed'), ord(CXL, 'label_order_cancelled'), ord(OLD, 'label_order_completed')], next_offset: -1 } };
run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg',
  captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(list) },
  pages: (u) => (u.includes('detail') ? details[new URL(u).searchParams.get('order_id')] : list),
  after: { capture: { url: `https://shopee.sg/api/v4/order/get_order_detail?_oft=2064&order_id=${NEW}`, method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(details[NEW]) } } })
.then((r) => {
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  console.log('column order:', H.slice(0, 22).join(','));
  const K = ['orderId', 'orderSn', 'status', 'purchasedAt', 'paidAt', 'shippedAt', 'deliveredAt', 'completedAt', 'cancelledAt', 'cancelReason', 'carrier', 'trackingNumber', 'parcels', 'amountPaid', 'coinsEarned', 'subtotal', 'shippingFee', 'discount', 'orderTotal', 'paymentMethod'];
  for (const l of rows) { const c = l.split(','); console.log(' ', K.map((k) => `${k}=${c[H.indexOf(k)]}`).join(' ')); }
  const get = (id, k) => rows.find((l) => l.split(',')[H.indexOf('orderId')] === String(id)).split(',')[H.indexOf(k)];
  assert.strictEqual(get(NEW, 'orderSn'), '260915EXAMPLE1'); assert.strictEqual(get(NEW, 'trackingNumber'), 'SPXSG000000000001');
  assert.strictEqual(get(NEW, 'deliveredAt'), '2026-09-21 16:23:24'); assert.strictEqual(get(NEW, 'completedAt'), '2026-09-28 17:00:37');
  assert.strictEqual(get(CXL, 'amountPaid'), '0.00'); assert.ok(get(CXL, 'cancelledAt')); assert.strictEqual(get(CXL, 'cancelReason'), 'admin 100');
  assert.strictEqual(get(OLD, 'orderSn'), '240501EXAMPLE3'); assert.strictEqual(get(OLD, 'carrier'), 'Ninja Van (Home Delivery)'); assert.strictEqual(get(OLD, 'shippedAt'), '2024-05-03 19:38:25'); assert.strictEqual(get(OLD, 'deliveredAt'), '2024-05-04 13:20:00'); assert.strictEqual(get(OLD, 'coinsEarned'), '1500'); assert.strictEqual(get(NEW, 'shippedAt'), '2026-09-16 13:26:48');
  console.log('EXTRAS PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
