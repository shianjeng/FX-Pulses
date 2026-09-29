const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');

/* The opt-in toolbar badge: one pair's rate on the extension icon, painted
   from the snapshots the worker fetches anyway, grey when the quote is old,
   gone when switched off, and never more than Chrome's four characters. */

const BASE = 'https://cdn.example/api/v1';
const NOW = Date.parse('2026-09-30T12:00:00Z');
const quote = (base_currency, quote_currency, midpoint, captured_at = '2026-09-30T11:00:00Z') => ({
  base_currency, quote_currency, midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at, is_stale: false,
});
const files = captured => ({
  '/meta.json': {generated_at: captured, provider: 'alpha_vantage', stale_after_minutes: 360, collector: []},
  '/pairs.json': ['USD/CNY', 'USD/JPY'],
  '/rates.json': [quote('USD', 'CNY', '6.69691655', captured), quote('USD', 'JPY', '157.43124392', captured)],
});

function worker({local = {}, captured = '2026-09-30T11:00:00Z'} = {}) {
  const event = () => { const l = []; return {addListener: fn => l.push(fn), listeners: l}; };
  const badge = {text: undefined, color: undefined, title: undefined};
  const alarms = new Map();
  const chrome = {
    storage: {
      local: {async get(keys) { return {...keys, ...local}; }, async set(v) { Object.assign(local, v); }, async remove() {}},
      onChanged: event(),
    },
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
    alarms: {
      onAlarm: event(),
      get: async name => alarms.get(name),
      create: async (name, info) => { alarms.set(name, {name, ...info}); },
      clear: async name => alarms.delete(name),
    },
    action: {
      setBadgeText: async ({text}) => { badge.text = text; },
      setBadgeBackgroundColor: async ({color}) => { badge.color = color; },
      setBadgeTextColor: async () => {},
      setTitle: async ({title}) => { badge.title = title; },
    },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout, Intl,
    AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => {
      vm.runInContext(source(name), context);
      if (name === 'config.js') Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
    }),
    Date: class extends Date { static now() { return NOW; } },
    fetch: async url => {
      const table = files(captured), path = url.slice(BASE.length);
      return path in table ? {ok: true, json: async () => table[path]} : {ok: false, status: 404};
    },
  });
  context.globalThis = context;
  vm.runInContext(source('config.js'), context);
  Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
  vm.runInContext(source('messages.js'), context);
  vm.runInContext(source('background.js'), context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const change = async values => {
    Object.assign(local, values);
    const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {newValue}]));
    chrome.storage.onChanged.listeners.forEach(fn => fn(changes, 'local'));
    await settle();
  };
  return {context, badge, alarms, change, settle};
}

test('the badge fits four characters at every magnitude', () => {
  const {context} = worker();
  const cases = [
    [6.69691655, '6.70'], [23.43628638, '23.4'], [157.43124392, '157'], [1380.5, '1.4k'],
    [16250, '16k'], [0.14932, '.149'], [0.0063520, '.006'], [0.00006, '6e-5'], [2.48e11, '2e11'],
    // Rounding up must not spill into a fifth character.
    [9.996, '10.0'], [99.96, '100'], [999.7, '1.0k'], [0.99971, '1.00'],
  ];
  for (const [value, text] of cases) {
    assert.equal(context.badgeText(value), text, `${value}`);
    assert.ok(context.badgeText(value).length <= 4, `${value} -> ${context.badgeText(value)}`);
  }
  assert.equal(context.badgeText(NaN), '');
  assert.equal(context.badgeText(0), '');
});

test('choosing a pair paints its rate and keeps it fresh with an alarm', async () => {
  const w = worker();
  await w.change({badgePair: 'USD/JPY'});
  assert.equal(w.badge.text, '157');
  assert.equal(w.badge.color, '#0b8a6f');
  assert.match(w.badge.title, /USD\/JPY = 157\.431/);
  assert.equal(w.alarms.get('fx-badge')?.periodInMinutes, 30);

  // Either way round: the inverse of a tracked pair is painted too.
  await w.change({badgePair: 'JPY/USD'});
  assert.equal(w.badge.text, '.006');
});

test('an old quote turns the badge grey and says so', async () => {
  const w = worker({captured: '2026-09-30T04:00:00Z'});  // eight hours old, threshold six
  await w.change({badgePair: 'USD/CNY'});
  assert.equal(w.badge.text, '6.70');
  assert.equal(w.badge.color, '#8c98a6');
  assert.match(w.badge.title, /数据较旧/);
});

test('switching it off clears the icon and stops the alarm', async () => {
  const w = worker();
  await w.change({badgePair: 'USD/CNY'});
  assert.equal(w.badge.text, '6.70');
  await w.change({badgePair: ''});
  assert.equal(w.badge.text, '');
  assert.equal(w.badge.title, 'FX Pulse');
  assert.equal(w.alarms.has('fx-badge'), false);
});

test('a snapshot fetched for the popup repaints the badge without asking again', async () => {
  const w = worker({local: {badgePair: 'USD/CNY'}});
  const reply = await new Promise(resolve => w.context.chrome.runtime.onMessage.listeners[0](
    {type: 'FX_SNAPSHOT'}, {id: 'test', url: 'chrome-extension://test/popup.html'}, resolve));
  assert.equal(reply.ok, true);
  await w.settle();
  assert.equal(w.badge.text, '6.70');
});

test('the settings page offers every market pair both ways and saves the choice', async () => {
  const {JSDOM} = require('jsdom');
  const dom = new JSDOM(source('options.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  const w = dom.window, saved = {};
  try {
    w.chrome = {
      storage: {local: {get: async defaults => ({...defaults}), set: async values => Object.assign(saved, values)}},
      permissions: {request: async () => true},
      runtime: {sendMessage: async message => message.path === '/currencies'
        ? {ok: true, data: {market_pairs: ['USD/CNY', 'CNY/JPY'], official_currencies: []}} : {ok: false}},
    };
    for (const name of ['config.js', 'messages.js', 'i18n.js', 'options.js']) w.eval(source(name));
    await new Promise(resolve => setTimeout(resolve, 60));
    const select = w.document.getElementById('badge-pair');
    assert.deepEqual([...select.options].map(option => option.value), ['', 'USD/CNY', 'CNY/USD', 'CNY/JPY', 'JPY/CNY']);
    assert.equal(select.value, '');
    select.value = 'CNY/JPY';
    select.dispatchEvent(new w.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(saved.badgePair, 'CNY/JPY');
  } finally { w.close(); }
});
