const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {JSDOM} = require('jsdom');
const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const pairs = ['USD/CNY', 'USD/JPY', 'CNY/JPY'];
const rates = (value = 7) => pairs.map((pair, index) => {
  const [base_currency, quote_currency] = pair.split('/'), midpoint = [value, 150, 20][index];
  return {base_currency, quote_currency, midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false};
});
const event = () => { const listeners = []; return {addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners}; };
function storage(data, changed, area) {
  return {async get(keys) {
    if (typeof keys === 'string') return keys in data ? {[keys]: data[keys]} : {};
    return {...keys, ...data};
  }, async set(values) {
    const updates = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {oldValue: data[key], newValue}]));
    Object.assign(data, values); changed.emit(updates, area);
  }, async remove(key) { delete data[key]; }};
}
function worker({session = {}, initial = {}} = {}) {
  let now = Date.now(), price = 7, fail = false, allowed = true, block, registered = [];
  const local = {hoverEnabled: true, ...initial}, changes = event(), removed = event(), messages = event(), calls = [];
  const chrome = {
    storage: {local: storage(local, changes, 'local'), session: storage(session, changes, 'session'), onChanged: changes},
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: messages, onInstalled: event(), onStartup: event(), openOptionsPage: async () => {}},
    permissions: {contains: async () => allowed, onRemoved: removed},
    scripting: {getRegisteredContentScripts: async () => registered, registerContentScripts: async items => { registered = items; }, unregisterContentScripts: async () => { registered = []; }},
  };
  const context = vm.createContext({chrome, URL, console, setTimeout, clearTimeout: globalThis.clearTimeout, AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => vm.runInContext(source(name), context)),
    Date: class extends Date { static now() { return now; } },
    fetch: async url => {
      calls.push(url);
      if (block && url.includes(block.base)) await block.promise;
      if (fail) throw new Error('offline');
      return {ok: true, json: async () => url.endsWith('/pairs') ? pairs : url.endsWith('/rates') ? rates(price) : []};
    }});
  context.globalThis = context;
  vm.runInContext(source('background.js'), context);
  const send = (message, page = false) => new Promise(resolve => {
    const sender = {id: 'test', url: page ? 'https://example.com/' : 'chrome-extension://test/popup.html', ...(page ? {tab: {id: 1}} : {})};
    if (!messages.listeners[0](message, sender, resolve)) resolve({ok: false});
  });
  return {chrome, local, session, calls, send, registrations: () => registered, advance: ms => {now += ms;}, price: value => {price = value;}, fail: value => {fail = value;},
    revoke: () => {allowed = false; removed.emit();}, block: base => {let release; block = {base, promise: new Promise(resolve => {release = resolve;})}; return release;}};
}

test('popup and multiple pages share one snapshot request and one-minute cache', async () => {
  const h = worker();
  const replies = await Promise.all([h.send({type: 'FX_SNAPSHOT'}), h.send({type: 'FX_SNAPSHOT'}, true), h.send({type: 'FX_SNAPSHOT'}, true)]);
  assert.ok(replies.every(reply => reply.ok)); assert.equal(h.calls.length, 2);
  await h.send({type: 'FX_SNAPSHOT'}, true); assert.equal(h.calls.length, 2);
  h.advance(61000); h.price(8);
  assert.equal((await h.send({type: 'FX_SNAPSHOT'}, true)).data.rates[0].midpoint, 8); assert.equal(h.calls.length, 4);
});

test('worker suspension preserves the session snapshot; content cannot force extra requests', async () => {
  const first = worker(); await first.send({type: 'FX_SNAPSHOT'});
  const next = worker({session: first.session});
  const result = await next.send({type: 'FX_SNAPSHOT', force: true}, true);
  assert.equal(result.data.rates[0].midpoint, 7); assert.equal(next.calls.length, 0);
  await next.send({type: 'FX_SNAPSHOT', force: true}); assert.equal(next.calls.length, 2);
});

test('outage serves flagged cache and coalesces retries; empty cold outage has backoff too', async () => {
  const h = worker(); await h.send({type: 'FX_SNAPSHOT'}); h.advance(61000); h.fail(true);
  const result = await h.send({type: 'FX_SNAPSHOT'});
  assert.equal(result.data.offline, true); assert.equal(result.data.rates[0].midpoint, 7);
  const count = h.calls.length; await h.send({type: 'FX_SNAPSHOT'}, true); assert.equal(h.calls.length, count);
  const cold = worker(); cold.fail(true);
  assert.equal((await cold.send({type: 'FX_SNAPSHOT'}, true)).ok, false);
  await cold.send({type: 'FX_SNAPSHOT'}, true); assert.equal(cold.calls.length, 2);
});

test('changing backend invalidates caches and rejects the old in-flight response', async () => {
  const h = worker(), release = h.block('localhost');
  const old = h.send({type: 'FX_SNAPSHOT'}); await tick();
  await h.chrome.storage.local.set({apiUrl: 'https://new.example/api/v1'});
  const fresh = await h.send({type: 'FX_SNAPSHOT'}); release();
  assert.equal(fresh.ok, true); assert.equal((await old).ok, false);
  assert.equal(h.session.fxSnapshot.base, 'https://new.example/api/v1');
});

test('message gateway rejects arbitrary URLs, page history calls and disabled hover', async () => {
  const h = worker();
  assert.equal((await h.send({type: 'FX_API', path: 'https://evil.example/'})).ok, false);
  assert.equal((await h.send({type: 'FX_API', path: '/rates/USD/CNY/history?days=7'}, true)).ok, false);
  await h.chrome.storage.local.set({hoverEnabled: false});
  assert.equal((await h.send({type: 'FX_SNAPSHOT'}, true)).ok, false);
  assert.equal(h.calls.length, 0);
});

test('hover registration is opt-in, isolated, and removed when permission is revoked', async () => {
  const h = worker({initial: {hoverEnabled: false}});
  await h.send({type: 'FX_SYNC_HOVER'}); assert.equal(h.registrations().length, 0);
  await h.chrome.storage.local.set({hoverEnabled: true}); await h.send({type: 'FX_SYNC_HOVER'});
  assert.equal(h.registrations()[0].world, 'ISOLATED'); assert.equal(h.registrations()[0].allFrames, false);
  h.revoke(); await tick();
  assert.equal(h.registrations().length, 0); assert.equal(h.local.hoverEnabled, false);
});

async function hover(t, {language = 'en', text = '$10', target = 'CNY'} = {}) {
  const h = worker({initial: {language, hoverTarget: target, hoverMode: 'detail', hoverSize: 'm', watchlist: pairs}});
  const dom = new JSDOM(`<body><span id="price"></span></body>`, {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window, requests = []; let shadow;
  w.document.getElementById('price').textContent = text;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  w.chrome = {...h.chrome, runtime: {...h.chrome.runtime, sendMessage: message => {requests.push(message); return h.send(message, true);}}};
  w.fetch = () => { throw new Error('Page must never fetch backend or providers'); };
  const price = w.document.getElementById('price');
  w.document.elementFromPoint = () => price;
  w.document.caretRangeFromPoint = () => ({startContainer: price.firstChild, startOffset: 2});
  const createRange = w.document.createRange.bind(w.document);
  w.document.createRange = () => {const range = createRange(); range.getBoundingClientRect = () => ({left: 10, right: 100, top: 10, bottom: 30}); return range;};
  w.eval(source('messages.js')); w.eval(source('amount-parser.js')); w.eval(source('hover.js')); await tick();
  const show = async () => {price.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: 20, clientY: 20})); await tick(250);};
  await show();
  return {...h, w, shadow: () => shadow, show, requests};
}

test('integrated hover uses shared service, closed shadow and no uploaded page text', async t => {
  const h = await hover(t);
  assert.match(h.shadow().querySelector('.amount').textContent, /70\.00 CNY/);
  assert.equal(h.w.document.getElementById('fx-pulse-unified-hover').shadowRoot, null);
  assert.equal(JSON.stringify(h.requests), JSON.stringify([{type: 'FX_SNAPSHOT'}]));
  assert.equal(h.calls.length, 2);
});

test('hover uses the direct CNY/JPY quote instead of a different cross-rate provider', async t => {
  const h = await hover(t, {text: '100元', target: 'JPY', language: 'zh'});
  assert.match(h.shadow().querySelector('.amount').textContent, /2,000 JPY/);
  assert.equal(h.calls.every(url => url.startsWith('http://localhost:8000/api/v1/')), true);
});

test('shared language and target update open cards; disabling removes the card immediately', async t => {
  const h = await hover(t);
  const body = () => [...h.shadow().querySelectorAll('.card')].map(card => card.textContent).join('');
  assert.doesNotMatch(body(), /[\u3400-\u9fff]/);
  await h.chrome.storage.local.set({language: 'ja', hoverTarget: 'JPY'});
  assert.match(body(), /元の通貨/); assert.match(body(), /1,500 JPY/);
  assert.equal(h.w.document.documentElement.lang, '');
  await h.chrome.storage.local.set({hoverEnabled: false});
  assert.equal(h.w.document.getElementById('fx-pulse-unified-hover').style.display, 'none');
});

test('missing currencies are explicit and clipboard denial leaves selectable text', async t => {
  const missing = await hover(t, {text: '€10'});
  assert.match(missing.shadow().querySelector('.card').textContent, /not configured/);
  const h = await hover(t); h.w.navigator.clipboard = {writeText: async () => {throw new Error('denied');}};
  [...h.shadow().querySelectorAll('button')].find(button => button.textContent === 'Copy').click(); await tick();
  assert.match(h.shadow().querySelector('input').value, /70\.00 CNY/);
});

test('generated parser preserves every legacy parser fixture', () => {
  const context = vm.createContext({}); vm.runInContext(source('amount-parser.js'), context);
  const legacy = require('../userscript/fx-pulse-hover.user.js');
  for (const fixture of require('../userscript/cases.js')) {
    const options = {lang: fixture.lang || 'zh-CN', host: fixture.host || 'example.com', memory: {}, signals: fixture.signals || '', profile: fixture.profile};
    assert.equal(JSON.stringify(context.FXAmountParser.parseAll(fixture.text, options)), JSON.stringify(legacy.parseAll(fixture.text, options)), fixture.id);
  }
});

test('popup reads the same gateway and shows persisted offline cache after reopening', async t => {
  const h = worker(); await h.send({type: 'FX_SNAPSHOT'}); h.advance(61000); h.fail(true);
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  w.chrome = {...h.chrome, runtime: {...h.chrome.runtime, sendMessage: h.send}};
  w.fetch = () => {throw new Error('Popup must use the shared service');};
  w.eval(source('config.js')); w.eval(source('messages.js')); w.eval(source('i18n.js')); w.eval(source('popup.js')); await tick(60);
  assert.match(w.document.getElementById('rates').textContent, /7\.0000/);
  assert.match(w.document.getElementById('status').textContent, /离线缓存/);
  assert.equal(w.document.getElementById('copy-button').disabled, true);
});

for (const language of ['zh', 'en', 'ja']) test(`unified options permission controls and language ${language}`, async t => {
  const h = worker({initial: {language, hoverEnabled: false}}), requested = [];
  let grant = false;
  const dom = new JSDOM(source('options.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  w.chrome = {...h.chrome, runtime: {...h.chrome.runtime, sendMessage: h.send}, permissions: {...h.chrome.permissions, request: async value => {requested.push(value); return grant;}}};
  w.eval(source('config.js')); w.eval(source('messages.js')); w.eval(source('i18n.js')); await w.FXI18N.ready;
  w.eval(source('options.js')); await tick();
  if (language === 'en') assert.doesNotMatch(w.document.body.textContent, /[\u3400-\u9fff]/);
  if (language === 'ja') assert.match(w.document.body.textContent, /ホバー換算/);
  const checkbox = w.document.getElementById('hover-enabled');
  checkbox.checked = true; checkbox.dispatchEvent(new w.Event('change')); await tick();
  assert.equal(checkbox.checked, false); assert.equal(h.local.hoverEnabled, false);
  grant = true; checkbox.checked = true; checkbox.dispatchEvent(new w.Event('change')); await tick();
  assert.equal(h.local.hoverEnabled, true); assert.equal(h.registrations().length, 1);
  assert.equal(JSON.stringify(requested[0]), JSON.stringify({origins: ['https://*/*', 'http://*/*']}));
});
