const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');

/* "fx", a space, then an amount: the address bar answers on its suggestion
   line, read the way the hover card reads a page, and Enter opens the popup
   on that conversion. */

const BASE = 'https://cdn.example/api/v1';
const quote = (base_currency, quote_currency, midpoint) => ({
  base_currency, quote_currency, midpoint, bid: midpoint, ask: midpoint, provider: 'alpha_vantage',
  captured_at: new Date().toISOString(), is_stale: false,
});
const files = {
  '/meta.json': {generated_at: new Date().toISOString(), provider: 'alpha_vantage', stale_after_minutes: 360, collector: []},
  '/pairs.json': ['USD/CNY', 'USD/JPY'],
  '/rates.json': [quote('USD', 'CNY', '7.2'), quote('USD', 'JPY', '152')],
  '/official-rates/THB/CNY.json': [
    {rate: '0.21', institution: 'European Central Bank', reference_date: '2026-10-15'},
    {rate: '0.2', institution: 'Bank of Canada', reference_date: '2026-10-16'},
  ],
};
// Coinbase's table: units per US dollar.
const LIVE = {EUR: 0.9, JPY: 150, CNY: 7.1, KRW: 1400, GBP: 0.8, AUD: 1.5, CAD: 1.4, CHF: 0.9, HKD: 7.8, SGD: 1.3,
  SEK: 10.5, NOK: 10.8, DKK: 6.7, NZD: 1.6, THB: 35, MYR: 4.4, PHP: 57, INR: 84, BRL: 5.4, MXN: 18, ZAR: 18, TWD: 32};

function worker({local = {}, firefox = false} = {}) {
  const event = () => { const l = []; return {addListener: fn => l.push(fn), listeners: l}; };
  const omnibox = {defaultSuggestion: null, onInputStarted: event(), onInputChanged: event(), onInputEntered: event(),
    setDefaultSuggestion(value) { this.defaultSuggestion = value.description; }};
  const opened = [];
  const chrome = {
    storage: {local: {async get(keys) { return {...keys, ...local}; }, async set(v) { Object.assign(local, v); }, async remove() {}}, onChanged: event()},
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
    alarms: {onAlarm: event(), get: async () => undefined, create: async () => {}, clear: async () => true},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}, openPopup: async () => { opened.push(true); }},
    omnibox,
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout, Intl,
    AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => {
      vm.runInContext(source(name), context);
      if (name === 'config.js') Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: 'static'});
    }),
    fetch: async url => {
      if (url.startsWith('https://api.coinbase.com/')) {
        return {ok: true, json: async () => ({data: {currency: 'USD', rates: Object.fromEntries(Object.entries(LIVE).map(([k, v]) => [k, String(v)]))}})};
      }
      const path = url.slice(BASE.length);
      return path in files ? {ok: true, json: async () => files[path]} : {ok: false, status: 404};
    },
  });
  context.globalThis = context;
  // Firefox alone has runtime.getBrowserInfo().
  if (firefox) context.browser = {runtime: {getBrowserInfo: async () => ({name: 'Firefox'})}};
  vm.runInContext(source('background.js'), context);
  const type = async text => {
    let rows;
    omnibox.onInputChanged.listeners[0](text, value => { rows = value; });
    await new Promise(resolve => setTimeout(resolve, 40));
    return {line: omnibox.defaultSuggestion, rows: rows || []};
  };
  const enter = async text => {
    omnibox.onInputEntered.listeners[0](text, 'currentTab');
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  return {type, enter, local, opened};
}

test('the suggestion line answers "100 usd jpy" before Enter', async () => {
  const w = worker();
  const {line} = await w.type('100 usd jpy');
  assert.match(line, /^100\.00 USD ≈ <match>15,000 JPY<\/match> <dim>· Coinbase 实时中间价<\/dim>/);
  assert.match(line, /回车在弹窗中打开/);
});

test('amounts are read the way the hover card reads a page', async () => {
  const w = worker();
  // No second currency: the hover card's target, CNY by default.
  assert.match((await w.type('5万日元')).line, /^50,000 JPY ≈ <match>2,366\.67 CNY<\/match>/);
  // "¥" alone is yuan to a Chinese reader.
  assert.match((await w.type('¥26,990 to usd')).line, /^26,990\.00 CNY ≈ <match>3,801\.41 USD<\/match>/);
  // Typed in full width, with an ideographic space.
  assert.match((await w.type('ＵＳＤ１００　ｊｐｙ')).line, /^100\.00 USD ≈ <match>15,000 JPY<\/match>/);
  // Codes alone are one unit; a bare number uses the popup's pair.
  assert.match((await w.type('eur gbp')).line, /^1\.00 EUR ≈ <match>0\.89 GBP<\/match>/);
  assert.match((await w.type('2k')).line, /^2,000\.00 USD ≈ <match>14,200\.00 CNY<\/match>/);
});

test('the watchlist\'s other currencies get a line each', async () => {
  const w = worker({local: {watchlist: ['USD/CNY', 'EUR/GBP', 'USD/JPY']}});
  const {rows} = await w.type('100 usd jpy');
  assert.deepEqual(Array.from(rows, row => row.content), ['100 USD CNY', '100 USD EUR', '100 USD GBP']);
  assert.match(rows[1].description, /^100\.00 USD ≈ <match>90\.00 EUR<\/match>/);
});

test('without live rates a collected quote, then an official reference, answers', async () => {
  const w = worker({local: {liveRates: false}});
  assert.match((await w.type('100 usd jpy')).line, /^100\.00 USD ≈ <match>15,200 JPY<\/match> <dim>· 市场中间价<\/dim>/);
  // The newest reference, named in the reader's language.
  assert.match((await w.type('1000 thb cny')).line, /≈ <match>200\.00 CNY<\/match> <dim>· 官方参考价 · 加拿大央行 · 2026-10-16<\/dim>/);
  assert.equal((await w.type('100 usd vnd')).line, '暂时没有 USD/VND 的汇率');
});

test('what cannot be read says so, and nothing typed is echoed as markup', async () => {
  const w = worker();
  assert.equal((await w.type('hello <b>')).line, '没有读出金额或币种，试试 100 usd jpy');
  assert.equal((await w.type('   ')).line, '输入金额和币种，例如 100 usd jpy、¥26,990、5万日元');
});

test('Enter opens the popup on that conversion', async () => {
  const w = worker();
  await w.enter('26,990 jpy cny');
  assert.equal(w.local.converterFrom, 'JPY');
  assert.equal(w.local.converterTo, 'CNY');
  assert.deepEqual({...w.local.converterAmount}, {value: '26,990', side: 'from'});
  assert.equal(w.opened.length, 1);
  await w.enter('nonsense');
  assert.equal(w.opened.length, 1, 'nothing to open');
});

test('Firefox shows suggestions as plain text, so they carry no markup', async () => {
  const w = worker({firefox: true});
  const {line, rows} = await w.type('100 usd jpy & more');
  assert.equal(line, '100.00 USD ≈ 15,000 JPY · Coinbase 实时中间价 · 回车在弹窗中打开');
  assert.equal(rows.length, 0);
  assert.equal((await w.type('<b>')).line, '没有读出金额或币种，试试 100 usd jpy');
});
