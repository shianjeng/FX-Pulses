const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Which history a range draws. Collection began on 23 September 2026, so one
   month and three months showed that same week stretched out. Collected quotes
   are drawn while they span the range; until then, and for every pair the
   market feed does not track, the ECB's daily reference rates are, with a
   caption saying so. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const DAY = 86400000;
const API = 'https://api.invalid';

// Business days over the last `days` days, oldest first, with a gentle trend.
function referenceFile(days = 95) {
  const dates = [];
  for (let back = days; back >= 0; back--) {
    const day = new Date(Date.now() - back * DAY);
    if (day.getUTCDay() % 6) dates.push(day.toISOString().slice(0, 10));
  }
  return {
    institution: 'European Central Bank', anchor_currency: 'EUR', source_url: 'https://www.ecb.europa.eu/',
    dates,
    rates: {
      USD: dates.map((_, index) => 1.10 + index * 0.001),
      JPY: dates.map((_, index) => 170 + index * 0.2),
      CNY: dates.map(() => 7.8),
      KRW: dates.map((_, index) => (index === 3 ? null : 1500 + index)),
    },
  };
}

// Market quotes every four hours over the last `days` days.
function marketHistory(days) {
  const points = [];
  for (let at = Date.now() - days * DAY + 3600000; at < Date.now(); at += 4 * 3600000) {
    points.push({midpoint: String(157 + Math.sin(at / DAY)), bid: '157', ask: '157', captured_at: new Date(at).toISOString()});
  }
  return points;
}

async function popup(t, {from = 'USD', to = 'JPY', collectedDays = 7, referenceDays, midpoint = '157'} = {}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, asked = [], reference = referenceFile(referenceDays);
  const state = {watchlist: ['USD/JPY'], targets: {}, apiUrl: API, viewMode: 'detail', converterFrom: from, converterTo: to};
  w.chrome = {storage: {local: {get: async d => ({...d, ...state}), set: async v => Object.assign(state, v)}}, runtime: {openOptionsPage() {}}};
  w.fetch = async url => {
    const path = url.slice(API.length);
    asked.push(path);
    const json = path === '/pairs' ? ['USD/CNY', 'USD/JPY', 'CNY/JPY']
      : path === '/rates' ? [{base_currency: 'USD', quote_currency: 'JPY', midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false}]
        : path === '/currencies' ? {market_pairs: ['USD/CNY', 'USD/JPY', 'CNY/JPY'], official_currencies: ['CNY', 'EUR', 'JPY', 'KRW', 'USD']}
          : path === '/reference-history' ? reference
            : path.includes('/history') ? marketHistory(collectedDays).filter(point => Date.parse(point.captured_at) >= Date.now() - Number(path.split('days=')[1]) * DAY)
              : path.startsWith('/comparisons/') ? {official: []} : [];
    return {ok: true, json: async () => json};
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick(80);
  const el = id => w.document.getElementById(id);
  const range = async days => { el('range-buttons').querySelector(`[data-days="${days}"]`).click(); await tick(60); };
  const line = () => el('chart').querySelector('path.chart-line')?.getAttribute('d') || '';
  const samples = () => [...line().matchAll(/[MLC]/g)].length;
  return {w, el, asked, range, line, samples, reference};
}

const inRange = (reference, days) => reference.dates.filter(date => Date.parse(`${date}T12:00:00Z`) >= Date.now() - days * DAY).length;

test('three months: the ECB line until the collector has caught up', async t => {
  const app = await popup(t);
  await app.range(90);
  assert.match(app.el('chart-source').textContent, /欧洲央行每日参考价/);
  assert.equal(app.samples(), inRange(app.reference, 90));
  // USD/JPY from two columns: JPY / USD.
  const crosses = app.reference.dates.map((date, index) => app.reference.rates.JPY[index] / app.reference.rates.USD[index])
    .filter((value, index) => Date.parse(`${app.reference.dates[index]}T12:00:00Z`) >= Date.now() - 90 * DAY);
  assert.equal(app.el('stat-high').textContent, Math.max(...crosses).toLocaleString('zh-CN', {minimumFractionDigits: 3, maximumFractionDigits: 3}));
});

test('one year: the ECB line, with the year on the axis and in the tooltip', async t => {
  const app = await popup(t, {referenceDays: 370});
  await app.range(365);
  assert.match(app.el('chart-source').textContent, /欧洲央行每日参考价/);
  assert.equal(app.samples(), inRange(app.reference, 365));
  // October to October: a month and day alone would read the same at both ends.
  const labels = [...app.el('chart').querySelectorAll('.chart-x span')].map(span => span.textContent);
  assert.equal(labels.length, 3);
  for (const label of labels) assert.match(label, /^\d{4}\/\d{1,2}$/);
  const svg = app.el('chart').querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0, width: 384, height: 132});
  app.el('chart').querySelector('.chart-hit').dispatchEvent(new app.w.MouseEvent('pointermove', {clientX: 20, clientY: 40}));
  assert.match(app.el('chart').querySelector('.chart-tip small').textContent, /^\d{4}\/\d{1,2}\/\d{1,2}$/);
  assert.match(app.el('chart').querySelector('svg').getAttribute('aria-label'), /一年/);
});

test('seven days: the collected quotes, which already span the range', async t => {
  const app = await popup(t);
  assert.match(app.el('chart-source').textContent, /市场中间价/);
  assert.equal(app.samples(), marketHistory(7).length);
  // The chart needs nothing more; the one file asked for is the year range's.
  assert.equal(app.asked.filter(path => path === '/reference-history').length, 1);
});

test('the year range says where the rate sits in its past year', async t => {
  const app = await popup(t, {referenceDays: 370});
  const box = app.el('year-range');
  assert.equal(box.hidden, false);
  // USD/JPY from the ECB columns runs from about 154.5 up to 163; the market says 157.
  const values = app.reference.dates.map((date, index) => app.reference.rates.JPY[index] / app.reference.rates.USD[index])
    .filter((value, index) => Date.parse(`${app.reference.dates[index]}T12:00:00Z`) >= Date.now() - 365 * DAY);
  const share = Math.round(values.filter(value => value < 157).length / values.length * 100);
  assert.equal(app.el('year-range-note').textContent, `1 USD 能换的 JPY 多于过去一年 ${share}% 的日子`);
  const left = parseFloat(app.el('year-range-dot').style.left);
  assert.ok(left > 0 && left < 100, `${left}%`);
  assert.equal(app.el('year-range-low').textContent, Math.min(...values).toLocaleString('zh-CN', {minimumFractionDigits: 3, maximumFractionDigits: 3}));
});

test('beyond the year\'s range it says most or least; a short history shows nothing', async t => {
  // The reference year runs from about 154.6 to 163.3 yen a dollar.
  const high = await popup(t, {referenceDays: 370, midpoint: '170'});
  assert.equal(high.el('year-range-note').textContent, '1 USD 能换的 JPY 是一年来最多的');
  assert.equal(high.el('year-range-dot').style.left, '100%');
  const low = await popup(t, {referenceDays: 370, midpoint: '150'});
  assert.equal(low.el('year-range-note').textContent, '1 USD 能换的 JPY 是一年来最少的');
  assert.equal(low.el('year-range-dot').style.left, '0%');
  // Just above the year's low: one day in 250 is below it, which rounds to 0%, and "more than on 0% of days" reads wrong.
  const reference = referenceFile(370);
  const lowest = Math.min(...reference.dates.map((date, index) => reference.rates.JPY[index] / reference.rates.USD[index])
    .filter((value, index) => Date.parse(`${reference.dates[index]}T12:00:00Z`) >= Date.now() - 365 * DAY));
  const edge = await popup(t, {referenceDays: 370, midpoint: String(lowest + 0.001)});
  assert.equal(edge.el('year-range-note').textContent, '1 USD 能换的 JPY 多于过去一年 1% 的日子');
  const short = await popup(t);
  assert.equal(short.el('year-range').hidden, true, 'three months is not a year');
});

test('once the collector spans three months, its own quotes are drawn', async t => {
  const app = await popup(t, {collectedDays: 92});
  await app.range(90);
  assert.match(app.el('chart-source').textContent, /市场中间价/);
});

test('a pair the market feed does not track gets the ECB line for a week too', async t => {
  const app = await popup(t, {from: 'EUR', to: 'KRW'});
  assert.match(app.el('chart-source').textContent, /欧洲央行每日参考价/);
  // EUR is the anchor, so EUR/KRW is the KRW column itself; the day without a value is skipped.
  assert.ok(app.samples() >= 4);
});

test('the inverse of a tracked pair uses the ECB cross the other way round', async t => {
  const app = await popup(t, {from: 'JPY', to: 'CNY'});
  await app.range(30);
  assert.match(app.el('chart-source').textContent, /欧洲央行每日参考价/);
  const last = app.reference.rates.CNY.at(-1) / app.reference.rates.JPY.at(-1);
  assert.equal(app.el('stat-low').textContent, last.toLocaleString('zh-CN', {minimumFractionDigits: 6, maximumFractionDigits: 6}));
});

test('weekends do not break a daily line, and its tooltip gives a date', async t => {
  const app = await popup(t);
  await app.range(30);
  assert.equal(app.el('chart').querySelectorAll('.chart-gap').length, 0);
  assert.equal(app.line().match(/M /g).length, 1);
  const svg = app.el('chart').querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0, width: 384, height: 132});
  app.el('chart').querySelector('.chart-hit').dispatchEvent(new app.w.MouseEvent('pointermove', {clientX: 200, clientY: 40}));
  assert.match(app.el('chart').querySelector('.chart-tip small').textContent, /^\d{1,2}\/\d{1,2}$/);
});

test('the worker serves the history file from a static host', async () => {
  const BASE = 'https://cdn.example/api/v1', calls = [];
  const event = () => { const listeners = []; return {addListener: fn => listeners.push(fn), listeners}; };
  const chrome = {
    storage: {local: {get: async keys => ({...keys}), set: async () => {}}, onChanged: event()},
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
  };
  const context = vm.createContext({chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout, AbortController: globalThis.AbortController,
    importScripts: () => {},
    fetch: async url => { calls.push(url); return {ok: true, json: async () => url.endsWith('/meta.json') ? {stale_after_minutes: 360, collector: []} : referenceFile()}; }});
  context.globalThis = context;
  vm.runInContext(source('config.js'), context);
  Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
  vm.runInContext(source('messages.js'), context);
  vm.runInContext(source('background.js'), context);
  const send = (message, url) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {id: 'test', url}, resolve));
  const reply = await send({type: 'FX_API', path: '/reference-history'}, 'chrome-extension://test/popup.html');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.anchor_currency, 'EUR');
  assert.ok(calls.includes(`${BASE}/reference-history.json`), calls.join());
  // A page has no business with it.
  assert.equal((await send({type: 'FX_API', path: '/reference-history'}, 'https://example.com/')).ok, false);
});
