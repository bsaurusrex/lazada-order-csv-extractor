// MAIN world, document_start (also injected on demand by the popup).
// Records order requests on Lazada, Shopee and AliExpress so they can be replayed
// page by page, and bridges the page's signed fetch (Shopee) and mtop (AliExpress)
// calls. Leaves Amazon alone: it is read from its order pages. Everything stays in this tab.
(() => {
  // Frames: only the hidden order frame the dates pass loads (see content.js).
  if (window !== window.top && window.name !== 'lzx-prime') return;
  // Versioned guard. Reloading the extension does not remove the previous
  // build's interceptor from an open tab, and that one cannot serve signed
  // replays. A newer build still installs its port handler next to it; it
  // only skips wrapping fetch/XHR again, since the old one already records.
  const VERSION = 3;   // 3: AliExpress mtop bridge
  if ((window.__LZX_INTERCEPTOR_V__ || 0) >= VERSION) return;
  const olderPresent = !!window.__LZX_INTERCEPTOR__;
  // Amazon is read from its order pages by the content script, so nothing
  // recorded there is ever used. Leave its fetch/XHR alone: a wrapped call that
  // fails (blocked trackers, aborted requests) is otherwise reported against
  // this file in chrome://extensions.
  const RECORDS = !/(^|\.)amazon\.(sg|com)$/i.test(location.hostname);
  window.__LZX_INTERCEPTOR__ = true;
  window.__LZX_INTERCEPTOR_V__ = VERSION;

  const MAX_BODY = 400000;
  // Lazada: /…/order/… (Ultron list and detail).
  // Shopee: /api/v4/order/get_order_list, get_order_detail, and the older
  //   get_all_order_and_checkout_list — all caught by /order/ in the path.
  // Shopee GraphQL: one shared /graphql path, so only keep calls whose
  //   operation (in the body or query) is about orders.
  const SHOPEE_ORDER_PATH = /\/api\/v\d+\/(order|purchase)\//i;
  const GRAPHQL_PATH = /graphql/i;
  const interesting = (url, body) => {
    try {
      // Pathname only: a query string carries spm tokens and search terms that
      // would otherwise drag in cart, checkout and address-book responses.
      const u = new URL(url, location.href);
      const path = u.pathname;
      if (/order/i.test(path) || SHOPEE_ORDER_PATH.test(path)) return true;
      if (GRAPHQL_PATH.test(path)) {
        const op = `${u.searchParams.get('operationName') || ''} ${typeof body === 'string' ? body.slice(0, 2000) : ''}`;
        return /order|purchase/i.test(op);
      }
      return false;
    } catch (_) {
      return false;
    }
  };

  // Requests fire during page load, potentially before the ISOLATED-world
  // listener exists. Buffer them so they can be replayed on demand.
  const buffer = [];
  let port = null;
  const emit = (rec) => {
    try {
      if (port) port.postMessage({ __lzx: 'capture', rec });
      else window.postMessage({ __lzx: 'capture', rec }, '*');
    } catch (_) {}
  };
  const post = (rec) => {
    buffer.push(rec);
    if (buffer.length > 20) buffer.shift();
    emit(rec);
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__lzx === 'connect') {
      const ch = new MessageChannel();
      port = ch.port1;
      port.onmessage = (ev) => { handleFetch(ev.data); handleMtop(ev.data); };
      // v tells content.js this port can also serve signed replays.
      window.postMessage({ __lzx: 'port', v: VERSION }, '*', [ch.port2]);
      for (const rec of buffer) emit(rec);
      return;
    }
    if (e.data.__lzx === 'drain') for (const rec of buffer) emit(rec);
  });

  // Replays for sites that sign requests in page script (Shopee: its security
  // SDK wraps window.fetch and adds x-sap-* anti-bot headers). The content
  // script's own fetch is the browser original, so its requests go out unsigned
  // and Shopee answers error 90309999. Running the replay here, through the
  // page's current window.fetch, gets each request freshly signed. Only
  // reachable over the private MessagePort, and only for this origin.
  function handleFetch(msg) {
    if (!msg || msg.__lzx !== 'fetch' || !port) return;
    const reply = (r) => { try { port.postMessage({ __lzx: 'fetchResult', id: msg.id, ...r }); } catch (_) {} };
    let url;
    try { url = new URL(msg.url, location.href); } catch (e) { reply({ error: 'bad url' }); return; }
    if (url.origin !== location.origin) { reply({ error: 'cross-origin replay refused' }); return; }
    Promise.resolve()
      .then(() => window.fetch(url.toString(), msg.init || {}))
      .then((res) => res.text().then((text) => reply({ status: res.status, text })))
      .catch((e) => reply({ error: String((e && e.message) || e) }));
  }

  // AliExpress: its order APIs are Alibaba "mtop" calls to acs.aliexpress.com,
  // signed per request from the _m_h5_tk cookie and loaded as JSONP <script>s,
  // so they can neither be recorded (no fetch/XHR) nor replayed from content.js.
  // The page's own client (window.lib.mtop.request) signs them; run them here.
  // Only these read-only APIs, only on AliExpress, only over the private port.
  const MTOP_ALLOWED = new Set([
    'mtop.aliexpress.trade.buyer.order.list',
    'mtop.aliexpress.trade.buyer.order.detail',
    'mtop.ae.ld.querydetail',
  ]);
  // The page's own list request carries the ship-to country, language and
  // time zone it renders with; reuse them so responses match what is on screen.
  function pageDefaults() {
    const out = { shipToCountry: '', _lang: '', timeZone: '' };
    try {
      const e = performance.getEntriesByType('resource').find((x) => /buyer\.order\.(list|detail)/.test(x.name));
      const d = e ? JSON.parse(new URL(e.name).searchParams.get('data') || '{}') : {};
      Object.assign(out, { shipToCountry: d.shipToCountry || '', _lang: d._lang || '', timeZone: d.timeZone || '' });
    } catch (_) {}
    if (!out._lang) out._lang = 'en_US';
    if (!out.timeZone) {
      const m = -new Date().getTimezoneOffset();
      out.timeZone = `GMT${m >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}${m % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : '00'}`;
    }
    return out;
  }
  async function handleMtop(msg) {
    if (!msg || msg.__lzx !== 'mtop' || !port) return;
    const reply = (r) => { try { port.postMessage({ __lzx: 'mtopResult', id: msg.id, ...r }); } catch (_) {} };
    try {
      if (!/(^|\.)aliexpress\./i.test(location.hostname)) throw new Error('not an AliExpress page');
      const opts = msg.opts || {};
      if (!MTOP_ALLOWED.has(opts.api)) throw new Error(`mtop api not allowed: ${opts.api}`);
      for (let i = 0; i < 50 && !(window.lib && window.lib.mtop && window.lib.mtop.request); i++) await new Promise((r) => setTimeout(r, 200));
      if (!(window.lib && window.lib.mtop && window.lib.mtop.request)) throw new Error('AliExpress page script (lib.mtop) not ready');
      const data = { ...(opts.data || {}) };
      if (data.__defaults) {
        delete data.__defaults;
        const d = pageDefaults();
        for (const k of Object.keys(d)) if (data[k] == null || data[k] === '') data[k] = d[k];
        if (!data.shipToCountry) delete data.shipToCountry;
      }
      const res = await window.lib.mtop.request({
        api: opts.api, v: opts.v || '1.0', type: opts.type || 'GET', dataType: 'originaljsonp',
        needLogin: true, isSec: opts.type === 'POST' ? 1 : 0, ecode: opts.type === 'POST' ? 1 : 0,
        timeout: 20000, data,
      }).then((r) => r, (e) => e);
      // Structured-clone safe: plain JSON only.
      reply({ data: JSON.parse(JSON.stringify(res || null)) });
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
    }
  }

  // Bodies arrive as strings, URLSearchParams or FormData; keep what is replayable.
  const readBody = (init) => {
    if (!init || init.body == null) return null;
    if (typeof init.body === 'string') return init.body;
    try {
      if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) return init.body.toString();
    } catch (_) {}
    return null;
  };

  const headersToObject = (h) => {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { out[k] = v; });
      else if (typeof h === 'object') Object.keys(h).forEach((k) => { out[k] = String(h[k]); });
    } catch (_) {}
    return out;
  };

  const origFetch = window.fetch;
  if (RECORDS && !olderPresent && typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      let bodySource = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
        // A Request carries its body on the object, not in init.
        if (typeof Request !== 'undefined' && input instanceof Request && !(init && init.body)) {
          bodySource = input.clone();
        }
      } catch (_) {}
      const p = origFetch.apply(this, arguments);
      if (!interesting(url, init && init.body)) return p;
      return p.then((res) => {
        try {
          res.clone().text().then((body) => {
            if (!/^\s*[{[]/.test(body)) return;
            post({
              url: new URL(url, location.href).toString(),
              method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
              reqHeaders: headersToObject((init && init.headers) || (input && input.headers)),
              reqBody: readBody(init),
              status: res.status,
              body: body.slice(0, MAX_BODY),
              ts: Date.now(),
              pending: !!bodySource,
            });
            // A Request body only reads asynchronously; re-post once it resolves.
            if (bodySource) {
              bodySource.text().then((rb) => {
                if (rb) post({
                  url: new URL(url, location.href).toString(),
                  method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
                  reqHeaders: headersToObject((init && init.headers) || (input && input.headers)),
                  reqBody: rb, status: res.status, body: body.slice(0, MAX_BODY), ts: Date.now(),
                });
              }).catch(() => {});
            }
          }).catch(() => {});
        } catch (_) {}
        return res;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (RECORDS && !olderPresent && XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__lzx = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: {} };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      if (this.__lzx) this.__lzx.headers[k] = v;
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const meta = this.__lzx;
      if (meta && interesting(meta.url, body)) {
        this.addEventListener('load', () => {
          try {
            const text = (this.responseType === '' || this.responseType === 'text')
              ? this.responseText
              : (typeof this.response === 'string' ? this.response : '');
            if (!/^\s*[{[]/.test(text || '')) return;
            post({
              url: new URL(meta.url, location.href).toString(),
              method: meta.method,
              reqHeaders: meta.headers,
              reqBody: typeof body === 'string' ? body
                : (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams ? body.toString() : null),
              status: this.status,
              body: (text || '').slice(0, MAX_BODY),
              ts: Date.now(),
            });
          } catch (_) {}
        });
      }
      return send.apply(this, arguments);
    };
  }
})();
