const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The in-page card: money in the currency's own minor unit, rates on the
   popup's rule, a correction offered only when the guess is uncertain, a card
   that never covers the amount, and detail rows for official-only currencies. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (base_currency, quote_currency, midpoint) => ({base_currency, quote_currency, midpoint,
  bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: '2026-09-23T07:39:40Z', is_stale: false});
const snapshot = {pairs: ['USD/CNY', 'USD/JPY', 'CNY/JPY'], offline: false,
  rates: [quote('USD', 'CNY', '7.1'), quote('USD', 'JPY', '150'), quote('CNY', 'JPY', '23.51135')]};

async function page(t, {text, settings = {}, official = {}, coverage = null, rect = {left: 10, right: 100, top: 10, bottom: 30}, innerHeight}) {
  const dom = new JSDOM('<body><span id="price"></span></body>', {runScripts: 'outside-only', url: 'https://example.com'});
  t.after(() => dom.window.close());
  const w = dom.window, requests = [];
  const local = {hoverEnabled: true, hoverTarget: 'CNY', hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY'], ...settings};
  w.chrome = {
    runtime: {getURL: path => path, sendMessage: async message => {
      requests.push(message);
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: snapshot};
      if (message.type === 'FX_OFFICIAL') return {ok: true, data: official[message.path] || []};
      if (message.type === 'FX_CURRENCIES') return coverage ? {ok: true, data: coverage} : {ok: false};
      return {ok: true};
    }},
    storage: {local: {
      get: async keys => keys === null ? {...local} : typeof keys === 'string' ? (keys in local ? {[keys]: local[keys]} : {}) : {...keys, ...local},
      set: async values => { Object.assign(local, values); },
      remove: async keys => { for (const key of [].concat(keys)) delete local[key]; },
    }, onChanged: {addListener() {}}},
  };
  if (innerHeight) Object.defineProperty(w, 'innerHeight', {value: innerHeight, configurable: true});
  let shadow;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  // JSDOM has no layout: give the card a size so placement can be checked.
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === 'fx-pulse-unified-hover' ? {width: 300, height: 260, left: 0, top: 0, right: 300, bottom: 260} : {width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0};
  };
  const price = w.document.getElementById('price');
  price.textContent = text;
  w.document.elementFromPoint = () => price;
  w.document.caretRangeFromPoint = () => ({startContainer: price.firstChild, startOffset: 2});
  const createRange = w.document.createRange.bind(w.document);
  w.document.createRange = () => { const range = createRange(); range.getBoundingClientRect = () => rect; return range; };
  for (const name of ['messages.js', 'amount-parser.js', 'hover.js']) w.eval(source(name));
  await tick();
  price.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: rect.left + 5, clientY: rect.top + 5}));
  await tick(300);
  const card = () => shadow.querySelector('.card');
  const host = () => w.document.getElementById('fx-pulse-unified-hover');
  const rehover = async () => {
    price.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: rect.left + 5, clientY: rect.top + 5}));
    await tick(300);
  };
  return {w, local, requests, card, host, rehover, q: selector => shadow.querySelector(selector), all: selector => [...shadow.querySelectorAll(selector)]};
}

test('money uses the currency\'s own minor unit', async t => {
  const yen = await page(t, {text: '4,590円'});
  // 4,590 / 23.51135 = 195.2249...; CNY has two minor digits, not four.
  assert.equal(yen.q('.amount').textContent, '≈ 195.22 CNY');

  const toYen = await page(t, {text: '100元', settings: {hoverTarget: 'JPY'}});
  assert.equal(toYen.q('.amount').textContent, '≈ 2,351 JPY');

  const toWon = await page(t, {text: '$10', settings: {hoverTarget: 'KRW', watchlist: ['USD/KRW']},
    official: {'/official-rates/USD/KRW': [{rate: '1380.5', institution: 'European Central Bank', reference_date: '2026-09-23'}]}});
  assert.equal(toWon.q('.amount').textContent, '≈ 13,805 KRW');
});

test('the unit rate reads like the popup and the time stops at minutes', async t => {
  const app = await page(t, {text: '4,590円'});
  assert.equal(app.q('.rate').textContent, '1 JPY = 0.042533 CNY');
  const meta = app.q('.meta').textContent;
  assert.match(meta, /市场中间价/);
  assert.doesNotMatch(meta, /\d{1,2}:\d{2}:\d{2}/, 'no seconds');
});

test('a confident guess is not second-guessed', async t => {
  const app = await page(t, {text: '4,590円'});
  assert.equal(app.all('.chip').length, 0);
  assert.doesNotMatch(app.card().textContent, /可手动校准/);
});

test('an uncertain guess offers its alternatives, and a choice sticks', async t => {
  const app = await page(t, {text: '¥100', settings: {hoverTarget: 'USD'}});
  const chips = app.all('.chip').map(chip => chip.textContent);
  assert.ok(chips.length >= 1, 'alternatives offered');
  const other = chips[0];
  app.all('.chip')[0].click(); await tick(60);
  assert.equal(app.q('select').value, other);
  assert.equal(app.all('.chip').length, 0, 'no more nagging after a choice');
  assert.equal(app.local['hoverMemory:example.com|¥'].code, other);
});

test('the card opens above the amount when it would not fit below', async t => {
  const low = await page(t, {text: '4,590円', innerHeight: 400, rect: {left: 10, right: 100, top: 350, bottom: 370}});
  // 370 + 8 + 260 would pass the bottom edge; above: 350 - 8 - 260 = 82.
  assert.equal(low.host().style.top, '82px');
  const high = await page(t, {text: '4,590円', innerHeight: 800, rect: {left: 10, right: 100, top: 10, bottom: 30}});
  assert.equal(high.host().style.top, '38px');
});

test('detail rows include official-only currencies from the watchlist', async t => {
  const app = await page(t, {text: '$10', settings: {hoverMode: 'detail', watchlist: ['USD/CNY', 'USD/SGD']},
    official: {'/official-rates/USD/SGD': [{rate: '1.3421', institution: 'European Central Bank', reference_date: '2026-09-23'}]}});
  await tick(60);
  assert.ok(app.requests.some(message => message.path === '/official-rates/USD/SGD'));
  const rows = app.all('.detail').map(row => row.textContent);
  assert.ok(rows.includes('SGD13.42'), rows.join(' | '));
});

test('the settings page offers every covered currency and keeps the saved one', async t => {
  const dom = new JSDOM(source('options.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  w.chrome = {storage: {local: {get: async d => ({...d, hoverTarget: 'SGD'}), set: async () => {}}},
    permissions: {request: async () => true},
    runtime: {sendMessage: async message => message.path === '/currencies'
      ? {ok: true, data: {market_pairs: ['USD/CNY'], official_currencies: ['EUR', 'KRW', 'SGD']}} : {ok: false}}};
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'options.js']) w.eval(source(name));
  await tick(80);
  const select = w.document.getElementById('hoverTarget');
  assert.deepEqual([...select.options].map(option => option.value), ['CNY', 'EUR', 'KRW', 'SGD', 'USD']);
  assert.equal(select.value, 'SGD');
});

test('both pickers list every covered currency, asked for once per page', async t => {
  const covered = ['AUD', 'CNY', 'EUR', 'GBP', 'JPY', 'KRW', 'SGD', 'USD'];
  const app = await page(t, {text: '4,590円', coverage: {market_pairs: ['USD/CNY', 'USD/JPY', 'CNY/JPY'], official_currencies: covered}});
  await tick(60);
  const [source, target] = app.all('select');
  assert.deepEqual([...source.options].map(option => option.value), covered);
  assert.deepEqual([...target.options].map(option => option.value), covered);
  assert.equal(source.value, 'JPY');
  assert.equal(target.value, 'CNY');

  await app.rehover(); await app.rehover();
  assert.equal(app.requests.filter(message => message.type === 'FX_CURRENCIES').length, 1);
});

test('without the list the pickers still offer what is known', async t => {
  const app = await page(t, {text: '4,590円'});
  const [source] = app.all('select');
  assert.deepEqual([...source.options].map(option => option.value), ['CNY', 'JPY', 'USD']);
});
