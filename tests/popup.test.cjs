const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = join(__dirname, "..", "extension");
const html = readFileSync(join(root, "popup.html"), "utf8");
const script = readFileSync(join(root, "popup.js"), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function setup({ clipboardFails = false, watchlist = ["USD/CNY"] } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://test.invalid" });
  const w = dom.window;
  const state = { watchlist, targets: {}, apiUrl: "https://api.invalid" };
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
  w.eval(script);
  await tick();
  return { w, state, copied: () => copied, close: () => w.close() };
}

test("loads Chinese popup without replacing missing watchlist entries", async () => {
  const app = await setup({ watchlist: ["USD/CNY", "USD/JPY"] });
  assert.equal(app.w.document.querySelectorAll(".rate-card").length, 2);
  assert.equal(app.state.watchlist[0], "USD/CNY");
  assert.equal(app.state.watchlist[1], "USD/JPY");
  assert.match(app.w.document.querySelector('[data-pair="USD/JPY"]').textContent, /等待采集/);
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
