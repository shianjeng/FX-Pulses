/* The only runtime network gateway for popup and hover. No provider keys here. */
// Generated from _locales; the worker localizes the errors it hands to the UI.
if (typeof importScripts === "function") importScripts("messages.js");
const FX_LANGUAGES = ["zh", "en", "ja"];
let workerLanguage = "zh";
const t = (key, ...values) => {
  const table = globalThis.FXMessages || {};
  const message = table[workerLanguage]?.[key] ?? table.zh?.[key] ?? key;
  return values.length
    ? message.replace(/\$(\d)/g, (match, index) => values[Number(index) - 1] ?? match)
    : message;
};
chrome.storage.local.get({language: null}).then(({language}) => {
  if (FX_LANGUAGES.includes(language)) workerLanguage = language;
}).catch(() => { /* keep the default */ });
const FX_DEFAULT_URL = "http://localhost:8000/api/v1";
const FX_MATCHES = ["https://*/*", "http://*/*"];
const FX_TTL = 60000;
const FX_OFFICIAL_TTL = 600000;
const FX_ALARM = "fx-target-check";
const FX_REQUEST_LIMIT = 120;
const pending = new Map();
const snapshots = new Map();
const requests = new Map();
let generation = 0;
let registrationTask = Promise.resolve();

async function apiBase() {
  const {apiUrl} = await chrome.storage.local.get({apiUrl: FX_DEFAULT_URL});
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(t("invalidUrl"));
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(base, path) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(base + path, {signal: controller.signal, credentials: "omit", redirect: "error"});
    if (!response.ok) throw new Error(response.status === 429 ? t("tooManyRequests") : t("serverReturned", response.status));
    try { return await response.json(); } catch { throw new Error(t("badFormat")); }
  } catch (error) {
    if (error.name === "AbortError") throw new Error(t("timeout"));
    if (error instanceof TypeError || error.message === "Failed to fetch") throw new Error(t("cannotConnect"));
    throw error;
  } finally { globalThis.clearTimeout(timeout); }
}

/* Separate maps: evicting request results must never drop the shared snapshot
   or its negative cache, which used to force a full refetch in every tab. */
function remember(map, key, value, limit = FX_REQUEST_LIMIT) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function validateSnapshot(pairs, rates) {
  const validPair = pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair);
  if (!Array.isArray(pairs) || !pairs.every(validPair) || !Array.isArray(rates) || !rates.every(rate =>
    rate && pairs.includes(`${rate.base_currency}/${rate.quote_currency}`) &&
    [rate.midpoint, rate.bid, rate.ask].every(value => Number.isFinite(Number(value)) && Number(value) > 0) &&
    Number(rate.bid) <= Number(rate.ask) && ["mock", "alpha_vantage"].includes(rate.provider) &&
    Number.isFinite(Date.parse(rate.captured_at)))) throw new Error(t("badFormat"));
}

async function snapshot(force = false) {
  const base = await apiBase();
  const key = `${base}|snapshot`;
  if (pending.has(key)) return pending.get(key);
  const failure = snapshots.get(key + "|error");
  if (!force && failure && Date.now() - failure.at < FX_TTL) throw new Error(failure.error);
  const version = generation;
  const task = (async () => {
    let saved = snapshots.get(key);
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
      if (base !== await apiBase() || version !== generation) throw new Error(t("sourceChanged"));
      const value = {base, pairs, rates, fetchedAt: Date.now(), offline: false};
      snapshots.set(key, value);
      snapshots.delete(key + "|error");
      if (chrome.storage.session) await chrome.storage.session.set({fxSnapshot: value});
      return value;
    } catch (error) {
      if (version !== generation) throw error;
      if (!saved) { snapshots.set(key + "|error", {at: Date.now(), error: error.message}); throw error; }
      // One-minute negative cache prevents an outage from causing tab-wide retries.
      const value = {...saved, fetchedAt: Date.now(), offline: true, error: error.message};
      snapshots.set(key, value);
      if (chrome.storage.session) await chrome.storage.session.set({fxSnapshot: value});
      return value;
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}

const UI_PATHS = /^\/(?:comparisons\/[A-Z]{3}\/[A-Z]{3}|currencies|official-rates\/[A-Z]{3}\/[A-Z]{3}|rates\/[A-Z]{3}\/[A-Z]{3}\/history\?days=(?:1|7|30|90))$/;
/* Content scripts may only read a single official cross rate, never arbitrary paths. */
const PAGE_PATHS = /^\/official-rates\/[A-Z]{3}\/[A-Z]{3}$/;

async function apiRequest(path, {fromPage = false} = {}) {
  const allowed = fromPage ? PAGE_PATHS : UI_PATHS;
  if (!allowed.test(path)) throw new Error("Unsupported API path");
  const base = await apiBase(), key = base + path;
  const ttl = PAGE_PATHS.test(path) ? FX_OFFICIAL_TTL : FX_TTL;
  const saved = requests.get(key);
  if (saved && Date.now() - saved.at < ttl) return saved.data;
  if (pending.has(key)) return pending.get(key);
  const version = generation;
  const task = fetchJson(base, path).then(data => {
    if (version !== generation) throw new Error(t("sourceChanged"));
    remember(requests, key, {at: Date.now(), data});
    return data;
  });
  pending.set(key, task);
  try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}

async function health() {
  const base = await apiBase();
  const key = `${base}|health`;
  const saved = requests.get(key);
  if (saved && Date.now() - saved.at < FX_TTL) return saved.data;
  const data = await fetchJson(new URL(base).origin, "/health");
  remember(requests, key, {at: Date.now(), data});
  return data;
}

/* The page-facing bridge is opt-in. While it is registered, any site can call
   the gateway, detect the extension and suppress its hover card, so only users
   who actually run the legacy userscript should pay that cost. */
function hoverScripts(bridgeEnabled) {
  return bridgeEnabled
    ? ["messages.js", "amount-parser.js", "userscript-bridge.js", "hover.js"]
    : ["messages.js", "amount-parser.js", "hover.js"];
}

async function syncHover() {
  const {hoverEnabled, bridgeEnabled} = await chrome.storage.local.get({
    hoverEnabled: false, bridgeEnabled: false,
  });
  const permitted = await chrome.permissions.contains({origins: FX_MATCHES});
  const wanted = hoverScripts(bridgeEnabled);
  let registered = await chrome.scripting.getRegisteredContentScripts({ids: ["fx-hover"]});
  const current = registered[0]?.js ?? [];
  if (registered.length && current.join(",") !== wanted.join(",")) {
    await chrome.scripting.unregisterContentScripts({ids: ["fx-hover"]});
    registered = [];
  }
  if ((!hoverEnabled || !permitted) && registered.length) await chrome.scripting.unregisterContentScripts({ids: ["fx-hover"]});
  if (hoverEnabled && permitted && !registered.length) await chrome.scripting.registerContentScripts([{
    id: "fx-hover", matches: FX_MATCHES, js: wanted,
    runAt: "document_idle", allFrames: false, persistAcrossSessions: true, world: "ISOLATED",
  }]);
  if (hoverEnabled && !permitted) await chrome.storage.local.set({hoverEnabled: false});
}
function queueRegistration() {
  registrationTask = registrationTask.then(syncHover, syncHover);
  registrationTask.catch(error => console.warn("Hover registration failed", error.message));
  return registrationTask;
}

/* ---- Opt-in target alerts -------------------------------------------------
   Off by default. Uses chrome.alarms so the worker stays asleep between checks
   and reads the same cached backend data as the popup: no upstream quota. */
const ALERT_DEFAULTS = {alertsEnabled: false, alertIntervalMinutes: 30, targets: {}, alertState: {}};

async function syncAlarms() {
  if (!chrome.alarms) return;
  const {alertsEnabled, alertIntervalMinutes} = await chrome.storage.local.get(ALERT_DEFAULTS);
  const allowed = !chrome.permissions || await chrome.permissions.contains({permissions: ["notifications"]});
  if (!alertsEnabled || !allowed) { await chrome.alarms.clear(FX_ALARM); return; }
  const minutes = Math.min(1440, Math.max(1, Number(alertIntervalMinutes) || 30));
  const existing = await chrome.alarms.get(FX_ALARM);
  if (!existing || existing.periodInMinutes !== minutes) {
    await chrome.alarms.create(FX_ALARM, {periodInMinutes: minutes, delayInMinutes: minutes});
  }
}

function reached(target, midpoint) {
  return target.direction === "above" ? midpoint >= target.value : midpoint <= target.value;
}

async function checkTargets() {
  const stored = await chrome.storage.local.get(ALERT_DEFAULTS);
  if (!stored.alertsEnabled || !chrome.notifications) return;
  let data;
  try { data = await snapshot(); } catch { return; }
  if (data.offline) return;                       // Never alert on a cached quote.
  const state = {...stored.alertState};
  for (const [pair, target] of Object.entries(stored.targets || {})) {
    const rate = data.rates.find(item => `${item.base_currency}/${item.quote_currency}` === pair);
    if (!rate || rate.is_stale || !Number.isFinite(Number(target?.value)) || Number(target.value) <= 0) continue;
    const hit = reached(target, Number(rate.midpoint));
    const signature = `${target.direction}|${target.value}`;
    const previous = state[pair];
    if (hit && previous?.signature !== signature) {
      state[pair] = {signature, at: Date.now()};
      chrome.notifications.create(`fx-${pair}-${Date.now()}`, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: `FX Pulse · ${pair}`,
        message: t("targetAlertBody", pair, target.direction === "above" ? "≥" : "≤", target.value, rate.midpoint),
      });
    } else if (!hit && previous) {
      delete state[pair];                          // Re-arm once the price moves back.
    }
  }
  await chrome.storage.local.set({alertState: state});
}

chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === FX_ALARM) void checkTargets(); });

/* Our own content script is trusted because hover is on; anything a web page
   relays through the bridge additionally requires the bridge opt-in. */
async function pageAccessAllowed(message) {
  const {hoverEnabled, bridgeEnabled} = await chrome.storage.local.get({
    hoverEnabled: false, bridgeEnabled: false,
  });
  if (!hoverEnabled) return false;
  return message?.fromBridge === true ? bridgeEnabled === true : true;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const isUi = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  const action = async () => {
    if (message?.type === "FX_SNAPSHOT") {
      if (!isUi && !await pageAccessAllowed(message)) throw new Error("Hover is disabled");
      return snapshot(isUi && message.force === true);
    }
    if (message?.type === "FX_API" && isUi) return apiRequest(message.path);
    if (message?.type === "FX_HEALTH" && isUi) return health();
    if (message?.type === "FX_OFFICIAL") {
      if (!isUi && !await pageAccessAllowed(message)) throw new Error("Hover is disabled");
      return apiRequest(message.path, {fromPage: !isUi});
    }
    if (message?.type === "FX_OPEN_SETTINGS") { await chrome.runtime.openOptionsPage(); return true; }
    if (message?.type === "FX_SYNC_HOVER" && isUi) { await queueRegistration(); return true; }
    if (message?.type === "FX_SYNC_ALERTS" && isUi) { await syncAlarms(); return true; }
    throw new Error("Unsupported message");
  };
  action().then(data => reply({ok: true, data}), error => reply({ok: false, error: error.message}));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.apiUrl) {
    generation++; snapshots.clear(); requests.clear(); pending.clear();
    if (chrome.storage.session) void chrome.storage.session.remove("fxSnapshot");
  }
  if (changes.hoverEnabled || changes.bridgeEnabled) void queueRegistration();
  if (changes.alertsEnabled || changes.alertIntervalMinutes) void syncAlarms();
  if (changes.language && FX_LANGUAGES.includes(changes.language.newValue)) workerLanguage = changes.language.newValue;
});
chrome.permissions.onRemoved.addListener(() => { void queueRegistration(); void syncAlarms(); });
chrome.runtime.onInstalled.addListener(() => { void queueRegistration(); void syncAlarms(); });
chrome.runtime.onStartup.addListener(() => { void queueRegistration(); void syncAlarms(); });
