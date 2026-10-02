const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Which official reference converts a pair that several institutions publish.
   "Newest wins" handed Monday mornings to the People's Bank of China, whose
   administered fixing sat 0.3-0.4% from the market, so the choice ranks by
   measured accuracy and lets freshness decide only within four days. The popup
   and the in-page card must land on the same reference, so every case runs
   through both. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
// The result box as it reads: its figure and the currency code beside it, or "—" while it is empty.
const shown = box => box.value ? `${box.value} ${box.parentElement.querySelector('.amount-code').textContent}` : '—';
const row = (institution, reference_date, rate, extra = {}) => ({institution, reference_date, rate, ...extra});

async function popup(t, rows) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = {watchlist: ['USD/CNY'], targets: {}, apiUrl: 'https://api.invalid', viewMode: 'detail', converterFrom: 'USD', converterTo: 'SGD'};
  w.chrome = {storage: {local: {get: async defaults => ({...defaults, ...state}), set: async values => Object.assign(state, values)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => ({ok: true, json: async () => {
    if (url.endsWith('/currencies')) return {official_currencies: ['CNY', 'SGD', 'USD']};
    if (url.includes('/official-rates/USD/SGD')) return rows;
    if (url.includes('/official-rates/')) return [];
    if (url.endsWith('/pairs')) return ['USD/CNY'];
    if (url.includes('history')) return [];
    if (url.includes('comparisons')) return {official: []};
    return [{base_currency: 'USD', quote_currency: 'CNY', midpoint: '7.12', bid: '7.119', ask: '7.121', provider: 'mock',
      change_percent: null, captured_at: '2026-09-28T00:00:00Z', is_stale: false}];
  }});
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick(60);
  const el = id => w.document.getElementById(id);
  return {converted: shown(el('converted')), status: el('converter-status').textContent};
}

async function hover(t, rows) {
  const dom = new JSDOM('<body><span id="price">$10</span></body>', {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const local = {hoverEnabled: true, hoverTarget: 'SGD', hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY']};
  w.chrome = {
    runtime: {getURL: path => path, sendMessage: async message => {
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: {pairs: ['USD/CNY'], offline: false, rates: []}};
      if (message.type === 'FX_OFFICIAL') return {ok: true, data: message.path === '/official-rates/USD/SGD' ? rows : []};
      return {ok: false};
    }},
    storage: {local: {get: async keys => keys === null ? {...local} : typeof keys === 'string' ? {[keys]: local[keys]} : {...keys, ...local},
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
  return {amount: shadow.querySelector('.amount').textContent, foot: shadow.querySelector('.foot').textContent};
}

async function bothChoose(t, rows, {popupAmount, hoverAmount, date}) {
  const [p, h] = await Promise.all([popup(t, rows), hover(t, rows)]);
  assert.equal(p.converted, popupAmount, `popup: ${p.status}`);
  assert.match(p.status, new RegExp(date));
  assert.equal(h.amount, hoverAmount, `hover: ${h.foot}`);
}

test('a Monday PBOC fixing does not displace Friday\'s ECB and Bank of Canada references', async t => {
  await bothChoose(t, [
    row("People's Bank of China", '2026-09-28', '1.3600'),
    row('Federal Reserve Board', '2026-09-18', '1.3500'),
    row('Bank of Canada', '2026-09-24', '1.3425'),
    row('European Central Bank', '2026-09-25', '1.3421'),
  ], {popupAmount: '1,342.10 SGD', hoverAmount: '≈ 13.42 SGD', date: '2026-09-25'});
});

test('a reference more than four days behind the newest gives way', async t => {
  await bothChoose(t, [
    row('European Central Bank', '2026-09-22', '1.3421'),
    row("People's Bank of China", '2026-09-28', '1.3600'),
  ], {popupAmount: '1,360.00 SGD', hoverAmount: '≈ 13.60 SGD', date: '2026-09-28'});
});

test('a direct reference beats a bridge, and an unknown institution sits mid-table', async t => {
  await bothChoose(t, [
    row('Bank of Canada / European Central Bank', '2026-09-25', '1.3000', {via_currency: 'EUR', is_derived: true}),
    row('Monetary Authority of Singapore', '2026-09-25', '1.3450'),
    row('Federal Reserve Board', '2026-09-25', '1.3500'),
  ], {popupAmount: '1,350.00 SGD', hoverAmount: '≈ 13.50 SGD', date: '2026-09-25'});
  await bothChoose(t, [
    row('Bank of Canada / European Central Bank', '2026-09-25', '1.3000', {via_currency: 'EUR', is_derived: true}),
    row('Monetary Authority of Singapore', '2026-09-25', '1.3450'),
  ], {popupAmount: '1,345.00 SGD', hoverAmount: '≈ 13.45 SGD', date: '2026-09-25'});
});

test('with a single source, age alone never discards it', async t => {
  await bothChoose(t, [row('Federal Reserve Board', '2026-09-11', '1.3500')],
    {popupAmount: '1,350.00 SGD', hoverAmount: '≈ 13.50 SGD', date: '2026-09-11'});
});
