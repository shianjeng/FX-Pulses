/* The page-facing bridge used to ship on every hover-enabled site, which let any
   page detect the extension, drive its gateway and silence its hover card. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const rate = {
  base_currency: 'USD', quote_currency: 'CNY', midpoint: 7, bid: 6.99, ask: 7.01,
  provider: 'alpha_vantage', captured_at: '2026-09-20T00:00:00Z', is_stale: false,
};

function event() {
  const listeners = [];
  return {addListener: fn => listeners.push(fn), emit: (...a) => listeners.forEach(fn => fn(...a)), listeners};
}
function store(data, changed, area) {
  return {
    async get(keys) {
      if (keys === null) return {...data};
      if (typeof keys === 'string') return keys in data ? {[keys]: data[keys]} : {};
      return {...keys, ...data};
    },
    async set(values) {
      const updates = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, {oldValue: data[k], newValue: v}]));
      Object.assign(data, values);
      changed.emit(updates, area);
    },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}

function worker(initial) {
  const local = {hoverEnabled: true, ...initial}, changes = event();
  const registered = [];
  const chrome = {
    storage: {local: store(local, changes, 'local'), session: store({}, changes, 'session'), onChanged: changes},
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(),
      onInstalled: event(), onStartup: event(), openOptionsPage: async () => {}},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {
      getRegisteredContentScripts: async () => registered.slice(),
      registerContentScripts: async items => { registered.push(...items); },
      unregisterContentScripts: async () => { registered.length = 0; },
    },
  };
  const calls = [];
  const context = vm.createContext({chrome, URL, console, setTimeout, Date,
    clearTimeout: globalThis.clearTimeout, AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => vm.runInContext(source(name), context)),
    fetch: async url => {
      calls.push(url);
      const data = url.endsWith('/pairs') ? ['USD/CNY'] : url.endsWith('/rates') ? [rate] : [];
      return {ok: true, json: async () => data};
    }});
  context.globalThis = context;
  vm.runInContext(source('background.js'), context);
  const send = (message, page = false) => new Promise(resolve => {
    chrome.runtime.onMessage.listeners[0](
      message, {id: 'test', url: page ? 'https://example.com/' : 'chrome-extension://test/popup.html'}, resolve);
  });
  return {chrome, local, calls, send, registered, async sync() { await send({type: 'FX_SYNC_HOVER'}); }};
}

test('the bridge is not injected unless the user opts in', async () => {
  const off = worker({});
  await off.sync();
  // The array comes from the worker's realm, so compare by value.
  assert.equal([...off.registered[0].js].join(','), 'messages.js,amount-parser.js,hover.js');

  const on = worker({bridgeEnabled: true});
  await on.sync();
  assert.ok(on.registered[0].js.includes('userscript-bridge.js'));
});

test('turning the opt-in off re-registers without the bridge', async () => {
  const h = worker({bridgeEnabled: true});
  await h.sync();
  assert.ok(h.registered[0].js.includes('userscript-bridge.js'));
  await h.chrome.storage.local.set({bridgeEnabled: false});
  await h.sync();
  assert.equal(h.registered.length, 1);
  assert.equal(h.registered[0].js.includes('userscript-bridge.js'), false);
});

test('the gateway refuses bridge traffic while the opt-in is off', async () => {
  const h = worker({});
  // Our own hover content script still works.
  assert.equal((await h.send({type: 'FX_SNAPSHOT'}, true)).ok, true);
  // Anything relayed from a web page does not.
  assert.equal((await h.send({type: 'FX_SNAPSHOT', fromBridge: true}, true)).ok, false);
  assert.equal((await h.send({
    type: 'FX_OFFICIAL', path: '/official-rates/EUR/CNY', fromBridge: true,
  }, true)).ok, false);

  const on = worker({bridgeEnabled: true});
  assert.equal((await on.send({type: 'FX_SNAPSHOT', fromBridge: true}, true)).ok, true);
});

async function page(t, {bridge = true} = {}) {
  const h = worker({bridgeEnabled: bridge});
  const dom = new JSDOM('<body><span id="p">$100</span></body>', {runScripts: 'outside-only', url: 'https://evil.example'});
  t.after(() => dom.window.close());
  const w = dom.window;
  let ready = false;
  w.document.addEventListener('fx-pulse-ready', () => { ready = true; });
  w.chrome = {...h.chrome, runtime: {...h.chrome.runtime, sendMessage: message => h.send(message, true)}};
  w.eval(source('messages.js'));
  if (bridge) w.eval(source('userscript-bridge.js'));
  const ask = () => w.document.dispatchEvent(new w.CustomEvent('fx-pulse-request', {
    detail: JSON.stringify({id: `r${Math.random().toString(36).slice(2, 8)}`, type: 'FX_SNAPSHOT'}),
  }));
  return {...h, w, ask, ready: () => ready};
}

test('a page cannot detect the extension when the bridge is off', async t => {
  const off = await page(t, {bridge: false});
  off.ask();
  await tick();
  assert.equal(off.ready(), false);
  assert.equal(off.w.__fxUserscriptUntil, undefined);

  const on = await page(t, {bridge: true});
  await tick();
  assert.equal(on.ready(), true);   // opt-in accepts the trade-off
});

test('a page can defer the hover card at most once per document', async t => {
  const h = await page(t, {bridge: true});
  h.ask();
  await tick();
  const first = h.w.__fxUserscriptUntil;
  assert.ok(first > Date.now(), 'the legacy userscript still gets its deferral');

  // Replaying the request must not extend the suppression indefinitely.
  for (let index = 0; index < 5; index += 1) { h.ask(); await tick(10); }
  assert.equal(h.w.__fxUserscriptUntil, first);
});
