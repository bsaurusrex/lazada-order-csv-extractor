// ISOLATED world. Orchestrates the export.
// Same-origin fetches from here carry your Lazada / Shopee session cookies automatically.
(() => {
  // Frames run only when the dates pass loads an order in a hidden frame to
  // record its detail request; any other embedded Lazada frame is left alone.
  const PRIME_FRAME = 'lzx-prime';
  const inFrame = window !== window.top;
  if (inFrame && window.name !== PRIME_FRAME) return;
  if (window.__LZX_CONTENT__) return;
  window.__LZX_CONTENT__ = true;

  // Which marketplace this page belongs to. Everything market-specific (API
  // parser, pagination, DOM fallback, file names) branches on this.
  const MARKET = /(^|\.)shopee\./i.test(location.hostname) ? 'shopee'
    : /(^|\.)aliexpress\./i.test(location.hostname) ? 'aliexpress'
    : /(^|\.)amazon\.(sg|com)$/i.test(location.hostname) ? 'amazon' : 'lazada';
  const IS_SHOPEE = MARKET === 'shopee';
  const IS_ALIEXPRESS = MARKET === 'aliexpress';
  const IS_AMAZON = MARKET === 'amazon';
  // Markets whose rows are stamped with the signed-in account from run().
  const STAMPS_ACCOUNT = IS_SHOPEE || IS_ALIEXPRESS || IS_AMAZON;
  // The currency every price on this site is in (ISO 4217), by marketplace and
  // country domain. AliExpress reports a per-order currency and uses its own.
  const SITE_CURRENCY = (() => {
    const h = location.hostname.toLowerCase();
    const byTld = [[/\.sg$/, 'SGD'], [/\.com\.my$/, 'MYR'], [/\.co\.th$/, 'THB'], [/\.co\.id$/, 'IDR'],
      [/\.(com\.)?ph$/, 'PHP'], [/\.vn$/, 'VND'], [/\.tw$/, 'TWD'], [/\.com\.br$/, 'BRL'], [/\.com\.mx$/, 'MXN'],
      [/\.com\.co$/, 'COP'], [/\.cl$/, 'CLP']];
    if (/(^|\.)amazon\.com$/.test(h)) return 'USD';
    for (const [re, c] of byTld) if (re.test(h)) return c;
    return '';
  })();
  // Per-market keys: a Shopee export must not overwrite the saved Lazada one.
  // amazon.sg and amazon.com are separate accounts, so each keeps its own.
  const STORE_TAG = IS_AMAZON ? `amazon_${location.hostname.split('.').pop()}` : MARKET;
  const CAP_KEY = MARKET === 'lazada' ? 'lzx_captures' : `lzx_captures_${STORE_TAG}`;
  const RESULT_KEY = MARKET === 'lazada' ? 'lzx_result' : `lzx_result_${STORE_TAG}`;
  // Requests are replayed only if recorded since this page loaded. A request
  // saved in an earlier session carries that session's context: replayed after
  // signing in as someone else, it can return the earlier account's orders.
  const SESSION_START = Date.now();
  const fresh = (c) => (c.ts || 0) >= SESSION_START;

  const state = {
    captures: [],
    rows: [],
    raw: [],
    running: false,
    cancel: false,
    done: false,
    complete: false,   // rows cover every page, so an update can stop at the first known page
    phase: null,
    mode: null,
    log: [],
    progress: { done: 0, total: 0, message: 'Ready' },
    detailError: '',        // why the last dates pass added nothing, shown in the popup
    failedIds: new Set(),   // orders the dates pass could not date; retried last
  };

  const log = (m) => {
    state.log.push(`${new Date().toLocaleTimeString()}  ${m}`);
    if (state.log.length > 120) state.log.shift();
    state.progress.message = m;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  const getText = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
  const safeParse = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };

  // Thailand writes 1,234.50 but Indonesia and Vietnam write 1.234.500, so a
  // dot is only a decimal point when one or two digits follow it.
  function parseMoney(v) {
    const str = String(v == null ? '' : v).trim();
    if (!str || /free/i.test(str)) return 0;
    let t = str.replace(/[^0-9.,]/g, '');
    if (!t) return 0;
    const dec = t.match(/[.,](\d{1,2})$/);
    if (dec) {
      const at = t.length - dec[0].length;
      t = t.slice(0, at).replace(/[.,]/g, '') + '.' + t.slice(at + 1);
    } else {
      t = t.replace(/[.,]/g, '');
    }
    const n = parseFloat(t);
    if (!isFinite(n)) return 0;
    return str.includes('-') ? -n : n;
  }

  const PAGE_KEYS = /^(page|pagenum|pageno|pageindex|pagenumber|currentpage|curpage|pn)$/i;
  const OFFSET_KEYS = /^(offset|start|cursor_offset)$/i;
  const LIMIT_KEYS = /^(limit|page_size|pagesize|size|count)$/i;
  const MONEY = /(?:฿|THB|RM|Rp|S\$|₱|₫|\$)\s?\d[\d.,]*/g;
  const PRICEY = /(?:฿|THB|RM|Rp|S\$|₱|₫)\s?\d/;

  // ------------------------------------------------------------- persistence
  const store = {
    set(k, v) { try { chrome.storage.local.set({ [k]: v }); } catch (_) {} },
    get(k) { return new Promise((res) => { try { chrome.storage.local.get(k, (o) => res(o && o[k])); } catch (_) { res(null); } }); },
    remove(keys) { return new Promise((res) => { try { chrome.storage.local.remove(keys, () => res()); } catch (_) { res(); } }); },
  };

  // Captures arrive over a transferred MessagePort so they are not broadcast to
  // every script on the page; window.postMessage is only the handshake.
  let capturePort = null;
  const drain = () => {
    try {
      window.postMessage({ __lzx: capturePort ? 'drain' : 'connect' }, '*');
    } catch (_) {}
  };

  // Replay fetch. Shopee signs every API call from page script, so its replays
  // must run in the page (see handleFetch in interceptor.js); a direct fetch
  // from here is rejected with error 90309999. Lazada needs no signature and
  // keeps the direct path. Same shape as fetch: resolves to { status, text() }.
  const pending = new Map();
  let fetchSeq = 0;
  const SIGNED_HEADERS = /^(x-sap-|af-ac-enc-|x-sz-sdk-version|x-shopee-client-timezone$)/i;
  // Only a port from interceptor v2+ answers fetch requests. An older
  // interceptor left in the tab by an extension reload answers the handshake
  // too, but would let every request time out.
  let fetchPort = null;
  let fetchPortV = 0;
  const NEEDS_RELOAD = 'This tab is still running the previous version of the extension. Reload the page (F5), then try again.';
  async function pageFetch(url, init) {
    if (!IS_SHOPEE) return fetch(url, init);
    if (!fetchPort) {
      try { window.postMessage({ __lzx: 'connect' }, '*'); } catch (_) {}
      for (let i = 0; i < 20 && !fetchPort; i++) await sleep(100);
    }
    if (!fetchPort) throw new Error(NEEDS_RELOAD);
    // Drop the signature headers recorded from the original call: they are
    // single-use, and Shopee's wrapper adds fresh ones.
    const headers = {};
    for (const [k, v] of Object.entries((init && init.headers) || {})) if (!SIGNED_HEADERS.test(k)) headers[k] = v;
    const id = ++fetchSeq;
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve({ error: 'timed out waiting for Shopee' }); }, 20000);
      pending.set(id, (d) => { clearTimeout(t); resolve(d); });
      fetchPort.postMessage({ __lzx: 'fetch', id, url, init: { ...init, headers } });
    });
    if (r.error) throw new Error(r.error);
    return { status: r.status, text: async () => r.text };
  }

  // AliExpress: run an mtop API through the page's own signed client (see
  // handleMtop in interceptor.js). Resolves to the mtop response object.
  async function pageMtop(api, data, type = 'GET') {
    if (!fetchPort || fetchPortV < 3) {
      try { window.postMessage({ __lzx: 'connect' }, '*'); } catch (_) {}
      for (let i = 0; i < 20 && (!fetchPort || fetchPortV < 3); i++) await sleep(100);
    }
    if (!fetchPort || fetchPortV < 3) throw new Error(NEEDS_RELOAD);
    const id = ++fetchSeq;
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve({ error: 'timed out waiting for AliExpress' }); }, 30000);
      pending.set(id, (d) => { clearTimeout(t); resolve(d); });
      fetchPort.postMessage({ __lzx: 'mtop', id, opts: { api, type, data: { ...data, __defaults: true } } });
    });
    if (r.error) throw new Error(r.error);
    const res = r.data || {};
    const ret = Array.isArray(res.ret) ? String(res.ret[0] || '') : '';
    if (!/^SUCCESS/.test(ret)) throw new Error(`AliExpress refused ${api.split('.').slice(-2).join('.')}: ${ret || 'no response'}`);
    return res;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lzx !== 'port') return;
    const port = e.ports && e.ports[0];
    if (!port) return;
    if ((e.data.v || 0) >= 2) { fetchPort = port; fetchPortV = e.data.v || 0; }
    // Every port gets a handler: an older interceptor still sends captures on its own.
    if (!capturePort || (e.data.v || 0) >= 2) capturePort = port;
    port.onmessage = (ev) => {
      const d = ev.data;
      if (d && (d.__lzx === 'fetchResult' || d.__lzx === 'mtopResult')) { const cb = pending.get(d.id); if (cb) { pending.delete(d.id); cb(d); } return; }
      acceptCapture(d);
    };
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    acceptCapture(e.data);
  });

  function acceptCapture(d) {
    if (!d || d.__lzx !== 'capture' || !d.rec) return;
    // Only accept same-origin records: anything on the page can post here.
    let origin = '';
    try { origin = new URL(d.rec.url).origin; } catch (_) { return; }
    if (origin !== location.origin) return;

    // The drain replays the whole buffer, so ignore anything already held.
    const key = capKey(d.rec);
    if (state.captures.some((c) => capKey(c) === key)) return;

    state.captures.push(d.rec);
    keepNewestPerPath();
    invalidate();
    scheduleSave();
  }

  const capKey = (c) => `${c.url}|${c.ts}`;

  // Storage is shared across all six Lazada origins; a capture from another
  // market would be replayed cross-origin and fail, or worse, be trusted.
  const sameOrigin = (c) => {
    try { return new URL(c.url).origin === location.origin; } catch (_) { return false; }
  };

  // Bodies run ~75KB each; batch writes rather than one per record.
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; store.set(CAP_KEY, state.captures); }, 1000);
  }

  // Derived status costs ~25 JSON parses plus deep walks; the popup polls twice a
  // second, so compute once and recompute only when captures or rows change.
  let cache = null;
  const invalidate = () => { cache = null; };
  function derived() {
    if (!cache) {
      cache = {
        api: !!pickCapture(),
        detail: !!detailReady(),
        diag: state.rows.length ? detailDiag() : [],
        totalPages: detectTotalPages(),
      };
    }
    return cache;
  }

  function pathOf(url) {
    try { return new URL(url).pathname; } catch (_) { return String(url); }
  }

  // Retain the newest capture per endpoint path. The list page re-fires
  // order-list constantly and would otherwise evict the one order-detail
  // capture the date pass depends on.
  function keepNewestPerPath() {
    const byPath = new Map();
    for (const c of state.captures) {
      const k = pathOf(c.url);
      const seen = byPath.get(k);
      if (!seen || (c.ts || 0) >= (seen.ts || 0)) byPath.set(k, c);
    }
    // Order by recency: pickCapture scans backwards expecting newest last.
    state.captures = [...byPath.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-10);
  }

  // ------------------------------------------------------------ deep JSON keys
  // Lazada nests the page number at lifecycle.pageNum, so a top-level scan misses it.
  function deepFindKey(node, re, depth = 0) {
    if (!isObj(node) || depth > 6) return null;
    for (const [k, v] of Object.entries(node)) {
      if (re.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
        return [{ k, leaf: true, str: typeof v === 'string' }];
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (isObj(v)) { const sub = deepFindKey(v, re, depth + 1); if (sub) return [{ k, json: false }, ...sub]; }
      else if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
        const p = safeParse(v);
        if (isObj(p)) { const sub = deepFindKey(p, re, depth + 1); if (sub) return [{ k, json: true }, ...sub]; }
      }
    }
    return null;
  }

  function deepSet(node, path, value) {
    const [head, ...rest] = path;
    const out = { ...node };
    if (head.leaf) { out[head.k] = head.str ? String(value) : value; return out; }
    const child = head.json ? safeParse(node[head.k]) : node[head.k];
    const next = deepSet(child, rest, value);
    out[head.k] = head.json ? JSON.stringify(next) : next;
    return out;
  }

  function scalars(obj, prefix) {
    const out = {};
    if (!isObj(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (isScalar(v)) out[prefix + k] = v;
      else if (isObj(v)) for (const [k2, v2] of Object.entries(v)) if (isScalar(v2)) out[`${prefix}${k}.${k2}`] = v2;
    }
    return out;
  }

  // ------------------------------------------------- Lazada (Ultron) response
  // module.data is a flat entity map (orderItem_*, order_*, orderShop_*), not an array.
  function parseLazadaAPI(json, page) {
    const mod = json && json.module;
    const data = mod && mod.data;
    if (!isObj(data)) return null;

    const ents = [];
    for (const [key, v] of Object.entries(data)) {
      if (isObj(v) && isObj(v.fields)) ents.push({ key, id: v.id, fields: v.fields });
    }
    const items = ents.filter((e) => /^orderItem/i.test(e.key));
    if (!items.length) return null;

    // Shops join by tradeOrderLineIds. tradeOrderId is NOT reliable here: item and
    // shop entities carry different ids in this payload.
    const byLineId = new Map();
    const byOrderId = new Map();
    for (const s of ents.filter((e) => /^orderShop/i.test(e.key))) {
      const ids = s.fields.tradeOrderLineIds;
      const list = Array.isArray(ids) ? ids : (typeof ids === 'string' ? ids.split(/[,;\s]+/) : []);
      for (const id of list) if (id) byLineId.set(String(id).trim(), s.fields);
      const oid = s.fields.tradeOrderId;
      if (oid && !byOrderId.has(String(oid))) byOrderId.set(String(oid), s.fields);
    }

    const rows = items.map((e) => {
      const f = e.fields;
      const d = isObj(f.delivery) ? f.delivery : {};
      const sku = isObj(f.sku) ? f.sku : {};
      const lineId = String(e.id || e.key.replace(/^orderItem_/i, ''));
      let shop = byLineId.get(lineId);
      let match = 'lineId';
      if (!shop) { shop = byOrderId.get(String(f.tradeOrderId)); match = shop ? 'orderId' : 'none'; }
      if (!shop) shop = {};
      const oi = isObj(shop.orderInfo) ? shop.orderInfo : {};
      return {
        _page: page,
        _shopMatch: match,
        accountId: numericBuyerId(f, shop, oi) || lazadaUserId(f.tradeOrderId),
        orderId: f.tradeOrderId ?? '',
        lineId,
        purchasedAt: '',   // list endpoint never populates these; filled by the detail pass
        paidAt: '',
        shippingFee: '',
        discount: '',
        subtotal: '',
        cashback: '',
        refundAmount: '',
        charges: '',
        status: shop.status || oi.status || d.status || '',
        itemStatus: f.status || '',   // e.g. "Refund issued" on individual lines
        refunded: /refund|returned/i.test(String(f.status || '')) ? 'yes' : '',
        title: f.title ?? '',
        variation: sku.skuText ?? sku.productVariant ?? '',
        quantity: f.quantity ?? '',
        price: f.price ?? '',
        orderTotal: d.orderDetailPrice || '',
        currency: SITE_CURRENCY,
        paymentMethod: oi.paymentDes || '',
        deliveryMethod: d.method ?? '',
        deliveryPrice: d.price ?? '',
        deliverySummary: d.deliverySummary ?? '',
        brand: sku.brand ?? '',
        shopName: shop.name ?? '',
        shopId: shop.shopId ?? '',
        sellerId: f.sellerId ?? shop.sellerId ?? '',
        itemId: f.itemId ?? '',
        skuId: f.skuId ?? '',
        orderDetailUrl: f.orderDetailUrl ?? (isObj(shop.order) ? shop.order.orderDetailUrl : '') ?? '',
        itemUrl: f.itemUrl ?? '',
        picUrl: f.picUrl ?? '',
        ...scalars(f, 'raw.'),
        ...scalars(shop, 'shop.'),
      };
    });

    const lc = isObj(mod.lifecycle) ? mod.lifecycle : {};
    return {
      rows,
      raw: items.map((i) => i.fields),
      totalPages: Number(lc.totalPageNum) || 0,
      pageSize: Number(lc.pageSize) || 0,
    };
  }


  // ------------------------------------------------------- Shopee response
  // Live (verified on shopee.sg, Oct 2026):
  //   GET /api/v4/order/get_all_order_and_checkout_list?limit=5&offset=0
  //   → { error: 0, new_data: { next_offset, order_or_checkout_data: [
  //        { order_list_detail: { status, shipping, info_card: { order_id,
  //          subtotal, final_total, order_list_cards: [{ shop_info,
  //          product_info: { item_groups: [{ items: [...] }] } }] } } } ] } }
  // Older/other endpoints (get_order_list) return data.details_list[] instead,
  // one entry per order, in one of two shapes:
  //   flat:   { order_id, shop_info, item_list: [...], shipping_fee, final_total }
  //   cards:  { info_card: { order_id, final_total, order_list_cards: [
  //             { shop_info, product_info: { item_groups: [{ items: [...] }] } } ] },
  //             status: { list_view_text: { text } } }
  // Both are read; anything missing is left blank rather than guessed.

  // Shopee's API sends money as integers scaled by 100,000 (S$12.90 is
  // 1290000). Display strings ("$12.90") go through parseMoney instead.
  function shopeeMoney(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' || /^-?\d+$/.test(String(v).trim())) {
      const n = Number(v);
      return Number.isFinite(n) ? +(n / 100000).toFixed(2) : '';
    }
    if (isObj(v)) return shopeeMoney(v.value ?? v.amount ?? v.price ?? '');
    const n = parseMoney(v);
    return n || '';
  }

  const money2 = (v) => (v === '' || v == null ? '' : Number(v).toFixed(2));

  // Status comes back as an i18n key ("label_order_completed"); tidy it.
  function shopeeText(v) {
    if (v == null) return '';
    if (isObj(v)) return shopeeText(v.text ?? v.label ?? v.status_label ?? '');
    return String(v).replace(/^(label_)?(order_list_text_|order_)?/i, '').replace(/_/g, ' ').trim();
  }

  // Image hashes live on a per-country CDN host.
  const SHOPEE_CC = { sg: 'sg', my: 'my', ph: 'ph', th: 'th', id: 'id', vn: 'vn', tw: 'tw', br: 'br', mx: 'mx', co: 'co', cl: 'cl' };
  function shopeeImage(hash) {
    if (!hash) return '';
    if (/^https?:/i.test(hash)) return hash;
    const tld = location.hostname.split('.').pop();
    return `https://down-${SHOPEE_CC[tld] || 'sg'}.img.susercontent.com/file/${hash}`;
  }

  function firstKey(node, key, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return undefined;
    if (!Array.isArray(node) && node[key] !== undefined && node[key] !== null && node[key] !== '') return node[key];
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') { const r = firstKey(v, key, depth + 1); if (r !== undefined) return r; }
    }
    return undefined;
  }

  function shopeeItemsOf(card) {
    const out = [];
    const pi = isObj(card.product_info) ? card.product_info : null;
    if (pi && Array.isArray(pi.item_groups)) {
      for (const g of pi.item_groups) for (const it of (g && g.items) || []) if (isObj(it)) out.push(it);
    }
    for (const k of ['item_list', 'items', 'order_items']) {
      if (!out.length && Array.isArray(card[k])) for (const it of card[k]) if (isObj(it)) out.push(it);
    }
    return out;
  }

  function parseShopeeAPI(json, page) {
    const data = json && isObj(json.new_data) ? json.new_data : json && isObj(json.data) ? json.data : null;
    if (!data) return null;
    const list = Array.isArray(data.order_or_checkout_data)
      // Unpaid checkouts come as checkout_list_detail; paid orders as order_list_detail.
      ? data.order_or_checkout_data.map((e) => (isObj(e) && (e.order_list_detail || e.checkout_list_detail)) || e)
      : Array.isArray(data.details_list) ? data.details_list
      : Array.isArray(data.order_data && data.order_data.details_list) ? data.order_data.details_list
      // Past the last order Shopee drops the list and sends next_offset: -1.
      : ('next_offset' in data) ? []
      : null;
    if (!list) return null;

    const rows = [];
    const raw = [];
    for (const d of list) {
      if (!isObj(d)) continue;
      const ic = isObj(d.info_card) ? d.info_card : {};
      const cards = Array.isArray(ic.order_list_cards) && ic.order_list_cards.length ? ic.order_list_cards : [d];
      const orderId = String(ic.order_id ?? d.order_id ?? firstKey(d, 'order_id') ?? '');
      const orderSn = String(d.order_sn ?? ic.order_sn ?? firstKey(d, 'order_sn') ?? '');
      // status_label is the plain state ("label_order_cancelled"); list_view_text,
      // when present, says why ("order_list_text_cancelled_by_system").
      const st = isObj(d.status) ? d.status : {};
      const status = shopeeText(st.status_label || st.list_view_status_label || st.list_view_text
        || (isObj(d.status) ? '' : d.status) || d.order_status || '');
      // Drop rating prompts ("completed enabled buyer has not rated"): not a status.
      const statusDetail = /rate|rating/i.test(String((st.list_view_text || {}).text || '')) ? '' : shopeeText(st.list_view_text || '');
      const total = shopeeMoney(ic.final_total ?? d.final_total ?? d.total_price ?? d.order_total ?? '');
      const shipFee = shopeeMoney(d.shipping_fee ?? ic.shipping_fee ?? firstKey(d, 'shipping_fee') ?? '');
      raw.push(d);

      for (const card of cards) {
        const shop = isObj(card.shop_info) ? card.shop_info : isObj(d.shop_info) ? d.shop_info : {};
        const items = shopeeItemsOf(card);
        items.forEach((it, idx) => {
          const qty = it.amount ?? it.quantity ?? it.qty ?? '';
          // item_price: listed unit price. order_price: unit price actually paid
          // (after item-level discounts) — verified: sum(order_price × amount)
          // equals info_card.subtotal when there is no shop voucher.
          const unit = shopeeMoney(it.item_price ?? it.price ?? it.order_price ?? '');
          const paid = shopeeMoney(it.order_price ?? '');
          const lineId = String(it.order_item_id ?? `${it.item_id ?? ''}-${it.model_id ?? ''}-${idx}`);
          rows.push({
            _page: page,
            _source: 'shopee-api',
            accountId: '',   // stamped by run() with the signed-in buyer's userid
            orderId,
            orderSn,
            lineId,
            purchasedAt: '',
            paidAt: '',
            // Filled by the dates pass from get_order_detail (see shopeeDetailExtras).
            shippedAt: '',
            deliveredAt: '',
            completedAt: '',
            cancelledAt: '',
            cancelReason: '',
            carrier: '',
            trackingNumber: '',
            parcels: '',
            amountPaid: '',
            coinsEarned: '',
            shippingFee: money2(shipFee),
            discount: '',
            // info_card.subtotal on the list equals final_total (shipping included),
            // so it is not the merchandise subtotal: the dates pass fills that.
            subtotal: '',
            cashback: '',
            refundAmount: '',
            charges: '',
            status,
            statusDetail,
            itemStatus: typeof it.status === 'number' ? '' : shopeeText(it.status ?? ''),
            refunded: /refund|return/i.test(`${status} ${statusDetail}`) ? 'yes' : '',
            title: it.name ?? it.item_name ?? it.title ?? '',
            variation: it.model_name ?? it.variation ?? '',
            quantity: qty,
            price: money2(unit),
            unitPricePaid: money2(paid),
            lineTotal: paid === '' || qty === '' ? '' : (paid * Number(qty)).toFixed(2),
            priceBeforeDiscount: money2(shopeeMoney(it.price_before_discount ?? '')),
            orderTotal: money2(total),
            currency: SITE_CURRENCY,
            paymentMethod: '',
            deliveryMethod: '',
            deliveryPrice: '',
            deliverySummary: shopeeText(isObj(d.shipping) && isObj(d.shipping.tracking_info) ? d.shipping.tracking_info.description : ''),
            brand: '',
            shopName: shop.shop_name ?? shop.username ?? shop.name ?? '',
            shopId: shop.shop_id ?? it.shop_id ?? '',
            sellerId: shop.user_id ?? '',
            itemId: it.item_id ?? '',
            skuId: it.model_id ?? '',
            orderDetailUrl: orderId ? `${location.origin}/user/purchase/order/${orderId}` : '',
            itemUrl: it.item_id && (shop.shop_id ?? it.shop_id) ? `${location.origin}/product/${shop.shop_id ?? it.shop_id}/${it.item_id}` : '',
            picUrl: shopeeImage(it.image || ''),
            ...scalars(it, 'raw.'),
            ...scalars(shop, 'shop.'),
          });
        });
      }
    }

    const nextOffset = Number(data.next_offset);
    return {
      rows,
      raw,
      totalPages: 0,           // Shopee never says; the run reads until a page comes back empty
      pageSize: list.length,
      // next_offset is -1 (or absent with a short page) once the list is exhausted.
      hasMore: Number.isFinite(nextOffset) ? nextOffset > 0 : null,
      empty: !list.length,
    };
  }

  // Everything else worth keeping from get_order_detail. Two layouts exist:
  //   newer: processing_info.info_rows [{ info_label.text: "label_odp_<x>_time",
  //          info_value.value: "<unix s>" }], shipping.{fulfilment_carrier,
  //          masked_carrier, tracking_number, tracking_info, num_parcels}
  //   older: pc_processing_info.{create_time, pay_time, shipping_confirm_time,
  //          delivery_time, complete_time, order_sn}, pc_shipping.{…,
  //          forder_shipping_info_list[].tracking_number}
  // Both: info_card.amount_paid (scaled), coins.coin_earn, and for cancelled
  // orders status.list_view_extra_cancel_info.cancel_reason.text.
  function shopeeDetailExtras(json) {
    const d = json && isObj(json.data) ? json.data : null;
    if (!d) return null;
    const out = {};
    const at = (v) => (/^1\d{9}$/.test(String(v || '')) ? readDate(String(v)).at : '');
    const txt = (o) => (isObj(o) && typeof o.text === 'string' ? o.text.trim() : '');

    const rows = (isObj(d.processing_info) && Array.isArray(d.processing_info.info_rows)) ? d.processing_info.info_rows : [];
    const rowAt = (re) => {
      const r = rows.find((x) => isObj(x) && isObj(x.info_label) && re.test(String(x.info_label.text || '')));
      return r && isObj(r.info_value) ? at(r.info_value.value) : '';
    };
    const pc = isObj(d.pc_processing_info) ? d.pc_processing_info : {};
    const pi = isObj(d.processing_info) ? d.processing_info : {};
    out.orderSn = String(pi.order_sn || pc.order_sn || '').trim();
    // pc_ layout (what the extension gets: the desktop page sends x-api-source: pc).
    // Verified Oct 2026 against the same order in both layouts:
    //   delivery_time         = shipped out (== label_odp_ship_time), NOT delivered
    //   shipping_confirm_time = seller arranged shipment (seconds after payment): ignored
    //   actual delivery       = the "Delivered" event in the tracking history
    out.shippedAt = rowAt(/odp_ship_time/i) || at(pc.delivery_time);
    out.completedAt = rowAt(/odp_complete(d)?_time/i) || at(pc.complete_time);
    out.cancelledAt = rowAt(/odp_cancel(led)?_time/i) || at(pc.cancel_time);

    const sh = isObj(d.shipping) ? d.shipping : isObj(d.pc_shipping) ? d.pc_shipping : {};
    const parcelsList = Array.isArray(sh.forder_shipping_info_list) ? sh.forder_shipping_info_list : [];
    out.carrier = txt(sh.fulfilment_carrier) || txt(sh.masked_carrier)
      || (parcelsList[0] ? txt(parcelsList[0].fulfilment_carrier) || txt(parcelsList[0].masked_carrier) : '');
    out.trackingNumber = [sh.tracking_number, ...parcelsList.map((p) => p && p.tracking_number)]
      .map((t) => String(t || '').trim()).filter((t, i, a) => t && a.indexOf(t) === i).join(' | ');
    out.parcels = Number(sh.num_parcels) || '';
    // Delivered: the latest tracking event marked delivered, from the full
    // history (pc_) or the single latest event (newer layout).
    const events = [];
    if (isObj(sh.tracking_info)) events.push(sh.tracking_info);
    for (const p of parcelsList) if (p && Array.isArray(p.tracking_info_list)) events.push(...p.tracking_info_list);
    const delivered = events
      .filter((e) => isObj(e) && (/^delivered$/i.test(txt(e.milestone)) || /has been delivered|parcel delivered|^delivered/i.test(String(e.description || ''))))
      .map((e) => Number(e.ctime) || 0).filter(Boolean);
    out.deliveredAt = delivered.length ? at(Math.max(...delivered)) : '';

    const ic = isObj(d.info_card) ? d.info_card : {};
    const paid = ic.amount_paid ?? pc.paid_amount;
    out.amountPaid = paid == null ? '' : money2(shopeeMoney(paid));
    // Coins are scaled like money (100000000 = 1,000 coins).
    out.coinsEarned = isObj(d.coins) && Number(d.coins.coin_earn) ? String(Math.round(Number(d.coins.coin_earn) / 100000)) : '';
    const st = isObj(d.status) ? d.status : {};
    const cx = isObj(st.list_view_extra_cancel_info) ? st.list_view_extra_cancel_info : {};
    out.cancelReason = (txt(cx.cancel_reason) || '').replace(/^label_cancel_order_reason_/i, '').replace(/_/g, ' ')
      || (/cancel/i.test(txt(st.header_text)) ? txt(st.header_text).replace(/^order_status_text_/i, '').replace(/_/g, ' ') : '');
    return out;
  }

  // ------------------------------------------------------ AliExpress response
  // mtop.aliexpress.trade.buyer.order.list (verified Oct 2026). Ultron, like
  // Lazada: data.data is an entity map. One pc_om_list_order_<n> per order:
  //   fields: { orderId, orderDateText "Oct 2, 2026", statusText, storeName,
  //             storePageUrl, totalPriceText "SG$11.19", currencyCode,
  //             orderDetailUrl, orderLines: [{ orderLineId, productId, skuId,
  //             itemTitle, itemPriceText, quantity, skuAttrs[{name,text}],
  //             itemDetailUrl, itemImgUrl }] }
  // pc_om_list_body_<n>.fields: { hasMore, pageIndex, pageSize: 10 }.
  const AE_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // "Oct 2, 2026" -> "2026-10-02" (AliExpress gives dates without a time).
  function aeDate(text) {
    const m = String(text || '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
    const mon = m ? AE_MONTHS.indexOf(m[1].toLowerCase()) : -1;
    return mon < 0 ? '' : `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const aeUrl = (u) => { try { return u ? new URL(u, location.href).href : ''; } catch (_) { return ''; } };
  const aeMoney = (t) => { const n = parseMoney(t); return t ? n.toFixed(2) : ''; };

  function parseAliExpressList(json, page) {
    const data = json && isObj(json.data) && isObj(json.data.data) ? json.data.data : null;
    if (!data) return null;
    const rows = [];
    const raw = [];
    let body = null;
    for (const [k, v] of Object.entries(data)) {
      if (!isObj(v) || !isObj(v.fields)) continue;
      if (/list_body/.test(k)) { body = v.fields; continue; }
      if (!/list_order_/.test(k)) continue;
      const f = v.fields;
      raw.push(f);
      const lines = Array.isArray(f.orderLines) ? f.orderLines : [];
      lines.forEach((l, i) => rows.push({
        _page: page,
        _source: 'aliexpress-api',
        accountId: '',   // stamped by run() with the signed-in buyer's member id
        orderId: String(f.orderId || ''),
        orderSn: '',
        lineId: String(l.orderLineId || `${f.orderId}-${i}`),
        purchasedAt: aeDate(f.orderDateText),   // date only; the dates pass adds the time
        paidAt: '', shippedAt: '', deliveredAt: '', completedAt: '', cancelledAt: '', cancelReason: '',
        carrier: '', trackingNumber: '', parcels: '', amountPaid: '', coinsEarned: '',
        shippingFee: '', discount: '', subtotal: '', tax: '', cashback: '', refundAmount: '', charges: '',
        status: String(f.statusText || '').trim(),   // "Canceled " arrives with a trailing space
        statusDetail: '',
        itemStatus: '',
        refunded: /refund|return/i.test(String(f.statusText || '')) ? 'yes' : '',
        title: l.itemTitle || '',
        variation: (Array.isArray(l.skuAttrs) ? l.skuAttrs : []).map((a) => (a && a.text ? (a.name ? `${a.name}: ${a.text}` : a.text) : '')).filter(Boolean).join('; '),
        quantity: l.quantity ?? '',
        price: aeMoney(l.itemPriceText),
        unitPricePaid: '',
        lineTotal: l.itemPriceText && l.quantity ? (parseMoney(l.itemPriceText) * Number(l.quantity)).toFixed(2) : '',
        priceBeforeDiscount: '',
        orderTotal: aeMoney(f.totalPriceText),
        currency: f.currencyCode || l.currencyCode || SITE_CURRENCY,
        paymentMethod: '',
        shopName: f.storeName || '',
        shopUrl: aeUrl(f.storePageUrl),
        itemId: l.productId || '',
        skuId: l.skuId || '',
        orderDetailUrl: aeUrl(f.orderDetailUrl),
        itemUrl: aeUrl(l.itemDetailUrl),
        picUrl: aeUrl(l.itemImgUrl),
      }));
    }
    return {
      rows, raw, totalPages: 0, pageSize: body ? Number(body.pageSize) || 10 : 10,
      hasMore: body ? !!body.hasMore : rows.length > 0 ? null : false,
      empty: !rows.length,
    };
  }

  // Pages chain: each "load more" POST repeats the list-body entity with the
  // next pageIndex plus the previous response's linkage (which carries a
  // signature), hierarchy and endpoint. Kept here between calls.
  let aeChain = null;   // { page, prev: { data, linkage, hierarchy, endpoint } }
  const AE_LIST = 'mtop.aliexpress.trade.buyer.order.list';
  async function aeFetchPage(page) {
    if (page === 1 || !aeChain || aeChain.page > page - 1) {
      const res = await pageMtop(AE_LIST, { statusTab: null, renderType: 'init', clientPlatform: 'pc' });
      aeChain = { page: 1, prev: res.data };
      if (page === 1) return parseAliExpressList(res, 1);
    }
    while (aeChain.page < page) {
      const prev = aeChain.prev;
      const bodyKey = Object.keys(prev.data || {}).find((k) => /list_body/.test(k));
      const body = bodyKey && prev.data[bodyKey];
      if (!body || !body.fields || !body.fields.hasMore) return { rows: [], raw: [], totalPages: 0, hasMore: false, empty: true };
      const actKey = Object.keys(prev.data).find((k) => /header_action/.test(k));
      const next = { ...body, fields: { ...body.fields, pageIndex: (Number(body.fields.pageIndex) || 1) + 1 } };
      const dataObj = { [bodyKey]: next };
      if (actKey) dataObj[actKey] = prev.data[actKey];
      const params = {
        data: JSON.stringify(dataObj), linkage: JSON.stringify(prev.linkage || {}),
        hierarchy: JSON.stringify({ structure: (prev.hierarchy || {}).structure || {} }),
        endpoint: JSON.stringify(prev.endpoint || {}), operator: bodyKey,
      };
      const res = await pageMtop(AE_LIST, { params: JSON.stringify(params) }, 'POST');
      const d = res.data || {};
      // Responses carry only changed entities; keep the rest, drop old orders.
      const merged = { ...prev, ...d, data: { ...prev.data, ...(d.data || {}) } };
      for (const k of Object.keys(merged.data)) if (/list_order_/.test(k) && !(k in (d.data || {}))) delete merged.data[k];
      merged.linkage = d.linkage || prev.linkage;
      merged.hierarchy = d.hierarchy || prev.hierarchy;
      merged.endpoint = d.endpoint || prev.endpoint;
      aeChain = { page: aeChain.page + 1, prev: merged };
      if (aeChain.page === page) return parseAliExpressList(res, page);
    }
    return { rows: [], raw: [], totalPages: 0, hasMore: false, empty: true };
  }

  // ---------------------------------------------------------------- Amazon
  // amazon.sg / amazon.com (verified on amazon.sg, Oct 2026). No JSON API:
  //  - /your-orders/orders?timeFilter=year-YYYY&startIndex=N lists 10 orders per
  //    page, but the card contents are encrypted in the HTML and only decrypted
  //    by page script. Each card's order number is plain, though:
  //    data-csa-c-slot-id="amzn1.yourorders.order-card.<###-#######-#######>".
  //    The years on offer come from the page's <option value="year-YYYY">.
  //  - /your-orders/order-details?orderID=… is plain HTML with everything else:
  //    [data-component=orderDate], per item [itemTitle] [unitPrice] [quantity]
  //    (empty when 1) [orderedMerchant] "Sold by: …", product link /dp/<ASIN>,
  //    and [chargeSummary] rows "Item(s) Subtotal: S$…", "Delivery: …", "GST: …",
  //    "Promotion(s) Applied: -…", "Gift Card Amount: -…", "Grand Total: …".
  // So "Export" reads each order's detail page; there is no list-only mode.
  // The payment method is filled in by page script and is not read. The
  // shipping address on the detail page is never read.
  const AMZ_ORDER_ID = /amzn1\.yourorders\.order-card\.(\d{3}-\d{7}-\d{7})/g;
  const AMZ_CURRENCY = { sg: 'SGD', com: 'USD' };
  const amzCurrency = () => AMZ_CURRENCY[location.hostname.split('.').pop()] || SITE_CURRENCY;
  const AMZ_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  // "12 March 2025" (amazon.sg) or "March 12, 2025" (amazon.com) -> 2025-03-12
  function amzDate(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    let m = t.match(/(\d{1,2}) ([A-Za-z]+),? (\d{4})/);
    let day, mon, year;
    if (m) { day = m[1]; mon = m[2]; year = m[3]; }
    else { m = t.match(/([A-Za-z]+) (\d{1,2}),? (\d{4})/); if (m) { mon = m[1]; day = m[2]; year = m[3]; } }
    if (!m) return '';
    const i = AMZ_MONTHS.findIndex((x) => x.startsWith(String(mon).toLowerCase().slice(0, 3)));
    return i < 0 ? '' : `${year}-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // Currency of one Amazon money string: "S$" SGD, "US$" USD, bare "$" is the
  // site's own (USD on amazon.com). Orders on amazon.com can be charged in SGD.
  const amzCurrencyOf = (t) => {
    const m = String(t || '').match(/(S\$|US\$|\$|SGD|USD)/);
    if (!m) return '';
    return m[1] === 'S$' || m[1] === 'SGD' ? 'SGD' : m[1] === 'US$' || m[1] === 'USD' ? 'USD' : amzCurrency();
  };
  const amzMoney = (t) => {
    const m = String(t || '').match(/-?\s*(?:S\$|US\$|\$)\s?[\d,]+(?:\.\d{1,2})?/);
    return m ? parseMoney(m[0]) : null;
  };
  async function amzGet(path) {
    const res = await fetch(new URL(path, location.origin).href, { credentials: 'include' });
    const text = await res.text();
    // Only Amazon's own sign-in and robot-check pages: ordinary pages mention
    // "captcha" in their scripts.
    if (/\/ap\/signin/.test(res.url) || /<form[^>]+name="signIn"/.test(text)) {
      throw new Error('Amazon asked to sign in again. Sign in on this tab, then retry.');
    }
    if (/\/errors\/validateCaptcha/.test(res.url) || /<form[^>]+action="\/errors\/validateCaptcha"/.test(text)) {
      throw new Error('Amazon showed a robot check. Open any Amazon page in this tab, complete it, then retry.');
    }
    return text;
  }

  // One order's rows from its detail page.
  function amzParseDetail(html, orderId, page) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    const q = (sel, root = d) => root.querySelector(sel);
    // Two layouts: the regular one (data-component markers) and the Amazon
    // Fresh one ("ufpo": #ufpo-order-status-secondary "Ordered on …", item rows
    // with <ASIN>-item-total-price, charge lines as label + amount leaves).
    const fresh = !q('[data-component="itemTitle"]') && !!q('#ufpo-od-item-list-section');
    const date = amzDate((q('[data-component="orderDate"]') || q('#ufpo-order-status-secondary') || {}).textContent);
    const charges = [];
    const sums = { subtotal: null, ship: 0, tax: 0, disc: 0, gift: 0, total: null, oos: 0, fees: 0, paid: null };
    let orderCur = '', paidCur = '', hasFees = false;
    let hasShip = false, hasTax = false;
    const chargeLines = [];
    const cs = q('[data-component="chargeSummary"]');
    for (const r of cs ? cs.querySelectorAll('.od-line-item-row, .a-row') : []) {
      if (!r.querySelector('.a-row, .od-line-item-row')) chargeLines.push(r.textContent);
    }
    if (fresh) {
      for (const e of d.body ? d.body.querySelectorAll('span, div') : []) {
        if (e.children.length || /item-total-price/.test(`${e.id} ${e.className}`) || !/^\s*-?\s*(?:S\$|US\$|\$)\s?\d/.test(e.textContent)) continue;
        // Fresh labels may lack a colon ("Deals and Discounts", "OOS (1)").
        let p = e.parentElement;
        for (let k = 0; k < 4 && p && !p.textContent.replace(e.textContent, '').trim(); k++) p = p.parentElement;
        const label = p ? p.textContent.replace(e.textContent, '').replace(/\s+/g, ' ').trim().replace(/:$/, '') : '';
        if (label && !/(?:S\$|US\$|\$)\s?\d/.test(label)) chargeLines.push(`${label}: ${e.textContent.trim()}`);
      }
    }
    const seen = new Set();
    for (const raw of chargeLines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      // The colon is optional: "Free Shipping -$7.02", "Deals and Discounts -S$1.00".
      const m = line.match(/^([^$]+?):?\s*(-?\s*(?:S\$|US\$|\$).+)$/);
      if (!m || seen.has(line)) continue;
      seen.add(line);
      const label = m[1].trim();
      const v = amzMoney(m[2]);
      if (v == null || !label) continue;
      charges.push(`${label}=${m[2].trim()}`);
      if (/^item\(?s?\)? subtotal/i.test(label)) { sums.subtotal = v; orderCur = orderCur || amzCurrencyOf(m[2]); }
      else if (/^grand total/i.test(label)) { sums.total = v; orderCur = amzCurrencyOf(m[2]) || orderCur; }
      // Converted orders also state what was actually charged to the card.
      else if (/^payment grand total/i.test(label)) { sums.paid = v; paidCur = amzCurrencyOf(m[2]); }
      else if (/free shipping|shipping (discount|promotion)/i.test(label)) sums.disc += Math.abs(v);
      else if (/exchange rate|import fee|customs|duty|surcharge|handling fee/i.test(label) && !/^(shipping|delivery)/i.test(label)) { sums.fees += v; hasFees = true; }
      else if (/gift card/i.test(label)) sums.gift += Math.abs(v);
      // Fresh: items out of stock at delivery are listed but credited ("OOS (1)").
      else if (/^oos\b|out of stock|unavailable/i.test(label)) sums.oos += Math.abs(v);
      else if (/promo|discount|coupon|saving|reward/i.test(label)) sums.disc += Math.abs(v);
      else if (/^(delivery|shipping)|import fees deposit/i.test(label)) { sums.ship += v; hasShip = true; }
      // "GST", "Estimated GST", "Estimated tax to be collected", "Sales tax"…;
      // never the "Total before GST" lines.
      else if (!/^total/i.test(label) && /\b(gst|tax|vat)\b/i.test(label)) { sums.tax += v; hasTax = true; }
    }
    // "Exchange rate: 1 USD = 1.3512 SGD" appears on orders charged in another currency.
    const fx = (cs ? cs.textContent : '').replace(/\s+/g, ' ').match(/([\d.,]+)\s*([A-Z]{3})\s*=\s*([\d.,]+)\s*([A-Z]{3})/);
    const exchangeRate = fx ? `${(parseFloat(fx[3].replace(/,/g, '')) / parseFloat(fx[1].replace(/,/g, ''))).toFixed(4)} ${fx[2]}->${fx[4]}` : '';
    orderCur = orderCur || amzCurrency();
    // Only visible status blocks: page scripts carry "cancelled" strings too.
    // Fresh pages carry hidden alert templates ("couldn't cancel…"): read only
    // their visible status line.
    const statusText = [...d.querySelectorAll(fresh ? '#ufpo-order-status-primary'
      : '[data-component="alerts"], [data-component="shipmentStatus"], [data-component="orderDetailsTitle"], .a-alert-content')]
      .map((e) => e.textContent).join(' ').replace(/\s+/g, ' ');
    const cancelled = /this order (has been|was) cancel|order cancell?ed|\bcancelled\b/i.test(statusText);
    const rows = [];
    if (fresh) {
      const PRICE_SEL = '[id$="-item-total-price"], [class*="-item-total-price"]';
      [...d.querySelectorAll(PRICE_SEL)].forEach((pe, i) => {
        const asin = (`${pe.id} ${pe.className}`.match(/([A-Z0-9]{10})-item-total-price/) || [])[1] || '';
        let row = pe;
        for (let k = 0; k < 6 && row.parentElement && row.parentElement.querySelectorAll(PRICE_SEL).length === 1; k++) row = row.parentElement;
        const leaves = [...row.querySelectorAll('span, div, a')].filter((e) => !e.children.length && e.textContent.trim() && e !== pe);
        const qty = parseInt((leaves.find((e) => /^\d{1,3}$/.test(e.textContent.trim())) || {}).textContent, 10) || 1;
        const title = leaves.map((e) => e.textContent.trim()).filter((t) => !/^\d+$|^(quantity|weight|total)$/i.test(t) && !/(?:S\$|\$)\s?\d/.test(t))
          .sort((a, b) => b.length - a.length)[0] || '';
        const line = amzMoney(pe.textContent);
        const img = row.querySelector('img');
        rows.push({
          _page: page, _source: 'amazon-html', accountId: '', orderId, orderSn: '',
          lineId: asin ? `${asin}-${i}` : `${orderId}-${i}`, purchasedAt: date,
          paidAt: '', shippedAt: '', deliveredAt: '', completedAt: '', cancelledAt: '', cancelReason: '',
          carrier: '', trackingNumber: '', parcels: '', amountPaid: '', coinsEarned: '',
          shippingFee: hasShip ? sums.ship.toFixed(2) : '', discount: sums.disc ? sums.disc.toFixed(2) : '',
          subtotal: sums.subtotal != null ? sums.subtotal.toFixed(2) : '', tax: hasTax ? sums.tax.toFixed(2) : '',
          giftCardAmount: sums.gift ? sums.gift.toFixed(2) : '', cashback: '', refundAmount: sums.oos ? sums.oos.toFixed(2) : '', charges: charges.join(' | '),
          status: cancelled ? 'cancelled' : '', statusDetail: 'Amazon Fresh', itemStatus: '', refunded: '',
          title, variation: '', quantity: qty,
          price: line != null ? (line / qty).toFixed(2) : '', unitPricePaid: '',
          lineTotal: line != null ? line.toFixed(2) : '', priceBeforeDiscount: '',
          orderTotal: sums.total != null ? sums.total.toFixed(2) : '', currency: orderCur, paymentMethod: '',
          shopName: 'Amazon Fresh', itemId: asin, skuId: '',
          orderDetailUrl: `${location.origin}/your-orders/order-details?orderID=${orderId}`,
          itemUrl: asin ? `${location.origin}/dp/${asin}` : '', picUrl: img ? (img.getAttribute('src') || '') : '',
          detailsVersion: DETAILS_VERSION,
        });
      });
    }
    const titles = [...d.querySelectorAll('[data-component="itemTitle"]')];
    titles.forEach((tt, i) => {
      let box = tt;
      for (let k = 0; k < 8 && box.parentElement && !box.querySelector('[data-component="unitPrice"]'); k++) box = box.parentElement;
      const link = tt.querySelector('a[href]') || box.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const href = link ? link.getAttribute('href') : '';
      const asin = (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || '';
      // Quantity above 1 shows as a badge on the product image (.od-item-view-qty);
      // the quantity component is often empty.
      // The badge sits in the image column, beside the block holding the price:
      // look in the nearest ancestor that also holds the image.
      let imgBox = box;
      for (let k = 0; k < 4 && imgBox.parentElement && !imgBox.querySelector('img')
        && imgBox.parentElement.querySelectorAll('[data-component="itemTitle"]').length === 1; k++) imgBox = imgBox.parentElement;
      const qty = parseInt(((q('[data-component="quantity"]', box) || {}).textContent || '').replace(/\D/g, ''), 10)
        || parseInt(((q('.od-item-view-qty', imgBox) || {}).textContent || '').replace(/\D/g, ''), 10) || 1;
      const unit = amzMoney((q('[data-component="unitPrice"]', box) || {}).textContent);
      const seller = ((q('[data-component="orderedMerchant"]', box) || {}).textContent || '').replace(/\s+/g, ' ').trim().replace(/^sold by:?\s*/i, '');
      const img = q('img', imgBox);
      rows.push({
        _page: page,
        _source: 'amazon-html',
        accountId: '',   // stamped by run() with the signed-in customer ID
        orderId,
        orderSn: '',
        lineId: asin ? `${asin}-${i}` : `${orderId}-${i}`,
        purchasedAt: date,
        paidAt: '', shippedAt: '', deliveredAt: '', completedAt: '', cancelledAt: '', cancelReason: '',
        carrier: '', trackingNumber: '', parcels: '',
        amountPaid: sums.paid != null ? sums.paid.toFixed(2) : '',
        paymentCurrency: sums.paid != null ? (paidCur || orderCur) : '',
        coinsEarned: '',
        shippingFee: hasShip ? sums.ship.toFixed(2) : '',
        discount: sums.disc ? sums.disc.toFixed(2) : '',
        subtotal: sums.subtotal != null ? sums.subtotal.toFixed(2) : '',
        tax: hasTax ? sums.tax.toFixed(2) : '',
        giftCardAmount: sums.gift ? sums.gift.toFixed(2) : '',
        cashback: '', refundAmount: '',
        charges: charges.join(' | '),
        status: cancelled ? 'cancelled' : '',
        statusDetail: '', itemStatus: '', refunded: '',
        title: tt.textContent.replace(/\s+/g, ' ').trim(),
        variation: '',
        quantity: qty,
        price: unit != null ? unit.toFixed(2) : '',
        unitPricePaid: '',
        lineTotal: unit != null ? (unit * qty).toFixed(2) : '',
        priceBeforeDiscount: '',
        orderTotal: sums.total != null ? sums.total.toFixed(2) : '',
        currency: orderCur,
        // Item prices keep the listing currency; only noted when it differs.
        itemCurrency: (() => { const c = amzCurrencyOf((q('[data-component="unitPrice"]', box) || {}).textContent); return c && c !== orderCur ? c : ''; })(),
        exchangeRate,
        otherFees: hasFees ? sums.fees.toFixed(2) : '',
        paymentMethod: '',
        shopName: seller,
        itemId: asin,
        skuId: '',
        orderDetailUrl: `${location.origin}/your-orders/order-details?orderID=${orderId}`,
        itemUrl: asin ? `${location.origin}/dp/${asin}` : '',
        picUrl: img ? (img.getAttribute('src') || '') : '',
        detailsVersion: DETAILS_VERSION,   // the detail page is the source: nothing left to add
      });
    });
    if (!rows.length && date) {
      // Digital or unusual orders without item blocks still get a row.
      rows.push({ _page: page, _source: 'amazon-html', accountId: '', orderId, lineId: `${orderId}-0`, purchasedAt: date,
        subtotal: sums.subtotal != null ? sums.subtotal.toFixed(2) : '', orderTotal: sums.total != null ? sums.total.toFixed(2) : '',
        charges: charges.join(' | '), status: cancelled ? 'cancelled' : '', currency: orderCur, exchangeRate,
        orderDetailUrl: `${location.origin}/your-orders/order-details?orderID=${orderId}`, detailsVersion: DETAILS_VERSION });
    }
    return rows;
  }

  // All order numbers, newest first: every year the page offers, every page.
  let amzIds = null;
  let amzStoppedAt = 0;
  async function amzCollectIds() {
    const first = await amzGet('/your-orders/orders');
    const all = [...new Set([...first.matchAll(/value="year-(\d{4})"/g)].map((m) => m[1]))].sort((a, b) => b - a);
    const years = FROM_YEAR ? all.filter((y) => Number(y) >= FROM_YEAR) : all;
    if (years.length < all.length) {
      amzStoppedAt = FROM_YEAR;
      log(`Skipping Amazon orders before ${FROM_YEAR} (${all.length - years.length} ${all.length - years.length === 1 ? 'year' : 'years'}).`);
    }
    const ids = [];
    for (const y of years) {
      if (state.cancel) break;
      for (let start = 0; start < 2000; start += 10) {
        const html = await amzGet(`/your-orders/orders?timeFilter=year-${y}&startIndex=${start}`);
        const got = [...new Set([...html.matchAll(AMZ_ORDER_ID)].map((m) => m[1]))];
        for (const id of got) if (!ids.includes(id)) ids.push(id);
        log(`Amazon ${y}: ${ids.length} orders found so far`);
        if (got.length < 10 || state.cancel) break;
        await sleep(400 + Math.random() * 200);
      }
      await sleep(300);
    }
    return ids;
  }

  // "Page" n = orders (n-1)*10 .. n*10-1, each read from its detail page.
  async function amzFetchPage(page) {
    if (page === 1 || !amzIds) amzIds = await amzCollectIds();
    const ids = amzIds.slice((page - 1) * 10, page * 10);
    const rows = [];
    for (const id of ids) {
      if (state.cancel) break;
      try {
        rows.push(...amzParseDetail(await amzGet(`/your-orders/order-details?orderID=${encodeURIComponent(id)}`), id, page));
      } catch (e) {
        if (/sign in|robot check/i.test(e.message)) throw e;
        log(`Order ${id}: ${e.message}`);
        rows.push({ _page: page, _source: 'amazon-html', accountId: '', orderId: id, lineId: `${id}-0`, currency: amzCurrency(),
          orderDetailUrl: `${location.origin}/your-orders/order-details?orderID=${id}` });
      }
      await sleep(350 + Math.random() * 250);
    }
    return { rows, raw: [], totalPages: Math.ceil(amzIds.length / 10) || 0, hasMore: page * 10 < amzIds.length, empty: !ids.length };
  }

  // Re-read orders whose detail page failed during the export.
  async function amzRunDetails(delayMs) {
    state.detailError = '';
    const ids = undatedOrders();
    if (!ids.length) { log('Every order already has its details.'); return 0; }
    state.phase = 'details';
    state.progress = { done: 0, total: ids.length, message: state.progress.message };
    let got = 0;
    for (let i = 0; i < ids.length && !state.cancel; i++) {
      const id = ids[i];
      try {
        const rows = amzParseDetail(await amzGet(`/your-orders/order-details?orderID=${encodeURIComponent(id)}`), id, 0);
        if (rows.length) {
          for (const r of rows) r.accountId = currentAccount;
          state.rows = state.rows.filter((r) => String(r.orderId) !== id).concat(rows);
          got++;
        }
      } catch (e) {
        log(`Order ${id}: ${e.message}`);
        if (/sign in|robot check/i.test(e.message)) { state.detailError = e.message; break; }
      }
      state.progress.done = i + 1;
      await sleep(delayMs + Math.random() * 200);
    }
    invalidate();
    log(`Detail pass done — ${got} orders read.`);
    return got;
  }

  // Which marketplace a recorded request belongs to, by its host.
  const marketOf = (url) => {
    try { return /(^|\.)shopee\./i.test(new URL(url).hostname) ? 'shopee' : 'lazada'; } catch (_) { return MARKET; }
  };

  function parseApi(json, page, url) {
    return marketOf(url || location.href) === 'shopee' ? parseShopeeAPI(json, page) : parseLazadaAPI(json, page);
  }

  // ------------------------------------------------------------- request replay
  // Shopee pages by offset/limit rather than page number. page N is
  // offset (N-1)*limit, so the rest of the run still thinks in pages.
  function buildOffsetPager(rec) {
    let url;
    try { url = new URL(rec.url); } catch (_) { return null; }
    let offKey = null; let limit = 0;
    for (const [k, v] of url.searchParams.entries()) {
      if (OFFSET_KEYS.test(k) && /^\d+$/.test(v)) offKey = k;
      else if (LIMIT_KEYS.test(k) && /^\d+$/.test(v)) limit = Number(v);
    }
    if (offKey) {
      const lim = limit || 20;
      return { where: `url:${offKey} (limit ${lim})`, offset: true, limit: lim, make: (page) => {
        const u = new URL(rec.url); u.searchParams.set(offKey, String((page - 1) * lim));
        if (!limit) u.searchParams.set('limit', String(lim));
        return { url: u.toString(), method: rec.method, headers: rec.reqHeaders, body: rec.reqBody };
      } };
    }
    // GraphQL / POST variants carry offset in the JSON body.
    const bodyJson = rec.reqBody ? safeParse(rec.reqBody) : null;
    if (isObj(bodyJson)) {
      const path = deepFindKey(bodyJson, OFFSET_KEYS);
      if (path) {
        const limPath = deepFindKey(bodyJson, LIMIT_KEYS);
        let lim = 20;
        if (limPath) { let n = bodyJson; for (const s of limPath) n = s.json ? safeParse(n[s.k]) : n[s.k]; lim = Number(n) || 20; }
        return { where: `body:${path.map((x) => x.k).join('.')} (limit ${lim})`, offset: true, limit: lim, make: (page) => ({
          url: rec.url, method: rec.method, headers: rec.reqHeaders,
          body: JSON.stringify(deepSet(bodyJson, path, (page - 1) * lim)),
        }) };
      }
    }
    return null;
  }

  function buildPager(rec, kind) {
    if ((kind || marketOf(rec.url)) === 'shopee') return buildOffsetPager(rec);
    let url;
    try { url = new URL(rec.url); } catch (_) { return null; }

    for (const [k, v] of url.searchParams.entries()) {
      if (PAGE_KEYS.test(k) && Number.isFinite(Number(v))) {
        return { where: `url:${k}`, make: (page) => {
          const u = new URL(rec.url); u.searchParams.set(k, String(page));
          return { url: u.toString(), method: rec.method, headers: rec.reqHeaders, body: rec.reqBody };
        } };
      }
      const nested = safeParse(v);
      if (isObj(nested)) {
        const path = deepFindKey(nested, PAGE_KEYS);
        if (path) {
          return { where: `url-json:${k}.${path.map((x) => x.k).join('.')}`, make: (page) => {
            const u = new URL(rec.url); u.searchParams.set(k, JSON.stringify(deepSet(nested, path, page)));
            return { url: u.toString(), method: rec.method, headers: rec.reqHeaders, body: rec.reqBody };
          } };
        }
      }
    }

    const bodyJson = rec.reqBody ? safeParse(rec.reqBody) : null;
    if (isObj(bodyJson)) {
      const path = deepFindKey(bodyJson, PAGE_KEYS);
      if (path) {
        return { where: `body:${path.map((x) => x.k).join('.')}`, make: (page) => ({
          url: rec.url, method: rec.method, headers: rec.reqHeaders,
          body: JSON.stringify(deepSet(bodyJson, path, page)),
        }) };
      }
    }
    return null;
  }

  function pickCapture() {
    for (let i = state.captures.length - 1; i >= 0; i--) {
      const rec = state.captures[i];
      if (!fresh(rec)) continue;
      const resp = safeParse(rec.body);
      if (!resp) continue;
      // Route by the request's host: Lazada's Ultron payload or Shopee's details_list.
      const kind = marketOf(rec.url);
      const parsed = kind === 'shopee' ? parseShopeeAPI(resp, 1) : parseLazadaAPI(resp, 1);
      if (!parsed) continue;
      const pager = buildPager(rec, kind);
      if (pager) return { rec, pager, kind };
    }
    return null;
  }

  // -------------------------------------------------------------- pager clicks
  function pagerButtons() {
    return Array.from(document.querySelectorAll(
      '.next-pagination-item, [class*="pagination-item"], [class*="pagination"] button, [class*="pagination"] a'
    )).filter((b) => /^\d+$/.test(getText(b)) && !b.disabled && b.offsetParent !== null);
  }

  // Trigger one real request so there is something to replay.
  function triggerRequest() {
    if (IS_SHOPEE) {
      // Infinite scroll: reaching the bottom fires the next get_order_list.
      window.scrollTo(0, document.documentElement.scrollHeight);
      setTimeout(() => window.scrollTo(0, 0), 1500);
      return true;
    }
    const btns = pagerButtons();
    if (btns.length > 1) {
      const current = btns.find((b) => /current|active/i.test(String(b.className)));
      const target = btns.find((b) => b !== current) || btns[1];
      target.click();
      return true;
    }
    return false;
  }

  // Shopee's list endpoint is a plain GET whose only state is the session
  // cookie, so when nothing was recorded since this script attached (e.g.
  // right after an extension reload, with every order already on screen so
  // scrolling fires nothing) it is safe to make the first request ourselves.
  // It goes through the page so Shopee signs it, and is verified before use.
  const SHOPEE_LIST_PATH = '/api/v4/order/get_all_order_and_checkout_list';
  async function seedShopeeCapture() {
    const url = `${location.origin}${SHOPEE_LIST_PATH}?limit=20&offset=0`;
    try {
      const res = await pageFetch(url, { method: 'GET', credentials: 'include', headers: {} });
      const text = await res.text();
      const json = safeParse(text);
      if (!json || (json.error && json.error !== 0)) {
        log(`Shopee did not accept the order-list request${json && json.error ? ` (error ${json.error})` : ''}.`);
        return null;
      }
      if (!parseShopeeAPI(json, 1)) { log('Shopee\'s order-list response was not in a known shape.'); return null; }
      const rec = { url, method: 'GET', reqHeaders: {}, reqBody: null, status: res.status, body: text.slice(0, 400000), ts: Date.now() };
      state.captures.push(rec);
      keepNewestPerPath();
      invalidate();
      return pickCapture();
    } catch (e) {
      log(`Could not request the order list: ${e.message}`);
      return null;
    }
  }

  async function ensureCapture() {
    if (IS_AMAZON) {
      amzIds = null;
      return { kind: 'amazon', rec: { url: `${location.origin}/your-orders/orders` },
               pager: { where: 'year pages + order details', offset: true, make: () => ({}) } };
    }
    if (IS_ALIEXPRESS) {
      // Nothing to record: requests go through the page's mtop client.
      aeChain = null;
      return { kind: 'aliexpress', rec: { url: `${location.origin}/p/order/index.html` },
               pager: { where: 'mtop order.list pageIndex', offset: true, make: () => ({}) } };
    }
    let cap = pickCapture();
    if (cap) return cap;
    if (IS_SHOPEE) {
      log('Requesting the order list from Shopee…');
      cap = await seedShopeeCapture();
      if (cap) return cap;
    }
    log('Recording one real request from the page…');
    if (!triggerRequest()) { log('No pager found to trigger a request.'); return null; }
    for (let i = 0; i < 50 && !state.cancel; i++) {
      await sleep(400);
      cap = pickCapture();
      if (cap) return cap;
    }
    return null;
  }

  // -------------------------------------------------------- live DOM fallback
  function discoverCards(root) {
    const counts = new Map();
    for (const el of root.querySelectorAll('div,li,section,article')) {
      const cn = typeof el.className === 'string' ? el.className.trim() : '';
      if (!cn) continue;
      const t = getText(el);
      if (t.length < 30 || t.length > 5000 || !PRICEY.test(t)) continue;
      for (const c of cn.split(/\s+/)) counts.set(c, (counts.get(c) || 0) + 1);
    }
    let best = [];
    for (const [cls, n] of counts) {
      if (n < 2 || n > 200) continue;
      let els;
      try { els = Array.from(root.querySelectorAll(`.${CSS.escape(cls)}`)); } catch (_) { continue; }
      els = els.filter((e) => PRICEY.test(getText(e)));
      els = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
      if (els.length > best.length) best = els;
    }
    return best;
  }

  // Shopee's class names are hashed CSS modules ("OrderShopSection__abc12"),
  // so match on the stable prefix with [class*=…].
  // Verified Oct 2026: shopee.sg now ships fully hashed class names
  // ("R5DdXs", "LNTevg"), so the descriptive selectors below find nothing.
  // They are tried first in case a market or A/B build still uses them; the
  // structural reader after them is what works on the live site.
  const SHOPEE_ORDER_LINK = 'a[href*="/user/purchase/order/"]';
  const shopeeOrderIdOf = (a) => ((a.getAttribute('href') || '').match(/\/order\/(\d+)/) || [])[1] || '';
  const orderIdsIn = (el) => new Set(Array.from(el.querySelectorAll(SHOPEE_ORDER_LINK)).map(shopeeOrderIdOf).filter(Boolean));
  // Skips screen-reader-only text, buttons, and SVG <title> badges ("Mall",
  // "Preferred Seller") that would otherwise read as the shop name.
  const visibleLeaves = (root) => Array.from(root.querySelectorAll('*'))
    .filter((e) => !e.children.length && !/a11y-hidden/.test(String(e.className))
      && e.tagName !== 'BUTTON' && e.tagName.toLowerCase() !== 'title' && !(e.closest && e.closest('svg')) && getText(e));
  // Shopee keeps screen-reader headings with stable text even though its
  // classes are hashed: "Order Shop Section", "Order Item List Section".
  const landmark = (el, re) => {
    const h = Array.from(el.querySelectorAll('h2,h3,h4,.a11y-hidden')).find((x) => re.test(getText(x)));
    return h ? h.parentElement : null;
  };
  const IS_QTY = /^[x×]\s?\d+$/;
  const IS_MONEY_ONLY = /^-?\s*(?:฿|THB|RM|Rp|S\$|₱|₫|NT\$|R\$|\$)\s?\d[\d.,]*$/;

  function extractShopeeStructural(page) {
    // One card per order: the highest ancestor of an order link that still
    // holds only that one order id.
    const cards = [];
    const seen = new Set();
    for (const a of document.querySelectorAll(SHOPEE_ORDER_LINK)) {
      const id = shopeeOrderIdOf(a);
      if (!id || seen.has(id)) continue;
      let c = a;
      while (c.parentElement && c.parentElement !== document.body && orderIdsIn(c.parentElement).size === 1) c = c.parentElement;
      seen.add(id);
      cards.push({ id, el: c, link: a });
    }
    const rows = [];
    for (const { id, el, link } of cards) {
      const leaves = visibleLeaves(el);
      // Items live under the "Order Item List Section" heading when present;
      // bounding the climb there keeps a single-item block from swallowing the
      // shop header above it.
      const itemSec = landmark(el, /item list/i);
      const bound = itemSec && el.contains(itemSec) && itemSec !== el ? itemSec : el;
      const qtyLeaves = leaves.filter((l) => IS_QTY.test(getText(l)) && bound.contains(l));
      // An item block is the widest ancestor of a quantity marker that holds no other marker.
      const blocks = qtyLeaves.map((q) => {
        let b = q;
        while (b.parentElement && b.parentElement !== bound
               && visibleLeaves(b.parentElement).filter((l) => IS_QTY.test(getText(l))).length === 1) b = b.parentElement;
        return b;
      });
      const inBlock = (l) => blocks.some((b) => b.contains(l));
      const inItems = (l) => (bound !== el ? bound.contains(l) : inBlock(l));
      const firstItemLeaf = leaves.findIndex(inItems);
      const head = leaves.slice(0, firstItemLeaf < 0 ? leaves.length : firstItemLeaf).map(getText);
      const tail = leaves.filter((l, i) => i > firstItemLeaf && !inItems(l)).map(getText);
      const shopName = head[0] || '';
      const status = head.length > 1 ? head[head.length - 1] : '';
      const orderTotal = tail.find((t) => IS_MONEY_ONLY.test(t)) || '';
      const orderDetailUrl = new URL(link.getAttribute('href'), location.href).toString();
      if (!blocks.length) {
        rows.push({ _page: page, _source: 'dom', orderId: id, shopName, status, orderTotal, orderDetailUrl, rawText: getText(el).slice(0, 900) });
        continue;
      }
      blocks.forEach((b, i) => {
        const texts = visibleLeaves(b).map(getText);
        const money = texts.filter((t) => IS_MONEY_ONLY.test(t));
        const variation = texts.find((t) => /^[^:]{2,20}:\s/.test(t) && !IS_MONEY_ONLY.test(t)) || '';
        const title = texts.filter((t) => !IS_QTY.test(t) && !IS_MONEY_ONLY.test(t) && t !== variation)
          .sort((x, y) => y.length - x.length)[0] || '';
        rows.push({
          _page: page, _source: 'dom', orderId: id, shopName, status,
          lineId: `${id}-${i}`,
          title,
          variation: variation.replace(/^[^:]+:\s*/, ''),
          quantity: (texts.find((t) => IS_QTY.test(t)) || '').replace(/\D/g, ''),
          price: money[money.length - 1] || '',               // what was paid
          priceBeforeDiscount: money.length > 1 ? money[0] : '',
          orderTotal,
          orderDetailUrl,
          picUrl: (b.querySelector('img') || {}).src || '',
          rawText: i === 0 ? getText(el).slice(0, 900) : '',
        });
      });
    }
    return rows;
  }

  function extractShopeeLive(page) {
    const pick = (root, sel) => root.querySelector(sel);
    if (!document.querySelector('[class*="OrderShopSection"]')) return extractShopeeStructural(page);
    let cards = Array.from(document.querySelectorAll('[class*="OrderShopSection"]'));
    cards = cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));
    const rows = [];
    for (const card of cards) {
      // The total sometimes sits beside the shop section rather than inside it:
      // climb to the nearest ancestor that holds exactly this one section.
      let scope = card;
      while (scope.parentElement && !pick(scope, '[class*="OrderTotal"]')
             && scope.parentElement.querySelectorAll('[class*="OrderShopSection"]').length === 1) {
        scope = scope.parentElement;
      }
      const totalEl = pick(scope, '[class*="OrderTotal"]');
      const totalText = getText(totalEl);
      const orderTotal = (totalText.match(MONEY) || []).pop() || '';
      const shopName = getText(pick(card, '[class*="shop-name"]'));
      const link = scope.querySelector('a[href*="/user/purchase/order/"]');
      let orderId = '';
      if (link) { const m = (link.getAttribute('href') || '').match(/\/order\/(\d+)/); if (m) orderId = m[1]; }
      const statusEl = scope.querySelector('[class*="status"],[class*="Status"]');
      const status = statusEl && statusEl !== totalEl ? getText(statusEl).split('\n').pop() : '';

      // OrderItemList may be the list itself or each item; take the elements
      // that each hold exactly one title.
      let items = Array.from(card.querySelectorAll('[class*="OrderItemList"]'));
      if (items.length === 1 && items[0].querySelectorAll('[class*="title"]').length > 1) {
        items = Array.from(items[0].querySelectorAll('[class*="title"]'))
          .map((t) => { let n = t; while (n.parentElement && n.parentElement !== items[0]) n = n.parentElement; return n; });
        items = items.filter((n, i) => items.indexOf(n) === i);
      }
      items = items.filter((it) => !items.some((o) => o !== it && it.contains(o)));
      if (!items.length) {
        rows.push({ _page: page, _source: 'dom', orderId, shopName, status, orderTotal, rawText: getText(scope).slice(0, 900) });
        continue;
      }
      items.forEach((it, i) => {
        const text = getText(it);
        const prices = Array.from(it.querySelectorAll('[class*="price"]')).map(getText).filter((t) => PRICEY.test(t) || /\$\s?\d/.test(t));
        const priceText = prices.length ? prices[prices.length - 1] : '';
        const qm = text.match(/[x×]\s?(\d+)/);
        const variation = getText(pick(it, '[class*="variation"]')).replace(/^variation:\s*/i, '');
        rows.push({
          _page: page, _source: 'dom', orderId, shopName, status,
          lineId: `${orderId}-${i}`,
          title: getText(pick(it, '[class*="title"]')),
          variation,
          quantity: qm ? qm[1] : '',
          price: (priceText.match(MONEY) || []).pop() || priceText,
          orderTotal,
          orderDetailUrl: link ? new URL(link.getAttribute('href'), location.href).toString() : '',
          picUrl: (it.querySelector('img') || {}).src || '',
          rawText: i === 0 ? getText(scope).slice(0, 900) : '',
        });
      });
    }
    return rows;
  }

  // Shopee renders 5-20 orders and appends more on scroll: scroll until the
  // card count stops growing so the DOM fallback sees everything.
  async function scrollShopeeToEnd() {
    let last = -1; let still = 0;
    for (let i = 0; i < 400 && !state.cancel; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(900);
      const n = orderIdsIn(document).size || document.querySelectorAll('[class*="OrderShopSection"]').length;
      state.progress.done = n;
      if (n === last) { if (++still >= 4) break; } else { still = 0; last = n; log(`Loaded ${n} orders on the page…`); }
    }
    window.scrollTo(0, 0);
  }

  function extractLive(page) {
    // Route by the active host: Shopee has its own layout.
    if (IS_SHOPEE) return extractShopeeLive(page);
    let cards = Array.from(document.querySelectorAll('[class*="order-item"],[class*="orderItem"],[class*="order-card"]'));
    cards = cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));
    if (!cards.length) cards = discoverCards(document);

    const rows = [];
    for (const card of cards) {
      const text = getText(card);
      const link = card.querySelector('a[href*="tradeOrderId"],a[href*="order/detail"]');
      let orderId = '';
      if (link) { const m = (link.getAttribute('href') || '').match(/tradeOrderId=([^&#]+)/i); if (m) orderId = decodeURIComponent(m[1]); }
      if (!orderId) { const m = text.match(/\b\d{10,}\b/); if (m) orderId = m[0]; }
      const money = text.match(MONEY) || [];
      const titles = Array.from(card.querySelectorAll('img[alt]')).map((i) => i.alt).filter((a) => a && a.length > 3);
      const qm = text.match(/[x×]\s?(\d+)/);
      if (!titles.length) { rows.push({ _page: page, _source: 'dom', orderId, orderTotal: money[money.length - 1] || '', rawText: text.slice(0, 900) }); continue; }
      titles.forEach((t, i) => rows.push({
        _page: page, _source: 'dom', orderId,
        title: t, price: money[i] || '', quantity: qm ? qm[1] : '',
        orderTotal: money[money.length - 1] || '',
        orderDetailUrl: link ? new URL(link.getAttribute('href'), location.href).toString() : '',
        rawText: i === 0 ? text.slice(0, 900) : '',
      }));
    }
    return rows;
  }

  function detectTotalPages() {
    if (IS_SHOPEE || IS_ALIEXPRESS || IS_AMAZON) return 0;   // no page count until the run ends
    // Scoped to the pager. Scanning the whole body would read a delivery date
    // like "9/2026" as 2026 pages.
    const scopes = document.querySelectorAll('[class*="pagination"],[class*="pager"],[class*="next-pagination"]');
    let max = 0;
    for (const scope of scopes) {
      for (const frac of (getText(scope).match(/(\d+)\s*\/\s*(\d+)/g) || [])) {
        const v = parseInt(frac.split('/')[1].trim(), 10);
        if (Number.isFinite(v) && v > max && v <= 5000) max = v;
      }
      for (const b of scope.querySelectorAll('button,a,li,span')) {
        const v = parseInt(getText(b), 10);
        if (Number.isFinite(v) && v > max && v <= 5000) max = v;
      }
    }
    return max || 1;
  }

  // ------------------------------------------------------------- detail pass
  // The list endpoint carries no dates. The detail page is client-rendered too, so
  // fetching its HTML yields a shell — the same record-and-replay trick is used:
  // capture one real order-detail request, then swap the order id per order.

  const DATE_KEY = /(gmtcreate|createtime|createdat|placedat|ordertime|paytime|paidat|paymenttime|ordercreatetime|orderdate|purchasedat)/i;
  const PAY_KEY = /(paymentmethod|paymentdes|paymethod|paymentname|paymenttype)/i;
  const TOTAL_KEY = /(totalamount|grandtotal|ordertotal|totalprice|orderamount|totalfee)/i;
  // Shopee sends Unix seconds (10 digits), Lazada milliseconds (13).
  const DATEISH = /(20\d\d)|(\d{1,2}[\/\-\s][A-Za-z]{3})|^\d{13}$|^1\d{9}$/;

  // Collect scalar values under date/payment/total-ish keys, wherever they sit.
  // Ultron renders the price breakdown as label/value pairs, so the amount lives
  // under a key called "value" and a key-name match never finds it. Capture the
  // pair instead: that also yields shipping and voucher lines, which are exactly
  // the difference between summed item prices and what was actually charged.
  // Singapore writes a bare "$34.58" / "-$34.58", so a plain $ counts too.
  const MONEYISH = /^\s*-?\s*(?:฿|THB|RM|Rp|S\$|₱|₫|\$)\s?-?[\d][\d,.]*\s*$/;
  const LABEL_KEYS = ['title', 'label', 'name', 'key', 'text', 'desc', 'content'];
  const VALUE_KEYS = ['value', 'price', 'amount', 'text', 'content', 'desc', 'subTitle'];

  function labelledAmount(node) {
    let label = '';
    let value = '';
    for (const k of LABEL_KEYS) {
      const v = node[k];
      if (typeof v === 'string' && v.trim() && !MONEYISH.test(v)) { label = v.trim(); break; }
    }
    if (!label) return null;
    for (const k of VALUE_KEYS) {
      const v = node[k];
      if ((typeof v === 'string' || typeof v === 'number') && MONEYISH.test(String(v))) { value = String(v).trim(); break; }
    }
    return value ? { label, value } : null;
  }

  function harvest(root) {
    // stamps keeps every date value in order; dates only the first per key.
    const out = { dates: {}, stamps: [], pay: {}, total: {}, lines: {}, orderTotal: '', orderSn: '', summary: null };
    const seen = new Set();
    (function walk(n, depth) {
      if (!n || typeof n !== 'object' || depth > 8 || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)) { n.forEach((v) => walk(v, depth + 1)); return; }
      const pair = labelledAmount(n);
      if (pair && !(pair.label in out.lines)) out.lines[pair.label] = pair.value;
      // Lazada's order-level "Order Summary" (totalSummary_<order>.fields):
      // { fees: [{ key: "Subtotal", value: "$51.04" }, { key: "Shipping Fee", … }], total: "$57.97" }.
      // Unlike the package blocks it covers every package of the order, so its
      // shipping fee and total are the order's own (verified Oct 2026).
      if (!IS_SHOPEE && !out.summary && Array.isArray(n.fees) && MONEYISH.test(String(n.total == null ? '' : n.total))) {
        const fees = n.fees.filter((x) => isObj(x) && typeof x.key === 'string' && MONEYISH.test(String(x.value == null ? '' : x.value)))
          .map((x) => [x.key.trim(), String(x.value).trim()]);
        out.summary = { fees, total: String(n.total).trim() };
      }
      // The order's summary block (Lazada SG): { totalKey: "Total: ", total: "$1.99" }.
      // It is the whole order's total, and is there even when the package
      // breakdown has no "Total:" row (older, multi-package and RedMart orders).
      if (!out.orderTotal && typeof n.totalKey === 'string' && MONEYISH.test(String(n.total == null ? '' : n.total))) {
        out.orderTotal = String(n.total).trim();
      }
      // Shopee get_order_detail (verified Oct 2026): dates are rows of
      // { info_label: { text: "label_odp_order_time" }, info_value: { value: "1700000000" } }.
      if (isObj(n.info_label) && isObj(n.info_value) && typeof n.info_label.text === 'string') {
        const m = n.info_label.text.match(/odp_(order|payment)_time/i);
        const v = String(n.info_value.value == null ? '' : n.info_value.value).trim();
        if (m && /^1\d{9}$/.test(v)) {
          const k = m[1].toLowerCase() === 'order' ? 'ordertime' : 'paytime';
          if (!out.dates[k]) out.dates[k] = v;
          out.stamps.push([k, v]);
        }
        // Price breakdown rows (payment_info.info_rows): type 5 is money, as a
        // scaled integer. Renamed to the labels kindOf() classifies.
        const moneyRow = Number(n.info_value.type) === 5 || /subtotal|shipping|voucher|discount|coin|total|fee|rebate/i.test(n.info_label.text);
        if (!m && moneyRow && /^-?\d+$/.test(v)) {
          const raw = n.info_label.text.replace(/^label_(odp_)?/i, '').replace(/_/g, ' ').trim().toLowerCase();
          const label = /merchandise subtotal/.test(raw) ? 'Subtotal'
            : /shipping/.test(raw) && /discount|voucher|promo|rebate|subsid/.test(raw) ? 'Shipping Fee Voucher'
            : /^shipping( fee)?$/.test(raw) ? 'Shipping Fee'
            : /^(order )?total$/.test(raw) ? 'Total'
            : raw.replace(/^\w/, (c) => c.toUpperCase());
          const amt = Number(v) / 100000;
          if (!(label in out.lines)) out.lines[label] = `${amt < 0 ? '-' : ''}$${Math.abs(amt).toFixed(2)}`;
        }
      }
      // Shopee: the order number shown to the buyer (e.g. "2401017ABCDEFG"), only in the
      // detail response (processing_info / pc_processing_info.order_sn).
      if (IS_SHOPEE && !out.orderSn && typeof n.order_sn === 'string' && n.order_sn.trim()) {
        out.orderSn = n.order_sn.trim();
      }
      // Shopee: { payment_channel_name: { text: "Credit/Debit Card" } }.
      if (isObj(n.payment_channel_name) && typeof n.payment_channel_name.text === 'string' && !out.pay.paidBy) {
        out.pay.paidBy = n.payment_channel_name.text.trim();
      }
      // Shopee: the order's charged total, as a scaled integer.
      if (IS_SHOPEE && !out.orderTotal && isObj(n.info_card) && n.info_card.final_total != null) {
        out.orderTotal = String(n.info_card.final_total);
      }
      // { key: "Paid by", value: "Credit/Debit Card", subValue: "$1.99" }: the method is the value.
      if (typeof n.key === 'string' && /^(paid by|payment method)$/i.test(n.key.trim())
          && typeof n.value === 'string' && n.value.trim() && !MONEYISH.test(n.value) && !out.pay.paidBy) {
        out.pay.paidBy = n.value.trim();
      }
      for (const [rk, v] of Object.entries(n)) {
        // Shopee uses snake_case (create_time, payment_method); compare without underscores.
        const k = rk.replace(/_/g, '');
        if (isScalar(v) && v !== null && String(v).trim()) {
          const sv = String(v).trim();
          if (DATE_KEY.test(k) && DATEISH.test(sv)) {
            if (!out.dates[k]) out.dates[k] = sv;
            out.stamps.push([k, sv]);
          } else if (PAY_KEY.test(k) && sv.length < 60 && !/^\d+$/.test(sv) && !out.pay[k]) out.pay[k] = sv;
          else if (TOTAL_KEY.test(k) && sv.length < 30 && !out.total[k]) out.total[k] = sv;
        } else walk(v, depth + 1);
      }
    })(root, 0);
    return out;
  }

  // Locate a leaf whose value is one of our known order ids, so it can be swapped.
  function findIdPath(node, idSet, depth = 0, path = []) {
    if (!isObj(node) || depth > 6) return null;
    for (const [k, v] of Object.entries(node)) {
      if ((typeof v === 'string' || typeof v === 'number') && idSet.has(String(v))) {
        return { path: [...path, { k, leaf: true, str: typeof v === 'string' }], id: String(v) };
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (isObj(v)) {
        const s = findIdPath(v, idSet, depth + 1, [...path, { k, json: false }]);
        if (s) return s;
      } else if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
        const p = safeParse(v);
        if (isObj(p)) {
          const s = findIdPath(p, idSet, depth + 1, [...path, { k, json: true }]);
          if (s) return s;
        }
      }
    }
    return null;
  }

  // Shopee's detail request is a GET with the id in the query
  // (get_order_detail?order_id=…) or the path; Lazada's is a POST body.
  function findIdInUrl(urlStr, idSet) {
    let u;
    try { u = new URL(urlStr); } catch (_) { return null; }
    for (const [k, v] of u.searchParams.entries()) if (idSet.has(v)) return { path: [{ k: `url?${k}` }], id: v };
    for (const seg of u.pathname.split('/')) if (idSet.has(seg)) return { path: [{ k: 'url-path' }], id: seg };
    return null;
  }

  // A capture is usable for the detail pass if its request embeds a known order id
  // (in the body or the URL) and its response carries at least one date.
  function pickDetailCapture(idSet) {
    for (let i = state.captures.length - 1; i >= 0; i--) {
      const rec = state.captures[i];
      if (!fresh(rec)) continue;
      const resp = safeParse(rec.body);
      if (!resp) continue;
      const h = harvest(resp);
      if (!Object.keys(h.dates).length) continue;
      const body = rec.reqBody ? safeParse(rec.reqBody) : null;
      // URL ids are Shopee-only: Lazada keeps its original body-only rule.
      const hit = (isObj(body) && findIdPath(body, idSet)) || (IS_SHOPEE ? findIdInUrl(rec.url, idSet) : null);
      if (!hit) continue;
      return { rec, body, path: hit.path, sampleId: hit.id, dateKeys: Object.keys(h.dates) };
    }
    return null;
  }

  // Why is the dates button still disabled? Report per capture rather than
  // leaving a greyed-out button with no explanation.
  function detailDiag() {
    const ids = new Set(state.rows.map((r) => String(r.orderId)).filter(Boolean));
    if (!state.captures.length) return ['No requests recorded yet on this page.'];
    const paths = state.captures.map((c) => pathOf(c.url));
    if (!paths.some((p) => /detail/i.test(p))) {
      return ['No order-detail request recorded yet — open one order, let it load, then reopen this popup.',
              `Seen so far: ${paths.join(', ')}`];
    }
    const out = [];
    for (const rec of state.captures.slice(-6)) {
      let path = rec.url;
      try { path = new URL(rec.url).pathname; } catch (_) {}
      const resp = safeParse(rec.body);
      const h = resp ? harvest(resp) : null;
      const dateKeys = h ? Object.keys(h.dates) : [];
      const body = rec.reqBody ? safeParse(rec.reqBody) : null;
      const hit = ids.size ? ((isObj(body) && findIdPath(body, ids)) || findIdInUrl(rec.url, ids)) : null;
      const why = [];
      if (!hit) why.push(rec.reqBody ? 'no known order id in body or URL' : 'no known order id in URL (no body)');
      if (!resp) why.push('response not JSON');
      else if (!dateKeys.length) why.push('no date-like keys in response');
      out.push(`${path} — ${why.length ? why.join('; ') : `OK (id at ${hit.path.map((x) => x.k).join('.')}, dates: ${dateKeys.join(', ')})`}`);
    }
    return out;
  }

  function detailReady() {
    const ids = new Set(state.rows.map((r) => String(r.orderId)).filter(Boolean));
    return ids.size ? pickDetailCapture(ids) : null;
  }

  // Orders the detail pass has not dated yet. An update only adds a handful,
  // so re-reading every order would waste ten minutes on known answers.
  // Bumped when the detail pass learns to read more, so orders read by an older
  // version are offered again (2: amounts and payment method on Lazada SG;
  // 3: the order total from the summary block).
  // Shopee 4: price breakdown (subtotal, shipping, vouchers) from payment_info.
  // Shopee 5: merchandise subtotal no longer shadowed by the list's subtotal.
  // Shopee 6: order number (orderSn) from the detail response.
  // Shopee 7: shipping timeline, carrier, tracking, amount paid, coins, cancel reason.
  // Shopee 8: shippedAt/deliveredAt from the right pc_ fields; coins unscaled.
  // Shopee 9: re-read so stale deliveredAt values from 7/8 are cleared.
  // Lazada 4: shipping fee and total from the order-level summary (every package).
  const DETAILS_VERSION = IS_SHOPEE ? '9' : IS_ALIEXPRESS ? 'ae1' : IS_AMAZON ? 'amz1' : '4';

  function undatedOrders() {
    const dated = new Set();
    const all = [];
    for (const r of state.rows) {
      const id = String(r.orderId || '');
      if (!id) continue;
      // Left out of every file anyway: not worth a request.
      if (beforeCutoff(r)) { dated.add(id); continue; }
      // Older versions are read again: Lazada 2 and 3 missed the shipping of
      // every package but the first.
      if (r.purchasedAt && r.detailsVersion === DETAILS_VERSION) dated.add(id);
      if (!all.includes(id)) all.push(id);
    }
    return all.filter((id) => !dated.has(id));
  }

  // Order pages worth loading in the hidden frame, best first. Only this
  // origin qualifies: the replay runs from here, so a request recorded on
  // another host would be discarded. That rules out orderDetailUrl as given,
  // which points at the mobile site (my-m.) while the list is on my.
  function detailPageCandidates(idSet) {
    const out = [];
    const add = (href) => {
      try {
        const u = new URL(href, location.href);
        if (u.origin === location.origin && !out.includes(u.href)) out.push(u.href);
      } catch (_) {}
    };
    if (IS_SHOPEE) {
      for (const a of document.querySelectorAll('a[href*="/user/purchase/order/"]')) {
        const m = String(a.href).match(/\/order\/(\d+)/);
        if (m && idSet.has(m[1])) { add(a.href); break; }
      }
    }
    // A link on the desktop list itself is the real desktop order page.
    for (const a of document.querySelectorAll('a[href*="tradeOrderId"]')) {
      const m = String(a.href).match(/tradeOrderId=(\d+)/);
      if (m && idSet.has(m[1])) { add(a.href); break; }
    }
    const row = state.rows.find((r) => r.orderDetailUrl && idSet.has(String(r.orderId)));
    if (row) {
      add(row.orderDetailUrl);
      // The mobile page's path and query, on this host.
      try {
        const u = new URL(row.orderDetailUrl, location.href);
        add(location.origin + u.pathname + u.search);
      } catch (_) {}
    }
    return out.slice(0, 2);
  }

  // Without a recorded detail request, load one order in a hidden same-origin
  // frame. The frame's own interceptor records the request and hands it over
  // through storage, exactly as a separately opened order tab would.
  async function ensureDetailCapture(idSet) {
    let cap = pickDetailCapture(idSet);
    if (cap) return cap;
    const urls = detailPageCandidates(idSet);
    if (urls.length) log('Opening one order out of sight to learn how order details load…');
    for (const url of urls) {
      const frame = document.createElement('iframe');
      frame.name = PRIME_FRAME;
      frame.src = url;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      // Off-screen but full size: a 1px or hidden frame may never render far
      // enough to fire the request.
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;';
      (document.body || document.documentElement).appendChild(frame);
      try {
        for (let i = 0; i < 30 && !state.cancel; i++) {
          await sleep(500);
          cap = pickDetailCapture(idSet);
          if (cap) return cap;
        }
      } finally {
        frame.remove();
      }
      if (state.cancel) break;
    }
    return null;
  }

  // Replace every standalone occurrence of the id, not just the first.
  const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function idPattern(id) {
    return new RegExp(`(?<![0-9])${reEscape(id)}(?![0-9])`, 'g');
  }

  function swapId(bodyStr, fromId, toId) {
    // Replacement is a function: a literal string would expand $& and friends.
    return String(bodyStr).replace(idPattern(fromId), () => String(toId));
  }

  // Lazada sends display text ("Placed on 31 May 2026  17:34:48"), sometimes
  // epoch milliseconds. Both become "2026-05-31 17:34:48" so the column sorts;
  // label is the word before "on" (placed, paid), which says what the time is.
  // A delivery estimate ("Get by 25 Sep") has no year and yields no time.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n) => String(n).padStart(2, '0');
  function readDate(v) {
    const s = String(v == null ? '' : v).trim();
    const label = ((s.match(/^([a-z ]+?)\s+on\s/i) || [])[1] || '').toLowerCase();
    if (/^\d{13}$/.test(s) || /^1\d{9}$/.test(s)) {
      const d = new Date(Number(s) * (s.length === 10 ? 1000 : 1));
      if (isNaN(d)) return { at: '', label };
      return { at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, label };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { at: s.replace('T', ' ').slice(0, 19), label };
    const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    if (mon < 0) return { at: '', label };
    return { at: `${m[3]}-${pad(mon + 1)}-${pad(m[1])} ${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`, label };
  }

  // Restored rows from 2.4.0 hold the raw text, and a delivery estimate may sit
  // in purchasedAt. Normalise; a blanked date makes the order undated again.
  function normaliseDates(r) {
    if (r.purchasedAt) {
      const d = readDate(r.purchasedAt);
      r.purchasedAt = d.label === 'paid' ? '' : d.at;
    }
    if (r.paidAt) {
      const d = readDate(r.paidAt);
      r.paidAt = d.label === 'placed' ? '' : d.at;
    }
    return r;
  }

  // ------------------------------------------------- AliExpress details pass
  // Two read-only calls per order (verified Oct 2026):
  //   mtop.aliexpress.trade.buyer.order.detail {tradeOrderId}: entity map with
  //     detail_simple_order_info_component.fields { orderCreatTime "Oct 2, 2026",
  //       payTime, orderShipTime, orderEndTime, paymentMethod, addressVO (never read) }
  //     detail_order_price_block.fields { priceDetails[{title,value}], totalPrice{value} }
  //   mtop.ae.ld.querydetail {tradeOrderId}: module.trackingDetailLineList[]
  //     { mailNo, logisticsCarrierName, detailList[{ time (ms), trackingDetailDesc,
  //       trackingPrimaryCode e.g. AE_GTMS_SIGNED = delivered }] }
  // The tracking history's "order created" event is the only exact order time.
  function aeEntity(res, type) {
    const data = res && res.data && isObj(res.data.data) ? res.data.data : {};
    for (const v of Object.values(data)) if (isObj(v) && (v.type === type || v.tag === type) && isObj(v.fields)) return v.fields;
    return {};
  }

  function aeDetailFields(detailRes, trackRes) {
    const out = {};
    const info = aeEntity(detailRes, 'detail_simple_order_info_component');
    out.paidAt = aeDate(info.payTime);
    out.shippedAt = aeDate(info.orderShipTime);
    out.completedAt = aeDate(info.orderEndTime);
    out.paymentMethod = String(info.paymentMethod || '').trim();
    const created = aeDate(info.orderCreatTime);

    const price = aeEntity(detailRes, 'detail_order_price_block');
    const lines = Array.isArray(price.priceDetails) ? price.priceDetails : [];
    let subtotal = 0, ship = 0, tax = 0, disc = 0, hasSub = false, hasShip = false, hasTax = false;
    const charges = [];
    for (const l of lines) {
      if (!isObj(l) || !l.title) continue;
      const t = String(l.title).trim();
      const v = parseMoney(l.value);
      charges.push(`${t}${String(l.hide) === 'true' ? ' (not shown)' : ''}=${l.value}`);
      if (/^sub\s*total/i.test(t)) { subtotal += v; hasSub = true; }
      else if (/coupon|discount|promo|sav(e|ing)|spend|voucher|coin|rebate|off\b/i.test(t) || v < 0) disc += Math.abs(v);
      else if (/shipping|delivery/i.test(t)) { ship += v; hasShip = true; }
      else if (/tax|gst|vat|duty/i.test(t)) { tax += v; hasTax = true; }
    }
    if (hasSub) out.subtotal = subtotal.toFixed(2);
    if (hasShip) out.shippingFee = ship.toFixed(2);
    if (hasTax) out.tax = tax.toFixed(2);
    out.discount = disc ? disc.toFixed(2) : '';
    out.charges = charges.join(' | ');
    if (isObj(price.totalPrice) && price.totalPrice.value) out.orderTotal = parseMoney(price.totalPrice.value).toFixed(2);

    const tl = trackRes && trackRes.data && isObj(trackRes.data.module) && Array.isArray(trackRes.data.module.trackingDetailLineList)
      ? trackRes.data.module.trackingDetailLineList : [];
    const uniq = (a) => a.map((x) => String(x || '').trim()).filter((x, i, arr) => x && arr.indexOf(x) === i);
    out.trackingNumber = uniq(tl.map((l) => l && l.mailNo)).join(' | ');
    out.carrier = uniq(tl.map((l) => l && l.logisticsCarrierName)).join(' | ');
    out.parcels = tl.length || '';
    const events = [];
    for (const l of tl) if (l && Array.isArray(l.detailList)) events.push(...l.detailList.filter(isObj));
    const ms = (e) => Number(e.time) || 0;
    const delivered = events.filter((e) => /SIGNED/i.test(String(e.trackingPrimaryCode || '')) || /delivered/i.test(String(e.trackingDetailDesc || ''))).map(ms).filter(Boolean);
    out.deliveredAt = delivered.length ? readDate(String(Math.max(...delivered))).at : '';
    const made = events.filter((e) => /order.{0,12}created|order (is )?placed/i.test(String(e.trackingDetailDesc || ''))).map(ms).filter(Boolean);
    const madeAt = made.length ? readDate(String(Math.min(...made))).at : '';
    // Prefer the exact time when it falls on the date the order page shows.
    out.purchasedAt = madeAt && (!created || madeAt.startsWith(created)) ? madeAt : created;
    return out;
  }

  async function aeRunDetails(delayMs) {
    state.detailError = '';
    const undated = undatedOrders();
    const ids = [...undated.filter((id) => !state.failedIds.has(id)), ...undated.filter((id) => state.failedIds.has(id))];
    if (!ids.length) { log('Every order already has its details.'); return 0; }
    state.phase = 'details';
    state.progress = { done: 0, total: ids.length, message: state.progress.message };
    log(`Reading ${ids.length} AliExpress orders (details + tracking, two requests each)…`);
    const got = new Map();
    let misses = 0;
    for (let i = 0; i < ids.length && !state.cancel; i++) {
      const id = ids[i];
      try {
        const detail = await pageMtop('mtop.aliexpress.trade.buyer.order.detail', { tradeOrderId: id, clientPlatform: 'pc' });
        let track = null;
        try {
          track = await pageMtop('mtop.ae.ld.querydetail', { tradeOrderId: id, tradeOrderLineId: '', terminalType: 'PC', needPageDisplayInfo: true });
        } catch (_) { /* no tracking for closed/unshipped orders */ }
        got.set(id, aeDetailFields(detail, track));
        state.failedIds.delete(id);
        misses = 0;
      } catch (e) {
        if (e.message === NEEDS_RELOAD) { state.detailError = NEEDS_RELOAD; log(NEEDS_RELOAD); break; }
        misses++;
        state.failedIds.add(id);
        if (misses <= 3) log(`Order ${id}: ${e.message}`);
        if (misses >= 8 && got.size === 0) {
          state.detailError = `AliExpress is refusing the order details (${e.message}). Reload the page, make sure you are signed in, and try again.`;
          log(state.detailError);
          break;
        }
      }
      state.progress.done = i + 1;
      if (i % 25 === 0) log(`Details ${i + 1}/${ids.length} — ${got.size} read`);
      await sleep(delayMs + Math.random() * 200);
    }
    let filled = 0;
    for (const r of state.rows) {
      const f = got.get(String(r.orderId));
      if (!f) continue;
      for (const [k, v] of Object.entries(f)) r[k] = v == null ? '' : v;
      // On a cancelled or expired order, "order ended" is when it was closed.
      if (/cancel|expire|closed/i.test(String(r.status || ''))) { r.cancelledAt = r.completedAt || ''; r.completedAt = ''; }
      r.detailsVersion = DETAILS_VERSION;
      filled++;
    }
    invalidate();
    log(`Detail pass done — ${got.size} orders read, ${filled} rows updated.`);
    return got.size;
  }

  // Details are fetched with the signed-in session. Never add them to an
  // export that belongs to a different account (or one that cannot be checked).
  async function detailsAccountCheck() {
    if (!STAMPS_ACCOUNT) return '';
    const rowsAcct = idOf(state.rows);
    const now = await guardAccountSwitch();
    const name = IS_SHOPEE ? 'Shopee' : IS_ALIEXPRESS ? 'AliExpress' : 'Amazon';
    if (rowsAcct && now && rowsAcct !== now) {
      return `This export belongs to a different ${name} account than the one signed in now. Export again for this account (or press Reset everything) before adding dates.`;
    }
    if (rowsAcct && !now) return `Could not confirm which ${name} account is signed in. Reload the page and try again.`;
    if (!rowsAcct) {
      if (!now) return `Could not confirm which ${name} account is signed in. Reload the page and try again.`;
      return `This export was made before account IDs were recorded. Export again (Update) so it is tied to the account signed in now, then add dates.`;
    }
    return '';
  }

  async function runDetails(delayMs) {
    if (IS_AMAZON) return amzRunDetails(delayMs);
    if (IS_ALIEXPRESS) return aeRunDetails(delayMs);
    state.detailError = '';
    // Orders that failed before go last, so they cannot trip the early stop
    // below ahead of orders that would date fine.
    const undated = undatedOrders();
    const ids = [...undated.filter((id) => !state.failedIds.has(id)),
                 ...undated.filter((id) => state.failedIds.has(id))];
    if (!ids.length) { log('Every order already has a date.'); return 0; }

    state.phase = 'details';
    state.progress = { done: 0, total: ids.length, message: state.progress.message };
    const known = new Set(state.rows.map((r) => String(r.orderId)).filter(Boolean));
    const cap = await ensureDetailCapture(known);
    if (!cap) {
      if (!state.cancel) {
        state.detailError = 'Could not learn how to read order dates here. Click any one of your orders so it opens, let it load, come back to this tab and press "Add purchase dates" again.';
        log(state.detailError);
      }
      return 0;
    }
    const occurrences = (String(cap.rec.reqBody || '').match(idPattern(cap.sampleId)) || []).length
      + (String(cap.rec.url).match(idPattern(cap.sampleId)) || []).length;
    log(`Detail API: ${new URL(cap.rec.url).pathname} — order id in ${occurrences} place(s), dates in ${cap.dateKeys.join(', ')}`);

    const headers = { ...(cap.rec.reqHeaders || {}) };
    ['host', 'cookie', 'content-length', 'connection', 'origin', 'referer', 'user-agent']
      .forEach((h) => Object.keys(headers).forEach((k) => { if (k.toLowerCase() === h) delete headers[k]; }));
    const method = (cap.rec.method || (cap.rec.reqBody ? 'POST' : 'GET')).toUpperCase();
    const hasBody = !!cap.rec.reqBody && method !== 'GET' && method !== 'HEAD';
    if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';

    // The "response mentions this order" guard catches a stale id left in a
    // POST body. Shopee's GET detail response never repeats the order id, and
    // with the id in the URL there is no body to go stale, so skip it there.
    const idInBody = hasBody && idPattern(cap.sampleId).test(String(cap.rec.reqBody));
    const enrich = new Map();
    let misses = 0;

    for (let i = 0; i < ids.length && !state.cancel; i++) {
      const id = ids[i];
      try {
        const init = { method, credentials: 'include', headers };
        if (hasBody) init.body = swapId(cap.rec.reqBody, cap.sampleId, id);
        const res = await pageFetch(swapId(cap.rec.url, cap.sampleId, id), init);
        const text = await res.text();
        if (idInBody && !text.includes(id)) {
          // The response is not about this order — a stale id was left in the
          // request. Dating rows from it would be silently wrong.
          misses++;
          state.failedIds.add(id);
          if (misses === 1) log(`Response did not match order ${id}; not dating it.`);
        } else {
          const json = safeParse(text);
          const h = json ? harvest(json) : null;
          if (h && IS_SHOPEE) h.extra = shopeeDetailExtras(json);
          if (h && Object.keys(h.dates).length) { enrich.set(id, h); misses = 0; state.failedIds.delete(id); }
          else { misses++; state.failedIds.add(id); }
        }
      } catch (e) {
        if (e.message === NEEDS_RELOAD) { state.detailError = NEEDS_RELOAD; log(NEEDS_RELOAD); break; }
        misses++;
        state.failedIds.add(id);
        if (i < 3) log(`Detail fetch failed: ${e.message}`);
      }

      // Stop early rather than grinding through a thousand failing requests.
      if (misses >= 8 && enrich.size === 0) {
        state.detailError = `${IS_SHOPEE ? 'Shopee' : 'Lazada'}'s order details are not coming back with dates, so the pass stopped. Open one of your orders in this tab, come back, and try again.`;
        log(state.detailError);
        break;
      }

      state.progress.done = i + 1;
      if (i % 25 === 0) log(`Details ${i + 1}/${ids.length} — ${enrich.size} dated`);
      await sleep(delayMs);
    }

    const PAYISH = /(pay|paid)/i;
    // What the text says beats what the key is called; then known keys whose
    // text does not contradict them; then anything that passes ok.
    const stampOf = (stamps, labels, keys, ok) => {
      const hit = stamps.find((s) => labels.includes(s.label))
        || stamps.find((s) => keys.includes(s.k) && (!s.label || labels.includes(s.label)))
        || stamps.find(ok);
      return hit ? hit.at : '';
    };
    const pick = (obj, prefer, fallback) => {
      for (const k of prefer) for (const [key, v] of Object.entries(obj)) if (key.toLowerCase() === k) return v;
      if (fallback === 'non-payment') {
        for (const [key, v] of Object.entries(obj)) if (!PAYISH.test(key)) return v;
      } else if (fallback === 'any') {
        return Object.values(obj)[0] || '';
      }
      return '';
    };

    // Pull the charged total and its components out of the breakdown.
    // Classification verified against 2,721 real breakdown lines. The naive
    // keyword match was wrong in three ways: "Shipping Fee Voucher" and
    // "Standard Delivery" both matched the shipping pattern and could win over
    // the actual fee; discounts are spread across seven labels and only the
    // first was kept; and "Cashback earned" was read as a refund.
    const kindOf = (label) => {
      const l = label.trim().toLowerCase();
      if (/^total\b/.test(l)) return 'total';
      if (/^sub\s*total/.test(l)) return 'subtotal';
      if (l.includes('shipping fee')) return /voucher|promo|discount/.test(l) ? 'discount' : 'shipping';
      // "Standard Delivery" / "Economy Delivery" head a package block and carry
      // that package's total, not a charge.
      if (/\bdelivery\b/.test(l)) return 'package_total';
      if (l.includes('cashback')) return 'cashback';
      if (/refund|returned|credited/.test(l)) return 'refund';
      if (/voucher|discount|promo|coupon|coins|rebate/.test(l)) return 'discount';
      return 'other';   // product rows and anything unrecognised
    };
    const amount = IS_SHOPEE ? (v) => Number(shopeeMoney(v)) || 0 : parseMoney;
    const fmt = (n) => (n ? n.toFixed(2) : '');

    let filled = 0;
    let totalled = 0;
    for (const r of state.rows) {
      const h = enrich.get(String(r.orderId));
      if (!h) continue;
      r.detailsVersion = DETAILS_VERSION;
      if (h.orderSn) r.orderSn = h.orderSn;
      // Overwrite blanks too: the order was just re-read, so an empty value is
      // the current answer (e.g. no "Delivered" event: Shopee keeps no tracking
      // history for older orders), and keeping the old value left stale data.
      if (h.extra) for (const [k, v] of Object.entries(h.extra)) r[k] = v == null ? '' : v;
      const lines = h.lines || {};

      const sums = {};
      for (const [label, value] of Object.entries(lines)) {
        const k = kindOf(label);
        if (k === 'other') continue;
        sums[k] = (sums[k] || 0) + amount(value);
      }

      const summary = !IS_SHOPEE && h.summary ? h.summary : null;
      const charged = summary ? amount(summary.total)
        : amount(h.orderTotal)
        || amount(pick(h.total, ['totalamount', 'grandtotal', 'ordertotal'], 'any'))
        || sums.total || sums.package_total || 0;
      if (charged || summary) { r.orderTotal = charged.toFixed(2); totalled++; }
      // Keep what the list already gave (Shopee's subtotal and shipping fee)
      // when the detail has no breakdown line for it.
      r.subtotal     = fmt(sums.subtotal) || (IS_SHOPEE ? '' : r.subtotal) || '';
      r.shippingFee  = fmt(sums.shipping) || r.shippingFee || '';
      if (summary) {
        // The summary's shipping covers every package; the package lines above
        // keep only the first package's ("Shipping Fee" repeats per package).
        r.shippingFee = summary.fees.filter(([k]) => /^shipping fee$/i.test(k)).reduce((t, [, v]) => t + amount(v), 0).toFixed(2);
        r.orderSummary = [...summary.fees.map(([k, v]) => `${k}=${v}`), `Total=${summary.total}`].join(' | ');
      }
      r.discount     = fmt(Math.abs(sums.discount || 0));   // reported as a magnitude
      r.cashback     = fmt(Math.abs(sums.cashback || 0));
      r.refundAmount = fmt(Math.abs(sums.refund || 0));
      r.charges = Object.entries(lines).map(([k, v]) => `${k}=${v}`).join(' | ');
      const stamps = (h.stamps || []).map(([k, v]) => ({ k: k.toLowerCase(), ...readDate(v) })).filter((s) => s.at);
      const purchased = stampOf(stamps, ['placed', 'ordered', 'created'],
        ['gmtcreate', 'createtime', 'createdat', 'placedat', 'ordertime', 'ordercreatetime'],
        (s) => s.label !== 'paid' && !PAYISH.test(s.k));
      // No fallback beyond payment keys: never echo the purchase date.
      const paid = stampOf(stamps, ['paid'], ['paytime', 'paidat', 'paymenttime'],
        (s) => s.label === 'paid');
      if (purchased) { r.purchasedAt = purchased; filled++; }
      if (paid) r.paidAt = paid;
      // No breakdown fallback here: the breakdown only holds money values, and a
      // payment method is not one, so it never appears there.
      if (!r.paymentMethod) r.paymentMethod = pick(h.pay, ['paymentmethod', 'paymentdes', 'paymethod', 'paidby'], 'any');
    }
    log(`Detail pass done — dated ${filled} rows, charged total on ${totalled}, across ${enrich.size} orders.`);
    return enrich.size;
  }

  // --------------------------------------------------------------------- run
  // lineId identifies an item line on its own; the title fallback is for DOM
  // rows, which have none.
  const rowKey = (r) => (r.lineId ? `${r.orderId}|${r.lineId}` : `${r.orderId}|${r.skuId}|${r.title}`);

  function addRows(rows, raw) {
    for (const r of rows) if (r && !r.currency) r.currency = SITE_CURRENCY;
    const seen = new Set(state.rows.map(rowKey));
    let added = 0;
    for (const r of rows) {
      const k = rowKey(r);
      if (seen.has(k)) continue;
      seen.add(k); state.rows.push(r); added++;
    }
    if (raw) state.raw.push(...raw);
    if (added) invalidate();
    return added;
  }

  // ------------------------------------------------------------- accounts
  // accountId: the marketplace's own numeric user id for the signed-in buyer,
  // on every row, so a household ledger can key orders to the account. Never
  // an email, name, username, phone or address: numeric id only, else blank.
  //   Shopee:     /api/v4/account/basic/get_account_info -> data.userid
  //               (the page calls it itself; SPC_U session cookie as fallback)
  //   AliExpress: cookie aep_usuc_f -> x_alimid (only that field is read; the
  //               neighbouring xman_* cookies carry name and email and are not)
  //   Lazada:     a numeric buyer id field on the order list, if present
  const ACCOUNT_KEY = `lzx_account_${STORE_TAG}`;
  let currentAccount = '';
  const NUMERIC_ID = /^\d{3,20}$/;
  const AMZ_CUSTOMER_ID = /^A[A-Z0-9]{8,20}$/;
  const LZ_BUYER_KEYS = ['buyerId', 'buyerUserId', 'buyerUid', 'userId', 'memberId', 'customerId'];
  function numericBuyerId(...objs) {
    for (const o of objs) {
      if (!isObj(o)) continue;
      for (const k of LZ_BUYER_KEYS) {
        const v = o[k];
        if ((typeof v === 'number' || typeof v === 'string') && NUMERIC_ID.test(String(v).trim())) return String(v).trim();
      }
    }
    return '';
  }
  // Lazada's list carries no buyer id, but the lzd_uid cookie is the signed-in
  // buyer's numeric user id, and Lazada order and item numbers end in the same
  // last five digits as it. Only that cookie is read, digits only, and it is
  // used only for an order whose number ends in those digits, so a row can
  // never be given another account's id.
  function lazadaUserId(orderId) {
    if (MARKET !== 'lazada') return '';
    const uid = cookieValue('lzd_uid').trim();
    if (!NUMERIC_ID.test(uid) || uid.length < 5) return '';
    return String(orderId || '').endsWith(uid.slice(-5)) ? uid : '';
  }
  function cookieValue(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1] : '';
  }
  async function resolveAccountId() {
    let id = '';
    try {
      if (IS_SHOPEE) {
        const res = await pageFetch(`${location.origin}/api/v4/account/basic/get_account_info`, { method: 'GET', credentials: 'include', headers: {} });
        const j = safeParse(await res.text());
        const v = j && isObj(j.data) ? j.data.userid : '';
        if (NUMERIC_ID.test(String(v ?? ''))) id = String(v);
        if (!id && NUMERIC_ID.test(cookieValue('SPC_U'))) id = cookieValue('SPC_U');
      } else if (IS_AMAZON) {
        // Amazon has no numeric user id. Its customer ID ("A" + 8-20 upper-case
        // letters/digits, no personal data) is used instead; the page config
        // carries it as "customerID":"…" beside "marketplaceID" (not that one).
        const m = document.documentElement.innerHTML.match(/"customerID"\s*:\s*"(A[A-Z0-9]{8,20})"/);
        if (m && AMZ_CUSTOMER_ID.test(m[1])) id = m[1];
      } else if (IS_ALIEXPRESS) {
        let raw = '';
        try { raw = decodeURIComponent(cookieValue('aep_usuc_f')); } catch (_) {}
        const m = raw.match(/(?:^|&)x_alimid=(\d{3,20})(?:&|$)/);
        if (m) id = m[1];
      }
    } catch (_) { /* unknown: left blank, and treated as unverifiable */ }
    if (STAMPS_ACCOUNT) currentAccount = id;
    return id;
  }

  // Account comparison: numeric ids when both sides have one, else (Lazada)
  // the buyer address the list returns on every row. Compared only, never
  // logged or shown.
  const idOf = (rows) => { for (const r of rows) if (r && r.accountId) return String(r.accountId); return ''; };
  const emailOf = (rows) => {
    for (const r of rows) if (r && r['raw.buyerEmail']) return String(r['raw.buyerEmail']).trim().toLowerCase();
    return '';
  };
  function accountRelation(a, b) {
    const ia = idOf(a), ib = idOf(b);
    if (ia && ib) return ia === ib ? 'same' : 'different';
    const ea = emailOf(a), eb = emailOf(b);
    if (ea && eb) return ea === eb ? 'same' : 'different';
    return 'unknown';
  }
  const accountOf = (rows) => idOf(rows) || emailOf(rows);

  // Enough to tell two household accounts apart in the popup: "ID …123" or "ac…@example.com".
  const maskAccount = (acct) => {
    const s = String(acct || '');
    if (NUMERIC_ID.test(s) || AMZ_CUSTOMER_ID.test(s)) return `ID …${s.slice(-3)}`;
    const [user, domain] = s.split('@');
    return user && domain ? `${user.slice(0, 2)}…@${domain}` : '';
  };

  // Recorded requests belong to whoever was signed in when they were made.
  // When the signed-in account changes, forget them so none is ever replayed
  // for the other account.
  async function guardAccountSwitch() {
    const now = await resolveAccountId();
    const was = await store.get(ACCOUNT_KEY);
    if (now && was && String(was) !== now) {
      state.captures = [];
      await store.remove([CAP_KEY]);
      invalidate();
      log('A different account is signed in than last time: requests recorded for the previous account were discarded.');
    }
    if (now) store.set(ACCOUNT_KEY, now);
    return now;
  }

  // Filled by the detail pass, never by the list. A refreshed row keeps them so
  // an update does not throw away dates that took minutes to fetch.
  const DETAIL_FIELDS = ['orderSn', 'tax', 'giftCardAmount', 'itemCurrency', 'exchangeRate', 'otherFees', 'paymentCurrency', 'shippedAt', 'deliveredAt', 'completedAt', 'cancelledAt', 'cancelReason',
                         'carrier', 'trackingNumber', 'parcels', 'amountPaid', 'coinsEarned', 'purchasedAt', 'paidAt', 'shippingFee', 'discount', 'subtotal', 'cashback',
                         'refundAmount', 'charges', 'orderTotal', 'paymentMethod', 'detailsVersion'];

  function carryDetails(row, prev) {
    if (!prev) return row;
    for (const k of DETAIL_FIELDS) if ((row[k] === '' || row[k] == null) && prev[k]) row[k] = prev[k];
    return row;
  }

  async function fetchPage(cap, page) {
    if (cap.kind === 'amazon') return amzFetchPage(page);
    if (cap.kind === 'aliexpress') {
      const out = await aeFetchPage(page);
      if (!out) throw new Error(`page ${page}: AliExpress order list was not in a known shape`);
      return out;
    }
    const req = cap.pager.make(page);
    const headers = { ...(req.headers || {}) };
    ['host', 'cookie', 'content-length', 'connection', 'origin', 'referer', 'user-agent']
      .forEach((h) => Object.keys(headers).forEach((k) => { if (k.toLowerCase() === h) delete headers[k]; }));
    if (req.body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const init = { method: req.method || 'GET', credentials: 'include', headers };
    if (req.body && init.method !== 'GET' && init.method !== 'HEAD') init.body = req.body;

    const res = await pageFetch(req.url, init);
    const json = safeParse(await res.text());
    if (!json) throw new Error(`page ${page}: HTTP ${res.status}, response was not JSON`);
    if (json.success === false) throw new Error(`page ${page}: server said success=false (${json.errorCode || 'no code'})`);
    // Shopee: { error: 0 } is success; anything else (e.g. 90309999, the
    // anti-bot check) means the replay was refused.
    if (cap.kind === 'shopee' && json.error && json.error !== 0) {
      throw new Error(`page ${page}: Shopee refused the request (error ${json.error}${json.error_msg ? `: ${json.error_msg}` : ''})`);
    }
    const parsed = parseApi(json, page, req.url);
    if (parsed && (parsed.empty || !parsed.rows.length) && cap.kind === 'shopee') return { ...parsed, rows: [], empty: true };
    if (parsed) return parsed;
    // Lazada's page count runs one past the last order (124 pages of orders,
    // totalPageNum 125). A well-formed page with no items is the end of the
    // list, not an error; treating it as one left every export "incomplete".
    const data = json.module && json.module.data;
    if (isObj(data)) return { rows: [], raw: [], totalPages: 0, empty: true };
    throw new Error(`page ${page}: no order items in response`);
  }

  async function run(opts) {
    // Pages run newest first. With a complete previous export, reading stops at
    // the first page holding nothing new; otherwise every page is read again.
    // Either way, rows from before keep their dates and anything not re-read
    // is carried over. An explicit page range or "full" starts from nothing.
    const start = opts.startPage || 1;
    let merging = !opts.full && start === 1 && !opts.endPage && state.rows.length > 0;
    let prior = merging ? state.rows : [];
    let priorByKey = new Map(prior.map((r) => [rowKey(r), r]));
    let stopEarly = merging && state.complete && coversCutoff();
    let hadDates = prior.some((r) => r.purchasedAt);
    const priorByOrder = new Map();

    state.running = true;
    state.cancel = false;
    state.done = false;
    state.complete = false;
    state.rows = [];
    state.raw = [];
    state.log = [];
    state.phase = stopEarly ? 'update' : 'list';
    state.progress = { done: 0, total: 0, message: 'Starting' };
    invalidate();

    let reachedEnd = false;
    let cutoffStop = false;
    amzStoppedAt = 0;
    let fresh = 0;
    // Newest-first lists: once a whole page is older than the cutoff, so is
    // everything after it. Lazada's list has no dates, so it reads every page.
    const allBeforeCutoff = (rows) => !!FROM_YEAR && rows.length > 0 && rows.every(beforeCutoff);
    // Folds the previous export back in. Runs on every exit path, so a failed
    // or stopped update never loses rows the last export had.
    const mergePrior = () => {
      if (!merging) return;
      const seen = new Set(state.rows.map(rowKey));
      for (const r of prior) if (!seen.has(rowKey(r))) state.rows.push(r);
      // Raw fields now cover only the re-read pages; the JSON falls back to rows.
      state.raw = [];
      invalidate();
    };
    const take = (out) => {
      const rows = out.rows.map((r) => {
        if (STAMPS_ACCOUNT && r) r.accountId = currentAccount;
        return carryDetails(r, priorByKey.get(rowKey(r)) || priorByOrder.get(String(r.orderId)));
      });
      const added = addRows(rows, out.raw);
      const unseen = rows.filter((r) => !priorByKey.has(rowKey(r))).length;
      fresh += unseen;
      return { added, unseen };
    };
    if (merging) log(stopEarly
      ? `Checking for orders newer than your last export (${prior.length} rows).`
      : 'The last export did not cover every page, so reading them all again (dates are kept).');

    try {
      if (STAMPS_ACCOUNT) await guardAccountSwitch();
      const cap = await ensureCapture();

      if (!cap && state.cancel) {
        mergePrior();
        finish('Stopped before anything was read.');
        return;
      }
      if (!cap) {
        state.mode = 'live DOM';
        log('No API request could be recorded — reading the visible page instead.');
        if (IS_SHOPEE) await scrollShopeeToEnd();
        addRows(extractLive(1).map((r) => ({ ...r, accountId: currentAccount })), null);
        mergePrior();
        finish(IS_SHOPEE
          ? `Read ${state.rows.length} rows from the page (scrolled to the end).`
          : `Read ${state.rows.length} rows from the current page only.`);
        return;
      }

      // Rows read off the page (the DOM fallback) key items differently from the
      // API, so merging them would duplicate every item. When the API works,
      // drop them and keep only their fetched details, matched by order id.
      if (merging && prior.some((r) => r._source === 'dom')) {
        for (const r of prior) {
          if (r._source !== 'dom' || !r.orderId || priorByOrder.has(String(r.orderId))) continue;
          priorByOrder.set(String(r.orderId), r);
        }
        prior = prior.filter((r) => r._source !== 'dom');
        priorByKey = new Map(prior.map((r) => [rowKey(r), r]));
        stopEarly = false;
        log('Replacing the rows read from the page with full API data (dates already fetched are kept).');
      }
      state.mode = `API (${cap.pager.where})`;
      log(`Using ${new URL(cap.rec.url).pathname} — page field ${cap.pager.where}`);

      let first;
      try {
        first = await fetchPage(cap, start);
      } catch (e) {
        // Shopee can still refuse a replay (anti-bot rules change). Rather than
        // stop at "Failed", read the orders off the page itself.
        if (!IS_SHOPEE) throw e;
        log(`${e.message} — reading the orders from the page instead (slower; scrolls to the end).`);
        state.mode = 'live DOM';
        await scrollShopeeToEnd();
        addRows(extractLive(1).map((r) => ({ ...r, accountId: currentAccount })), null);
        mergePrior();
        if (state.rows.length) downloadCsv();
        finish(`Read ${state.rows.length} rows from the page — CSV downloaded.`);
        return;
      }
      if (first.empty) throw new Error(`page ${start}: no order items in response`);
      // Signed in as someone else since the last export (e.g. a partner's account in
      // the same browser): their orders must not be added to the previous account's.
      if (STAMPS_ACCOUNT) for (const r of first.rows) r.accountId = currentAccount;
      const relation = accountRelation(prior, first.rows);
      const marketName = IS_SHOPEE ? 'Shopee' : IS_ALIEXPRESS ? 'AliExpress' : IS_AMAZON ? 'Amazon' : 'Lazada';
      if (merging && relation === 'different') {
        log(`This is a different ${marketName} account from your last export, so this is a new export for it. The last account's export is replaced: save it first if you still need it.`);
        merging = false; prior = []; priorByKey = new Map(); priorByOrder.clear(); stopEarly = false; hadDates = false;
        state.phase = 'list';
      } else if (merging && relation === 'unknown' && STAMPS_ACCOUNT) {
        // The last export cannot be tied to an account (made before accountId
        // existed, or the id could not be read now): never fold its rows in.
        // Details are still carried for orders this account's list returns,
        // since an order id belongs to exactly one buyer.
        log(`Your last export has no account ID to check against, so this is a fresh export for the ${marketName} account signed in now (dates for orders found again are kept).`);
        merging = false; stopEarly = false;
        state.phase = 'list';
      }
      if (!STAMPS_ACCOUNT) currentAccount = idOf(first.rows);
      // Offset-paged lists (Shopee) never report a page count: read until a
      // page comes back empty or the server says there is no more.
      const openEnded = !opts.endPage && !first.totalPages && !!cap.pager.offset;
      const MAX_OPEN_PAGES = 1000;
      let total = opts.endPage || first.totalPages || (openEnded ? MAX_OPEN_PAGES : detectTotalPages());
      // A chosen range, or a page count guessed from the pager, can end early.
      const trustEnd = !opts.endPage && (!!first.totalPages || openEnded);
      const of = (n) => (openEnded ? '' : `/${n}`);
      if (total < start) {
        log(`Last page (${total}) is before the first (${start}); exporting page ${start} only.`);
        total = start;
      }
      state.progress.total = openEnded ? 0 : total - start + 1;

      let caughtUp = false;
      const firstTake = take(first);
      state.progress.done = 1;
      log(`Page ${start}${of(total)} — ${first.rows.length} items (${firstTake.unseen} new)`);
      if (stopEarly && !firstTake.unseen) caughtUp = true;
      else if (start === total || first.hasMore === false) { reachedEnd = true; total = start; }
      else if (allBeforeCutoff(first.rows)) { cutoffStop = true; reachedEnd = true; total = start; log(`Every order on page ${start} is before ${FROM_YEAR} — stopping.`); }

      for (let page = start + 1; page <= total && !state.cancel && !caughtUp; page++) {
        await sleep(opts.delayMs + Math.random() * 200);
        let out;
        try { out = await fetchPage(cap, page); }
        catch (e) { log(`${e.message} — stopping here.`); break; }
        if (out.empty) { log(`Page ${page} is empty — that is the end of your orders.`); reachedEnd = true; break; }
        const { added, unseen } = take(out);
        state.progress.done = page - start + 1;
        log(`Page ${page}${of(total)} — ${out.rows.length} items (${added} added, ${unseen} new), ${state.rows.length} rows`);
        if (stopEarly && !unseen) caughtUp = true;
        else if (page === total || out.hasMore === false) { reachedEnd = true; break; }
        else if (allBeforeCutoff(out.rows)) { cutoffStop = true; reachedEnd = true; log(`Every order on page ${page} is before ${FROM_YEAR} — stopping.`); break; }
      }

      mergePrior();
      // Complete only if this run read from page 1 to the end, or caught up
      // with an export that itself was complete.
      state.complete = !state.cancel && start === 1 && (caughtUp || (reachedEnd && (trustEnd || cutoffStop)));
      if (!caughtUp) state.coveredFrom = cutoffStop || amzStoppedAt ? FROM_YEAR : 0;
      if (!state.complete && !state.cancel && start === 1) log('Not every page was read, so the next update will read them all again.');

      // Someone who added dates before expects new orders dated too.
      if (merging && hadDates && fresh && !state.cancel && undatedOrders().length) {
        await runDetails(opts.delayMs || 400);
      }

      const orders = new Set(state.rows.map((r) => r.orderId)).size;
      // An update that found nothing new has nothing new to save: say so, and
      // point at the detail pass when orders still lack details.
      if (merging && !fresh && !state.cancel) {
        const todo = undatedOrders().length;
        finish(`No new orders since your last export (${orders} orders).` + (todo
          ? ` ${todo} ${todo === 1 ? 'order still needs' : 'orders still need'} details: press "Add purchase dates".`
          : ' Press "Save CSV again" for a copy.'));
        return;
      }
      if (state.rows.length) downloadCsv();
      finish(state.cancel
        ? `Stopped. ${state.rows.length} rows kept — CSV downloaded.`
        : merging
          ? `Updated. ${fresh} new ${fresh === 1 ? 'item' : 'items'}; ${state.rows.length} rows from ${orders} orders — CSV downloaded.`
          : `Done. ${state.rows.length} rows from ${orders} orders — CSV downloaded.`);
    } catch (e) {
      mergePrior();
      finish(`Failed: ${e.message}`);
    }
  }

  function finish(msg) {
    state.running = false;
    state.done = true;
    log(msg);
    saveRows();
  }

  function saveRows() {
    store.set(RESULT_KEY, {
      rows: state.rows.slice(0, 20000), at: Date.now(), origin: location.origin,
      complete: state.complete && state.rows.length <= 20000,
      coveredFrom: state.coveredFrom || 0,
    });
  }

  // ------------------------------------------------------------- from year
  // "Only orders from year X": one setting for every marketplace, set in the
  // popup. Older orders are not read where the site lists them by year or
  // newest first (Amazon, AliExpress, Shopee), and are left out of every file.
  // Rows already saved are kept, so lowering the year brings them back without
  // reading them again. An order with no date yet is never left out.
  const FROM_YEAR_KEY = 'lzx_from_year';
  let FROM_YEAR = 0;
  const validYear = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1995 && n <= 2100 ? n : 0; };
  store.get(FROM_YEAR_KEY).then((v) => { FROM_YEAR = validYear(v); }).catch(() => {});
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[FROM_YEAR_KEY]) { FROM_YEAR = validYear(changes[FROM_YEAR_KEY].newValue); invalidate(); }
    });
  } catch (_) {}
  const yearOf = (r) => { const m = String((r && r.purchasedAt) || '').match(/^(\d{4})-/); return m ? Number(m[1]) : 0; };
  const beforeCutoff = (r) => !!FROM_YEAR && yearOf(r) > 0 && yearOf(r) < FROM_YEAR;
  const exportRows = () => (FROM_YEAR ? state.rows.filter((r) => !beforeCutoff(r)) : state.rows);
  // A saved export that stopped at a cutoff covers orders from that year on.
  // It is complete for any cutoff at or after that year, not for an earlier one.
  const coversCutoff = () => !state.coveredFrom || (FROM_YEAR && FROM_YEAR >= state.coveredFrom);

  // ------------------------------------------------------------------ output
  // Every marketplace exports the same core columns, in the same order, with the
  // same meaning. Normalizing happens here, on the way out: the saved rows stay
  // as they were read, so merging and re-reading are unaffected.
  //   money     plain numbers (2 decimals; 0 for IDR/VND/JPY/KRW), never "$" or "FREE"
  //   dates     "YYYY-MM-DD HH:MM:SS" in the site's time, or "YYYY-MM-DD" when the site
  //             gives no time (Amazon); placeholder dates (1970) are blank
  //   status    one shared vocabulary (STATUS_WORDS); the site's own words in statusDetail
  //   totals    subtotal + shippingFee + tax + otherFees - discount - giftCardAmount
  //             = orderTotal, checked per order in totalsCheck
  const CORE_COLUMNS = ['marketplace', 'accountId', 'orderId', 'orderSn', 'lineId',
    'purchasedAt', 'paidAt', 'shippedAt', 'deliveredAt', 'completedAt', 'cancelledAt',
    'status', 'statusDetail', 'title', 'variation', 'itemId', 'skuId', 'quantity', 'price', 'lineTotal',
    'currency', 'itemCurrency', 'subtotal', 'shippingFee', 'tax', 'otherFees', 'discount', 'giftCardAmount',
    'orderTotal', 'amountPaid', 'paymentCurrency', 'exchangeRate', 'cashback', 'refundAmount', 'totalsCheck',
    'paymentMethod', 'shopName', 'sellerId', 'carrier', 'trackingNumber', 'orderDetailUrl', 'itemUrl', 'picUrl', 'charges'];
  const MONEY_COLUMNS = ['price', 'lineTotal', 'subtotal', 'shippingFee', 'tax', 'otherFees', 'discount', 'giftCardAmount',
    'orderTotal', 'amountPaid', 'cashback', 'refundAmount', 'unitPricePaid', 'priceBeforeDiscount', 'deliveryPrice'];
  const DATE_COLUMNS = ['purchasedAt', 'paidAt', 'shippedAt', 'deliveredAt', 'completedAt', 'cancelledAt'];
  const ZERO_DECIMAL = new Set(['IDR', 'VND', 'JPY', 'KRW']);
  // Never exported: anything that identifies the person rather than the order.
  // Compared with separators removed, so buyer_name, buyerName and raw.buyer.name all match.
  const PERSONAL_KEY = /(email|phone|mobile|address|receiver|recipient|consignee|(buyer|user|nick|full|shipping|billing|customer|contact|real|first|last)name)/i;
  const isPersonalKey = (k) => PERSONAL_KEY.test(String(k).replace(/[_.\-\s]/g, ''));
  const EMAIL_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  // The JSON export is the raw responses: drop every personal field at any
  // depth, and blank any email address that turns up inside other text.
  function scrubPersonal(v, depth = 0) {
    if (depth > 40) return null;
    if (typeof v === 'string') return v.replace(EMAIL_TEXT, '');
    if (Array.isArray(v)) return v.map((x) => scrubPersonal(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!isPersonalKey(k)) o[k] = scrubPersonal(x, depth + 1);
      return o;
    }
    return v;
  }
  // Page-rendering flags and styling copied from the raw response: no order data.
  const UI_COLUMN = /(color|icon|logo|async|\.input$|\.submit$|signature|disablelink|linkdisable|borderbottom|indentation|sequence|linktip|linktext|linkasbutton|banner|showdialog|alertdialog|quantityprefix|\.scene$|tipscolor|bgcolor|reviewable|queryreviewapisuccess|paymentpendingcancel|^_shopmatch$)/i;
  const STATUS_WORDS = [
    ['refunded', /refund|returned|return completed/i],
    ['cancelled', /cancel|closed|expired|failed|unsuccessful/i],
    ['completed', /complete|finished|received|confirm(ed)? receipt|rated|review/i],
    ['delivered', /deliver(ed|y completed)|arrived|collected/i],
    ['shipped', /ship(ped)?\b|in transit|to receive|dispatch|out for delivery|awaiting delivery|on the way/i],
    ['pending', /unpaid|to pay|awaiting payment|pending payment|payment pending/i],
    ['processing', /processing|to ship|packing|ready to ship|awaiting shipment|confirmed|placed/i],
    ['paid', /\bpaid\b/i],
  ];
  function normalStatus(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    for (const [word, re] of STATUS_WORDS) if (re.test(t)) return word;
    return t.toLowerCase();
  }
  function normalDate(v) {
    const t = String(v == null ? '' : v).trim();
    if (!t || /^1970-01-01/.test(t)) return '';
    const m = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
    if (!m) return t;
    return m[2] ? `${m[1]} ${m[2]}:${m[3] || '00'}` : m[1];
  }
  const MARKET_LABEL = () => location.hostname.toLowerCase().replace(/^(www|my|m|member|order|sale)\./, '');

  // Lazada's breakdown mixes package-level and order-level lines, sometimes
  // shows the subtotal after item discounts and sometimes before, and repeats
  // the shipping discount ("Shipping Fee Voucher" and "Shipping Fee Promotion").
  // The charged total is the one figure it states consistently, so the order is
  // put together from that: subtotal = the items at list price, and discount =
  // whatever was taken off between that and the total.
  const LZ_CHARGE_LABEL = /^(total:?|sub\s*total.*|shipping fee( (voucher|promotion|discount|rebate))?|(lazada|shop|platform|seller|store|lazmall|bank|payment|card)?\s*(voucher|promotion|promo|discount|rebate|bonus)s?|item discount|coins?( discount)?|cashback (balance|earned)|(standard|economy|scheduled|express|priority|same day|next day)?\s*delivery|postal mail)$/i;
  function lazadaOrderTotals(rs, num) {
    const a = rs[0];
    const out = {};
    let balance = 0, totalLine = null;
    for (const part of String(a.charges || '').split(' | ')) {
      const at = part.lastIndexOf('=');
      if (at < 0) continue;
      const label = part.slice(0, at).trim();
      if (!LZ_CHARGE_LABEL.test(label)) continue;
      const v = parseMoney(part.slice(at + 1));
      if (/cashback balance/i.test(label)) balance += Math.abs(v);
      else if (/^total:?$/i.test(label) && totalLine === null) totalLine = v;
    }
    // Orders from 2018-19 show shipping discounts 100 times too large
    // ("-$199.00" for $1.99), which drives the order summary's total below
    // zero. The package's own "Total:" line is right in those orders.
    if (num(a.orderTotal) < 0 && totalLine !== null && totalLine >= 0) out.orderTotal = totalLine;
    const sub = rs.reduce((s, r) => s + num(r.lineTotal), 0);
    out.subtotal = Math.round(sub * 100) / 100;
    out.giftCardAmount = balance;
    const total = out.orderTotal !== undefined ? out.orderTotal : num(a.orderTotal);
    const cancelled = normalStatus(a.status) === 'cancelled';
    if (a.orderTotal !== '' && a.orderTotal != null && !cancelled) {
      const taken = sub + num(a.shippingFee) - balance - total;
      if (taken > -0.005) out.discount = Math.round(taken * 100) / 100;
    }
    return out;
  }

  // AliExpress: every negative breakdown line is a discount, whatever it is
  // called ("Spend & save" was missed before 2.8.2). And AliExpress lists a
  // shipping line it neither shows the buyer nor charges (marked hidden, e.g.
  // S$0.02 with a total of subtotal + tax): when the shipping fee is exactly
  // what stops the order adding up, it was not charged.
  function aeOrderTotals(a, num) {
    const out = {};
    let disc = 0, seen = false;
    for (const part of String(a.charges || '').split(' | ')) {
      const at = part.lastIndexOf('=');
      if (at < 0) continue;
      const label = part.slice(0, at).trim();
      const v = parseMoney(part.slice(at + 1));
      if (/^sub\s*total/i.test(label)) continue;
      seen = true;
      if (v < 0 || /coupon|discount|promo|sav(e|ing)|spend|voucher|coin|rebate|off\b/i.test(label)) disc += Math.abs(v);
    }
    if (seen && (disc > 0 || (a.discount !== '' && a.discount != null))) out.discount = Math.round(disc * 100) / 100;
    const d = out.discount !== undefined ? out.discount : num(a.discount);
    const ship = num(a.shippingFee);
    if (a.orderTotal !== '' && a.orderTotal != null && a.subtotal !== '' && ship > 0) {
      const gap = num(a.subtotal) + ship + num(a.tax) + num(a.otherFees) - d - num(a.giftCardAmount) - num(a.orderTotal);
      if (Math.abs(gap - ship) < 0.005) out.shippingFee = 0;   // also catches S$0.01 misses
    }
    return out;
  }

  function normalizeRows(rows) {
    const dp = (cur) => (ZERO_DECIMAL.has(cur) ? 0 : 2);
    // Numbers are used as they are: parseMoney reads "3.2100000000000009" as text.
    const num = (v) => (typeof v === 'number' ? v : parseMoney(v));
    const out = rows.map((r) => {
      const o = { ...r };
      o.marketplace = MARKET_LABEL();
      if (!o.currency) o.currency = SITE_CURRENCY;
      // FREE gifts and "$3.25" become numbers; lineTotal is always there.
      if (o.price !== undefined && o.price !== '') o.price = num(o.price);
      if ((o.lineTotal === undefined || o.lineTotal === '') && o.price !== undefined && o.price !== '') {
        o.lineTotal = num(o.price) * (Number(o.quantity) || 1);
      }
      for (const k of DATE_COLUMNS) if (o[k] !== undefined) o[k] = normalDate(o[k]);
      const site = String(o.status || '').trim();
      o.status = normalStatus(site);
      if (site && site.toLowerCase() !== o.status && !o.statusDetail) o.statusDetail = site;
      return o;
    });
    // Order-level columns are repeated on each item row of the order.
    const byOrder = new Map();
    for (const o of out) {
      const k = String(o.orderId);
      if (!byOrder.has(k)) byOrder.set(k, []);
      byOrder.get(k).push(o);
    }
    for (const rs of byOrder.values()) {
      if (MARKET === 'aliexpress') {
        const t = aeOrderTotals(rs[0], num);
        for (const r of rs) Object.assign(r, t);
      }
      if (MARKET === 'lazada') {
        const t = lazadaOrderTotals(rs, num);
        for (const r of rs) {
          Object.assign(r, t);
          // Rows saved before Lazada had an accountId: same check as when read.
          if (!r.accountId) r.accountId = lazadaUserId(r.orderId);
        }
      }
      const a = rs[0];
      const has = (k) => a[k] !== undefined && a[k] !== '';
      let check = '';
      if (has('orderTotal') && has('subtotal') && rs.every((r) => normalStatus(r.status) !== 'cancelled')) {
        const sum = num(a.subtotal) + num(a.shippingFee) + num(a.tax) + num(a.otherFees) - num(a.discount) - num(a.giftCardAmount);
        // Within one cent: AliExpress rounds tax per item, so its own lines can
        // disagree with its total by S$0.01. Anything larger is real.
        check = Math.abs(sum - num(a.orderTotal)) < 0.011 ? 'ok' : 'mismatch';
      }
      for (const r of rs) r.totalsCheck = check;
    }
    for (const o of out) {
      const itemDp = dp(o.itemCurrency || o.currency);
      for (const k of MONEY_COLUMNS) {
        if (o[k] === undefined || o[k] === '' || o[k] === null) continue;
        const places = (k === 'price' || k === 'lineTotal' || k === 'unitPricePaid' || k === 'priceBeforeDiscount') ? itemDp
          : k === 'amountPaid' ? dp(o.paymentCurrency || o.currency) : dp(o.currency);
        const n = typeof o[k] === 'number' ? o[k] : num(o[k]);
        o[k] = (Math.abs(n) < 0.005 ? 0 : n).toFixed(places);
      }
    }
    return out;
  }

  // Columns: the core set always, in order (blank where a marketplace has no such
  // data), then any other column that carries real data. Raw copies that repeat a
  // core column, page-styling flags and anything personal are left out.
  function exportColumns(rows, asRead) {
    const seen = new Set(CORE_COLUMNS);
    const extra = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); extra.push(k); }
    const keep = extra.filter((k) => {
      if (isPersonalKey(k) || UI_COLUMN.test(k)) return false;
      const vals = rows.map((r) => (r[k] == null ? '' : String(r[k])));
      if (vals.every((v) => v === '')) return false;
      if (/^(raw|shop)\./.test(k)) {
        if (new Set(vals).size === 1 && rows.length > 1) return false;   // a constant flag
        const same = (c) => rows.every((r, i) => vals[i] === String(r[c] == null ? '' : r[c])
          || vals[i] === String(asRead[i][c] == null ? '' : asRead[i][c]));
        if (CORE_COLUMNS.some(same) || ['itemStatus'].some(same)) return false;
      }
      return true;
    });
    return [...CORE_COLUMNS, ...keep];
  }

  function toCsv(rawRows) {
    if (!rawRows.length) return '';
    const rows = normalizeRows(rawRows);
    const cols = exportColumns(rows, rawRows);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }

  // Saving from inside the page is an automatic download as far as Chrome is
  // concerned (the click happened in the popup, not here): the first one is
  // allowed, then Chrome blocks or quietly asks about every later one. So files
  // the popup asks for go back to it and it saves them from its own click (see
  // saveFile in popup.js). Only the end-of-run CSV, with no click behind it,
  // is still saved from here.
  function download(file) {
    const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mime};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    // Deliberately not appended to the document: a blob URL in the page DOM is
    // readable by any script on the page, and this blob is the whole export.
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // AliExpress prices are stored as numbers; the symbol comes from the
  // account's display currency (SGD shows as SG$).
  const AE_SYMBOL = { SGD: 'SG$', USD: 'US$', EUR: '€', GBP: '£', AUD: 'AU$', CAD: 'CA$', MYR: 'RM', THB: '฿', PHP: '₱', IDR: 'Rp', VND: '₫', JPY: '¥', KRW: '₩', INR: '₹', HKD: 'HK$', NZD: 'NZ$', BRL: 'R$' };
  function aeSymbol() {
    const c = (state.rows.find((r) => r.currency) || {}).currency || '';
    return AE_SYMBOL[c] || (c ? `${c} ` : '');
  }

  // A standalone page with the data inlined, so it opens from disk with no
  // server. Product images are the only thing still fetched from Lazada.
  async function buildReport() {
    if (!state.rows.length) throw new Error('Export the list first');
    const keep = ['orderId', 'purchasedAt', 'title', 'variation', 'quantity', 'price',
                  'orderTotal', 'currency', 'status', 'itemStatus', 'shopName', 'itemUrl', 'picUrl'];
    const slim = exportRows().map((r) => {
      const o = {};
      for (const k of keep) if (r[k] !== undefined && r[k] !== '') o[k] = r[k];
      return o;
    });
    // The page names the marketplace and, for Shopee (plain-number prices),
    // the currency symbol it cannot read from the data.
    const SHOPEE_SYMBOL = { sg: '$', my: 'RM', ph: '₱', th: '฿', id: 'Rp', vn: '₫', tw: 'NT$', br: 'R$' };
    const meta = {
      exported: new Date().toLocaleString(), rows: slim.length,
      market: IS_SHOPEE ? 'Shopee' : IS_ALIEXPRESS ? 'AliExpress' : IS_AMAZON ? 'Amazon' : 'Lazada',
      symbol: IS_SHOPEE ? (SHOPEE_SYMBOL[location.hostname.split('.').pop()] || '')
        : IS_ALIEXPRESS ? aeSymbol() : IS_AMAZON ? (amzCurrency() === 'SGD' ? 'S$' : '$') : '',
    };
    const tpl = await fetch(chrome.runtime.getURL('report.html')).then((r) => r.text());
    // A "</script>" inside the data would close the tag early.
    const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const html = tpl.replace('/*__DATA__*/[]', () => safe(slim))
                    .replace('/*__META__*/{}', () => safe(meta));
    log(`Saved a browsable page with ${slim.length} items.`);
    return { name: `${MARKET}-purchases-${stamp()}.html`, text: html, mime: 'text/html' };
  }

  const stamp = () => new Date().toISOString().slice(0, 10);
  const csvFile = () => ({ name: `${MARKET}-orders-${stamp()}.csv`, text: toCsv(exportRows()), mime: 'text/csv' });
  const jsonFile = () => ({ name: `${MARKET}-orders-${stamp()}.json`, text: JSON.stringify(scrubPersonal(state.raw.length && !FROM_YEAR ? state.raw : exportRows()), null, 2), mime: 'application/json' });
  const downloadCsv = () => download(csvFile());

  // --------------------------------------------------------------- messaging
  // The hidden frame only records; the popup talks to the top frame alone.
  if (!inFrame) chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    try {
      if (msg.cmd === 'ping') {
        drain();
        respond({ ok: true, market: MARKET });
      } else if (msg.cmd === 'status') {
        drain();
        const dv = derived();
        respond({
          ok: true,
          running: state.running,
          stopping: state.running && state.cancel,
          done: state.done,
          mode: state.mode,
          phase: state.phase,
          rows: exportRows().length,
          orders: new Set(exportRows().map((r) => r.orderId)).size,
          fromYear: FROM_YEAR,
          leftOut: new Set(state.rows.filter(beforeCutoff).map((r) => r.orderId)).size,
          account: maskAccount(accountOf(state.rows)),
          undated: undatedOrders().length,
          complete: state.complete,
          progress: state.progress,
          totalPages: dv.totalPages,
          captures: state.captures.length,
          capturePaths: state.captures.map((c) => pathOf(c.url)),
          hasApi: dv.api,
          hasDetailApi: dv.detail,
          detailDiag: dv.diag,
          log: state.log.slice(-12),
        });
      } else if (msg.cmd === 'run') {
        if (state.running) respond({ ok: false, error: 'Already running' });
        else { run(msg.opts || { startPage: 1, endPage: 0, delayMs: 600 }); respond({ ok: true }); }
      } else if (msg.cmd === 'details') {
        if (state.running) respond({ ok: false, error: 'Already running' });
        else if (!state.rows.length) respond({ ok: false, error: 'Export the list first' });
        else {
          state.running = true; state.cancel = false; state.done = false;
          detailsAccountCheck()
            .then((problem) => { if (problem) { state.detailError = problem; return 0; } return runDetails(msg.delayMs || 400); })
            .then((n) => {
              if (n) { downloadCsv(); finish('Dates added — CSV re-downloaded. If no file appeared, press Save CSV again.'); }
              else finish(state.detailError
                || (undatedOrders().length ? 'No dates were added; the CSV is unchanged.' : 'Every order already has a date.'));
            })
            .catch((e) => finish(`Detail pass failed: ${e.message}`));
          respond({ ok: true });
        }
      } else if (msg.cmd === 'reset') {
        // Forget the saved export and every recorded request, e.g. before
        // exporting a second Lazada account in the same browser.
        if (state.running) respond({ ok: false, error: 'Stop the current run first' });
        else {
          store.remove([CAP_KEY, RESULT_KEY, ACCOUNT_KEY]).then(() => {
            currentAccount = '';
            state.captures = []; state.rows = []; state.raw = [];
            state.done = false; state.complete = false; state.coveredFrom = 0; state.detailError = '';
            state.failedIds = new Set();
            state.progress = { done: 0, total: 0, message: 'Ready' };
            state.log = ['Reset: the saved export and recorded requests are forgotten. Export again for whoever is signed in.'];
            invalidate();
            respond({ ok: true });
          });
          return true;
        }
      } else if (msg.cmd === 'cancel') {
        state.cancel = true; respond({ ok: true });
      } else if (msg.cmd === 'csv') {
        respond({ ok: true, rows: state.rows.length, file: csvFile() });
      } else if (msg.cmd === 'json') {
        respond({ ok: true, rows: state.rows.length, file: jsonFile() });
      } else if (msg.cmd === 'report') {
        buildReport().then((file) => respond({ ok: true, file })).catch((e) => respond({ ok: false, error: e.message }));
        return true;
      } else if (msg.cmd === 'sample') {
        // Ground truth for mapping fields the harvest does not recognise.
        const ids = new Set(state.rows.map((r) => String(r.orderId)).filter(Boolean));
        const cap = ids.size ? pickDetailCapture(ids) : null;
        const rec = cap ? cap.rec : state.captures[state.captures.length - 1];
        if (!rec) { respond({ ok: false, error: 'Nothing recorded yet' }); }
        else {
          respond({ ok: true, file: { name: `${MARKET}-detail-sample.json`, mime: 'application/json', text: JSON.stringify({
            url: rec.url, method: rec.method,
            note: 'Request headers omitted: they carry session and CSRF tokens.',
            requestBody: safeParse(rec.reqBody) || rec.reqBody,
            response: safeParse(rec.body) || rec.body,
          }, null, 2) } });
        }
      } else {
        respond({ ok: false, error: 'unknown command' });
      }
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
    return true;
  });

  // Restore captures and any finished export, so navigating away from the list
  // page (e.g. to open one order) does not lose the run.
  drain();

  (async () => {
    const saved = await store.get(CAP_KEY);
    if (Array.isArray(saved) && saved.length) {
      const known = new Set(state.captures.map(capKey));
      for (const c of saved) if (sameOrigin(c) && !known.has(capKey(c))) state.captures.push(c);
      keepNewestPerPath();
      invalidate();
    }

    if (inFrame) return;
    const prev = await store.get(RESULT_KEY);
    // Only ever restore an export captured on this same Lazada market.
    if (prev && prev.origin === location.origin
        && Array.isArray(prev.rows) && prev.rows.length && !state.rows.length && !state.running) {
      // Exports saved before 2.7.1 have no currency column; the saved export is
      // tied to this origin, so the site's currency applies.
      state.rows = prev.rows.map(normaliseDates).map((r) => (r.currency ? r : { ...r, currency: SITE_CURRENCY }));
      state.raw = [];
      state.done = true;
      // Exports saved before this flag existed may have been stopped part way;
      // treating them as incomplete costs one full read, never missing orders.
      state.complete = prev.complete === true;
      state.coveredFrom = Number(prev.coveredFrom) || 0;
      invalidate();
      log(`Restored ${prev.rows.length} rows from the last export on this page.`);
    }
  })();

  // Captures written by another tab (the order-detail page you open) land here.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[CAP_KEY]) return;
      const next = changes[CAP_KEY].newValue;
      if (!Array.isArray(next)) return;
      const known = new Set(state.captures.map(capKey));
      let added = 0;
      for (const c of next) if (sameOrigin(c) && !known.has(capKey(c))) { state.captures.push(c); added++; }
      if (!added) return;
      keepNewestPerPath();
      invalidate();   // a capture from another tab must re-enable the dates button
    });
  } catch (_) {}
})();
