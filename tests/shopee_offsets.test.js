const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8'); const interceptorSrc = fs.readFileSync(process.argv[2].replace('content.js','interceptor.js'), 'utf8'); const S = 1e5;
const ord = (id, st) => ({ order_list_detail: { status: { status_label: { text: st ? 'label_order_cancelled' : 'label_order_completed' }, list_view_text: st ? { text: 'order_list_text_cancelled_by_system' } : undefined },
  info_card: { order_id: id, subtotal: 557000, final_total: 557000, order_list_cards: [{ shop_info: { shop_id: 7, shop_name: 'LShop' }, order_id: id,
    product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 2, shop_id: 7, name: 'Item B', model_name: 'Variant 1', image: 'h', amount: 2, item_price: 300000, order_price: 278500, status: 1 }] }] } }] } } });
const all = Array.from({ length: 7 }, (_, i) => ord(200000000000000 + i, i === 3));
const page = (off, lim) => { const l = all.slice(off, off + lim); return l.length ? { error: 0, new_data: { order_or_checkout_data: l, next_offset: off + lim < all.length ? off + lim : -1 } } : { error: 0, new_data: { next_offset: -1, translation_status: 0 } }; };
(async () => {
  const r = await run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg',
    captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?_oft=2064&limit=5&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(page(0, 5)) },
    pages: (u) => { const q = new URL(u).searchParams; return page(Number(q.get('offset')), Number(q.get('limit'))); } });
  console.log('REAL-SHAPE', r.st.mode, '| rows', r.st.rows, '| orders', r.st.orders, '| complete', r.st.complete, '| offsets', r.fetched.map((f) => new URL(f.url).searchParams.get('offset')).join(','));
  const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(',');
  const pick = (line, k) => line.split(',')[H.indexOf(k)];
  console.log(['status','statusDetail','price','unitPricePaid','lineTotal','orderTotal','subtotal'].map((k) => `${k}=${pick(rows[3], k)}`).join(' '));
  assert.strictEqual(r.st.rows, 7); assert.ok(r.st.complete); console.log('REAL-SHAPE PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
