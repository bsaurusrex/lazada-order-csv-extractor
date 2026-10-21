// Interceptor leaves Amazon's fetch/XHR alone and still wraps Lazada's.
const vm = require('vm'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(process.argv[2] + '/interceptor.js', 'utf8');
const tryHost = (host) => {
  const fetch = function () { return Promise.resolve(); }; function XHR() {} XHR.prototype.open = function () {}; XHR.prototype.send = function () {};
  const open = XHR.prototype.open;
  const win = { location: { hostname: host, href: `https://${host}/`, origin: `https://${host}` }, fetch, XMLHttpRequest: XHR, addEventListener() {}, postMessage() {}, name: '' };
  win.top = win; win.window = win; win.self = win;
  const ctx = vm.createContext(Object.assign(win, { URL, MessageChannel, Promise, JSON, Date, console, setTimeout }));
  vm.runInContext(src, ctx);
  return { fetchSame: win.fetch === fetch, openSame: win.XMLHttpRequest.prototype.open === open };
};
const amz = tryHost('www.amazon.com'); const amzSg = tryHost('www.amazon.sg'); const laz = tryHost('my.lazada.sg');
console.log({ amz, amzSg, laz });
assert.deepStrictEqual(amz, { fetchSame: true, openSame: true }); assert.deepStrictEqual(amzSg, { fetchSame: true, openSame: true });
assert.strictEqual(laz.fetchSame, false, 'lazada still wrapped');
console.log('NOWRAP PASSED');
