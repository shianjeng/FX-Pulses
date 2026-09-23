/* A non-UTC zone is the whole point of the timestamp test below: a naive
   ISO string is parsed as local time, which is exactly what shifted the chart. */
process.env.TZ = 'Asia/Tokyo';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const pairs = ['USD/CNY', 'USD/JPY', 'CNY/JPY'];
const quote = (midpoint = 7) => ({
  base_currency: 'USD', quote_currency: 'CNY', midpoint, bid: midpoint - 0.01,
  ask: midpoint + 0.01, provider: 'mock', captured_at: new Date().toISOString(), is_stale: false,
});
const response = data => ({ok: true, json: async () => data});

async function popup(t, {watchlist = pairs, onUrl} = {}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, state = {watchlist, targets: {}}, urls = [];
  w.chrome = {storage: {local: {
    get: async defaults => ({...defaults, ...state}),
    set: async changes => Object.assign(state, changes),
  }}, runtime: {openOptionsPage() {}}};
  w.fetch = async url => {
    urls.push(url);
    if (onUrl) { const custom = onUrl(url); if (custom) return custom; }
    if (url.endsWith('/pairs')) return response(pairs);
    if (url.endsWith('/rates')) return response([quote()]);
    if (url.includes('/comparisons/')) return response({official: []});
    if (url.includes('/history')) return response([
      {midpoint: 7.1, captured_at: '2026-09-18T00:00:00Z'},
      {midpoint: 7.2, captured_at: '2026-09-19T00:00:00Z'},
    ]);
    return response([]);
  };
  w.eval(source('config.js'));
  w.eval(source('messages.js'));
  w.eval(source('i18n.js'));
  w.eval(source('popup.js'));
  await tick(40);
  return {w, state, urls, el: id => w.document.getElementById(id)};
}

test('a timestamp without an offset is read as UTC, not as local time', async t => {
  const {w} = await popup(t);
  // Guard: this assertion is only meaningful outside UTC.
  assert.notEqual(Date.parse('2026-09-20T00:00:00'), Date.parse('2026-09-20T00:00:00Z'));
  assert.equal(
    w.eval('chartTimeLabel("2026-09-20T01:33:17")'),
    w.eval('chartTimeLabel("2026-09-20T01:33:17Z")'),
  );
});

test('the trend line follows the sampling interval instead of a fixed six hours', async t => {
  const {w, el} = await popup(t);
  const every = hours => Array.from({length: 6}, (unused, index) => ({
    midpoint: 7 + index * 0.01,
    captured_at: new Date(Date.UTC(2026, 8, 14 + index * hours / 24, (index * hours) % 24)).toISOString(),
  }));
  // A six-hour collector used to break the path at every single point.
  w.eval(`drawChart(${JSON.stringify(every(6))})`);
  const path = el('chart').querySelector('path').getAttribute('d');
  assert.equal(path.match(/M /g).length, 1);
  assert.ok(path.includes('L '));
  // A genuine outage still breaks the line.
  const withGap = every(6);
  withGap[3].captured_at = new Date(Date.UTC(2026, 8, 25)).toISOString();
  w.eval(`drawChart(${JSON.stringify(withGap)})`);
  assert.ok(el('chart').querySelector('path').getAttribute('d').match(/M /g).length > 1);
});

test('history range buttons request the selected window', async t => {
  const {w, el, urls} = await popup(t);
  assert.ok(urls.some(url => url.includes('history?days=7')));
  el('range-buttons').querySelector('[data-days="30"]').click();
  await tick(40);
  assert.ok(urls.some(url => url.includes('history?days=30')));
  assert.equal(el('range-buttons').querySelector('[data-days="30"]').classList.contains('selected'), true);
  assert.equal(el('range-buttons').querySelector('[data-days="7"]').classList.contains('selected'), false);
  assert.match(w.document.querySelector('#chart svg')?.getAttribute('aria-label') ?? '', /三十日/);
});

test('a zero or blank target is rejected instead of reading as reached forever', async t => {
  const {w, state, el} = await popup(t);
  const submit = async value => {
    el('target-value').value = value;
    el('target-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await tick();
  };
  await submit('0');
  assert.deepEqual(state.targets, {});
  assert.match(el('target-message').textContent, /大于0/);
  await submit('-5');
  assert.deepEqual(state.targets, {});
  await submit('7.2');
  assert.equal(state.targets['USD/CNY'].value, 7.2);
});

test('a stalled collector is reported separately from stale data', async t => {
  const {el} = await popup(t, {
    onUrl: url => url.endsWith('/health')
      ? response({status: 'ok', provider: 'mock', collector: [{job: 'market', is_stalled: true}]})
      : null,
  });
  await tick(40);
  assert.match(el('status').textContent, /采集器已停止/);
});

/* ---- background service worker ------------------------------------------- */

function event() {
  const listeners = [];
  return {addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners};
}
function storage(data, changed, area) {
  return {
    async get(keys) {
      if (keys === null) return {...data};
      if (typeof keys === 'string') return keys in data ? {[keys]: data[keys]} : {};
      return {...keys, ...data};
    },
    async set(values) {
      const updates = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {oldValue: data[key], newValue}]));
      Object.assign(data, values);
      changed.emit(updates, area);
    },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}
function worker({initial = {}, official = []} = {}) {
  const local = {hoverEnabled: true, ...initial}, changes = event(), calls = [];
  const chrome = {
    storage: {local: storage(local, changes, 'local'), session: storage({}, changes, 'session'), onChanged: changes},
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(),
      onInstalled: event(), onStartup: event(), openOptionsPage: async () => {}},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
  };
  const context = vm.createContext({chrome, URL, console, setTimeout, Date,
    clearTimeout: globalThis.clearTimeout, AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => vm.runInContext(source(name), context)),
    fetch: async url => {
      calls.push(url);
      const data = url.endsWith('/pairs') ? pairs
        : url.endsWith('/rates') ? [quote()]
        : url.includes('/official-rates/') ? official
        : url.endsWith('/health') ? {status: 'ok', provider: 'mock', collector: []}
        : [];
      return {ok: true, json: async () => data};
    }});
  context.globalThis = context;
  vm.runInContext(source('background.js'), context);
  const send = (message, page = false) => new Promise(resolve => {
    const sender = {id: 'test', url: page ? 'https://example.com/' : 'chrome-extension://test/popup.html'};
    chrome.runtime.onMessage.listeners[0](message, sender, resolve);
  });
  return {chrome, local, calls, send};
}

test('evicting cached requests never discards the shared snapshot', async () => {
  const h = worker();
  await h.send({type: 'FX_SNAPSHOT'});
  const before = h.calls.length;
  // Overflow the request cache well past its limit.
  for (let index = 0; index < 140; index += 1) {
    await h.send({type: 'FX_API', path: `/rates/USD/CNY/history?days=${[1, 7, 30, 90][index % 4]}`});
  }
  await h.send({type: 'FX_SNAPSHOT'});
  // Only the four distinct history paths were fetched; the snapshot was reused.
  assert.equal(h.calls.length, before + 4);
});

test('a content script cannot ask the gateway for arbitrary paths', async () => {
  const h = worker({official: [{rate: '7.8', institution: 'European Central Bank', reference_date: '2026-09-18', is_derived: true}]});
  assert.equal((await h.send({type: 'FX_OFFICIAL', path: '/official-rates/EUR/CNY'}, true)).ok, true);
  assert.equal((await h.send({type: 'FX_API', path: '/official-rates/EUR/CNY'})).ok, true);
  for (const path of ['/rates', '/official-rates/EUR/CNY/../../rates', '/pairs', '/official-rates/eur/cny']) {
    const reply = await h.send({type: 'FX_OFFICIAL', path}, true);
    assert.equal(reply.ok, false, path);
  }
  assert.equal((await h.send({type: 'FX_API', path: '/pairs'}, true)).ok, false);
});

test('alerts stay off until enabled and then schedule a periodic check', async () => {
  const alarms = {};
  const h = worker();
  h.chrome.alarms = {
    async create(name, options) { alarms[name] = options; },
    async clear(name) { delete alarms[name]; },
    async get(name) { return alarms[name]; },
    onAlarm: event(),
  };
  await h.send({type: 'FX_SYNC_ALERTS'});
  assert.deepEqual(alarms, {});
  await h.chrome.storage.local.set({alertsEnabled: true, alertIntervalMinutes: 30});
  await h.send({type: 'FX_SYNC_ALERTS'});
  assert.equal(alarms['fx-target-check'].periodInMinutes, 30);
});

/* ---- hover --------------------------------------------------------------- */

async function hover(t, {text = '€10', target = 'CNY', official = []} = {}) {
  const h = worker({initial: {language: 'en', hoverTarget: target, hoverMode: 'simple', hoverSize: 'm', watchlist: pairs}, official});
  const dom = new JSDOM('<body><span id="price"></span></body>', {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window;
  let shadow;
  w.document.getElementById('price').textContent = text;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  w.chrome = {...h.chrome, runtime: {...h.chrome.runtime, sendMessage: message => h.send(message, true)}};
  w.fetch = () => { throw new Error('Page must never fetch the backend directly'); };
  const price = w.document.getElementById('price');
  w.document.elementFromPoint = () => price;
  w.document.caretRangeFromPoint = () => ({startContainer: price.firstChild, startOffset: 2});
  const createRange = w.document.createRange.bind(w.document);
  w.document.createRange = () => {
    const range = createRange();
    range.getBoundingClientRect = () => ({left: 10, right: 100, top: 10, bottom: 30});
    return range;
  };
  w.eval(source('messages.js'));
  w.eval(source('amount-parser.js'));
  w.eval(source('hover.js'));
  await tick();
  price.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: 20, clientY: 20}));
  await tick(300);
  return {...h, w, shadow: () => shadow};
}

test('a currency the market feed lacks falls back to a labelled official rate', async t => {
  const h = await hover(t, {official: [{
    rate: '7.80000000', institution: 'European Central Bank',
    reference_date: '2026-09-18', is_derived: true,
  }]});
  const card = h.shadow().querySelector('.card').textContent;
  assert.match(h.shadow().querySelector('.amount').textContent, /78\.00 CNY/);
  assert.match(card, /Official reference/);
  assert.match(card, /European Central Bank/);
  assert.doesNotMatch(card, /not configured/);
});

test('hover selects the newest official observation and retries a negative cache', async t => {
  const official = [
    {rate: '7.5', institution: 'Bank of Canada', reference_date: '2026-08-01'},
    {rate: '8', institution: 'European Central Bank', reference_date: '2026-09-18'},
  ];
  const h = await hover(t, {official});
  assert.match(h.shadow().querySelector('.amount').textContent, /80\.00 CNY/);
  assert.match(h.shadow().querySelector('.card').textContent, /European Central Bank/);

  const missing = [];
  const recovered = await hover(t, {official: missing});
  assert.equal(recovered.shadow().querySelector('.amount').textContent, '—');
  missing.push({rate: '9', institution: 'Federal Reserve Board', reference_date: '2026-09-19'});
  const realNow = recovered.w.Date.now;
  recovered.w.Date.now = () => realNow() + 61000;
  recovered.w.document.getElementById('price').dispatchEvent(
    new recovered.w.MouseEvent('mousemove', {bubbles: true, clientX: 20, clientY: 20}),
  );
  await tick(300);
  assert.match(recovered.shadow().querySelector('.amount').textContent, /90\.00 CNY/);
});

test('per-site currency memory is capped instead of growing forever', async t => {
  const h = await hover(t, {text: '$10', official: []});
  for (let index = 0; index < 260; index += 1) {
    await h.chrome.storage.local.set({[`hoverMemory:site${index}.example|$`]: {code: 'USD', at: index}});
  }
  const select = h.shadow().querySelector('select');
  select.value = 'JPY';
  select.dispatchEvent(new h.w.Event('change'));
  await tick(60);
  const keys = Object.keys(h.local).filter(key => key.startsWith('hoverMemory:'));
  assert.ok(keys.length <= 200, `kept ${keys.length} keys`);
  assert.equal(h.local['hoverMemory:example.com|$'].code, 'JPY');
  // The oldest entries are the ones dropped.
  assert.equal(keys.includes('hoverMemory:site0.example|$'), false);
});
