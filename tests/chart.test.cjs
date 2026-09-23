const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The trend chart reads like a quote sheet: a plain line over a soft fill,
   markers only on the period's high and low, and statistics that describe
   the selected range rather than the last 24 hours. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const response = data => ({ok: true, json: async () => data});
const hours = (h, midpoint) => ({midpoint, captured_at: new Date(Date.UTC(2026, 8, 14, h)).toISOString()});

async function popup(t) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = {watchlist: ['USD/CNY'], targets: {}, viewMode: 'detail'};
  w.chrome = {storage: {local: {get: async d => ({...d, ...state}), set: async v => Object.assign(state, v)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => url.endsWith('/pairs') ? response(['USD/CNY'])
    : url.endsWith('/rates') ? response([{base_currency: 'USD', quote_currency: 'CNY', midpoint: 7, bid: 7, ask: 7,
      provider: 'mock', captured_at: new Date().toISOString(), is_stale: false}])
    : url.includes('/comparisons/') ? response({official: []}) : response([]);
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick();
  const el = id => w.document.getElementById(id);
  const draw = points => w.eval(`drawChart(${JSON.stringify(points)})`);
  return {w, el, draw};
}

// Six evenly spaced samples, high at index 2 and low at index 4.
const wave = [hours(0, 7.10), hours(4, 7.14), hours(8, 7.20), hours(12, 7.16), hours(16, 7.05), hours(20, 7.12)];

test('only the high and the low carry a marker, not every sample', async t => {
  const {el, draw} = await popup(t);
  draw(wave);
  const marks = [...el('chart').querySelectorAll('circle.chart-extreme')];
  assert.equal(marks.length, 2);
  assert.equal(el('chart').querySelectorAll('circle.chart-lone').length, 0);
  // Highest value is drawn nearest the top, lowest nearest the bottom.
  const ys = marks.map(mark => Number(mark.getAttribute('cy'))).sort((a, b) => a - b);
  const line = el('chart').querySelector('path.chart-line').getAttribute('d');
  const lineYs = [...line.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map(m => Number(m[1]));
  assert.equal(ys[0], Math.min(...lineYs));
  assert.equal(ys[1], Math.max(...lineYs));
});

test('a flat period has no high or low to mark', async t => {
  const {el, draw} = await popup(t);
  draw(wave.map(point => ({...point, midpoint: 7})));
  assert.equal(el('chart').querySelectorAll('circle.chart-extreme').length, 0);
});

test('statistics describe the selected range', async t => {
  const {el, draw} = await popup(t);
  draw(wave);
  assert.equal(el('stat-high').textContent, '7.2000');
  assert.equal(el('stat-low').textContent, '7.0500');
  assert.equal(el('stat-avg').textContent, '7.1283');
  // First sample 7.10 to last 7.12 over the range, not a 24-hour figure.
  assert.equal(el('stat-change').textContent, '+0.28%');
  assert.equal(el('stat-change').className, 'positive');

  draw([hours(0, 7.2), hours(4, 7.1)]);
  assert.equal(el('stat-change').textContent, '-1.39%');
  assert.equal(el('stat-change').className, 'negative');
});

test('the fill follows the line and breaks where collection stopped', async t => {
  const {el, draw} = await popup(t);
  draw(wave);
  assert.equal(el('chart').querySelectorAll('polygon.chart-area').length, 1);

  const gapped = [...wave.slice(0, 3), hours(24 * 6, 7.3), hours(24 * 6 + 4, 7.31), hours(24 * 6 + 8, 7.28)];
  draw(gapped);
  assert.equal(el('chart').querySelectorAll('polygon.chart-area').length, 2, 'one fill per uninterrupted run');
  // The line is still the first path, so earlier path assertions keep holding.
  assert.equal(el('chart').querySelector('path').getAttribute('class'), 'chart-line');
});

test('a lone sample after an outage stays visible without a fill', async t => {
  const {el, draw} = await popup(t);
  draw([...wave, hours(24 * 6, 7.3)]);
  assert.equal(el('chart').querySelectorAll('polygon.chart-area').length, 1);
  assert.equal(el('chart').querySelectorAll('circle.chart-lone').length, 1);
});

test('range tabs use readable, localized labels', async t => {
  const {el} = await popup(t);
  const labels = [...el('range-buttons').querySelectorAll('button')].map(button => button.textContent);
  assert.deepEqual(labels, ['24小时', '7天', '1个月', '3个月']);
});
