// ISOLATED world. Orchestrates the export.
// Same-origin fetches from here carry your Lazada session cookies automatically.
(() => {
  // Frames run only when the dates pass loads an order in a hidden frame to
  // record its detail request; any other embedded Lazada frame is left alone.
  const PRIME_FRAME = 'lzx-prime';
  const inFrame = window !== window.top;
  if (inFrame && window.name !== PRIME_FRAME) return;
  if (window.__LZX_CONTENT__) return;
  window.__LZX_CONTENT__ = true;

  const CAP_KEY = 'lzx_captures';
  const RESULT_KEY = 'lzx_result';

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
  const MONEY = /(?:฿|THB|RM|Rp|S\$|₱|₫|\$)\s?\d[\d.,]*/g;
  const PRICEY = /(?:฿|THB|RM|Rp|S\$|₱|₫)\s?\d/;

  // ------------------------------------------------------------- persistence
  const store = {
    set(k, v) { try { chrome.storage.local.set({ [k]: v }); } catch (_) {} },
    get(k) { return new Promise((res) => { try { chrome.storage.local.get(k, (o) => res(o && o[k])); } catch (_) { res(null); } }); },
  };

  // Captures arrive over a transferred MessagePort so they are not broadcast to
  // every script on the page; window.postMessage is only the handshake.
  let capturePort = null;
  const drain = () => {
    try {
      window.postMessage({ __lzx: capturePort ? 'drain' : 'connect' }, '*');
    } catch (_) {}
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lzx !== 'port') return;
    const port = e.ports && e.ports[0];
    if (!port) return;
    capturePort = port;
    capturePort.onmessage = (ev) => acceptCapture(ev.data);
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

  // --------------------------------------------------------- Ultron response
  // module.data is a flat entity map (orderItem_*, order_*, orderShop_*), not an array.
  function parseUltron(json, page) {
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

  // ------------------------------------------------------------- request replay
  function buildPager(rec) {
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
      const resp = safeParse(rec.body);
      if (!resp || !parseUltron(resp, 1)) continue;
      const pager = buildPager(rec);
      if (pager) return { rec, pager };
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
    const btns = pagerButtons();
    if (btns.length > 1) {
      const current = btns.find((b) => /current|active/i.test(String(b.className)));
      const target = btns.find((b) => b !== current) || btns[1];
      target.click();
      return true;
    }
    return false;
  }

  async function ensureCapture() {
    let cap = pickCapture();
    if (cap) return cap;
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

  function extractLive(page) {
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
  const DATEISH = /(20\d\d)|(\d{1,2}[\/\-\s][A-Za-z]{3})|^\d{13}$/;

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
    const out = { dates: {}, stamps: [], pay: {}, total: {}, lines: {} };
    const seen = new Set();
    (function walk(n, depth) {
      if (!n || typeof n !== 'object' || depth > 8 || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)) { n.forEach((v) => walk(v, depth + 1)); return; }
      const pair = labelledAmount(n);
      if (pair && !(pair.label in out.lines)) out.lines[pair.label] = pair.value;
      // { key: "Paid by", value: "Credit/Debit Card", subValue: "$1.99" }: the method is the value.
      if (typeof n.key === 'string' && /^(paid by|payment method)$/i.test(n.key.trim())
          && typeof n.value === 'string' && n.value.trim() && !MONEYISH.test(n.value) && !out.pay.paidBy) {
        out.pay.paidBy = n.value.trim();
      }
      for (const [k, v] of Object.entries(n)) {
        if (isScalar(v) && v !== null && String(v).trim()) {
          const sv = String(v).trim();
          if (DATE_KEY.test(k) && DATEISH.test(sv)) {
            if (!out.dates[k]) out.dates[k] = sv;
            out.stamps.push([k, sv]);
          } else if (PAY_KEY.test(k) && sv.length < 60 && !out.pay[k]) out.pay[k] = sv;
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

  // A capture is usable for the detail pass if its request embeds a known order id
  // and its response carries at least one date.
  function pickDetailCapture(idSet) {
    for (let i = state.captures.length - 1; i >= 0; i--) {
      const rec = state.captures[i];
      if (!rec.reqBody) continue;
      const resp = safeParse(rec.body);
      if (!resp) continue;
      const h = harvest(resp);
      if (!Object.keys(h.dates).length) continue;
      const body = safeParse(rec.reqBody);
      if (!isObj(body)) continue;
      const hit = findIdPath(body, idSet);
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
      const hit = isObj(body) && ids.size ? findIdPath(body, ids) : null;
      const why = [];
      if (!rec.reqBody) why.push('no request body');
      else if (!isObj(body)) why.push('body not JSON');
      else if (!hit) why.push('no known order id in body');
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
  // version are offered again (2: amounts and payment method on Lazada SG).
  const DETAILS_VERSION = '2';

  function undatedOrders() {
    const dated = new Set();
    const all = [];
    for (const r of state.rows) {
      const id = String(r.orderId || '');
      if (!id) continue;
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
    if (/^\d{13}$/.test(s)) {
      const d = new Date(Number(s));
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

  async function runDetails(delayMs) {
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
    const occurrences = (String(cap.rec.reqBody).match(idPattern(cap.sampleId)) || []).length;
    log(`Detail API: ${new URL(cap.rec.url).pathname} — order id in ${occurrences} place(s), dates in ${cap.dateKeys.join(', ')}`);

    const headers = { ...(cap.rec.reqHeaders || {}) };
    ['host', 'cookie', 'content-length', 'connection', 'origin', 'referer', 'user-agent']
      .forEach((h) => Object.keys(headers).forEach((k) => { if (k.toLowerCase() === h) delete headers[k]; }));
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';

    const enrich = new Map();
    let misses = 0;

    for (let i = 0; i < ids.length && !state.cancel; i++) {
      const id = ids[i];
      try {
        const res = await fetch(cap.rec.url, {
          method: cap.rec.method || 'POST',
          credentials: 'include',
          headers,
          body: swapId(cap.rec.reqBody, cap.sampleId, id),
        });
        const text = await res.text();
        if (!text.includes(id)) {
          // The response is not about this order — a stale id was left in the
          // request. Dating rows from it would be silently wrong.
          misses++;
          state.failedIds.add(id);
          if (misses === 1) log(`Response did not match order ${id}; not dating it.`);
        } else {
          const json = safeParse(text);
          const h = json ? harvest(json) : null;
          if (h && Object.keys(h.dates).length) { enrich.set(id, h); misses = 0; state.failedIds.delete(id); }
          else { misses++; state.failedIds.add(id); }
        }
      } catch (e) {
        misses++;
        state.failedIds.add(id);
        if (i < 3) log(`Detail fetch failed: ${e.message}`);
      }

      // Stop early rather than grinding through a thousand failing requests.
      if (misses >= 8 && enrich.size === 0) {
        state.detailError = 'Lazada\'s order details are not coming back with dates, so the pass stopped. Open one of your orders in this tab, come back, and try again.';
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
    const amount = parseMoney;
    const fmt = (n) => (n ? n.toFixed(2) : '');

    let filled = 0;
    let totalled = 0;
    for (const r of state.rows) {
      const h = enrich.get(String(r.orderId));
      if (!h) continue;
      r.detailsVersion = DETAILS_VERSION;
      const lines = h.lines || {};

      const sums = {};
      for (const [label, value] of Object.entries(lines)) {
        const k = kindOf(label);
        if (k === 'other') continue;
        sums[k] = (sums[k] || 0) + amount(value);
      }

      const charged = amount(pick(h.total, ['totalamount', 'grandtotal', 'ordertotal'], 'any'))
        || sums.total || sums.package_total || 0;
      if (charged) { r.orderTotal = fmt(charged); totalled++; }
      r.subtotal     = fmt(sums.subtotal);
      r.shippingFee  = fmt(sums.shipping);
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

  // Which Lazada account rows belong to: the buyer address the list returns on
  // every row. Compared only, never logged or shown.
  const accountOf = (rows) => {
    for (const r of rows) if (r && r['raw.buyerEmail']) return String(r['raw.buyerEmail']).trim().toLowerCase();
    return '';
  };

  // Filled by the detail pass, never by the list. A refreshed row keeps them so
  // an update does not throw away dates that took minutes to fetch.
  const DETAIL_FIELDS = ['purchasedAt', 'paidAt', 'shippingFee', 'discount', 'subtotal', 'cashback',
                         'refundAmount', 'charges', 'orderTotal', 'paymentMethod', 'detailsVersion'];

  function carryDetails(row, prev) {
    if (!prev) return row;
    for (const k of DETAIL_FIELDS) if ((row[k] === '' || row[k] == null) && prev[k]) row[k] = prev[k];
    return row;
  }

  async function fetchPage(cap, page) {
    const req = cap.pager.make(page);
    const headers = { ...(req.headers || {}) };
    ['host', 'cookie', 'content-length', 'connection', 'origin', 'referer', 'user-agent']
      .forEach((h) => Object.keys(headers).forEach((k) => { if (k.toLowerCase() === h) delete headers[k]; }));
    if (req.body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const init = { method: req.method || 'GET', credentials: 'include', headers };
    if (req.body && init.method !== 'GET' && init.method !== 'HEAD') init.body = req.body;

    const res = await fetch(req.url, init);
    const json = safeParse(await res.text());
    if (!json) throw new Error(`page ${page}: HTTP ${res.status}, response was not JSON`);
    if (json.success === false) throw new Error(`page ${page}: server said success=false (${json.errorCode || 'no code'})`);
    const parsed = parseUltron(json, page);
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
    let stopEarly = merging && state.complete;
    let hadDates = prior.some((r) => r.purchasedAt);

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
    let fresh = 0;
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
      const rows = out.rows.map((r) => carryDetails(r, priorByKey.get(rowKey(r))));
      const added = addRows(rows, out.raw);
      const unseen = rows.filter((r) => !priorByKey.has(rowKey(r))).length;
      fresh += unseen;
      return { added, unseen };
    };
    if (merging) log(stopEarly
      ? `Checking for orders newer than your last export (${prior.length} rows).`
      : 'The last export did not cover every page, so reading them all again (dates are kept).');

    try {
      const cap = await ensureCapture();

      if (!cap && state.cancel) {
        mergePrior();
        finish('Stopped before anything was read.');
        return;
      }
      if (!cap) {
        state.mode = 'live DOM';
        log('No API request could be recorded — reading the visible page instead.');
        addRows(extractLive(1), null);
        mergePrior();
        finish(`Read ${state.rows.length} rows from the current page only.`);
        return;
      }

      state.mode = `API (${cap.pager.where})`;
      log(`Using ${new URL(cap.rec.url).pathname} — page field ${cap.pager.where}`);

      const first = await fetchPage(cap, start);
      if (first.empty) throw new Error(`page ${start}: no order items in response`);
      // Signed in as someone else since the last export (e.g. a partner's account in
      // the same browser): their orders must not be added to the previous account's.
      const was = accountOf(prior);
      const now = accountOf(first.rows);
      if (merging && was && now && was !== now) {
        log('This is a different Lazada account from your last export, so this is a new export for it. The last account\'s export is replaced: save it first if you still need it.');
        merging = false; prior = []; priorByKey = new Map(); stopEarly = false; hadDates = false;
        state.phase = 'list';
      }
      let total = opts.endPage || first.totalPages || detectTotalPages();
      // A chosen range, or a page count guessed from the pager, can end early.
      const trustEnd = !opts.endPage && !!first.totalPages;
      if (total < start) {
        log(`Last page (${total}) is before the first (${start}); exporting page ${start} only.`);
        total = start;
      }
      state.progress.total = total - start + 1;

      let caughtUp = false;
      const firstTake = take(first);
      state.progress.done = 1;
      log(`Page ${start}/${total} — ${first.rows.length} items (${firstTake.unseen} new)`);
      if (stopEarly && !firstTake.unseen) caughtUp = true;
      else if (start === total) reachedEnd = true;

      for (let page = start + 1; page <= total && !state.cancel && !caughtUp; page++) {
        await sleep(opts.delayMs + Math.random() * 200);
        let out;
        try { out = await fetchPage(cap, page); }
        catch (e) { log(`${e.message} — stopping here.`); break; }
        if (out.empty) { log(`Page ${page} is empty — that is the end of your orders.`); reachedEnd = true; break; }
        const { added, unseen } = take(out);
        state.progress.done = page - start + 1;
        log(`Page ${page}/${total} — ${out.rows.length} items (${added} added, ${unseen} new), ${state.rows.length} rows`);
        if (stopEarly && !unseen) caughtUp = true;
        else if (page === total) reachedEnd = true;
      }

      mergePrior();
      // Complete only if this run read from page 1 to the end, or caught up
      // with an export that itself was complete.
      state.complete = !state.cancel && start === 1 && (caughtUp || (reachedEnd && trustEnd));
      if (!state.complete && !state.cancel && start === 1) log('Not every page was read, so the next update will read them all again.');

      // Someone who added dates before expects new orders dated too.
      if (merging && hadDates && fresh && !state.cancel && undatedOrders().length) {
        await runDetails(opts.delayMs || 400);
      }

      if (state.rows.length) downloadCsv();
      const orders = new Set(state.rows.map((r) => r.orderId)).size;
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
    });
  }

  // ------------------------------------------------------------------ output
  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = []; const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
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

  // A standalone page with the data inlined, so it opens from disk with no
  // server. Product images are the only thing still fetched from Lazada.
  async function buildReport() {
    if (!state.rows.length) throw new Error('Export the list first');
    const keep = ['orderId', 'purchasedAt', 'title', 'variation', 'quantity', 'price',
                  'orderTotal', 'status', 'itemStatus', 'shopName', 'itemUrl', 'picUrl'];
    const slim = state.rows.map((r) => {
      const o = {};
      for (const k of keep) if (r[k] !== undefined && r[k] !== '') o[k] = r[k];
      return o;
    });
    const meta = { exported: new Date().toLocaleString(), rows: slim.length };
    const tpl = await fetch(chrome.runtime.getURL('report.html')).then((r) => r.text());
    // A "</script>" inside the data would close the tag early.
    const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const html = tpl.replace('/*__DATA__*/[]', () => safe(slim))
                    .replace('/*__META__*/{}', () => safe(meta));
    log(`Saved a browsable page with ${slim.length} items.`);
    return { name: `lazada-purchases-${stamp()}.html`, text: html, mime: 'text/html' };
  }

  const stamp = () => new Date().toISOString().slice(0, 10);
  const csvFile = () => ({ name: `lazada-orders-${stamp()}.csv`, text: toCsv(state.rows), mime: 'text/csv' });
  const jsonFile = () => ({ name: `lazada-orders-${stamp()}.json`, text: JSON.stringify(state.raw.length ? state.raw : state.rows, null, 2), mime: 'application/json' });
  const downloadCsv = () => download(csvFile());

  // --------------------------------------------------------------- messaging
  // The hidden frame only records; the popup talks to the top frame alone.
  if (!inFrame) chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    try {
      if (msg.cmd === 'ping') {
        drain();
        respond({ ok: true });
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
          rows: state.rows.length,
          orders: new Set(state.rows.map((r) => r.orderId)).size,
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
          runDetails(msg.delayMs || 400)
            .then((n) => {
              if (n) { downloadCsv(); finish('Dates added — CSV re-downloaded. If no file appeared, press Save CSV again.'); }
              else finish(state.detailError
                || (undatedOrders().length ? 'No dates were added; the CSV is unchanged.' : 'Every order already has a date.'));
            })
            .catch((e) => finish(`Detail pass failed: ${e.message}`));
          respond({ ok: true });
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
          respond({ ok: true, file: { name: 'lazada-detail-sample.json', mime: 'application/json', text: JSON.stringify({
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
      state.rows = prev.rows.map(normaliseDates);
      state.raw = [];
      state.done = true;
      // Exports saved before this flag existed may have been stopped part way;
      // treating them as incomplete costs one full read, never missing orders.
      state.complete = prev.complete === true;
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
