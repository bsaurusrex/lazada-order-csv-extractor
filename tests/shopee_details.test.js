const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8'); const interceptorSrc = fs.readFileSync(process.argv[2].replace('content.js','interceptor.js'), 'utf8');
const ord = (id) => ({ order_list_detail: { status: { status_label: { text: 'label_order_completed' } }, info_card: { order_id: id, subtotal: 557000, final_total: 557000, order_list_cards: [{ shop_info: { shop_id: 7, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 2, name: 'N', amount: 1, item_price: 557000, order_price: 557000 }] }] } }] } } });
const ids = [100000000000201, 100000000000202, 100000000000203];
const list = { error: 0, new_data: { order_or_checkout_data: ids.map(ord), next_offset: -1 } };
// Real detail shape: no order id echoed back; dates as info_rows.
const detail = (id) => ({ error: 0, data: { status: {}, info_card: { subtotal: 557000, final_total: 557000 + (id % 10) * 100000 },
  payment_method: { payment_method: 1, payment_channel_name: { text: 'Credit/Debit Card' } },
  processing_info: { order_sn: 'X', info_rows: [
    { info_label: { text: 'label_odp_order_time' }, info_value: { type: 8, value: String(1789463312 + (id % 10) * 86400) } },
    { info_label: { text: 'label_odp_payment_time' }, info_value: { type: 8, value: String(1789463315 + (id % 10) * 86400) } },
    { info_label: { text: 'label_odp_ship_time' }, info_value: { type: 8, value: '1789536408' } } ] } } });
(async () => {
  const r = await run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg',
    captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?_oft=2064&limit=20&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(list) },
    pages: (u) => { const q = new URL(u); if (q.pathname.includes('detail')) return detail(Number(q.searchParams.get('order_id'))); return list; },
    after: { capture: { url: `https://shopee.sg/api/v4/order/get_order_detail?_oft=2064&order_id=${ids[0]}`, method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(detail(ids[0])) } } });
  console.log('DETAILS log:', r.st.log.slice(-3).join(' || '));
  const detailCalls = r.fetched.filter((f) => f.url.includes('detail'));
  console.log('detail fetches:', detailCalls.map((f) => `${f.init.method} ${new URL(f.url).searchParams.get('order_id').slice(-3)} body=${f.init.body === undefined ? 'none' : 'YES'}`).join(', '));
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  for (const l of rows) { const c = l.split(','); console.log('  ', ['orderId','purchasedAt','paidAt','paymentMethod','orderTotal','subtotal','detailsVersion'].map((k) => `${k}=${c[H.indexOf(k)]}`).join(' ')); }
  assert.strictEqual(r.st.undated, 0);
  console.log('DETAILS PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
