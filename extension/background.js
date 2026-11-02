// Background worker: reads eBay order-detail pages for the eBay export.
// The purchase list is on www.ebay.com but each order's details are on
// order.ebay.com, which a page on www.ebay.com cannot read (CORS). This worker
// can, because the extension has host permission for ebay.com.
//
// Deliberately narrow: it answers only this extension's own content script on
// an eBay page, fetches only https://order.ebay.com[.sg]/ord/show?…, and
// returns only the page's order data (window.__APP_INITIAL_STATE__) with the
// delivery address, payment and buyer sections removed before it leaves here.

const DETAIL_HOSTS = new Set(['order.ebay.com', 'order.ebay.com.sg']);
const SENDER_HOST = /(^|\.)ebay\.(com|com\.sg)$/i;
// Never returned: who the buyer is, where they live and how they paid.
const DROP_MODULES = new Set(['deliveryAddress', 'paymentInfo', 'optInBanner', 'billingAddress']);
const DROP_SECTION = /address|payment|paid with|billing|buyer/i;
const DROP_LABEL = /^(buyer|payment method|paid with|ship to|shipping address|billing address|phone|email)\b/i;

const textOf = (x) => (Array.isArray(x) ? x.map(textOf).join(' ')
  : x && Array.isArray(x.textSpans) ? x.textSpans.map((t) => (t && t.text) || '').join('')
  : typeof x === 'string' ? x : '');

// The personal values themselves: the texts of the address modules, of any
// section titled address/buyer, and of rows such as "Buyer" or "Payment
// method". A name or address can be repeated elsewhere on the page (a "ship
// to" line, a heading), so those strings are blanked wherever they occur in
// what is kept. Not collected: the payment module, which repeats the order's
// price breakdown, and anything that reads as money, a date or a label.
const COLLECT_MODULES = new Set(['deliveryAddress', 'billingAddress']);
const COLLECT_SECTION = /address|buyer|ship to/i;
const NOT_PERSONAL = /[$£€]\s?\d|\d\.\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|^(shipping address|delivery address|payment info|payment method|paid with|billing address|buyer|ship to|order (info|information|total|details)|\d+ items?|total|subtotal|edit|change|copy|default)$/i;
function personalValues(node, inside = false, depth = 0, out = new Set()) {
  if (depth > 40 || node == null) return out;
  if (typeof node === 'string') {
    const t = node.trim();
    if (inside && t.length >= 4 && !NOT_PERSONAL.test(t)) out.add(t);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((x) => personalValues(x, inside, depth + 1, out)); return out; }
  const row = node.labels && DROP_LABEL.test(textOf(node.labels).trim());
  const section = (node.title && COLLECT_SECTION.test(textOf(node.title)))
    || (node.section && node.section.title && COLLECT_SECTION.test(textOf(node.section.title)));
  for (const [k, v] of Object.entries(node)) {
    if (k === 'paymentInfo' || k === 'optInBanner') continue;
    // A dropped row's label ("Buyer") is not personal; its values are.
    const here = inside || COLLECT_MODULES.has(k) || section || (row && k !== 'labels');
    personalValues(v, here, depth + 1, out);
  }
  return out;
}
function redact(node, values, depth = 0) {
  if (depth > 40 || node == null) return node;
  if (typeof node === 'string') {
    let t = node;
    for (const v of values) if (t.includes(v)) t = t.split(v).join('');
    return t;
  }
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((x) => redact(x, values, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = redact(v, values, depth + 1);
  return out;
}

// Copy of the state without personal parts: whole modules by name, any
// section whose title says address/payment/buyer, and labelled rows such as
// "Buyer" or "Payment method" wherever they appear.
function scrub(node, depth = 0) {
  if (depth > 40 || node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.filter((x) => !(x && typeof x === 'object' && (
      (x.labels && DROP_LABEL.test(textOf(x.labels).trim()))
      || (x.title && DROP_SECTION.test(textOf(x.title)))
      || (x.section && x.section.title && DROP_SECTION.test(textOf(x.section.title))))))
      .map((x) => scrub(x, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_MODULES.has(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

function stateFrom(html) {
  const at = html.indexOf('window.__APP_INITIAL_STATE__');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) return null;
  const body = html.slice(start, end).trim().replace(/;\s*$/, '');
  try { return JSON.parse(body); } catch (_) { return null; }
}

async function ebayDetail(url) {
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, error: 'bad url' }; }
  if (u.protocol !== 'https:' || !DETAIL_HOSTS.has(u.hostname) || u.pathname !== '/ord/show') {
    return { ok: false, error: 'not an eBay order page' };
  }
  const res = await fetch(u.href, { credentials: 'include', redirect: 'follow' });
  const landed = new URL(res.url);
  if (/signin\.ebay\./i.test(landed.hostname) || /\/signin\//i.test(landed.pathname)) return { ok: false, error: 'signin' };
  if (/captcha/i.test(landed.pathname)) return { ok: false, error: 'captcha' };
  const html = await res.text();
  // eBay caps order-page views per account per day: it redirects to a
  // pages.ebay.com notice titled "Daily limit exceeded".
  if (/daily limit exceeded/i.test(html) || (landed.hostname !== u.hostname && /^pages\.ebay\./i.test(landed.hostname))) return { ok: false, error: 'limit' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const state = stateFrom(html);
  if (!state || !state.modules) return { ok: false, error: 'no order data on the page' };
  const personal = [...personalValues(state.modules)].sort((a, b) => b.length - a.length);
  return { ok: true, state: { modules: redact(scrub(state.modules), personal) } };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.cmd !== 'ebayDetail') return false;
  let fromEbay = false;
  try { fromEbay = sender.id === chrome.runtime.id && !!sender.tab && SENDER_HOST.test(new URL(sender.url).hostname); } catch (_) {}
  if (!fromEbay) { respond({ ok: false, error: 'not allowed' }); return false; }
  ebayDetail(msg.url).then(respond, (e) => respond({ ok: false, error: String((e && e.message) || e) }));
  return true;   // answers asynchronously
});
