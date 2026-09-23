const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* For a pair with no market quote the hero printed "official daily reference ·
   institution · date" three times: under the title, under the rate and under
   the converter. The sentence stays in the DOM for assistive technology and
   the older assertions, but only the subtitle shows it. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const response = data => ({ok: true, json: async () => data});
const market = {base_currency: 'USD', quote_currency: 'CNY', midpoint: 7.1, bid: 7.09, ask: 7.11,
  provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false, change_percent: '0.1'};

async function popup(t, from, to) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = {watchlist: ['USD/CNY'], targets: {}, converterFrom: from, converterTo: to};
  w.chrome = {storage: {local: {get: async d => ({...d, ...state}), set: async v => Object.assign(state, v)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => url.endsWith('/pairs') ? response(['USD/CNY'])
    : url.endsWith('/rates') ? response([market])
    : url.endsWith('/currencies') ? response({market_pairs: ['USD/CNY'], official_currencies: ['CNY', 'SGD', 'USD']})
    : url.includes('/official-rates/USD/SGD') ? response([{base_currency: 'USD', quote_currency: 'SGD', rate: '1.3421',
      institution: 'European Central Bank', reference_date: '2026-09-18', is_derived: true}])
    : response([]);
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick();
  const el = id => w.document.getElementById(id);
  // Everything in the hero that is actually rendered and mentions the source.
  const shown = pattern => [el('status'), el('converter-status'), ...el('rates').querySelectorAll('small')]
    .filter(node => !node.hidden && pattern.test(node.textContent)).length;
  return {el, shown};
}

test('an official-only pair names its source once', async t => {
  const app = await popup(t, 'USD', 'SGD');
  assert.match(app.el('status').textContent, /官方日参考价.*欧洲央行/);
  assert.equal(app.shown(/官方日参考价/), 1);
});

test('a market pair keeps its separate source line under the converter', async t => {
  const app = await popup(t, 'USD', 'CNY');
  assert.equal(app.el('converter-status').hidden, false);
  assert.match(app.el('converter-status').textContent, /市场中间价/);
});
