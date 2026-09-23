const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The simple view is the default for people who only want the number. It must
   fold the specialist panels away without losing anything, and it must skip
   their requests rather than merely hide them: a hidden chart that still loads
   costs every popup open a history and a comparison call for nothing. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const pairs = ['USD/CNY', 'USD/JPY', 'CNY/JPY'];
const quote = {
  base_currency: 'USD', quote_currency: 'CNY', midpoint: 7.1, bid: 7.09, ask: 7.11,
  provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false,
};
const response = data => ({ok: true, json: async () => data});

async function popup(t, stored = {}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, state = {watchlist: pairs, targets: {}, ...stored}, urls = [];
  w.chrome = {storage: {local: {
    get: async defaults => ({...defaults, ...state}),
    set: async changes => Object.assign(state, changes),
  }}, runtime: {openOptionsPage() {}}};
  w.fetch = async url => {
    urls.push(url);
    if (url.endsWith('/pairs')) return response(pairs);
    if (url.endsWith('/rates')) return response([quote]);
    if (url.includes('/comparisons/')) return response({official: [{
      institution: 'European Central Bank', reference_date: new Date().toISOString().slice(0, 10),
      is_derived: true, rate: '7.05', market_deviation_percent: '0.7',
    }]});
    if (url.includes('/history')) return response([{midpoint: 7.1, captured_at: '2026-09-22T00:00:00Z'}]);
    return response([]);
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick();
  const el = id => w.document.getElementById(id);
  const asked = part => urls.some(url => url.includes(part));
  return {w, state, urls, el, asked};
}

test('a first open shows the simple view', async t => {
  const {w, el} = await popup(t);
  assert.equal(w.document.body.dataset.view, 'simple');
  assert.equal(el('view-toggle').textContent, '显示详细数据');
});

test('the simple view skips history and official requests instead of hiding them', async t => {
  const {asked} = await popup(t);
  assert.ok(asked('/rates'), 'the rates themselves are still loaded');
  assert.ok(!asked('/history'), 'no history request in the simple view');
  assert.ok(!asked('/comparisons/'), 'no comparison request in the simple view');
});

test('the converter keeps working in the simple view', async t => {
  const {w, el} = await popup(t);
  el('amount').value = '100';
  el('amount').dispatchEvent(new w.Event('input'));
  assert.match(el('converted').textContent, /710/);
});

test('switching to details loads the skipped panels and remembers the choice', async t => {
  const {w, el, state, asked} = await popup(t);
  el('view-toggle').click();
  await tick();

  assert.equal(w.document.body.dataset.view, 'detail');
  assert.equal(state.viewMode, 'detail', 'the choice persists to the next open');
  assert.equal(el('view-toggle').textContent, '精简显示');
  assert.ok(asked('/history'), 'the chart is filled once it becomes visible');
  assert.match(el('official-rates').textContent, /欧洲央行/);

  el('view-toggle').click();
  await tick();
  assert.equal(w.document.body.dataset.view, 'simple');
  assert.equal(state.viewMode, 'simple');
});

test('a stored choice of details is honoured on open', async t => {
  const {w, asked} = await popup(t, {viewMode: 'detail'});
  assert.equal(w.document.body.dataset.view, 'detail');
  assert.ok(asked('/history') && asked('/comparisons/'));
});

test('specialist content is marked for folding and the disclaimer never is', () => {
  const html = source('popup.html');
  const js = source('popup.js');
  const css = source('popup.css');
  for (const marker of ['official-panel pro-only', 'trend-panel pro-only', 'data-i18n="refreshHint"']) {
    assert.ok(html.includes(marker), `missing: ${marker}`);
  }
  assert.match(html, /class="hint pro-only" data-i18n="refreshHint"/);
  assert.match(js, /<span class="pro-only">\$\{t\("bid"\)\}/, 'bid/ask belongs to the detailed view');
  // Hiding the one line that says this is not a bank rate would be a real loss.
  assert.match(html, /<p class="hint" data-i18n="midpointDisclaimer">/);
  assert.match(css, /body\[data-view="simple"\] \.pro-only\s*\{\s*display:\s*none/);
  assert.match(css, /body\[data-view="detail"\] \.simple-only\s*\{\s*display:\s*none/);
});
