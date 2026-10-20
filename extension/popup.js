const $ = (id) => document.getElementById(id);

// A popup that throws renders as a blank box with no clue why. Surface it.
function fail(where, err) {
  const msg = `${where}: ${(err && err.message) || err}`;
  const box = $('phase') || document.body;
  if (box) { box.textContent = msg; box.style.color = '#a8342a'; }
  try { console.error('[order-history-to-csv]', msg, err); } catch (_) {}
}
window.addEventListener('error', (e) => fail('Popup error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail('Popup error', e.reason));
// Bind defensively: a missing element must not throw at load and take the
// whole popup down with it.
const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
// Which build is loaded: after replacing an unpacked copy it is otherwise hard to tell.
try {
  const m = chrome.runtime.getManifest();
  $('version').textContent = `Version ${m.version_name || m.version}`;
} catch (_) {}
const ORDER_PATH = '/customer/order/index/';
const RUN_NOTE = ($('runNote') || {}).innerHTML || '';
const n = (v) => (v || 0).toLocaleString();

let tabId = null;
let ready = false;
let running = false;

const send = (msg) => new Promise((resolve) => {
  if (typeof tabId !== 'number') { resolve({ ok: false, error: 'no tab' }); return; }
  // Top frame only: the hidden order frame the dates pass loads also listens.
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (res) => {
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false }));
  });
});

// Save a file the page handed back. Saving it here, from the popup's own click,
// is a download the person asked for; saved from the Lazada page it counts as an
// automatic download, which Chrome allows once and then blocks or asks about.
function saveFile(file) {
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Ask the page for a file and save it, or say why not.
async function fetchAndSave(cmd) {
  const res = await send({ cmd });
  if (res.ok && res.file) saveFile(res.file);
  else $('phase').textContent = res.error || 'Could not save the file.';
  return res;
}

// Loading an extension does not inject content scripts into already-open tabs,
// so inject on demand rather than making people reload.
async function ensureInjected() {
  if ((await send({ cmd: 'ping' })).ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['interceptor.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], world: 'ISOLATED' });
  } catch (e) {
    $('sub').textContent = 'Cannot attach to this page';
    $('phase').textContent = e.message;
    return false;
  }
  return (await send({ cmd: 'ping' })).ok;
}

function paint(s) {
  const p = s.progress || {};

  if (s.rows) {
    $('count').textContent = n(s.rows);
    $('sub').textContent = `items from ${n(s.orders)} orders` + (s.account ? ` (${s.account})` : '');
  } else {
    $('count').textContent = s.totalPages ? n(s.totalPages) : '—';
    $('sub').textContent = s.totalPages === 1 ? 'page ready to export' : 'pages ready to export';
  }

  if (s.stopping) {
    $('phase').textContent = 'Stopping after the current request…';
  } else if (s.running) {
    $('phase').textContent = s.phase === 'details'
      ? `Reading order ${n(p.done)} of ${n(p.total)}`
      : s.phase === 'update'
        ? `Checking page ${n(p.done)} for new orders`
        : `Page ${n(p.done)} of ${n(p.total)}`;
  } else {
    $('phase').textContent = s.done ? (p.message || 'Finished') : '';
  }

  $('fill').style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + '%';

  // While anything runs, the main button is the way to stop it. With a previous
  // export it tops that up instead of starting over.
  running = s.running;
  const update = s.rows && !s.running;
  $('run').disabled = !!s.stopping;
  $('run').classList.toggle('halt', s.running);
  $('run').textContent = s.stopping ? 'Stopping…'
    : s.running ? 'Stop'
    : update ? 'Update with new orders' : 'Export all orders to CSV';
  $('runNote').innerHTML = update
    ? (s.complete
      ? 'Reads only orders placed since your last export and adds them, keeping any dates already fetched. Usually a few seconds.'
      : 'Your last export did not cover every page, so this reads them all again — about <strong>2 minutes</strong>. Dates already fetched are kept.')
    : RUN_NOTE;
  $('full').disabled = s.running || !s.rows;
  $('csv').disabled = !s.rows || s.running;
  $('json').disabled = !s.rows || s.running;
  $('sample').disabled = s.running || !s.captures;
  $('reset').disabled = s.running;
  $('report').disabled = !s.rows || s.running || savingReport;

  // Only undated orders are read, so after an update this is a short pass.
  const dates = $('dates');
  const todo = s.undated || 0;
  dates.disabled = s.running || !todo;
  dates.textContent = !s.rows ? 'Add purchase dates'
    : todo ? `Add purchase dates (${n(todo)} ${todo === 1 ? 'order' : 'orders'})`
    : 'Every order has a date';

  // A concrete estimate beats a vague "this is slow".
  if (todo) {
    const mins = Math.max(1, Math.round(todo * ((Number($('delay').value) || 600) + 300) / 60000));
    $('datesNote').innerHTML = `Adds the date each order was placed. Reads one order at a time — <strong>about ${mins} ${mins === 1 ? 'minute' : 'minutes'}</strong> for ${n(todo)} ${todo === 1 ? 'order' : 'orders'}.`
      + (s.hasDetailApi ? '' : ' It first opens one of your orders out of sight to learn how.');
  } else if (s.rows) {
    $('datesNote').textContent = 'Every order has its date. Updates date new orders automatically.';
  }

  const lines = [...(s.log || [])];
  if (!s.running && s.rows && !s.hasDetailApi && (s.detailDiag || []).length) {
    lines.push('', 'Dates unavailable because:', ...s.detailDiag.map((d) => '  ' + d));
  }
  $('log').textContent = lines.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

async function refresh() {
  if (!ready) return;
  const s = await send({ cmd: 'status' });
  if (s.ok) paint(s);
}

const runWith = async (full) => {
  await send({ cmd: 'run', opts: {
    startPage: Math.max(1, Number($('start').value) || 1),
    endPage: Math.max(0, Number($('end').value) || 0),
    delayMs: Math.max(0, Number($('delay').value) || 0),
    full,
  } });
  refresh();
};
// Stopped runs keep what they read and still save a CSV.
on('run', () => (running ? send({ cmd: 'cancel' }).then(refresh) : runWith(false)));
on('full', () => runWith(true));
on('dates', async () => {
  await send({ cmd: 'details', delayMs: Math.max(0, Number($('delay').value) || 0) });
  refresh();
});
on('csv', () => fetchAndSave('csv'));
on('json', () => fetchAndSave('json'));
on('sample', () => fetchAndSave('sample'));
// Two clicks, so a stray one can't throw away an export that took minutes.
let resetArmed = null;
on('reset', async () => {
  if (!resetArmed) {
    $('reset').textContent = 'Click again to forget everything';
    resetArmed = setTimeout(() => { resetArmed = null; $('reset').textContent = 'Reset everything'; }, 4000);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null;
  $('reset').textContent = 'Reset everything';
  const res = await send({ cmd: 'reset' });
  if (!res.ok) $('phase').textContent = res.error || 'Could not reset.';
  refresh();
});

// Building the page takes a moment with nothing visible happening; without
// this a second click saves a second copy.
let savingReport = false;
on('report', async () => {
  if (savingReport) return;
  savingReport = true;
  $('report').disabled = true;
  $('report').textContent = 'Saving…';
  await fetchAndSave('report');
  savingReport = false;
  $('report').textContent = 'Save as browsable page';
  refresh();
});

// The popup is capped at 600px, so Details opens below the fold and looks
// like the click did nothing. Bring it into view.
const more = document.querySelector('details');
if (more) more.addEventListener('toggle', () => {
  if (more.open) more.scrollIntoView({ block: 'end', behavior: 'smooth' });
});

(async () => {
  try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/lazada\./i.test(tab.url || '')) {
    $('sub').textContent = 'Open Lazada to begin';
    $('phase').textContent = 'Sign in, then go to My Orders.';
    $('run').disabled = true;
    return;
  }
  tabId = tab.id;

  if (!/order/i.test(new URL(tab.url).pathname)) {
    $('sub').textContent = 'This is not your order list';
    $('phase').textContent = '';
    $('run').textContent = 'Go to My Orders';
    $('run').onclick = async () => {
      await chrome.tabs.update(tabId, { url: new URL(ORDER_PATH, tab.url).toString() });
      window.close();
    };
    return;
  }

  ready = await ensureInjected();
  if (!ready) return;
  refresh();
  setInterval(refresh, 700);
  } catch (e) {
    fail('Could not start', e);
  }
})();
