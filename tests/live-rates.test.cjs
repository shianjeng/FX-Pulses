const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Live rates: Coinbase's public exchange-rate table, fetched by the worker at
   most once a minute for every caller together, preferred over the backend's
   collected quotes wherever it has both currencies, and never trusted blindly:
   crypto and metals are not money, a feed that disagrees with the collected
   quotes is refused, a stale copy stops counting, and the switch turns it off. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
// The result box as it reads: its figure and the currency code beside it, or "—" while it is empty.
const shown = box => box.value ? `${box.value} ${box.parentElement.querySelector('.amount-code').textContent}` : '—';
const BASE = 'https://cdn.example/api/v1';
const LIVE = 'https://api.coinbase.com/v2/exchange-rates?currency=USD';
const quote = (base_currency, quote_currency, midpoint, captured_at = new Date(Date.now() - 3600000).toISOString()) => ({
  base_currency, quote_currency, midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at, is_stale: false,
});
// Twenty-odd currencies, as the feed serves them, plus assets that are not money.
const table = (overrides = {}) => ({data: {currency: 'USD', rates: {
  EUR: '0.882', GBP: '0.756', JPY: '157.35', CNY: '6.71', KRW: '1353', SGD: '1.278', AUD: '1.431', CAD: '1.419',
  HKD: '7.846', TWD: '31.82', CHF: '0.834', INR: '95.87', THB: '33.58', MXN: '18.05', SEK: '9.41', NOK: '10.1',
  DKK: '6.58', NZD: '1.62', ZAR: '17.4', BRL: '5.3', VND: '26210', BTC: '0.0000089', ETH: '0.00021', XAU: '0.00026',
  USDC: '1', ...overrides,
}}});

function worker({local: initial = {}, live = () => table()} = {}) {
  let now = Date.parse('2026-09-30T12:00:00Z');
  const event = () => { const listeners = []; return {addListener: fn => listeners.push(fn), listeners}; };
  const local = {hoverEnabled: true, ...initial}, calls = [], notes = [], alarms = new Map();
  let respond = live;
  const chrome = {
    storage: {
      local: {async get(keys) { return typeof keys === 'string' ? (keys in local ? {[keys]: local[keys]} : {}) : {...keys, ...local}; }, async set(v) { Object.assign(local, v); }, async remove() {}},
      onChanged: event(),
    },
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
    alarms: {onAlarm: event(), get: async name => alarms.get(name), create: async (name, info) => { alarms.set(name, info); }, clear: async name => alarms.delete(name)},
    notifications: {create: (id, options) => { notes.push(options); }},
  };
  const files = {
    '/meta.json': {generated_at: '2026-09-30T11:00:00Z', provider: 'alpha_vantage', stale_after_minutes: 360, collector: []},
    '/pairs.json': ['USD/CNY', 'USD/JPY'],
    '/rates.json': [quote('USD', 'CNY', '6.70', '2026-09-30T11:00:00Z'), quote('USD', 'JPY', '157.2', '2026-09-30T11:00:00Z')],
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout, AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => {
      vm.runInContext(source(name), context);
      if (name === 'config.js') Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
    }),
    Date: class extends Date { static now() { return now; } },
    fetch: async url => {
      calls.push(url);
      if (url === LIVE) {
        const body = respond();
        if (body instanceof Error) throw body;
        return {ok: true, json: async () => body};
      }
      const path = url.slice(BASE.length);
      return path in files ? {ok: true, json: async () => files[path]} : {ok: false, status: 404};
    },
  });
  context.globalThis = context;
  vm.runInContext(source('config.js'), context);
  Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
  vm.runInContext(source('messages.js'), context);
  vm.runInContext(source('background.js'), context);
  const send = (message, page = false) => new Promise(resolve => {
    const sender = {id: 'test', url: page ? 'https://example.com/' : 'chrome-extension://test/popup.html'};
    chrome.runtime.onMessage.listeners[0](message, sender, resolve);
  });
  const liveCalls = () => calls.filter(url => url === LIVE).length;
  return {chrome, local, calls, notes, alarms, send, liveCalls, advance: ms => { now += ms; }, respond: fn => { respond = fn; },
    alarm: async name => { chrome.alarms.onAlarm.listeners.forEach(fn => fn({name})); await tick(40); }};
}

test('one request a minute serves the popup and every page together', async () => {
  const h = worker();
  const replies = await Promise.all([h.send({type: 'FX_LIVE'}), h.send({type: 'FX_LIVE'}, true), h.send({type: 'FX_LIVE'}, true)]);
  assert.ok(replies.every(reply => reply.ok && reply.data.rates.JPY === 157.35));
  assert.equal(h.liveCalls(), 1);
  h.advance(30000);
  await h.send({type: 'FX_LIVE'}, true);
  assert.equal(h.liveCalls(), 1, 'still within the minute');
  // A page cannot force a fresh request; the popup's refresh button can.
  await h.send({type: 'FX_LIVE', force: true}, true);
  assert.equal(h.liveCalls(), 1);
  await h.send({type: 'FX_LIVE', force: true});
  assert.equal(h.liveCalls(), 2);
  h.advance(61000);
  await h.send({type: 'FX_LIVE'}, true);
  assert.equal(h.liveCalls(), 3);
});

test('only money counts: crypto assets and metals are left out', async () => {
  const {data} = await worker().send({type: 'FX_LIVE'});
  assert.equal(data.rates.USD, 1);
  assert.equal(data.rates.VND, 26210);
  for (const code of ['BTC', 'ETH', 'XAU', 'USDC']) assert.equal(code in data.rates, false, code);
  assert.equal(data.source, 'coinbase');
});

test('a feed that disagrees with the collected quotes by over 5% is refused', async () => {
  const h = worker({live: () => table({JPY: '190'})});
  await h.send({type: 'FX_SNAPSHOT'});                 // USD/JPY 157.2 collected
  assert.equal((await h.send({type: 'FX_LIVE'})).data, null);
  const garbage = worker({live: () => ({data: {currency: 'USD', rates: {JPY: 'abc'}}})});
  assert.equal((await garbage.send({type: 'FX_LIVE'})).data, null);
});

test('a failed request keeps the last copy for ten minutes, then gives way', async () => {
  const h = worker();
  const first = (await h.send({type: 'FX_LIVE'})).data;
  h.respond(() => new Error('offline'));
  h.advance(2 * 60000);
  assert.equal((await h.send({type: 'FX_LIVE'})).data.fetchedAt, first.fetchedAt);
  // A failure is not retried by every caller: one attempt a minute.
  const calls = h.liveCalls();
  await h.send({type: 'FX_LIVE'}, true);
  assert.equal(h.liveCalls(), calls);
  h.advance(9 * 60000);
  assert.equal((await h.send({type: 'FX_LIVE'})).data, null);
});

test('switched off, nothing is fetched and nothing is returned', async () => {
  const h = worker({local: {liveRates: false}});
  assert.equal((await h.send({type: 'FX_LIVE'})).data, null);
  assert.equal(h.liveCalls(), 0);
});

test('pages may ask only while hover is on', async () => {
  const h = worker({local: {hoverEnabled: false}});
  assert.equal((await h.send({type: 'FX_LIVE'}, true)).ok, false);
  assert.equal((await h.send({type: 'FX_LIVE'})).ok, true);
});

test('target alerts use the live rate and fire when the backend has not caught up', async () => {
  const h = worker({local: {alertsEnabled: true, targets: {'USD/JPY': {direction: 'above', value: 157.3}}}});
  await h.alarm('fx-target-check');
  // Collected 157.2 is below the target; live 157.35 is above it.
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].message, /157\.35/);
});

test('the icon shows the live rate and follows it every five minutes', async () => {
  const h = worker({local: {badgePair: 'USD/JPY'}});
  const badge = {};
  h.chrome.action = {
    setBadgeText: async ({text}) => { badge.text = text; }, setBadgeBackgroundColor: async ({color}) => { badge.color = color; },
    setBadgeTextColor: async () => {}, setTitle: async ({title}) => { badge.title = title; },
  };
  h.chrome.storage.onChanged.listeners.forEach(fn => fn({badgePair: {newValue: 'USD/JPY'}}, 'local'));
  await tick(60);
  assert.equal(h.alarms.get('fx-badge').periodInMinutes, 5);
  assert.match(badge.title, /USD\/JPY = 157\.35/);
  assert.equal(badge.color, '#0b8a6f');
});

/* ---- popup ---------------------------------------------------------------- */

async function popup(t, {liveData, official = {}, captured} = {}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, asked = [];
  const state = {watchlist: ['USD/CNY'], targets: {}, viewMode: 'detail', converterFrom: 'USD', converterTo: 'CNY'};
  let liveReply = liveData;
  const intervals = [];
  w.setInterval = (fn, ms) => { intervals.push({fn, ms}); return intervals.length; };
  w.chrome = {
    storage: {local: {get: async d => ({...d, ...state}), set: async v => Object.assign(state, v)}},
    runtime: {openOptionsPage() {}, sendMessage: async message => {
      asked.push(message.path || message.type);
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: {pairs: ['USD/CNY'], offline: false, rates: [quote('USD', 'CNY', '7.1', captured)]}};
      if (message.type === 'FX_LIVE') return {ok: true, data: liveReply};
      if (message.path === '/currencies') return {ok: true, data: {market_pairs: ['USD/CNY'], official_currencies: ['USD', 'CNY', 'EUR']}};
      if (message.path?.startsWith('/official-rates/')) return {ok: true, data: official[message.path] || []};
      if (message.path?.includes('/history')) return {ok: true, data: []};
      if (message.path?.startsWith('/comparisons/')) return {ok: true, data: {official: []}};
      return {ok: false};
    }},
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick(80);
  const el = id => w.document.getElementById(id);
  const choose = async (from, to) => {
    el('converter-from').value = from; el('converter-to').value = to;
    el('converter-to').dispatchEvent(new w.Event('change')); await tick(40);
  };
  return {w, el, asked, choose, intervals, setLive: value => { liveReply = value; }};
}
const liveData = (rates, age = 30000) => ({source: 'coinbase', base: 'USD', rates, fetchedAt: Date.now() - age});

test('the popup converts with the live rate and says where it comes from', async t => {
  const app = await popup(t, {liveData: liveData({USD: 1, CNY: 7.2, JPY: 150, KRW: 1350})});
  assert.equal(shown(app.el('converted')), '7,200.00 CNY');
  assert.match(app.el('status').textContent, /实时 · Coinbase/);
  assert.match(app.el('rates').textContent, /7\.2000/);
  assert.equal(app.el('rates').querySelector('.rate-bottom .live').textContent, '实时');
  assert.equal(app.el('converter-status').textContent, '实时中间价 · Coinbase');
});

test('live rates cover pairs the backend has no quote for, without asking it', async t => {
  const app = await popup(t, {liveData: liveData({USD: 1, CNY: 7.2, KRW: 1350, VND: 26210})});
  // Currencies only the live table knows are offered too.
  assert.ok([...app.el('converter-to').options].some(option => option.value === 'VND'));
  await app.choose('USD', 'KRW');
  assert.equal(shown(app.el('converted')), '1,350,000 KRW');
  assert.equal(app.asked.some(path => String(path).startsWith('/official-rates/')), false);
});

test('a live copy older than ten minutes is not used', async t => {
  const app = await popup(t, {liveData: liveData({USD: 1, CNY: 7.2}, 11 * 60000)});
  assert.equal(shown(app.el('converted')), '7,100.00 CNY');
  assert.doesNotMatch(app.el('status').textContent, /Coinbase/);
});

test('while open, the popup follows the live rate every minute', async t => {
  const app = await popup(t, {liveData: liveData({USD: 1, CNY: 7.2})});
  const poll = app.intervals.find(entry => entry.ms === 60000);
  assert.ok(poll, 'a one-minute refresh is scheduled');
  app.setLive(liveData({USD: 1, CNY: 7.25}, 0));
  await poll.fn(); await tick(40);
  assert.equal(shown(app.el('converted')), '7,250.00 CNY');
  // And when live rates go away, the backend's quote takes over again.
  app.setLive(null);
  await poll.fn(); await tick(40);
  assert.equal(shown(app.el('converted')), '7,100.00 CNY');
});

/* ---- hover ---------------------------------------------------------------- */

async function hover(t, liveReply) {
  const dom = new JSDOM('<body><span id="price">$10</span></body>', {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window, local = {hoverEnabled: true, hoverTarget: 'CNY', hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY']};
  w.chrome = {
    runtime: {getURL: path => path, sendMessage: async message => {
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: {pairs: ['USD/CNY'], offline: false, rates: [quote('USD', 'CNY', '7.1')]}};
      if (message.type === 'FX_LIVE') return liveReply;
      return {ok: false};
    }},
    storage: {local: {get: async keys => keys === null ? {...local} : typeof keys === 'string' ? {} : {...keys, ...local},
      set: async values => { Object.assign(local, values); }, remove: async () => {}}, onChanged: {addListener() {}}},
  };
  let shadow;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  const price = w.document.getElementById('price');
  w.document.elementFromPoint = () => price;
  w.document.caretRangeFromPoint = () => ({startContainer: price.firstChild, startOffset: 1});
  const createRange = w.document.createRange.bind(w.document);
  w.document.createRange = () => { const range = createRange(); range.getBoundingClientRect = () => ({left: 10, right: 100, top: 10, bottom: 30}); return range; };
  for (const name of ['messages.js', 'amount-parser.js', 'hover.js']) w.eval(source(name));
  await tick();
  price.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: 15, clientY: 15}));
  await tick(300);
  return {amount: shadow.querySelector('.amount').textContent, meta: shadow.querySelector('.meta').textContent};
}

test('the hover card converts with the live rate and labels it', async t => {
  const card = await hover(t, {ok: true, data: liveData({USD: 1, CNY: 7.2})});
  assert.equal(card.amount, '≈ 72.00 CNY');
  assert.match(card.meta, /实时Coinbase 实时中间价/);
});

test('without live rates the hover card uses the backend, as before', async t => {
  const card = await hover(t, {ok: true, data: null});
  assert.equal(card.amount, '≈ 71.00 CNY');
  assert.match(card.meta, /市场中间价/);
});

/* ---- settings ------------------------------------------------------------- */

test('the settings page has live rates on by default and can switch them off', async t => {
  const dom = new JSDOM(source('options.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, saved = {};
  w.chrome = {storage: {local: {get: async d => ({...d}), set: async v => Object.assign(saved, v)}},
    permissions: {request: async () => true}, runtime: {sendMessage: async () => ({ok: false})}};
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'options.js']) w.eval(source(name));
  await tick(60);
  const box = w.document.getElementById('live-rates');
  assert.equal(box.checked, true);
  assert.match(w.document.body.textContent, /Coinbase 会看到你的 IP 地址/);
  box.checked = false; box.dispatchEvent(new w.Event('change')); await tick(20);
  assert.equal(saved.liveRates, false);
  assert.deepEqual([...w.document.getElementById('alert-interval').options].map(option => option.value), ['5', '30', '60', '180', '360']);
});
