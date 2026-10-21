const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8'); const interceptorSrc = fs.readFileSync(process.argv[2].replace('content.js','interceptor.js'), 'utf8');
const S = 100000;
// Shape A: info_card / order_list_cards / product_info.item_groups (current Shopee web)
const orderA = (id, n) => ({ info_card: { order_id: id, final_total: 2590 * S / 100 * 100, order_list_cards: [{
  shop_info: { shop_id: 111, shop_name: `Shop ${id}` },
  product_info: { item_groups: [{ items: Array.from({ length: n }, (_, i) => ({ item_id: 900 + i, model_id: 70 + i, shop_id: 111, name: `Widget ${id}-${i}`, model_name: 'Blue,XL', amount: i + 1, item_price: 1290000, image: 'abc123' })) }] } }] },
  status: { list_view_text: { text: 'label_order_completed' } }, shipping_fee: 199000 });
// Shape B: flat (as described in the brief)
const orderB = (id) => ({ order_id: id, shop_info: { shop_id: 5, shop_name: 'Flat Shop' }, item_list: [{ item_id: 1, name: 'Flat thing', amount: 2, item_price: 500000 }], shipping_fee: 0, final_total: 1000000 });
const LIMIT = 5, TOTAL = 12;
const all = Array.from({ length: TOTAL }, (_, i) => (i % 3 === 2 ? orderB(String(1000 + i)) : orderA(String(1000 + i), (i % 2) + 1)));
const page = (off) => { const list = all.slice(off, off + LIMIT); return { error: 0, data: { details_list: list, next_offset: off + LIMIT < TOTAL ? off + LIMIT : -1 } }; };
(async () => {
  const shopee = await run({ src, interceptorSrc, signedOnly: true, host: 'shopee.sg',
    captureRec: { url: `https://shopee.sg/api/v4/order/get_order_list?list_type=3&offset=0&limit=${LIMIT}`, method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify(page(0)) },
    pages: (url) => page(Number(new URL(url).searchParams.get('offset'))) });
  console.log('SHOPEE before run:', JSON.stringify({ hasApi: shopee.st0.hasApi, totalPages: shopee.st0.totalPages }));
  console.log('SHOPEE fetched offsets:', shopee.fetched.map((f) => new URL(f.url).searchParams.get('offset')).join(','));
  console.log('SHOPEE status:', shopee.st.mode, '| rows', shopee.st.rows, '| orders', shopee.st.orders, '| complete', shopee.st.complete);
  console.log('SHOPEE log:', shopee.st.log.slice(-4).join(' || '));
  console.log('SHOPEE downloads:', shopee.downloads);
  const lines = shopee.csv.text.replace(/^﻿/, '').split('\n');
  const hdr = lines[0].split(','); const ix = (k) => hdr.indexOf(k);
  console.log('SHOPEE csv cols (first 30):', hdr.slice(0, 30).join(','));
  for (const l of lines.slice(1, 4).concat(lines.slice(-2))) { const c = l.split(','); console.log('  ', ['orderId','title','variation','quantity','price','orderTotal','shippingFee','status','shopName','itemUrl','picUrl'].map((k) => c[ix(k)]).join(' | ')); }
  const expectedRows = all.reduce((n, o) => n + (o.info_card ? o.info_card.order_list_cards[0].product_info.item_groups[0].items.length : 1), 0);
  assert.strictEqual(shopee.st.rows, expectedRows); assert.strictEqual(shopee.st.orders, TOTAL); assert.ok(shopee.st.complete);

  // Lazada regression: Ultron payload with lifecycle.pageNum in a JSON body.
  const laz = (p) => ({ module: { lifecycle: { pageNum: p, totalPageNum: 2, pageSize: 1 }, data: {
    [`orderItem_${p}1`]: { id: `${p}1`, fields: { tradeOrderId: `T${p}`, title: `Laz item ${p}`, quantity: 1, price: '$5.00', status: 'Delivered', delivery: {} } },
    [`orderShop_${p}`]: { fields: { tradeOrderLineIds: [`${p}1`], tradeOrderId: `T${p}`, name: 'LazShop', status: 'Delivered' } } } } });
  const lz = await run({ src, interceptorSrc, host: 'my.lazada.sg',
    captureRec: { url: 'https://my.lazada.sg/customer/api/sync/order-list', method: 'POST', reqHeaders: {}, reqBody: JSON.stringify({ lifecycle: { pageNum: 1 } }), status: 200, body: JSON.stringify(laz(1)) },
    pages: (url, init) => laz(JSON.parse(init.body).lifecycle.pageNum) });
  console.log('LAZADA status:', lz.st.mode, '| rows', lz.st.rows, '| complete', lz.st.complete, '| downloads', lz.downloads);
  assert.strictEqual(lz.st.rows, 2);
  console.log('ALL ASSERTIONS PASSED'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
