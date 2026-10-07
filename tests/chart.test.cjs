const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The trend chart reads like a quote sheet: a smooth line over a soft fill
   that never invents a high or low between samples, markers only on the
   period's high and low, a round-numbered price scale and a time axis, and
   statistics that describe the selected range rather than the last 24 hours. */

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

// The points a path passes through: M/L targets and the end of every C.
function onCurve(d) {
  const points = [];
  for (const [, , numbers] of d.matchAll(/([MLC])([^MLCZ]*)/g)) {
    const values = numbers.trim().split(/\s+/).map(Number);
    points.push({x: values.at(-2), y: values.at(-1)});
  }
  return points;
}

test('only the high and the low carry a marker, not every sample', async t => {
  const {el, draw} = await popup(t);
  draw(wave);
  const marks = [...el('chart').querySelectorAll('circle.chart-extreme')];
  assert.equal(marks.length, 2);
  assert.equal(el('chart').querySelectorAll('circle.chart-lone').length, 0);
  // Highest value is drawn nearest the top, lowest nearest the bottom.
  const ys = marks.map(mark => Number(mark.getAttribute('cy'))).sort((a, b) => a - b);
  const lineYs = onCurve(el('chart').querySelector('path.chart-line').getAttribute('d')).map(point => point.y);
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
  assert.equal(el('chart').querySelectorAll('.chart-area').length, 1);
  assert.equal(el('chart').querySelectorAll('.chart-gap').length, 0);

  const gapped = [...wave.slice(0, 3), hours(24 * 6, 7.3), hours(24 * 6 + 4, 7.31), hours(24 * 6 + 8, 7.28)];
  draw(gapped);
  assert.equal(el('chart').querySelectorAll('.chart-area').length, 2, 'one fill per uninterrupted run');
  // The outage is a faint dashed span of its own, not part of the line.
  assert.equal(el('chart').querySelectorAll('.chart-gap').length, 1);
  assert.equal(el('chart').querySelector('path.chart-line').getAttribute('d').match(/M /g).length, 2);
  // The line is drawn over its fills.
  assert.equal([...el('chart').querySelectorAll('path')].at(-1).getAttribute('class'), 'chart-line');
});

test('a lone sample after an outage stays visible without a fill', async t => {
  const {el, draw} = await popup(t);
  draw([...wave, hours(24 * 6, 7.3)]);
  assert.equal(el('chart').querySelectorAll('.chart-area').length, 1);
  assert.equal(el('chart').querySelectorAll('circle.chart-lone').length, 1);
});

test('the smooth line never goes beyond the samples on either side', async t => {
  const {el, draw} = await popup(t);
  // Sharp turns, a flat run and a lone spike: where an ordinary spline overshoots.
  const jagged = [7.10, 7.30, 7.05, 7.05, 7.05, 7.40, 7.12, 7.13, 7.00, 7.20].map((value, index) => hours(index * 2, value));
  draw(jagged);
  const d = el('chart').querySelector('path.chart-line').getAttribute('d');
  assert.match(d, /C /, 'drawn as curves');
  let previous;
  for (const [, command, numbers] of d.matchAll(/([MLC])([^MLCZ]*)/g)) {
    const values = numbers.trim().split(/\s+/).map(Number);
    if (command === 'C') {
      const [, c1, , c2, , end] = values;
      const lowY = Math.min(previous, end) - 0.01, highY = Math.max(previous, end) + 0.01;
      assert.ok(c1 >= lowY && c1 <= highY && c2 >= lowY && c2 <= highY, `control points ${c1}, ${c2} outside ${previous}..${end}`);
    }
    previous = values.at(-1);
  }
  // A flat run stays flat: the three equal samples share one height.
  const ys = onCurve(d).map(point => point.y);
  assert.equal(ys[2], ys[3]);
  assert.equal(ys[3], ys[4]);
});

test('a round-numbered price scale and a time axis frame the line', async t => {
  const {el, draw} = await popup(t);
  draw(wave);
  const labels = [...el('chart').querySelectorAll('.chart-y')].map(label => label.textContent);
  assert.ok(labels.length >= 2, labels.join());
  // 7.05 to 7.20 steps by 0.02 or 0.05, never by an arbitrary 0.0375.
  const steps = labels.slice(1).map((label, index) => Math.round((Number(label) - Number(labels[index])) * 1e6) / 1e6);
  assert.ok(steps.every(step => [0.02, 0.025, 0.05].includes(step)), steps.join());
  assert.equal(el('chart').querySelectorAll('.chart-x span').length, 3);
});

test('the tooltip reads the time, the rate and the move since the range began', async t => {
  const {w, el, draw} = await popup(t);
  draw(wave);
  const svg = el('chart').querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0, width: 384, height: 132});
  // Sample 2 of 6 sits at x = 340 * 8 / 20 = 136.
  el('chart').querySelector('.chart-hit').dispatchEvent(new w.MouseEvent('pointermove', {clientX: 136, clientY: 20}));
  const tip = el('chart').querySelector('.chart-tip');
  assert.ok(tip.classList.contains('is-on'));
  assert.match(tip.querySelector('b').textContent, /7\.2000/);
  assert.equal(tip.querySelector('em').textContent, '+1.41%');
  assert.equal(tip.querySelector('em').className, 'positive');
  // The high is near the top, so the tip opens below it instead of over the tabs.
  assert.ok(tip.classList.contains('below'));
});

test('range tabs use readable, localized labels', async t => {
  const {el} = await popup(t);
  const labels = [...el('range-buttons').querySelectorAll('button')].map(button => button.textContent);
  assert.deepEqual(labels, ['24小时', '7天', '1个月', '3个月', '1年']);
});
