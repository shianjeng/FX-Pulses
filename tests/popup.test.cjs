const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "..", "extension");
const html = readFileSync(join(root, "popup.html"), "utf8");
const config = readFileSync(join(root, "config.js"), "utf8");
const script = readFileSync(join(root, "popup.js"), "utf8");
const messages = readFileSync(join(root, "messages.js"), "utf8");
const i18n = readFileSync(join(root, "i18n.js"), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function setup({ clipboardFails = false, watchlist = ["USD/CNY"] } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://test.invalid" });
  const w = dom.window;
  // These tests cover the full interface, which the simple view folds away.
  const state = { watchlist, targets: {}, apiUrl: "https://api.invalid", viewMode: "detail" };
  let copied;
  w.chrome = { storage: { local: {
    get: async defaults => ({ ...defaults, ...state }),
    set: async values => Object.assign(state, values),
  } }, runtime: { openOptionsPage() {} } };
  Object.defineProperty(w.navigator, "clipboard", { value: {
    writeText: async value => {
      if (clipboardFails) throw new Error("NotAllowedError");
      copied = value;
    },
  } });
  w.fetch = async url => ({ ok: true, json: async () => {
    if (url.endsWith('/currencies')) return {official_currencies: ['EUR', 'GBP', 'USD', 'CNY', 'JPY']};
    if (url.includes('/official-rates/')) return [
      {rate: 7, institution: 'Bank of Canada', reference_date: '2026-09-17'},
      {rate: 8, institution: 'European Central Bank', reference_date: '2026-09-18'},
    ];
    if (url.endsWith('/pairs')) return ['USD/CNY','USD/JPY','CNY/JPY'];
    if (url.includes("history")) {
      return [{ midpoint: "7.12", captured_at: "2026-09-18T00:00:00Z" }];
    }
    if (url.includes("comparisons")) {
      return { official: [{
        institution: "European Central Bank", reference_date: "2026-09-18",
        is_derived: true, rate: "7.10", market_deviation_percent: "0.2817",
      }] };
    }
    return [{ base_currency: "USD", quote_currency: "CNY", midpoint: "7.12",
      bid: "7.119", ask: "7.121", provider: "mock", change_percent: null,
      captured_at: "2026-09-18T00:00:00Z", is_stale: false }];
  } });
  w.eval(config);
  w.eval(messages);
  w.eval(i18n);
  w.eval(script);
  await tick();
  return { w, state, copied: () => copied, close: () => w.close() };
}

test("loads Chinese popup without replacing missing watchlist entries", async () => {
  const app = await setup({ watchlist: ["USD/CNY", "USD/JPY"] });
  assert.equal(app.w.document.querySelectorAll(".rate-card").length, 1);
  assert.equal(app.state.watchlist[0], "USD/CNY");
  assert.equal(app.state.watchlist[1], "USD/JPY");
  assert.match(app.w.document.getElementById("status").textContent, /模拟数据/);
  assert.match(app.w.document.getElementById("official-rates").textContent, /欧洲央行/);
  app.close();
});
test("clipboard success", async () => {
  const app = await setup();
  app.w.document.getElementById("copy-button").click();
  await tick();
  assert.equal(app.copied(), "USD/CNY 7.12");
  assert.equal(app.w.document.getElementById("copy-button").textContent, "已复制");
  app.close();
});
test("clipboard denial exposes selectable fallback", async () => {
  const app = await setup({ clipboardFails: true });
  app.w.document.getElementById("copy-button").click();
  await tick();
  assert.equal(app.w.document.getElementById("copy-value").value, "USD/CNY 7.12");
  assert.equal(app.w.document.getElementById("copy-fallback").classList.contains("hidden"), false);
  app.close();
});
test("converter reverses and target persists locally", async () => {
  const app = await setup();
  app.w.document.getElementById("reverse-button").click();
  assert.match(app.w.document.getElementById("converted").textContent, /140.45 USD/);
  app.w.document.getElementById("target-value").value = "7";
  app.w.document.getElementById("target-form").dispatchEvent(
    new app.w.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(app.state.targets["USD/CNY"].value, 7);
  assert.match(app.w.document.getElementById("target-message").textContent, /已达到/);
  app.close();
});

test("official-only conversion selects the newest reference and preserves preferences", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    assert.equal(el('converter-from').options.length, 5);
    el('converter-from').value = 'EUR';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    await tick();
    assert.equal(el('converted').textContent, '8,000.00 CNY');
    assert.match(el('converter-status').textContent, /官方日参考价.*欧洲央行.*2026-09-18/);
    assert.equal(app.state.converterFrom, 'EUR');
    el('amount').value = '2';
    el('amount').dispatchEvent(new app.w.Event('input'));
    assert.equal(el('converted').textContent, '16.00 CNY');
    el('converter-to').value = 'EUR';
    el('converter-to').dispatchEvent(new app.w.Event('change'));
    await tick();
    assert.equal(el('converted').textContent, '2.00 EUR');
    assert.match(el('converter-status').textContent, /1:1/);
  } finally { app.close(); }
});

test("late official response cannot replace a newer currency selection; missing rates stay explicit", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    let finish;
    app.w.fetch = async () => ({ok: true, json: () => new Promise(resolve => { finish = resolve; })});
    el('converter-from').value = 'EUR';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    await tick();
    el('converter-from').value = 'USD';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    finish([{rate: 99, institution: 'Bank of Canada', reference_date: '2026-09-20'}]);
    await tick();
    assert.equal(el('converted').textContent, '7,120.00 CNY');
    assert.match(el('converter-status').textContent, /市场中间价/);
    app.w.fetch = async () => ({ok: true, json: async () => []});
    el('converter-from').value = 'GBP';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    await tick();
    assert.equal(el('converted').textContent, '—');
    assert.match(el('converter-status').textContent, /暂无可用汇率/);
  } finally { app.close(); }
});

test("currency selectors drive the main card, official panel, history and saved selection", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    el('converter-from').value = 'EUR';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    await tick();
    assert.equal(app.w.document.querySelectorAll('.rate-card').length, 1);
    assert.match(el('rates').textContent, /EUR\/CNY/);
    assert.match(el('rates').textContent, /8\.0000/);
    assert.match(el('rates').textContent, /官方日参考价.*欧洲央行/);
    assert.match(el('official-title').textContent, /EUR\/CNY/);
    assert.match(el('chart').textContent, /暂无市场历史数据/);
    await app.w.eval('loadData()');
    await tick();
    assert.equal(el('converter-from').value, 'EUR');
    assert.match(el('rates').textContent, /EUR\/CNY/);
    assert.equal(app.state.converterFrom, 'EUR');
  } finally { app.close(); }
});

test("reverse selection uses reciprocal market prices and history", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    el('reverse-button').click();
    await tick();
    assert.match(el('rates').textContent, /CNY\/USD/);
    assert.match(el('rates').textContent, /0\.1404/);
    assert.equal(el('stat-low').textContent, '0.140449');
    assert.match(el('official-title').textContent, /CNY\/USD/);
  } finally { app.close(); }
});

test("explorer retains unavailable selections and triangulation labels after PR14", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    app.state.converterFrom = "ZAR";
    await app.w.eval("init()");
    await tick();
    assert.equal(el('converter-from').value, 'ZAR');
    assert.match(el('converter-from').selectedOptions[0].textContent, /不可用/);
    app.w.fetch = async url => ({ok:true,json:async () => url.includes('/official-rates/')
      ? [{rate:8,institution:'Bank A / Bank B',reference_date:'2026-09-18',via_currency:'USD'}]
      : {official:[]}});
    el('converter-from').value = 'EUR';
    el('converter-from').dispatchEvent(new app.w.Event('change'));
    await tick();
    assert.match(el('rates').textContent, /Bank A \/ Bank B/);
    assert.match(el('rates').textContent, /USD/);
    assert.match(el('converter-status').textContent, /USD/);
  } finally { app.close(); }
});

test("small rates agree across card, history and converter without rounding calculations", async () => {
  const app = await setup();
  try {
    const el = id => app.w.document.getElementById(id);
    const raw = 0.0425749;
    app.w.fetch = async url => ({ok:true,json:async () =>
      url.endsWith('/pairs') ? ['JPY/CNY'] :
      url.endsWith('/currencies') ? {official_currencies:['JPY','CNY']} :
      url.includes('/history') ? [{midpoint:raw,captured_at:'2026-09-20T00:00:00Z'}] :
      url.includes('/comparisons/') ? {official:[{rate:raw,institution:'Bank of Japan',reference_date:'2026-09-20'}]} :
      [{base_currency:'JPY',quote_currency:'CNY',midpoint:raw,bid:0.042574,ask:0.0425758,
        captured_at:'2026-09-20T00:00:00Z',provider:'alpha_vantage',is_stale:false}]});
    await app.w.eval('loadData()');
    await app.w.eval('selectPair("JPY/CNY")');
    await tick();
    assert.equal(el('rates').querySelector('strong').textContent, '0.042575');
    assert.equal(el('stat-low').textContent, '0.042575');
    assert.equal(el('official-rates').querySelector('strong').textContent, '0.042575');
    assert.equal(el('conversion-rate').textContent, '1 JPY ≈ 0.042575 CNY');
    assert.equal(el('converted').textContent, '42.57 CNY');
    el('amount').value = '1000000';
    el('amount').dispatchEvent(new app.w.Event('input'));
    assert.equal(el('converted').textContent, '42,574.90 CNY');
    assert.match(el('conversion-rate').title, /0\.0425749/);
    assert.notEqual(app.w.eval('formatRate(1e-14)'), '0.000000');
    assert.match(app.w.eval('formatRate(1e-14)'), /E-14/i);
  } finally { app.close(); }
});
