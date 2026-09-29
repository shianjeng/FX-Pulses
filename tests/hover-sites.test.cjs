const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Shops that draw a price in pieces. Amazon writes "¥" and "26,990" in two
   spans next to a hidden copy for screen readers, amazon.com splits "$29.99"
   four ways, and Mercari lays the price over the thumbnail with pointer
   events switched off, so the pointer "lands" on the image. The markup below
   is what those pages served on 30 September 2026. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (base_currency, quote_currency, midpoint) => ({base_currency, quote_currency, midpoint,
  bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: '2026-09-30T07:39:40Z', is_stale: false});
const snapshot = {pairs: ['USD/CNY', 'USD/JPY', 'CNY/JPY'], offline: false,
  rates: [quote('USD', 'CNY', '7.1'), quote('USD', 'JPY', '150'), quote('CNY', 'JPY', '23.51135')]};
const BOX = {left: 10, right: 100, top: 10, bottom: 30};
const money = (value, digits = 2) => value.toLocaleString('zh-CN', {minimumFractionDigits: digits, maximumFractionDigits: digits});

/* `at(document)` returns what the browser's hit testing reports at the pointer:
   {element} for elementFromPoint and {node, offset} for the caret. */
async function page(t, {html, url, lang = 'ja', target = 'CNY', at, setup}) {
  const dom = new JSDOM(`<!doctype html><html lang="${lang}"><body>${html}</body></html>`, {runScripts: 'outside-only', url});
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  const local = {hoverEnabled: true, hoverTarget: target, hoverSize: 'm', hoverMode: 'simple', language: 'zh', watchlist: ['USD/CNY']};
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
  // Opacity is the only style these pages use to hide their copies; JSDOM has no checkVisibility.
  w.Element.prototype.checkVisibility = function () {
    for (let el = this; el; el = el.parentElement) if (w.getComputedStyle(el).opacity === '0') return false;
    return true;
  };
  setup?.(w);
  const hit = at(d);
  d.elementFromPoint = () => hit.element;
  d.caretRangeFromPoint = () => ({startContainer: hit.node ?? hit.element, startOffset: hit.offset ?? 0});
  const createRange = d.createRange.bind(d);
  d.createRange = () => {
    const range = createRange();
    range.getBoundingClientRect = () => BOX;
    range.getClientRects = () => (hit.drawn ? hit.drawn(range) : true) ? [BOX] : [];
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
  const hover = async (from = hit.node?.parentElement ?? hit.element) => {
    from.dispatchEvent(new w.MouseEvent('mousemove', {bubbles: true, clientX: 15, clientY: 15}));
    await tick(300);
  };
  const card = () => shadow?.querySelector('.card');
  const amount = () => shadow?.querySelector('.amount')?.textContent;
  const visible = () => d.getElementById('fx-pulse-unified-hover')?.style.display === 'block';
  return {w, d, hover, card, amount, visible};
}

const text = (d, selector) => d.querySelector(selector).firstChild;

test('Amazon Japan: "¥" and "26,990" in separate spans, beside a hidden copy', async t => {
  const html = '<span class="a-price"><span class="a-offscreen" style="position:absolute;opacity:0">¥26,990</span>' +
    '<span aria-hidden="true"><span class="a-price-symbol">¥</span><span class="a-price-whole">26,990</span></span></span>';
  for (const selector of ['.a-price-whole', '.a-price-symbol']) {
    const app = await page(t, {html, url: 'https://www.amazon.co.jp/s?k=x', at: d => ({element: d.querySelector(selector), node: text(d, selector), offset: 1})});
    await app.hover();
    assert.equal(app.amount(), `≈ ${money(26990 / 23.51135)} CNY`, selector);
    assert.match(app.card().textContent, /¥26,990 · JPY/);
  }
});

test('amazon.com: "$", "29", "." and "99" read as one price', async t => {
  const html = '<span class="a-price"><span class="a-offscreen" style="opacity:0">$29.99</span><span aria-hidden="true">' +
    '<span class="a-price-symbol">$</span><span class="a-price-whole">29<span class="a-price-decimal">.</span></span>' +
    '<span class="a-price-fraction">99</span></span></span>';
  const app = await page(t, {html, url: 'https://www.amazon.com/s?k=x', lang: 'en-US',
    at: d => ({element: d.querySelector('.a-price-fraction'), node: text(d, '.a-price-fraction'), offset: 1})});
  await app.hover();
  assert.equal(app.amount(), `≈ ${money(29.99 * 7.1)} CNY`);
});

test('a hidden copy inside the same box is not read twice', async t => {
  const html = '<span class="p-price"><span style="opacity:0">¥99.00</span><em>¥</em><i>1,200.00</i></span>';
  const app = await page(t, {html, url: 'https://item.jd.com/1.html', lang: 'zh-CN', target: 'JPY',
    at: d => ({element: d.querySelector('i'), node: text(d, 'i'), offset: 2})});
  await app.hover();
  assert.equal(app.amount(), `≈ ${money(1200 * 23.51135, 0)} JPY`);
});

test('a bare number is never paired with a currency from further away', async t => {
  const html = '<div><span>¥</span><p>Sold <b>2,000</b> units this week to customers in many countries around the world, ' +
    'shipped from warehouses in several regions with tracking on every parcel and a thirty day return policy.</p></div>';
  const app = await page(t, {html, url: 'https://shop.example/', at: d => ({element: d.querySelector('b'), node: text(d, 'b'), offset: 1})});
  await app.hover();
  assert.equal(app.card(), undefined);
});

test('Mercari: a price tag that takes no pointer events, over the thumbnail', async t => {
  const html = '<figure><img id="thumb" alt=""><div class="overlay" style="pointer-events:none">' +
    '<span class="merPrice"><span class="currency">¥</span><span class="number">1,980</span></span></div></figure>';
  const app = await page(t, {html, url: 'https://jp.mercari.com/search?keyword=x',
    // Hit testing finds the image; only the number's glyphs are drawn at the pointer.
    at: d => ({element: d.getElementById('thumb'), node: null, drawn: range => range.startContainer === text(d, '.number')})});
  await app.hover(app.d.getElementById('thumb'));
  assert.equal(app.amount(), `≈ ${money(1980 / 23.51135)} CNY`);
});

test('a web component\'s open shadow root is read too', async t => {
  let root, number;
  const app = await page(t, {html: '<mer-price id="price"></mer-price>', url: 'https://shop.example/',
    setup: w => {
      const element = w.document.getElementById('price');
      root = element.attachShadow({mode: 'open'});
      root.innerHTML = '<span class="currency">¥</span><span class="number">2,000</span>';
      number = root.querySelector('.number');
      root.elementFromPoint = () => number;
      w.document.caretPositionFromPoint = (x, y, options) =>
        options?.shadowRoots?.includes(root) ? {offsetNode: number.firstChild, offset: 1} : null;
    },
    at: d => ({element: d.getElementById('price'), node: null})});
  await app.hover(app.d.getElementById('price'));
  assert.equal(app.amount(), `≈ ${money(2000 / 23.51135)} CNY`);
});

test('a page that stops mousemove from bubbling cannot switch hover off', async t => {
  const html = '<div id="widget"><span id="price">¥2,000</span></div>';
  const app = await page(t, {html, url: 'https://www.amazon.co.jp/dp/X',
    setup: w => w.document.getElementById('widget').addEventListener('mousemove', event => event.stopPropagation()),
    at: d => ({element: d.getElementById('price'), node: text(d, '#price'), offset: 2})});
  await app.hover();
  assert.equal(app.amount(), `≈ ${money(2000 / 23.51135)} CNY`);
});

test('only a scroll that moves the amount closes the card', async t => {
  const html = '<div id="carousel"><span>ad</span></div><span id="price">¥2,000</span>';
  const app = await page(t, {html, url: 'https://www.amazon.co.jp/', at: d => ({element: d.getElementById('price'), node: text(d, '#price'), offset: 2})});
  await app.hover();
  assert.ok(app.visible());
  // An auto-rotating carousel elsewhere on the page.
  app.d.getElementById('carousel').dispatchEvent(new app.w.Event('scroll'));
  assert.ok(app.visible(), 'a carousel scrolling elsewhere left the card alone');
  app.d.dispatchEvent(new app.w.Event('scroll'));
  assert.ok(!app.visible(), 'scrolling the page closes it');
});
