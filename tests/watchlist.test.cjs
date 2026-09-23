const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The watchlist holds saved pairs of any two currencies the picker offers,
   not just the three the collector quotes. A row shows the pair's rate and
   switches the picker to it; official-only rates are fetched when the panel
   opens, never while it is closed. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const response = data => ({ok: true, json: async () => data});
const market = {base_currency: 'USD', quote_currency: 'CNY', midpoint: 7.1, bid: 7.09, ask: 7.11,
  provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false, change_percent: '0.1'};
const official = rate => [{base_currency: 'USD', quote_currency: 'SGD', rate, institution: 'European Central Bank',
  reference_date: new Date().toISOString().slice(0, 10), is_derived: true}];

async function popup(t, stored = {}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, urls = [];
  const state = {watchlist: ['USD/CNY'], targets: {}, converterFrom: 'USD', converterTo: 'CNY', ...stored};
  w.chrome = {storage: {local: {get: async d => ({...d, ...state}), set: async v => Object.assign(state, v)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => {
    urls.push(url);
    if (url.endsWith('/pairs')) return response(['USD/CNY']);
    if (url.endsWith('/rates')) return response([market]);
    if (url.endsWith('/currencies')) return response({market_pairs: ['USD/CNY'], official_currencies: ['CNY', 'EUR', 'SGD', 'USD']});
    if (url.includes('/official-rates/USD/SGD')) return response(official('1.3421'));
    if (url.includes('/official-rates/')) return response([]);
    return response([]);
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick();
  const el = id => w.document.getElementById(id);
  const rows = () => [...el('watchlist-options').querySelectorAll('.watch-item')].map(row => ({
    pair: row.querySelector('.watch-open span:first-child').textContent,
    rate: row.querySelector('.watch-rate').textContent,
    selected: row.classList.contains('selected'),
    removable: !row.querySelector('.watch-remove').disabled,
  }));
  const pick = async (from, to) => {
    el('converter-from').value = from; el('converter-from').dispatchEvent(new w.Event('change'));
    el('converter-to').value = to; el('converter-to').dispatchEvent(new w.Event('change'));
    await tick();
  };
  const openPanel = async () => {
    el('watchlist-panel').open = true;
    el('watchlist-panel').dispatchEvent(new w.Event('toggle'));
    await tick();
  };
  return {w, el, state, urls, rows, pick, openPanel};
}

test('any pair from the picker can be added, including official-only ones', async t => {
  const app = await popup(t);
  await app.pick('USD', 'SGD');
  assert.equal(app.el('watch-add').textContent, '加入自选 USD/SGD');
  app.el('watch-add').click(); await tick();

  assert.deepEqual([...app.state.watchlist], ['USD/CNY', 'USD/SGD']);
  assert.deepEqual(app.rows().map(row => row.pair), ['USD/CNY', 'USD/SGD']);
  assert.equal(app.el('watch-add').textContent, 'USD/SGD 已在自选中');
  assert.equal(app.el('watch-add').disabled, true);
});

test('rows show market quotes at once and official rates only once the panel opens', async t => {
  const app = await popup(t, {watchlist: ['USD/CNY', 'USD/SGD']});
  const officialCalls = () => app.urls.filter(url => url.includes('/official-rates/USD/SGD')).length;
  // The hero is on USD/CNY; nothing should have asked for USD/SGD yet.
  assert.equal(officialCalls(), 0);
  assert.deepEqual(app.rows().map(row => row.rate), ['7.1000', '—']);

  await app.openPanel();
  assert.ok(officialCalls() >= 1);
  assert.deepEqual(app.rows().map(row => row.rate), ['7.1000', '1.3421']);
});

test('selecting a row switches the picker to that pair', async t => {
  const app = await popup(t, {watchlist: ['USD/CNY', 'EUR/CNY']});
  assert.deepEqual(app.rows().map(row => row.selected), [true, false]);
  app.el('watchlist-options').querySelectorAll('.watch-open')[1].click(); await tick();
  assert.equal(app.el('converter-from').value, 'EUR');
  assert.equal(app.el('converter-to').value, 'CNY');
  assert.deepEqual(app.rows().map(row => row.selected), [false, true]);
});

test('pairs can be removed, but never the last one', async t => {
  const app = await popup(t, {watchlist: ['USD/CNY', 'USD/SGD']});
  assert.deepEqual(app.rows().map(row => row.removable), [true, true]);
  app.el('watchlist-options').querySelectorAll('.watch-remove')[1].click(); await tick();
  assert.deepEqual([...app.state.watchlist], ['USD/CNY']);
  // Hover conversion reads its extra currencies from this list.
  assert.deepEqual(app.rows().map(row => row.removable), [false]);
});

test('the list stops at eight pairs', async t => {
  const eight = ['USD/CNY', 'USD/EUR', 'EUR/CNY', 'CNY/EUR', 'EUR/USD', 'CNY/USD', 'SGD/USD', 'SGD/CNY'];
  const app = await popup(t, {watchlist: eight});
  await app.pick('USD', 'SGD');
  assert.equal(app.el('watch-add').disabled, true);
  assert.equal(app.el('watch-add').textContent, '自选已满（最多 8 个）');
});

test('the same currency on both sides cannot be added', async t => {
  const app = await popup(t);
  await app.pick('USD', 'USD');
  assert.equal(app.el('watch-add').disabled, true);
  assert.equal(app.el('watch-add').textContent, '请先选择两种不同的货币');
});

test('target alerts only offer pairs with market quotes', async t => {
  const app = await popup(t, {watchlist: ['USD/CNY', 'USD/SGD']});
  const offered = [...app.el('target-pair').options].map(option => option.value);
  assert.deepEqual(offered, ['USD/CNY']);
});
