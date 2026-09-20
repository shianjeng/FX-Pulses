const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const source = readFileSync(join(__dirname, '../userscript/fx-pulse-hover.user.js'), 'utf8');
const fx = require('../userscript/fx-pulse-hover.user.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function harness(t, {fail = false} = {}) {
  const dom = new JSDOM('<body><span>$10</span></body>', {url: 'https://example.com', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window;
  let now = Date.now(), count = 0, midpoint = 7, bad = fail, shadow;
  const store = new Map();
  w.Date.now = () => now;
  w.GM_getValue = (key, fallback) => store.has(key) ? JSON.parse(store.get(key)) : fallback;
  w.GM_setValue = (key, value) => store.set(key, JSON.stringify(value));
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  w.fetch = async () => {
    count++;
    if (bad) throw new Error('offline');
    return {ok: true, text: async () => JSON.stringify({rates: {USD: 1, CNY: midpoint, JPY: 150}, time_last_update_utc: '2026-09-20'})};
  };
  // Test-only closure access: the shipped script has no page-accessible API.
  w.eval(source.replace('function publishApi() {', `function publishApi() {
    globalThis.testHarness = api;
    globalThis.testCopy = copyCurrent;
    globalThis.testShow = function () { showCard(10, 10, {match: parseText('$10', {}), rect: {left: 10, top: 10, bottom: 30}, element: document.body}); };
  `));
  await tick();
  return {w, api: w.testHarness, shadow: () => shadow, count: () => count,
    advance: minutes => { now += minutes * 60000; }, price: value => { midpoint = value; }, fail: value => { bad = value; }};
}

test('hover rejects negative and accounting amounts instead of quoting them as positive', () => {
  for (const text of ['-$10', '−10 USD', '- 100元', '($10)', '$-10', 'USD -10']) {
    assert.equal(fx.parseAll(text, {}).accepted.length, 0, text);
  }
  assert.equal(fx.parseAll('$10', {}).accepted[0].amount, 10);
  assert.equal(fx.convertAmount({USD: 1, CNY: 7}, -10, 'USD', 'CNY'), null);
});

test('hover refreshes expired cache when returning to the page and coalesces requests', async t => {
  const h = await harness(t);
  Object.defineProperty(h.w.document, 'visibilityState', {value: 'visible'});
  assert.equal(h.count(), 1);
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
  assert.equal(h.count(), 1);
  h.advance(31); h.price(8);
  for (let i = 0; i < 3; i++) h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  await tick(); assert.equal(h.count(), 2); assert.equal(h.api.rates().table.CNY, 8);
});

test('hover failed refresh keeps stale cache, retries with backoff and recovers', async t => {
  const h = await harness(t);
  Object.defineProperty(h.w.document, 'visibilityState', {value: 'visible'});
  h.advance(31); h.fail(true);
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
  assert.equal(h.api.rates().stale, true); assert.equal(h.api.rates().table.CNY, 7);
  const failedCount = h.count();
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
  assert.equal(h.count(), failedCount);
  h.advance(2); h.fail(false); h.price(8);
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); await tick();
  assert.equal(h.api.rates().stale, false); assert.equal(h.api.rates().table.CNY, 8);
});

test('hover initial outage never substitutes a hardcoded example quote', async t => {
  const h = await harness(t, {fail: true});
  assert.equal(h.api.rates().table, null);
  assert.equal(h.api.convert(10, 'USD', 'CNY'), null);
});

test('hover does not expose mutable state and copies of rates cannot mutate conversions', async t => {
  const h = await harness(t);
  assert.equal(h.w.__fxph, undefined);
  assert.equal(h.w.document.getElementById('fxph-host').shadowRoot, null);
  h.api.rates().table.CNY = 999;
  assert.equal(h.api.convert(10, 'USD', 'CNY'), 70);
  assert.doesNotMatch(source, /@grant\s+unsafeWindow/);
});

test('hover rejects malformed upstream tables instead of replacing valid cache', async t => {
  const h = await harness(t); h.price(-1);
  await h.api.refresh();
  assert.equal(h.api.rates().table.CNY, 7);
  assert.equal(h.api.rates().stale, true);
});

test('small hover cards retain currency calibration in embedded CSS', async t => {
  const h = await harness(t);
  const css = h.shadow().querySelector('#fxph-theme').textContent;
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  assert.equal(blocks.some(([, selector, rule]) => selector.includes('data-size="s"') && /origin-select|target-select/.test(selector) && /display\s*:\s*none/.test(rule)), false);
});

test('hover checks TTL on a fresh hover and offers manual copy after clipboard denial', async t => {
  const h = await harness(t);
  h.advance(31); h.price(8); h.w.testShow(); await tick();
  assert.equal(h.api.rates().table.CNY, 8);
  h.w.navigator.clipboard = {writeText: async () => { throw new Error('denied'); }};
  h.w.testCopy(); await tick();
  const fallback = h.shadow().querySelector('[data-part="copy-fallback"]');
  assert.ok(fallback); assert.match(fallback.value, /80\.00/); assert.equal(fallback.readOnly, true);
});
