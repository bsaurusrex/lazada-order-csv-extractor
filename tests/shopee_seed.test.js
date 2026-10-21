const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const all = Array.from({ length: 23 }, (_, i) => ({ order_list_detail: { status: { status_label: { text: i % 7 === 3 ? 'label_order_cancelled' : 'label_order_completed' } }, info_card: { order_id: 100000000000000 + i, subtotal: 100000, final_total: 100000, order_list_cards: [{ shop_info: { shop_id: 1, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: i, model_id: 1, name: `I${i}`, amount: 1, item_price: 100000, order_price: 100000 }] }] } }] } } }));
const page = (u) => { const q = new URL(u).searchParams; const o = +q.get('offset'), l = +q.get('limit'); const sl = all.slice(o, o + l); return sl.length ? { error: 0, new_data: { order_or_checkout_data: sl, next_offset: o + l < all.length ? o + l : -1 } } : { error: 0, new_data: { next_offset: -1 } }; };
// Previous export = page-read rows (13 orders, dated).
const domPrior = all.slice(0, 13).map((o, i) => ({ _page: 1, _source: 'dom', lineId: `${o.order_list_detail.info_card.order_id}-0`, orderId: String(o.order_list_detail.info_card.order_id), title: `I${i}`, purchasedAt: '2025-01-01 10:00:00', detailsVersion: '4', subtotal: '1.00' }));
run({ src, interceptorSrc, signedOnly: true, noCapture: true, host: 'shopee.sg', preStore: { lzx_result_shopee: { rows: domPrior, origin: 'https://shopee.sg', complete: false } },
  captureRec: {}, pages: page })
.then((r) => {
  console.log('log:', r.st.log.filter((l) => /Requesting|Using|Replacing|Page|Updated|Done|reading/.test(l)).map((l) => l.slice(l.indexOf('  ') + 2)).join(' || '));
  const sources = new Set(r.csv.text.split('\n').slice(1).map((l) => l.split(',')[1]));
  console.log('rows', r.st.rows, 'orders', r.st.orders, 'sources', [...sources].join('/'), 'undated', r.st.undated, 'via', [...new Set(r.fetched.map((f) => f.via))].join('/'));
  assert.strictEqual(r.st.orders, 23); assert.ok(!sources.has('dom'));
  console.log('SEED PASSED'); process.exit(0);
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
