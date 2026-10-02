const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* How numbers and sources read: money in each currency's own minor unit in
   both the popup and the in-page card, small amounts that do not collapse to
   0.00, institutions named in the reader's language (bridges included), a
   same-currency hover that answers 1:1, and a status line that says how old
   the quote is. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
// The result box as it reads: its figure and the currency code beside it, or "—" while it is empty.
const shown = box => box.value ? `${box.value} ${box.parentElement.querySelector('.amount-code').textContent}` : '—';
const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
const market = (base_currency, quote_currency, midpoint, captured_at = hoursAgo(3)) => ({base_currency, quote_currency,
  midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at, change_percent: null, is_stale: false});
const RATES = [market('USD', 'CNY', '6.69691655'), market('USD', 'JPY', '157.43124392')];

async function popup(t, {from, to, amount, official = {}}) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = {watchlist: ['USD/CNY'], targets: {}, apiUrl: 'https://api.invalid', viewMode: 'simple', converterFrom: from, converterTo: to};
  w.chrome = {storage: {local: {get: async defaults => ({...defaults, ...state}), set: async values => Object.assign(state, values)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => ({ok: true, json: async () => {
    if (url.endsWith('/currencies')) return {official_currencies: ['CNY', 'JPY', 'KRW', 'SGD', 'USD']};
    const path = url.slice('https://api.invalid'.length);
    if (path.startsWith('/official-rates/')) return official[path] || [];
    if (url.endsWith('/pairs')) return ['USD/CNY', 'USD/JPY'];
    return RATES;
  }});
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick(60);
  const el = id => w.document.getElementById(id);
  if (amount !== undefined) { el('amount').value = amount; el('amount').dispatchEvent(new w.Event('input')); }
  return {converted: shown(el('converted')), status: el('status').textContent};
}

async function hover(t, {text, target, official = {}}) {
  const dom = new JSDOM(`<body><span id="price">${text}</span></body>`, {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const local = {hoverEnabled: true, hoverTarget: target, hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY']};
  w.chrome = {
    runtime: {getURL: path => path, sendMessage: async message => {
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: {pairs: ['USD/CNY', 'USD/JPY'], offline: false, rates: RATES}};
      if (message.type === 'FX_OFFICIAL') return {ok: true, data: official[message.path] || []};
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

test('the popup shows yen without decimals and keeps a small amount readable', async t => {
  assert.equal((await popup(t, {from: 'USD', to: 'JPY'})).converted, '157,431 JPY');
  assert.equal((await popup(t, {from: 'USD', to: 'CNY'})).converted, '6,696.92 CNY');
  const won = await popup(t, {from: 'KRW', to: 'USD', amount: '1', official: {
    '/official-rates/KRW/USD': [{rate: '0.000724', institution: 'European Central Bank', reference_date: '2026-09-29'}]}});
  assert.equal(won.converted, '0.00072 USD');
});

test('the popup says how old the quote is', async t => {
  const {status} = await popup(t, {from: 'USD', to: 'CNY'});
  assert.match(status, /（3小时前）/);
});

test('a bridged official reference names both institutions in the reader\'s language', async t => {
  const {status} = await popup(t, {from: 'SGD', to: 'KRW', official: {'/official-rates/SGD/KRW': [{
    rate: '1080.5', institution: 'Bank of Canada + Federal Reserve Board', reference_date: '2026-09-25', via_currency: 'USD', is_derived: true}]}});
  assert.match(status, /加拿大央行 \+ 美国联邦储备委员会/);
  assert.doesNotMatch(status, /Bank of Canada/);
});

test('the hover card names the institution in the reader\'s language', async t => {
  const card = await hover(t, {text: '$10', target: 'SGD', official: {
    '/official-rates/USD/SGD': [{rate: '1.2773', institution: 'European Central Bank', reference_date: '2026-09-29'}]}});
  assert.equal(card.amount, '≈ 12.77 SGD');
  assert.match(card.meta, /欧洲央行 · 2026-09-29/);
});

test('the hover card keeps a small amount readable', async t => {
  const card = await hover(t, {text: '₩1', target: 'USD', official: {
    '/official-rates/KRW/USD': [{rate: '0.000724', institution: 'European Central Bank', reference_date: '2026-09-29'}]}});
  assert.equal(card.amount, '≈ 0.00072 USD');
});

test('a currency converted into itself reads 1:1 instead of "not collected"', async t => {
  const card = await hover(t, {text: '₩5,000', target: 'KRW'});
  assert.equal(card.amount, '≈ 5,000 KRW');
  assert.match(card.meta, /同币种换算/);
});
