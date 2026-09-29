/* The only runtime network gateway for popup and hover. No provider keys here. */
// Generated from _locales; the worker localizes the errors it hands to the UI.
if (typeof importScripts === "function") importScripts("config.js", "messages.js");
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
const FX_DEFAULT_URL = globalThis.FXConfig.defaultApiUrl;
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

/* ---- static backend adapter ----------------------------------------------
   A static backend is a directory of JSON files with no server to compute
   anything per request. The worker therefore maps each API path onto the file
   holding that data and derives the time-dependent fields itself. Everything
   above this layer sees identical results in both modes. */

const FX_STATIC_ROUTES = new Set(["/pairs", "/rates", "/currencies", "/official-rates"]);

function staticPathFor(path) {
  const [route, query] = path.split("?");
  if (FX_STATIC_ROUTES.has(route)) return {file: `${route}.json`, query};
  // /rates/USD/CNY/history?days=7 -> one 90-day file, sliced below.
  const history = route.match(/^\/rates\/([A-Z]{3})\/([A-Z]{3})\/history$/);
  if (history) return {file: `/rates/${history[1]}/${history[2]}/history.json`, query};
  const pair = route.match(/^\/(comparisons|official-rates)\/([A-Z]{3})\/([A-Z]{3})$/);
  if (pair) return {file: `/${pair[1]}/${pair[2]}/${pair[3]}.json`, query};
  throw new Error("Unsupported API path");
}

let metaCache = null;
async function staticMeta(base) {
  if (metaCache && metaCache.base === base && Date.now() - metaCache.at < FX_TTL) return metaCache.data;
  const data = await fetchJson(base, "/meta.json", {raw: true});
  metaCache = {base, at: Date.now(), data};
  return data;
}

const olderThan = (timestamp, minutes) =>
  !timestamp || Date.now() - Date.parse(timestamp) > minutes * 60000;

/* Freshness is relative to now, and a CDN may serve a file long after it was
   written, so these are never read from the file itself. */
function applyFreshness(data, staleAfterMinutes) {
  const mark = quote => quote && typeof quote === "object"
    ? {...quote, is_stale: olderThan(quote.captured_at, staleAfterMinutes)}
    : quote;
  if (Array.isArray(data)) return data.map(mark);
  if (data && typeof data === "object" && "market" in data) return {...data, market: mark(data.market)};
  return data;
}

async function fetchStatic(base, path) {
  const {file, query} = staticPathFor(path);
  const data = await fetchJson(base, file, {raw: true});
  if (file.endsWith("/history.json")) {
    const days = Number(new globalThis.URLSearchParams(query || "").get("days")) || 7;
    const since = Date.now() - days * 86400000;
    return data.filter(point => Date.parse(point.captured_at) >= since);
  }
  const {stale_after_minutes: stale} = await staticMeta(base);
  return applyFreshness(data, stale);
}

/* /health has no file of its own: meta.json carries the raw collector rows and
   the stall thresholds, and the verdict is computed here. */
async function staticHealth(base) {
  const meta = await staticMeta(base);
  return {
    status: "ok",
    provider: meta.provider,
    collector: (meta.collector || []).map(job => ({
      job: job.job,
      finished_at: job.finished_at,
      last_success_at: job.last_success_at,
      consecutive_failures: job.consecutive_failures || 0,
      last_error: job.last_error ?? null,
      is_stalled: olderThan(job.last_success_at, job.stall_after_minutes),
    })),
  };
}

/* The mode belongs to the backend, not to the build. A user who pointed the
   extension at their own server must keep talking to it as an API even when the
   shipped default is a static host, and vice versa. The options page stores the
   mode it detected next to the URL; a URL saved before modes existed was always
   an API. Only the untouched default follows config.js. */
async function backendMode() {
  const {apiUrl, backendMode: stored} = await chrome.storage.local.get({apiUrl: null, backendMode: null});
  if (!apiUrl) return globalThis.FXConfig.backendMode;
  return stored === "static" ? "static" : "api";
}

async function fetchJson(base, path, {raw = false} = {}) {
  if (!raw && await backendMode() === "static") return fetchStatic(base, path);
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
      void paintBadge(value);
      return value;
    } catch (error) {
      if (version !== generation) throw error;
      if (!saved) { snapshots.set(key + "|error", {at: Date.now(), error: error.message}); throw error; }
      // One-minute negative cache prevents an outage from causing tab-wide retries.
      const value = {...saved, fetchedAt: Date.now(), offline: true, error: error.message};
      snapshots.set(key, value);
      if (chrome.storage.session) await chrome.storage.session.set({fxSnapshot: value});
      void paintBadge(value);
      return value;
    }
  })();
  pending.set(key, task);
  try {
    lastSnapshot = await task;
    return lastSnapshot;
  } finally { if (pending.get(key) === task) pending.delete(key); }
}

/* ---- Live reference rates ---------------------------------------------------
   Coinbase's public exchange-rate endpoint: documented, no key, about 160
   currencies against one base, refreshed about once a minute. On 29 September
   2026 it sat a median 0.006% (at most 0.04%, USD/CNY) from Wise's mid-market
   rate across 14 currencies, while the backend's quotes were up to three hours
   old. One request covers every pair, and the shared one-minute cache keeps
   popup, pages, icon and alerts together to a request a minute at most, and
   only while one of them is in use. On by default; Settings turns it off. */
const FX_LIVE_ORIGIN = "https://api.coinbase.com";
const FX_LIVE_PATH = "/v2/exchange-rates?currency=USD";
const FX_LIVE_TTL = 60000;
// An older copy is no longer shown as live; the backend's quotes take over.
const FX_LIVE_FRESH = 10 * 60000;
// Coinbase lists crypto assets beside money; only ISO 4217 currencies count.
const FX_NOT_MONEY = new Set(["XAG", "XAU", "XPD", "XPT", "XDR", "XTS", "XXX", "XBA", "XBB", "XBC", "XBD", "XSU", "XUA"]);
const FX_FIAT = new Set((Intl.supportedValuesOf?.("currency") ?? []).filter(code => !FX_NOT_MONEY.has(code)));
let lastSnapshot = null;
let liveCache = null;
let livePending = null;
let liveFailedAt = 0;

async function liveEnabled() {
  return (await chrome.storage.local.get({liveRates: true})).liveRates !== false;
}

const liveFresh = value => value && Date.now() - value.fetchedAt < FX_LIVE_FRESH ? value : null;

function liveTable(payload) {
  const rates = payload?.data?.currency === "USD" ? payload.data.rates : null;
  if (!rates || typeof rates !== "object") throw new Error(t("badFormat"));
  const table = {USD: 1};
  for (const [code, value] of Object.entries(rates)) {
    const number = Number(value);
    if (FX_FIAT.has(code) && Number.isFinite(number) && number > 0) table[code] = number;
  }
  if (!table.EUR || !table.JPY || Object.keys(table).length < 20) throw new Error(t("badFormat"));
  // A broken feed must not replace good data: each pair the backend collects
  // has to agree with its last quote within 5%.
  for (const rate of lastSnapshot?.rates || []) {
    const cross = table[rate.quote_currency] / table[rate.base_currency];
    if (Number.isFinite(cross) && Math.abs(cross / Number(rate.midpoint) - 1) > 0.05) throw new Error(t("badFormat"));
  }
  return table;
}

// The quote for one pair from a live table, or null.
function liveCross(live, pair) {
  const [base, quote] = pair.split("/");
  const value = live?.rates?.[quote] / live?.rates?.[base];
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function liveRates(force = false) {
  if (!await liveEnabled()) return null;
  if (!liveCache && chrome.storage.session) {
    const stored = (await chrome.storage.session.get("fxLive")).fxLive;
    if (stored?.rates && Number.isFinite(stored.fetchedAt)) liveCache = stored;
  }
  if (!force && liveCache && Date.now() - liveCache.fetchedAt < FX_LIVE_TTL) return liveCache;
  // After a failure every caller waits a minute before the next attempt.
  if (!force && Date.now() - liveFailedAt < FX_LIVE_TTL) return liveFresh(liveCache);
  if (livePending) return livePending;
  livePending = (async () => {
    try {
      const rates = liveTable(await fetchJson(FX_LIVE_ORIGIN, FX_LIVE_PATH, {raw: true}));
      liveCache = {source: "coinbase", base: "USD", rates, fetchedAt: Date.now()};
      if (chrome.storage.session) await chrome.storage.session.set({fxLive: liveCache});
      void paintBadge(lastSnapshot);
      return liveCache;
    } catch {
      liveFailedAt = Date.now();
      return liveFresh(liveCache);
    } finally { livePending = null; }
  })();
  return livePending;
}

const UI_PATHS = /^\/(?:comparisons\/[A-Z]{3}\/[A-Z]{3}|currencies|official-rates\/[A-Z]{3}\/[A-Z]{3}|rates\/[A-Z]{3}\/[A-Z]{3}\/history\?days=(?:1|7|30|90))$/;
/* Content scripts may read a single official cross rate or the list of covered
   currencies (public, and it carries nothing from the page), never other paths. */
const PAGE_PATHS = /^\/(?:official-rates\/[A-Z]{3}\/[A-Z]{3}|currencies)$/;

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
  // A static backend has no /health; its verdict is derived from meta.json.
  const data = await backendMode() === "static" ? await staticHealth(base) : await fetchJson(new URL(base).origin, "/health");
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
  let data = null;
  try { data = await snapshot(); } catch { /* the live rate may still answer */ }
  const live = await liveRates().catch(() => null);
  const state = {...stored.alertState};
  for (const [pair, target] of Object.entries(stored.targets || {})) {
    if (!Number.isFinite(Number(target?.value)) || Number(target.value) <= 0) continue;
    const rate = data?.rates.find(item => `${item.base_currency}/${item.quote_currency}` === pair);
    // Never alert on a cached or stale quote.
    const current = liveCross(live, pair) ?? (rate && !data.offline && !rate.is_stale ? Number(rate.midpoint) : null);
    if (current === null) continue;
    const hit = reached(target, current);
    const signature = `${target.direction}|${target.value}`;
    const previous = state[pair];
    if (hit && previous?.signature !== signature) {
      state[pair] = {signature, at: Date.now()};
      chrome.notifications.create(`fx-${pair}-${Date.now()}`, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: `FX Pulse · ${pair}`,
        message: t("targetAlertBody", pair, target.direction === "above" ? "≥" : "≤", target.value,
          Number(current.toPrecision(8))),
      });
    } else if (!hit && previous) {
      delete state[pair];                          // Re-arm once the price moves back.
    }
  }
  await chrome.storage.local.set({alertState: state});
}

/* ---- Opt-in toolbar badge -------------------------------------------------
   One pair's rate on the extension icon, readable without opening anything.
   It is painted from every snapshot the worker fetches anyway, and an alarm
   asks for one every 30 minutes while it is on: the shared one-minute cache,
   no extra upstream calls. Grey means the quote is old or the source offline. */
const FX_BADGE_ALARM = "fx-badge";
const FX_BADGE_MINUTES = 30;
// With live rates the icon can follow the market more closely at no extra cost.
const FX_BADGE_LIVE_MINUTES = 5;
const FX_LOCALES = {zh: "zh-CN", en: "en-US", ja: "ja-JP"};

// Chrome shows about four characters: 6.70, 23.4, 157, 1.4k, .043, 6e-5.
function badgeText(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 999500) return value.toExponential(0).replace("e+", "e");
  if (value >= 9950) return `${Math.round(value / 1000)}k`;
  if (value >= 999.5) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 99.95) return String(Math.round(value));
  if (value >= 9.995) return value.toFixed(1);
  if (value >= 0.9995) return value.toFixed(2);
  if (value >= 0.0005) return value.toFixed(3).slice(1);
  return value.toExponential(0);
}

async function paintBadge(data) {
  if (!chrome.action) return;
  try {
    const {badgePair} = await chrome.storage.local.get({badgePair: ""});
    if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(badgePair || "")) {
      await chrome.action.setBadgeText({text: ""});
      await chrome.action.setTitle({title: "FX Pulse"});
      return;
    }
    const [base, quote] = badgePair.split("/");
    const live = await liveEnabled() ? liveFresh(liveCache) : null;
    const liveValue = liveCross(live, badgePair);
    const rates = Array.isArray(data?.rates) ? data.rates : [];
    const direct = rates.find(rate => rate.base_currency === base && rate.quote_currency === quote);
    const reverse = rates.find(rate => rate.base_currency === quote && rate.quote_currency === base);
    const source = direct || reverse;
    const grey = {color: "#8c98a6"};
    // Nothing to show this time: keep the last number, but say it is not current.
    if (liveValue === null && !source) { await chrome.action.setBadgeBackgroundColor(grey); return; }
    const value = liveValue ?? (direct ? Number(direct.midpoint) : 1 / Number(reverse.midpoint));
    const old = liveValue === null && (data.offline || source.is_stale);
    const locale = FX_LOCALES[workerLanguage] || "zh-CN";
    const time = new Date(liveValue !== null ? live.fetchedAt : source.captured_at)
      .toLocaleString(locale, {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
    const shown = new Intl.NumberFormat(locale, {maximumSignificantDigits: 6}).format(value);
    await chrome.action.setBadgeText({text: badgeText(value)});
    await chrome.action.setBadgeBackgroundColor(old ? grey : {color: "#0b8a6f"});
    await chrome.action.setBadgeTextColor?.({color: "#ffffff"});
    await chrome.action.setTitle({title: t("badgeTooltip", badgePair, shown, time) + (old ? ` · ${t("outdated")}` : "")});
  } catch (error) { console.warn("Badge update failed", error.message); }
}

async function syncBadge() {
  const {badgePair} = await chrome.storage.local.get({badgePair: ""});
  if (!badgePair) {
    await chrome.alarms?.clear(FX_BADGE_ALARM);
    await paintBadge(null);
    return;
  }
  const minutes = await liveEnabled() ? FX_BADGE_LIVE_MINUTES : FX_BADGE_MINUTES;
  if (chrome.alarms && (await chrome.alarms.get(FX_BADGE_ALARM))?.periodInMinutes !== minutes) {
    await chrome.alarms.create(FX_BADGE_ALARM, {periodInMinutes: minutes});
  }
  let data = null;
  try { data = await snapshot(); } catch { /* painted grey below */ }
  await liveRates().catch(() => null);
  await paintBadge(data);
}

chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === FX_ALARM) void checkTargets();
  if (alarm.name === FX_BADGE_ALARM) void syncBadge();
});

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
    if (message?.type === "FX_LIVE") {
      if (!isUi && !await pageAccessAllowed(message)) throw new Error("Hover is disabled");
      return liveRates(isUi && message.force === true);
    }
    if (message?.type === "FX_CURRENCIES") {
      if (!isUi && !await pageAccessAllowed(message)) throw new Error("Hover is disabled");
      return apiRequest("/currencies", {fromPage: !isUi});
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
  if (changes.apiUrl || changes.backendMode) {
    generation++; snapshots.clear(); requests.clear(); pending.clear(); lastSnapshot = null;
    if (chrome.storage.session) void chrome.storage.session.remove("fxSnapshot");
  }
  if (changes.liveRates) {
    liveCache = null; liveFailedAt = 0;
    if (chrome.storage.session) void chrome.storage.session.remove("fxLive");
  }
  if (changes.badgePair || changes.apiUrl || changes.backendMode || changes.language || changes.liveRates) void syncBadge();
  if (changes.hoverEnabled || changes.bridgeEnabled) void queueRegistration();
  if (changes.alertsEnabled || changes.alertIntervalMinutes) void syncAlarms();
  if (changes.language && FX_LANGUAGES.includes(changes.language.newValue)) workerLanguage = changes.language.newValue;
});
chrome.permissions.onRemoved.addListener(() => { void queueRegistration(); void syncAlarms(); });
chrome.runtime.onInstalled.addListener(() => { void queueRegistration(); void syncAlarms(); void syncBadge(); });
chrome.runtime.onStartup.addListener(() => { void queueRegistration(); void syncAlarms(); void syncBadge(); });
