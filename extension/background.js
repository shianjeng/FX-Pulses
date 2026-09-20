/* The only runtime network gateway for popup and hover. No provider keys here. */
const FX_DEFAULT_URL = "http://localhost:8000/api/v1";
const FX_MATCHES = ["https://*/*", "http://*/*"];
const FX_TTL = 60000;
const pending = new Map();
const cache = new Map();
let generation = 0;
let registrationTask = Promise.resolve();

async function apiBase() {
  const {apiUrl} = await chrome.storage.local.get({apiUrl: FX_DEFAULT_URL});
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入有效的HTTP或HTTPS地址");
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(base, path) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(base + path, {signal: controller.signal, credentials: "omit", redirect: "error"});
    if (!response.ok) throw new Error(response.status === 429 ? "请求过于频繁，请稍后重试" : `服务器返回 ${response.status}`);
    try { return await response.json(); } catch { throw new Error("行情数据格式错误"); }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请重试");
    if (error instanceof TypeError) throw new Error("Failed to fetch");
    throw error;
  } finally { globalThis.clearTimeout(timeout); }
}

function validateSnapshot(pairs, rates) {
  const validPair = pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair);
  if (!Array.isArray(pairs) || !pairs.every(validPair) || !Array.isArray(rates) || !rates.every(rate =>
    rate && pairs.includes(`${rate.base_currency}/${rate.quote_currency}`) &&
    [rate.midpoint, rate.bid, rate.ask].every(value => Number.isFinite(Number(value)) && Number(value) > 0) &&
    Number(rate.bid) <= Number(rate.ask) && ["mock", "alpha_vantage"].includes(rate.provider) &&
    Number.isFinite(Date.parse(rate.captured_at)))) throw new Error("行情数据格式错误");
}

async function snapshot(force = false) {
  const base = await apiBase();
  const key = `${base}|snapshot`;
  if (pending.has(key)) return pending.get(key);
  const failure = cache.get(key + "|error");
  if (!force && failure && Date.now() - failure.at < FX_TTL) throw new Error(failure.error);
  const version = generation;
  const task = (async () => {
    let saved = cache.get(key);
    if (!saved && chrome.storage.session) {
      const stored = (await chrome.storage.session.get("fxSnapshot")).fxSnapshot;
      if (stored?.base === base) {
        try { validateSnapshot(stored.pairs, stored.rates); saved = stored; } catch { /* Ignore invalid cache. */ }
      }
    }
    const age = saved ? Date.now() - saved.fetchedAt : Infinity;
    if (!force && saved && age >= 0 && age < FX_TTL) return saved;
    try {
      const [pairs, rates] = await Promise.all([fetchJson(base, "/pairs"), fetchJson(base, "/rates")]);
      validateSnapshot(pairs, rates);
      if (base !== await apiBase() || version !== generation) throw new Error("数据源已更改，请重试");
      const value = {base, pairs, rates, fetchedAt: Date.now(), offline: false};
      cache.set(key, value);
      cache.delete(key + "|error");
      if (chrome.storage.session) await chrome.storage.session.set({fxSnapshot: value});
      return value;
    } catch (error) {
      if (version !== generation) throw error;
      if (!saved) { cache.set(key + "|error", {at: Date.now(), error: error.message}); throw error; }
      // One-minute negative cache prevents an outage from causing tab-wide retries.
      const value = {...saved, fetchedAt: Date.now(), offline: true, error: error.message};
      cache.set(key, value);
      if (chrome.storage.session) await chrome.storage.session.set({fxSnapshot: value});
      return value;
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}

async function apiRequest(path) {
  if (!/^\/(?:comparisons\/[A-Z]{3}\/[A-Z]{3}|rates\/[A-Z]{3}\/[A-Z]{3}\/history\?days=7)$/.test(path)) throw new Error("Unsupported API path");
  const base = await apiBase(), key = base + path;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < FX_TTL) return saved.data;
  if (pending.has(key)) return pending.get(key);
  const version = generation;
  const task = fetchJson(base, path).then(data => {
    if (version !== generation) throw new Error("数据源已更改，请重试");
    if (cache.size > 100) cache.clear();
    cache.set(key, {at: Date.now(), data});
    return data;
  });
  pending.set(key, task);
  try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}

async function syncHover() {
  const {hoverEnabled} = await chrome.storage.local.get({hoverEnabled: false});
  const permitted = await chrome.permissions.contains({origins: FX_MATCHES});
  const registered = await chrome.scripting.getRegisteredContentScripts({ids: ["fx-hover"]});
  if ((!hoverEnabled || !permitted) && registered.length) await chrome.scripting.unregisterContentScripts({ids: ["fx-hover"]});
  if (hoverEnabled && permitted && !registered.length) await chrome.scripting.registerContentScripts([{
    id: "fx-hover", matches: FX_MATCHES, js: ["amount-parser.js", "hover.js"],
    runAt: "document_idle", allFrames: false, persistAcrossSessions: true, world: "ISOLATED",
  }]);
  if (hoverEnabled && !permitted) await chrome.storage.local.set({hoverEnabled: false});
}
function queueRegistration() {
  registrationTask = registrationTask.then(syncHover, syncHover);
  registrationTask.catch(error => console.warn("Hover registration failed", error.message));
  return registrationTask;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const isUi = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  const action = async () => {
    if (message?.type === "FX_SNAPSHOT") {
      if (!isUi && !(await chrome.storage.local.get({hoverEnabled: false})).hoverEnabled) throw new Error("Hover is disabled");
      return snapshot(isUi && message.force === true);
    }
    if (message?.type === "FX_API" && isUi) return apiRequest(message.path);
    if (message?.type === "FX_OPEN_SETTINGS") { await chrome.runtime.openOptionsPage(); return true; }
    if (message?.type === "FX_SYNC_HOVER" && isUi) { await queueRegistration(); return true; }
    throw new Error("Unsupported message");
  };
  action().then(data => reply({ok: true, data}), error => reply({ok: false, error: error.message}));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.apiUrl) {
    generation++; cache.clear(); pending.clear();
    if (chrome.storage.session) void chrome.storage.session.remove("fxSnapshot");
  }
  if (changes.hoverEnabled) void queueRegistration();
});
chrome.permissions.onRemoved.addListener(() => { void queueRegistration(); });
chrome.runtime.onInstalled.addListener(() => { void queueRegistration(); });
chrome.runtime.onStartup.addListener(() => { void queueRegistration(); });
