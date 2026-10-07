const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Selecting a price converts it, as Currency Converter Pro and similar
   extensions do: the selection is read on its own, and a double-click that
   picks only the figure of a split price ("26,990" beside "¥") is read where
   it sits. The card stays while the selection does. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (base_currency, quote_currency, midpoint) => ({base_currency, quote_currency, midpoint,
  bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: '2026-10-07T07:39:40Z', is_stale: false});
const snapshot = {pairs: ['USD/CNY', 'USD/JPY', 'CNY/JPY'], offline: false,
  rates: [quote('USD', 'CNY', '7.1'), quote('USD', 'JPY', '150'), quote('CNY', 'JPY', '23.51135')]};
const BOX = {left: 10, right: 100, top: 10, bottom: 30, width: 90, height: 20};
const money = (value, digits = 2) => value.toLocaleString('zh-CN', {minimumFractionDigits: digits, maximumFractionDigits: digits});

async function page(t, {html, url = 'https://www.amazon.co.jp/', lang = 'ja', enabled = true}) {
  const dom = new JSDOM(`<!doctype html><html lang="${lang}"><body>${html}</body></html>`, {runScripts: 'outside-only', url});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  const local = {hoverEnabled: enabled, hoverTarget: 'CNY', hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY']};
  w.chrome = {
    runtime: {getURL: path => path, sendMessage: async message => {
      if (message.type === 'FX_SNAPSHOT') return {ok: true, data: snapshot};
      if (message.type === 'FX_OFFICIAL') return {ok: true, data: []};
      return {ok: false};
    }},
    storage: {local: {
      get: async keys => keys === null ? {...local} : typeof keys === 'string' ? {} : {...keys, ...local},
      set: async values => { Object.assign(local, values); }, remove: async () => {},
    }, onChanged: {addListener() {}}},
  };
  w.Element.prototype.checkVisibility = function () {
    for (let el = this; el; el = el.parentElement) if (w.getComputedStyle(el).opacity === '0') return false;
    return true;
  };
  const createRange = d.createRange.bind(d);
  d.createRange = () => {
    const range = createRange();
    range.getBoundingClientRect = () => BOX;
    range.getClientRects = () => [BOX];
    return range;
  };
  let shadow;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) {
    const root = attach.call(this, options);
    if (this.id === 'fx-pulse-unified-hover') shadow = root;
    return root;
  };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === 'fx-pulse-unified-hover' ? {width: 300, height: 260, left: 0, top: 0, right: 300, bottom: 260} : {width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0};
  };
  for (const name of ['messages.js', 'amount-parser.js', 'hover.js']) w.eval(source(name));
  await tick();
  const select = async (node, from = 0, to = node.data.length) => {
    const range = d.createRange();
    range.setStart(node, from); range.setEnd(node, to);
    const selection = d.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    d.body.dispatchEvent(new w.MouseEvent('mouseup', {bubbles: true}));
    await tick(300);
  };
  const text = selector => d.querySelector(selector).firstChild;
  const amount = () => shadow?.querySelector('.amount')?.textContent;
  const visible = () => d.getElementById('fx-pulse-unified-hover')?.style.display === 'block';
  return {w, d, select, text, amount, visible};
}

test('a selected price opens the card', async t => {
  const app = await page(t, {html: '<p>価格 <span id="price">¥26,990</span> 税込</p>'});
  await app.select(app.text('#price'));
  assert.equal(app.amount(), `≈ ${money(26990 / 23.51135)} CNY`);
  assert.ok(app.visible());
});

test('a double-click that picks only the figure of a split price is read in place', async t => {
  const html = '<span class="a-price"><span class="a-offscreen" style="position:absolute;opacity:0">¥26,990</span>' +
    '<span aria-hidden="true"><span class="a-price-symbol">¥</span><span class="a-price-whole">26,990</span></span></span>';
  const app = await page(t, {html});
  await app.select(app.text('.a-price-whole'));
  assert.equal(app.amount(), `≈ ${money(26990 / 23.51135)} CNY`);
});

test('words, two prices, form fields and a switched-off hover open nothing', async t => {
  const words = await page(t, {html: '<p id="p">Free returns within thirty days</p>'});
  await words.select(words.text('#p'));
  assert.equal(words.visible(), false);

  const two = await page(t, {html: '<p id="p">$10 or $20</p>', url: 'https://shop.example/', lang: 'en'});
  await two.select(two.text('#p'));
  assert.equal(two.visible(), false);

  const field = await page(t, {html: '<textarea id="note">¥26,990</textarea>'});
  await field.select(field.text('#note'));
  assert.equal(field.visible(), false);

  const off = await page(t, {html: '<span id="price">¥26,990</span>', enabled: false});
  await off.select(off.text('#price'));
  assert.equal(off.visible(), false);
});

test('the card stays while the pointer moves and goes with the selection', async t => {
  const app = await page(t, {html: '<p>価格 <span id="price">¥26,990</span></p><p id="elsewhere">送料無料</p>'});
  await app.select(app.text('#price'));
  assert.ok(app.visible());
  app.d.getElementById('elsewhere').dispatchEvent(new app.w.MouseEvent('mousemove', {bubbles: true, clientX: 200, clientY: 200}));
  await tick(700);
  assert.ok(app.visible(), 'moving away does not close a card the reader asked for');
  app.d.getSelection().removeAllRanges();
  app.d.dispatchEvent(new app.w.Event('selectionchange'));
  assert.equal(app.visible(), false);
});
