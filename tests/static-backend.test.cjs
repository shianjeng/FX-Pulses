const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');

/* A static backend is a directory of JSON files with no server to compute
   anything per request. These tests pin the two properties that makes safe:
   every API path resolves to the file holding that data, and every field the
   API derived from the clock is derived again here — never read from the file,
   which a CDN may still be serving hours after it was written. */

const BASE = 'https://cdn.example/api/v1';
const MINUTE = 60000;

function worker({files, mode = 'static', now = Date.parse('2026-09-23T12:00:00Z')} = {}) {
  const calls = [];
  const local = {};
  const event = () => { const l = []; return {addListener: fn => l.push(fn), emit: (...a) => l.forEach(fn => fn(...a)), listeners: l}; };
  const chrome = {
    storage: {
      local: {async get(keys) { return typeof keys === 'string' ? {} : {...keys, ...local}; }, async set(v) { Object.assign(local, v); }, async remove() {}},
      onChanged: event(),
    },
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout,
    AbortController: globalThis.AbortController,
    // background.js re-runs config.js through importScripts, which would reset
    // the overrides below, so they are re-applied every time it loads.
    importScripts: (...names) => names.forEach(name => {
      vm.runInContext(source(name), context);
      if (name === 'config.js') Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: mode});
    }),
    Date: class extends Date { static now() { return now; } },
    fetch: async url => {
      calls.push(url);
      const path = url.slice(BASE.length);
      if (!(path in files)) return {ok: false, status: 404};
      return {ok: true, json: async () => files[path]};
    },
  });
  context.globalThis = context;
  vm.runInContext(source('config.js'), context);
  context.FXConfig.defaultApiUrl = BASE;
  context.FXConfig.backendMode = mode;
  vm.runInContext(source('messages.js'), context);
  vm.runInContext(source('background.js'), context);
  const send = message => new Promise(resolve => {
    const sender = {id: 'test', url: 'chrome-extension://test/popup.html'};
    if (!chrome.runtime.onMessage.listeners[0](message, sender, resolve)) resolve({ok: false});
  });
  return {send, calls, advance: ms => { now += ms; }};
}

const quote = (captured_at, extra = {}) => ({
  base_currency: 'USD', quote_currency: 'CNY', midpoint: '7.1', bid: '7.09', ask: '7.11',
  provider: 'alpha_vantage', captured_at, is_stale: false, ...extra,
});

const point = (captured_at, midpoint) => ({captured_at, midpoint, bid: midpoint, ask: midpoint});

const baseFiles = (captured = '2026-09-23T11:00:00Z') => ({
  '/meta.json': {
    generated_at: captured, provider: 'alpha_vantage', stale_after_minutes: 360,
    collector: [
      {job: 'market', finished_at: captured, last_success_at: captured, consecutive_failures: 0, last_error: null, stall_after_minutes: 720},
      {job: 'official:pboc', finished_at: null, last_success_at: null, consecutive_failures: 0, last_error: 'never ran', stall_after_minutes: 1080},
    ],
  },
  '/pairs.json': ['USD/CNY'],
  '/rates.json': [quote(captured)],
  '/currencies.json': {market_pairs: ['USD/CNY'], official_currencies: ['USD', 'CNY']},
});

test('each API path resolves to the static file holding that data', async () => {
  const files = {
    ...baseFiles(),
    '/comparisons/USD/CNY.json': {base_currency: 'USD', quote_currency: 'CNY', market: quote('2026-09-23T11:00:00Z'), official: []},
    '/official-rates/USD/CNY.json': [{base_currency: 'USD', quote_currency: 'CNY', rate: '7.0', institution: 'ECB', is_derived: false}],
  };
  const w = worker({files});
  await w.send({type: 'FX_API', path: '/comparisons/USD/CNY'});
  await w.send({type: 'FX_API', path: '/official-rates/USD/CNY'});
  await w.send({type: 'FX_SNAPSHOT'});

  const requested = w.calls.map(url => url.slice(BASE.length));
  assert.ok(requested.includes('/comparisons/USD/CNY.json'), `missing mapped comparison: ${requested}`);
  assert.ok(requested.includes('/official-rates/USD/CNY.json'), `missing mapped official: ${requested}`);
  assert.ok(requested.includes('/pairs.json') && requested.includes('/rates.json'), requested.join(','));
  // Nothing may reach the server-only routes, which do not exist on a CDN.
  assert.ok(!requested.some(p => p === '/pairs' || p === '/rates' || p === '/health'), requested.join(','));
});

test('staleness is recomputed from the clock, not read from the file', async () => {
  // The file says is_stale:false and never changes; the threshold is 360 min.
  const captured = '2026-09-23T11:00:00Z';
  const w = worker({files: baseFiles(captured)});

  const fresh = await w.send({type: 'FX_SNAPSHOT'});
  assert.equal(fresh.data.rates[0].is_stale, false, 'one hour old should be fresh');

  w.advance(8 * 60 * MINUTE);
  const stale = await w.send({type: 'FX_SNAPSHOT', force: true});
  assert.equal(stale.data.rates[0].is_stale, true, 'nine hours old must read stale despite is_stale:false in the file');
});

test('a stalled collector is derived from meta.json thresholds', async () => {
  const w = worker({files: baseFiles('2026-09-23T11:00:00Z')});
  const health = await w.send({type: 'FX_HEALTH'});
  const jobs = Object.fromEntries(health.data.collector.map(j => [j.job, j]));

  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.provider, 'alpha_vantage');
  assert.equal(jobs.market.is_stalled, false);
  // Never ran: no last_success_at at all must count as stalled, not as healthy.
  assert.equal(jobs['official:pboc'].is_stalled, true);
  assert.equal(jobs['official:pboc'].last_error, 'never ran');
});

test('history comes from one 90-day file, sliced to the requested window', async () => {
  const files = {
    ...baseFiles(),
    '/rates/USD/CNY/history.json': [
      point('2026-09-01T12:00:00Z', '7.0'),   // 22 days ago
      point('2026-09-20T12:00:00Z', '7.1'),   // 3 days ago
      point('2026-09-23T06:00:00Z', '7.2'),   // 6 hours ago
    ],
  };
  const w = worker({files});

  const week = await w.send({type: 'FX_API', path: '/rates/USD/CNY/history?days=7'});
  assert.deepEqual(week.data.map(p => p.midpoint), ['7.1', '7.2']);

  const quarter = await w.send({type: 'FX_API', path: '/rates/USD/CNY/history?days=90'});
  assert.deepEqual(quarter.data.map(p => p.midpoint), ['7.0', '7.1', '7.2']);

  const day = await w.send({type: 'FX_API', path: '/rates/USD/CNY/history?days=1'});
  assert.deepEqual(day.data.map(p => p.midpoint), ['7.2']);

  // All three windows share a single fetch of the same file.
  const historyCalls = w.calls.filter(url => url.includes('/history'));
  assert.deepEqual([...new Set(historyCalls)], [`${BASE}/rates/USD/CNY/history.json`]);
});

test('api mode still sends API paths untouched', async () => {
  const files = {
    '/pairs': ['USD/CNY'],
    '/rates': [quote('2026-09-23T11:00:00Z')],
  };
  const w = worker({files, mode: 'api'});
  await w.send({type: 'FX_SNAPSHOT'});
  const requested = w.calls.map(url => url.slice(BASE.length));
  assert.ok(requested.includes('/pairs') && requested.includes('/rates'), requested.join(','));
  assert.ok(!requested.some(p => p.endsWith('.json')), requested.join(','));
});
