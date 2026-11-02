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
  if (/signin\.ebay\./i.test(res.url) || /\/signin\//i.test(new URL(res.url).pathname)) {
    return { ok: false, error: 'signin' };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const state = stateFrom(await res.text());
  if (!state || !state.modules) return { ok: false, error: 'no order data on the page' };
  return { ok: true, state: { modules: scrub(state.modules) } };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.cmd !== 'ebayDetail') return false;
  let fromEbay = false;
  try { fromEbay = sender.id === chrome.runtime.id && !!sender.tab && SENDER_HOST.test(new URL(sender.url).hostname); } catch (_) {}
  if (!fromEbay) { respond({ ok: false, error: 'not allowed' }); return false; }
  ebayDetail(msg.url).then(respond, (e) => respond({ ok: false, error: String((e && e.message) || e) }));
  return true;   // answers asynchronously
});
