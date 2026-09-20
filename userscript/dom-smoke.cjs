/*
 * 呈现层冒烟测试（node + 极简 DOM 桩，不需要浏览器）
 *   node dom-smoke.cjs
 *
 * 它验证的是 fx-pulse-hover.user.js 里的 DOM 层：
 *   - init() 能在有 document/window 的环境下跑完不抛错
 *   - 悬停命中后卡片被渲染出来，且简单/详细两种模式各自该有的 data-part 都在
 *   - 设置面板能打开，settings 系列的 data-part 都在
 *   - 主题 CSS 注入生效、data-mode/data-size 被写入
 * 这不模拟布局与样式计算，只保证「结构契约」（THEME.md 里承诺的 data-part）不被破坏。
 */
'use strict';

/* ---------------- 极简 DOM 桩 ---------------- */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    dataset: {},
    style: { setProperty() {}, cssText: '' },
    className: '',
    textContent: '',
    title: '',
    value: '',
    checked: false,
    type: '',
    rows: 0,
    placeholder: '',
    isContentEditable: false,
    offsetWidth: 240,
    offsetHeight: 80,
    offsetLeft: 12,
    offsetTop: 34,
    parentElement: null,
    shadowRoot: null,
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    focus() {},
    insertBefore(child) { child.parentElement = this; this.children.push(child); return child; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    attachShadow() { const s = makeEl('shadow-root'); this.shadowRoot = s; return s; },
  };
  return el;
}

const documentStub = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  scripts: [],
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, data: String(t) }),
  createRange: () => ({
    setStart() {}, setEnd() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20 }; },
  }),
  elementFromPoint: () => null,
  caretRangeFromPoint: () => null,
  querySelector: () => null,
  getElementById: () => null,
  addEventListener() {},
  dispatchEvent() {},
};
documentStub.documentElement.getAttribute = (k) => (k === 'lang' ? 'zh-CN' : null);

const locationStub = { hostname: 'example.com', href: 'https://example.com/', protocol: 'https:' };

globalThis.document = documentStub;
globalThis.location = locationStub;
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
globalThis.window = {
  document: documentStub,
  location: locationStub,
  navigator: { language: 'en-US' },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
globalThis.getComputedStyle = (el) => ({ backgroundColor: el._bg || 'rgba(0, 0, 0, 0)' });
globalThis.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const timer = originalInterval(...args); timer.unref(); return timer; };
globalThis.fetch = async () => ({
  ok: true,
  text: async () => JSON.stringify({
    rates: { USD: 1, CNY: 6.6976, JPY: 150, EUR: 0.9, GBP: 0.8, HKD: 7.8, TWD: 32, KRW: 1300, SGD: 1.3, AUD: 1.5, CAD: 1.4, NZD: 1.6, SEK: 9.3, NOK: 10, DKK: 6.5, THB: 33, MYR: 4.1, PHP: 62, VND: 26000, INR: 83, BRL: 5 },
    time_last_update_utc: 'TEST-2026-09-20',
  }),
});

/* ---------------- 加载脚本（isBrowser 为真 → init() 会执行） ---------------- */
const fx = require('./fx-pulse-hover.user.js');
const api = fx.testApi;

let failures = 0;
function assert(cond, label) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failures++;
}

function partsIn(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.dataset && node.dataset.part) out.push(node.dataset.part);
  (node.children || []).forEach((c) => partsIn(c, out));
  return out;
}
function findPart(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node.dataset && node.dataset.part === name) return node;
  for (const child of node.children || []) {
    const match = findPart(child, name);
    if (match) return match;
  }
  return null;
}
function shadow() { return documentStub.body.children[0].shadowRoot; }
function card() {
  const s = shadow();
  return s ? s.children.filter((c) => c.dataset && c.dataset.part === 'card')[0] : null;
}
function analyze(text, offset, background = 'rgb(255, 255, 255)') {
  const textNode = documentStub.createTextNode(text);
  const target = makeEl('span');
  target._bg = background;
  documentStub.elementFromPoint = () => target;
  documentStub.caretRangeFromPoint = () => ({ startContainer: textNode, startOffset: offset });
  return api.detectAt(10, 10);
}

(async function run() {
  await new Promise((r) => setTimeout(r, 60));   // 等 ensureRates() 走完（桩 fetch 立即返回）

  console.log('\n[1] 注入与发布');
  assert(!globalThis.window.__fxph, '网页不能访问内部状态');
  assert(documentStub.documentElement.dataset.fxph === fx.VERSION, 'dataset.fxph = ' + fx.VERSION);
  assert(!documentStub.documentElement.dataset.fxphError, 'init() 没抛错（dataset.fxphError 为空）');
  assert(!!card(), '#fxph-host 已插入并建好 card');

  console.log('\n[2] 汇率（桩 fetch）');
  const rates = api.rates();
  assert(rates.table && rates.table.JPY === 150, '汇率表已载入：' + rates.source);

  console.log('\n[3] 简单模式渲染');
  api.set('mode', 'simple');
  const hit = analyze('价格 $1,299.00 元', 5);
  assert(hit === true, 'detectAt 命中');
  const c1 = card();
  const p1 = partsIn(c1, []);
  ['card', 'amount-main', 'amount-main-code', 'amount-origin', 'amount-origin-code',
    'origin-select', 'target-select', 'timestamp']
    .forEach((p) => assert(p1.indexOf(p) >= 0, '简单模式含 data-part=' + p));
  assert(c1.dataset.mode === 'simple', 'card[data-mode=simple]');
  assert(findPart(c1, 'rate-line').textContent.includes('6.6976'), '单位汇率保留四位精度');

  console.log('\n[3b] 两个下拉常驻（美术定稿：高置信也必须都在）');
  api.cfg.memory['example.com|円'] = 'JPY';   // 站点记忆命中 → conf = 1，无任何歧义
  assert(analyze('税込 1,000円', 5) === true, '高置信命中');
  const cHigh = card();
  assert(!!findPart(cHigh, 'origin-select'), '置信度 1.0 时原始币种下拉仍在');
  assert(!!findPart(cHigh, 'target-select'), '置信度 1.0 时目标币种下拉仍在');
  assert((cHigh.dataset.state || '').indexOf('ambiguous') < 0, '高置信不进 ambiguous 状态（下拉与状态解耦）');
  delete api.cfg.memory['example.com|円'];

  console.log('\n[4] 详细模式渲染');
  api.set('mode', 'detail');
  assert(analyze('価格 ¥12,800', 4) === true, 'detectAt 命中（¥ 歧义文本）');
  const c2 = card();
  const p2 = partsIn(c2, []);
  ['card', 'amount-main', 'amount-main-code', 'amount-origin', 'amount-origin-code',
    'multi-list', 'multi-row', 'multi-value', 'multi-code',
    'origin-select', 'target-select', 'rate-line', 'timestamp', 'parse-detail', 'actions',
    'action-settings', 'action-copy', 'action-close']
    .forEach((p) => assert(p2.indexOf(p) >= 0, '详细模式含 data-part=' + p));
  assert(c2.dataset.mode === 'detail', 'card[data-mode=detail]');
  assert(c2.dataset.size === 'm', 'card[data-size=m]（默认中档）');

  console.log('\n[5] 档位与主题');
  api.set('size', 'l');
  assert(card().dataset.size === 'l', '切到大档后 card[data-size=l]');
  api.setTheme(':host{--fxph-accent:#ffb703}');
  const themeStyle = shadow().children.filter((c) => c.id === 'fxph-theme')[0];
  assert(!!themeStyle && themeStyle.textContent.indexOf('#ffb703') >= 0, '主题 CSS 注入到 #fxph-theme');
  assert(card().dataset.mode === 'detail', '主题注入不影响模式');
  assert(themeStyle.textContent.includes('data-palette=\\"ink\\"') || themeStyle.textContent.includes('data-palette="ink"'), '内置报纸主题已注入');

  console.log('\n[5b] 网页底色识别');
  const palettes = [
    ['rgb(255, 255, 255)', 'paper'],
    ['rgb(18, 24, 30)', 'ink'],
    ['rgb(201, 230, 243)', 'marine'],
    ['rgb(214, 232, 197)', 'sage'],
    ['rgb(245, 210, 195)', 'clay'],
  ];
  for (const [background, expected] of palettes) {
    assert(analyze('¥12,800', 2, background) && documentStub.body.children[0].dataset.palette === expected,
      background + ' → ' + expected);
  }

  console.log('\n[6] 设置面板');
  api.settings();
  const panel = shadow().children.filter((c) => c.dataset && c.dataset.part === 'settings')[0];
  assert(!!panel, '设置面板已插入');
  const p3 = partsIn(panel, []);
  ['settings', 'settings-head', 'settings-row', 'settings-label', 'settings-control', 'settings-actions', 'settings-memory']
    .forEach((p) => assert(p3.indexOf(p) >= 0, '设置面板含 data-part=' + p));
  api.closeSettings();

  console.log('\n[7] 站点记忆（校准）');
  api.cfg.memory['example.com|¥'] = 'JPY';
  const r = api.parseAll('¥1,000', { host: 'example.com', lang: 'zh-CN', memory: api.cfg.memory });
  assert(r.accepted[0] && r.accepted[0].code === 'JPY', '记忆生效：¥ → JPY（' + (r.accepted[0] || {}).why + '）');
  delete api.cfg.memory['example.com|¥'];

  console.log('\n' + (failures ? 'FAILED: ' + failures + ' 项' : '全部通过'));
  if (failures) process.exitCode = 1;
})();
