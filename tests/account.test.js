// accountId: numeric marketplace user id on every row; account switches never merge or replay.
const run = require('./harness'); const fs = require('fs'); const assert = require('assert');
const E = process.argv[2]; const src = fs.readFileSync(E + '/content.js', 'utf8'); const interceptorSrc = fs.readFileSync(E + '/interceptor.js', 'utf8');
const ACC1 = '100000001', ACC2 = '200000002';
const csvRows = (r) => { const [h, ...rows] = r.csv.text.replace(/^﻿/, '').split('\n'); const H = h.split(','); return { H, rows: rows.map((l) => l.split(',')) }; };
// ---- Shopee
const ord = (id) => ({ order_list_detail: { status: { status_label: { text: 'label_order_completed' } }, info_card: { order_id: id, final_total: 100000, order_list_cards: [{ shop_info: { shop_id: 1, shop_name: 'S' }, product_info: { item_groups: [{ items: [{ item_id: 1, model_id: 1, name: 'Thing', amount: 1, item_price: 100000, order_price: 100000 }] }] } }] } } });
const shopee = (acc, ids) => ({
  src, interceptorSrc, signedOnly: true, host: 'shopee.sg',
  captureRec: { url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=0', method: 'GET', reqHeaders: {}, reqBody: null, status: 200, body: JSON.stringify({ error: 0, new_data: { order_or_checkout_data: ids.map(ord), next_offset: -1 } }) },
  // username present in the API on purpose: it must never be exported.
  pages: (u) => (u.includes('get_account_info') ? { error: 0, data: { userid: Number(acc), shopid: 5, username: 'account_one_name', email: 'someone@example.com' } }
    : { error: 0, new_data: { order_or_checkout_data: ids.map(ord), next_offset: -1 } }),
});
(async () => {
  // 1. Shopee account 1: every row carries the numeric userid, nothing personal.
  const a = await run(shopee(ACC1, [11, 12, 13]));
  let t = csvRows(a);
  assert.ok(t.H.includes('accountId'));
  assert.ok(t.rows.every((c) => c[t.H.indexOf('accountId')] === ACC1), 'shopee rows carry account 1');
  assert.ok(!/account_one_name|example\.com/.test(a.csv.text), 'no username/email exported');
  assert.strictEqual(a.store.lzx_account_shopee, ACC1);
  console.log('1 shopee accountId on every row:', t.rows.length, 'rows, popup shows', a.st.account);

  // 2. Same browser, now account 2, with account 1's export saved: no merge, recorded requests dropped.
  const prior = csvRows(a).rows.map((c) => Object.fromEntries(csvRows(a).H.map((k, i) => [k, c[i]])));
  const b = await run({ ...shopee(ACC2, [21, 22]), preStore: { lzx_result_shopee: { rows: prior, origin: 'https://shopee.sg', complete: true }, lzx_account_shopee: ACC1, lzx_captures_shopee: [{ url: 'https://shopee.sg/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=0', ts: 1 }] } });
  t = csvRows(b);
  assert.strictEqual(b.st.orders, 2, 'only account 2 orders');
  assert.ok(t.rows.every((c) => c[t.H.indexOf('accountId')] === ACC2));
  assert.ok(b.st.log.some((l) => /different Shopee account/.test(l)) && b.st.log.some((l) => /recorded for the previous account were discarded/.test(l)));
  assert.strictEqual(b.store.lzx_account_shopee, ACC2);
  console.log('2 switch to account 2: rows', b.st.rows, '| account 1 rows merged: 0 | old captures dropped');

  // 3. Dates for account 1's export while account 2 is signed in: refused.
  const c = await run({ ...shopee(ACC2, [11, 12, 13]), preStore: { lzx_result_shopee: { rows: prior, origin: 'https://shopee.sg', complete: true }, lzx_account_shopee: ACC1 }, cmd: 'details' });
  assert.ok(/different Shopee account/.test(c.st.log.slice(-1)[0]), c.st.log.slice(-1)[0]);
  assert.ok(!c.fetched.some((f) => /get_order_detail/.test(f.url)), 'no detail request made');
  console.log('3 add dates across accounts refused:', c.st.log.slice(-1)[0].slice(0, 70) + '…');

  // 4. Reset clears the stored id.
  const d = await run({ ...shopee(ACC1, [11]), cmd2: 'reset' });
  assert.ok(!('lzx_account_shopee' in d.store) || d.store.lzx_account_shopee == null, 'reset removed stored id');
  console.log('4 reset clears stored account id');

  // 5. AliExpress: x_alimid from aep_usuc_f only; name/email in neighbouring cookies never exported.
  const cookie = `aep_usuc_f=${encodeURIComponent('site=glo&b_locale=en_US&x_alimid=' + ACC1)}; xman_us_f=${encodeURIComponent('x_user=XX|Account|One|ifm|' + ACC1 + '&x_lid=xx0000000000abcd')}; xman_us_t=${encodeURIComponent('rmb_pp=someone@example.com')}`;
  const page1 = { ret: ['SUCCESS::ok'], data: { data: { pc_om_list_body_1: { type: 'pc_om_list_body', fields: { hasMore: false, pageIndex: 1, pageSize: 10 } },
    pc_om_list_order_9: { type: 'pc_om_list_order', fields: { orderId: '9000000000000001', orderDateText: 'Oct 2, 2026', statusText: 'Completed', storeName: 'Store', totalPriceText: 'SG$1.00', currencyCode: 'SGD', orderLines: [{ orderLineId: '9000000000000002', itemTitle: 'Thing', itemPriceText: 'SG$1.00', quantity: 1 }] } } }, linkage: {}, hierarchy: { structure: {} }, endpoint: {} } };
  const e = await run({ src, interceptorSrc, host: 'www.aliexpress.com', noCapture: true, captureRec: {}, cookie, mtop: () => page1, pages: () => ({}) });
  t = csvRows(e);
  assert.ok(t.rows.length && t.rows.every((c2) => c2[t.H.indexOf('accountId')] === ACC1), 'aliexpress rows carry x_alimid');
  assert.ok(!/Account|One|example\.com|xx0000000000abcd/.test(e.csv.text), 'no name/email/login id exported');
  console.log('5 aliexpress accountId from x_alimid:', t.rows.length, 'row(s)');

  // 6. AliExpress with no readable member id: blank, never a personal value.
  const f = await run({ src, interceptorSrc, host: 'www.aliexpress.com', noCapture: true, captureRec: {}, cookie: `xman_us_t=${encodeURIComponent('rmb_pp=someone@example.com')}`, mtop: () => page1, pages: () => ({}) });
  t = csvRows(f);
  assert.ok(t.rows.every((c2) => c2[t.H.indexOf('accountId')] === ''), 'blank when only personal values exist');
  assert.ok(!/example\.com/.test(f.csv.text));
  console.log('6 aliexpress without member id: accountId blank');
  console.log('ACCOUNT PASSED'); process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
