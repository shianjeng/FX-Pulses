const DEFAULTS = {
  apiUrl: globalThis.FXConfig.defaultApiUrl,
  watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"],
  converterFrom: "USD",
  converterTo: "CNY",
  targets: {},
  alertsEnabled: false,
  viewMode: "simple",
};

let settings = { ...DEFAULTS };
let rates = [];
let selectedPair = "USD/CNY";
let historyVersion = 0;
let refreshVersion = 0;
let converterVersion = 0;
let supportedPairs = [];
let officialCurrencies = [];
let converterQuote = null;
let offline = false;
const validPair = pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair);

const RANGE_DAYS = [1, 7, 30, 90];
const t = (key, ...values) => globalThis.FXI18N.t(key, ...values);
let historyDays = 7;

/* A timestamp without an offset is parsed as LOCAL time by the browser, which
   shifted every chart label by the client's UTC offset. Backend values are UTC. */
const parseUtc = (value) => Date.parse(/([Zz]|[+-]\d{2}:?\d{2})$/.test(String(value)) ? value : `${value}Z`);

const $ = (id) => document.getElementById(id);
const docLocale = () => ({zh: "zh-CN", en: "en-US", ja: "ja-JP"})[globalThis.FXI18N.language] || "zh-CN";
const INSTITUTIONS = {
  "European Central Bank": "institutionEcb",
  "Bank of Canada": "institutionBoc",
  "People's Bank of China": "institutionPboc",
  "Federal Reserve Board": "institutionFed",
  "Bank of Japan": "institutionBoj",
};
const fmt = (value, digits = 4) => Number(value).toLocaleString(docLocale(), {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
// Display rounding never changes the numeric quote used for conversion.
function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number < 1e-8) return number.toLocaleString(docLocale(), {
    notation: "scientific", maximumSignificantDigits: 5,
  });
  const digits = number >= 100 ? 3 : number >= 1 ? 4
    : Math.min(12, Math.max(6, 4 - Math.floor(Math.log10(number))));
  return fmt(number, digits);
}
const pairOf = (rate) => `${rate.base_currency}/${rate.quote_currency}`;
const changeText = (value) => value === null || value === undefined ? t("noComparison") :
  `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;

async function request(path) {
  if (chrome.runtime?.sendMessage) {
    const response = await chrome.runtime.sendMessage({type: "FX_API", path});
    if (!response?.ok) throw new Error(response?.error || t("cannotConnect"));
    return response.data;
  }
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
  const response = await fetch(`${settings.apiUrl.replace(/\/$/, "")}${path}`, {signal: controller.signal});
  if (!response.ok) {
    throw new Error(response.status === 429 ? t("tooManyRequests") : t("serverReturned", response.status));
  }
  return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(t("timeout"));
    if (error instanceof TypeError || error.message === "Failed to fetch") throw new Error(t("checkBackend"));
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function rateCard(rate) {
  const pair = pairOf(rate);
  const change = Number(rate.change_percent || 0);
  return `<button class="rate-card ${pair === selectedPair ? "selected" : ""}" data-pair="${pair}">
    <div class="rate-top"><span class="pair">${pair}</span><span class="change ${rate.change_percent === null || rate.change_percent === undefined ? "" : change >= 0 ? "positive" : "negative"}">${changeText(rate.change_percent)}</span></div>
    <strong>${formatRate(rate.midpoint)}</strong>
    <div class="rate-bottom"><span class="pro-only">${t("bid")} ${formatRate(rate.bid)} · ${t("ask")} ${formatRate(rate.ask)}</span><span class="${offline || rate.is_stale ? "stale" : ""}">${offline ? t("offlineCache") : rate.is_stale ? t("outdated") : t("updated")}</span></div>
    <small class="quote-time">${chartTimeLabel(rate.captured_at)}</small>
  </button>`;
}

function currentRate() {
  const direct = rates.find(rate => pairOf(rate) === selectedPair);
  if (direct) return direct;
  const [base, quote] = selectedPair.split("/");
  const inverse = rates.find(rate => rate.base_currency === quote && rate.quote_currency === base);
  return inverse ? {...inverse, base_currency: base, quote_currency: quote,
    midpoint: 1 / Number(inverse.midpoint), bid: 1 / Number(inverse.ask),
    ask: 1 / Number(inverse.bid), change_percent: null} : null;
}

async function reconcileWatchlist() {
  const pair = settings.converterFrom + "/" + settings.converterTo;
  if (validPair(pair)) selectedPair = pair;
}

/* The watchlist is a set of saved pairs, any two currencies the picker offers.
   Each row shows its rate and switches the picker to it. Market quotes are
   already in memory; official-only pairs are fetched when the panel opens, so
   a closed panel costs nothing. */
const WATCH_LIMIT = 8;
const watchOfficial = new Map();
let watchVersion = 0;

function watchRate(pair) {
  const [base, quote] = pair.split("/");
  const market = marketConverterQuote(base, quote);
  if (market) return market.rate;
  return watchOfficial.get(pair) ?? null;
}

function pickerPair() {
  const base = $("converter-from").value, quote = $("converter-to").value;
  return base && quote && base !== quote ? `${base}/${quote}` : null;
}

function renderWatchlist() {
  const list = $("watchlist-options");
  if (!list) return;
  list.replaceChildren();
  for (const pair of settings.watchlist) {
    const row = document.createElement("div");
    row.className = pair === selectedPair ? "watch-item selected" : "watch-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "watch-open";
    const name = document.createElement("span");
    name.textContent = pair;
    const value = document.createElement("span");
    value.className = "watch-rate";
    const rate = watchRate(pair);
    value.textContent = rate === null ? "—" : formatRate(rate);
    open.append(name, value);
    open.addEventListener("click", () => { void selectPair(pair); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "watch-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("watchRemove", pair));
    // Hover conversion reads its extra currencies from this list.
    remove.disabled = settings.watchlist.length <= 1;
    remove.addEventListener("click", () => { void removeWatch(pair); });
    row.append(open, remove);
    list.append(row);
  }
  const current = pickerPair(), add = $("watch-add");
  const saved = current && settings.watchlist.includes(current);
  const full = settings.watchlist.length >= WATCH_LIMIT;
  add.textContent = !current ? t("watchPick") : saved ? t("watchSaved", current) : full ? t("watchFull", WATCH_LIMIT) : t("watchAdd", current);
  add.disabled = !current || saved || full;
}

async function saveWatchlist(next) {
  settings.watchlist = next;
  await chrome.storage.local.set({watchlist: next});
  renderSelects();
}

async function addWatch() {
  const pair = pickerPair();
  if (!pair || settings.watchlist.includes(pair) || settings.watchlist.length >= WATCH_LIMIT) return;
  await saveWatchlist([...settings.watchlist, pair]);
  await loadWatchRates();
}

async function removeWatch(pair) {
  if (settings.watchlist.length <= 1) return;
  await saveWatchlist(settings.watchlist.filter(item => item !== pair));
}

async function loadWatchRates() {
  if (!$("watchlist-panel")?.open) return;
  const version = ++watchVersion;
  const missing = settings.watchlist.filter(pair => {
    const [base, quote] = pair.split("/");
    return !marketConverterQuote(base, quote) && !watchOfficial.has(pair);
  });
  await Promise.all(missing.map(async pair => {
    try {
      const newest = newestOfficial(await request(`/official-rates/${pair}`));
      if (newest) watchOfficial.set(pair, Number(newest.rate));
    } catch { /* Shown as "—"; the next opening tries again. */ }
  }));
  if (version === watchVersion) renderWatchlist();
}

function renderRates() {
  const rate = currentRate();
  if (rate) $("rates").innerHTML = rateCard(rate);
  else {
    $("rates").replaceChildren();
    const card = document.createElement("div");
    card.className = "rate-card selected";
    card.dataset.pair = selectedPair;
    const title = document.createElement("span");
    title.className = "pair";
    title.textContent = selectedPair;
    const value = document.createElement("strong");
    const source = document.createElement("small");
    const available = converterQuote && selectedPair === $("converter-from").value + "/" + $("converter-to").value;
    value.textContent = available ? formatRate(converterQuote.rate) : "—";
    source.textContent = available ? converterStatus() : offline ? t("dataUnavailable") : t("converterNoRate");
    card.append(title, value, source);
    $("rates").append(card);
  }
  $("copy-button").disabled = offline || (!rate && !converterQuote);
  renderWatchlist();
}

function renderSelects() {
  const pairs = [...new Set([...supportedPairs, ...settings.watchlist])];
  // Alerts are checked against market quotes only; an official-only pair in this
  // list would accept a target that can never fire.
  const options = supportedPairs.map(pair => `<option value="${pair}">${pair}</option>`).join("");
  $("target-pair").innerHTML = options;
  $("target-pair").value = supportedPairs.includes(selectedPair) ? selectedPair : supportedPairs[0] || "";
  const available = [...new Set([
    ...pairs.flatMap(pair => pair.split("/")),
    ...officialCurrencies,
  ])].filter(currency => /^[A-Z]{3}$/.test(currency)).sort();
  // A saved currency stays selectable while coverage is unknown (offline, or
  // /currencies not answered yet); losing the selection silently looked like the
  // setting had been forgotten.
  const chosen = [settings.converterFrom, settings.converterTo]
    .filter(currency => /^[A-Z]{3}$/.test(currency) && !available.includes(currency));
  const currencies = [...new Set([...available, ...chosen])].sort();
  const currencyOptions = currencies.map(currency =>
    `<option value="${currency}">${available.includes(currency) ? currency : t("converterUnavailableCurrency", currency)}</option>`).join("");
  $("converter-from").innerHTML = currencyOptions;
  $("converter-to").innerHTML = currencyOptions;
  const [fallbackFrom, fallbackTo] = selectedPair.split("/");
  $("converter-from").value = currencies.includes(settings.converterFrom) ? settings.converterFrom : fallbackFrom;
  $("converter-to").value = currencies.includes(settings.converterTo) ? settings.converterTo : fallbackTo;
  renderWatchlist();
  void loadConverterRate();
  loadTarget();
}

function chartTimeLabel(value) {
  const date = new Date(parseUtc(value));
  if (Number.isNaN(date.getTime())) return "—";
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

/* Split the samples wherever collection paused. The threshold follows the
   observed sampling interval instead of a fixed six hours, which turned the
   whole line into loose dots on slower collectors. */
function chartSegments(points) {
  const gaps = points.slice(1)
    .map((point, index) => parseUtc(point.time) - parseUtc(points[index].time))
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[(gaps.length - 1) >> 1] : 0;
  const limit = Math.max(typical * 2.5, 60000);
  const segments = [];
  points.forEach((point, index) => {
    if (!index || parseUtc(point.time) - parseUtc(points[index - 1].time) > limit) segments.push([]);
    segments.at(-1).push(point);
  });
  return segments;
}

// Straight segments cannot invent extrema between observations.
function linePath(segments) {
  return segments.map(segment => segment.map((point, index) =>
    `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ")).join(" ");
}

/* Filled per segment and closed straight down to the baseline, so an outage
   stays a visible gap instead of a slope, and a lone sample never becomes a
   filled triangle. Polygons rather than paths keep the line the first path. */
function areaPolygons(segments, height) {
  return segments.filter(segment => segment.length > 1).map(segment => {
    const top = segment.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<polygon class="chart-area" points="${top} ${segment.at(-1).x.toFixed(2)},${height} ${segment[0].x.toFixed(2)},${height}" fill="url(#chart-fill)"></polygon>`;
  }).join("");
}

function resetChartStats() {
  ["stat-high", "stat-low", "stat-avg", "stat-change"].forEach(id => { $(id).textContent = "—"; });
  $("stat-change").className = "";
}

function drawChart(points) {
  const root = $("chart");
  points = points.filter(point => Number.isFinite(Number(point.midpoint)) && Number(point.midpoint) > 0 && Number.isFinite(parseUtc(point.captured_at))).sort((a,b) => parseUtc(a.captured_at) - parseUtc(b.captured_at));
  if (!points.length) {
    root.innerHTML = `<span>${t("chartCollecting")}</span>`;
    resetChartStats();
    return;
  }

  const values = points.map((point) => Number(point.midpoint));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const width = 340;
  const height = 120;
  const range = high - low || 1;
  const start = parseUtc(points[0].captured_at);
  const duration = parseUtc(points.at(-1).captured_at) - start;
  const plotted = values.map((value, index) => {
    const x = duration ? (parseUtc(points[index].captured_at) - start) / duration * width : width / 2;
    const y = high === low ? height / 2 : 7 + ((high - value) / range) * (height - 14);
    return {
      x,
      y,
      value,
      time: points[index].captured_at,
    };
  });

  const segments = chartSegments(plotted);
  // Only the period's high and low get a marker; a dot on every sample turned
  // a 90-day line into a string of beads that hid its own shape.
  const marker = (point, name) =>
    `<circle class="${name}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3"></circle>`;
  const extremes = high === low ? "" :
    marker(plotted[values.indexOf(high)], "chart-extreme") + marker(plotted[values.indexOf(low)], "chart-extreme");
  // A segment of one sample has no length to stroke, so it would vanish.
  const lone = segments.filter(segment => segment.length === 1).map(([point]) => marker(point, "chart-lone")).join("");

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${t("chartAria", selectedPair, t(`range${historyDays}`))}">
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#56e39f" stop-opacity=".3"/>
          <stop offset="1" stop-color="#56e39f" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${areaPolygons(segments, height)}
      <path class="chart-line" d="${linePath(segments)}" fill="none" stroke="#56e39f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
      ${lone}${extremes}
      <line class="chart-guide" x1="0" y1="4" x2="0" y2="${height - 2}" stroke="#edf8f2" stroke-opacity=".18" stroke-dasharray="3 4" visibility="hidden"></line>
      <circle class="chart-dot" cx="0" cy="0" r="3.6" fill="#07120e" stroke="#56e39f" stroke-width="2" visibility="hidden"></circle>
      <rect class="chart-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    </svg>
    <div class="chart-tip" aria-hidden="true">
      <small>—</small>
      <b>—</b>
    </div>
  ${points.length === 1 ? `<span class="single-point-note">${t("singlePoint")}</span>` : ""}`;

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const change = points.length > 1 ? (values.at(-1) - values[0]) / values[0] * 100 : null;
  $("stat-high").textContent = formatRate(high);
  $("stat-low").textContent = formatRate(low);
  $("stat-avg").textContent = formatRate(average);
  // Over the selected range, not the last 24 hours, so it always matches the line.
  $("stat-change").textContent = change === null ? "—" : changeText(change);
  $("stat-change").className = change === null ? "" : change >= 0 ? "positive" : "negative";

  const svg = root.querySelector("svg");
  const guide = root.querySelector(".chart-guide");
  const dot = root.querySelector(".chart-dot");
  const hit = root.querySelector(".chart-hit");
  const tip = root.querySelector(".chart-tip");
  const tipTime = tip.querySelector("small");
  const tipValue = tip.querySelector("b");

  const showAt = (index) => {
    const point = plotted[index];
    if (!point) return;
    guide.setAttribute("x1", point.x);
    guide.setAttribute("x2", point.x);
    guide.setAttribute("visibility", "visible");
    dot.setAttribute("cx", point.x);
    dot.setAttribute("cy", point.y);
    dot.setAttribute("visibility", "visible");
    tipTime.textContent = chartTimeLabel(point.time);
    tipValue.textContent = `${selectedPair}  ${formatRate(point.value)}`;
    const percent = width ? (point.x / width) * 100 : 50;
    tip.style.left = `${Math.min(92, Math.max(8, percent))}%`;
    tip.style.top = `${(point.y / height) * 100}%`;
    tip.classList.add("is-on");
  };

  const hideTip = () => {
    guide.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.classList.remove("is-on");
  };

  const pickIndex = (event) => {
    const box = svg.getBoundingClientRect();
    if (!box.width) return 0;
    const ratio = (event.clientX - box.left) / box.width;
    return plotted.reduce((best, point, index) => Math.abs(point.x - ratio * width) < Math.abs(plotted[best].x - ratio * width) ? index : best, 0);
  };

  hit.addEventListener("mousemove", (event) => showAt(pickIndex(event)));
  hit.addEventListener("mouseleave", hideTip);
}

function detailed() {
  return settings.viewMode === "detail";
}

function applyViewMode() {
  document.body.dataset.view = detailed() ? "detail" : "simple";
  $("view-toggle").textContent = detailed() ? t("showSimple") : t("showDetails");
}

async function loadHistory() {
  // Hiding the panels would still spend a request per pair selection on data
  // nobody is looking at, so the simple view never asks for it.
  if (!detailed()) return;
  void loadOfficial();
  const version = ++historyVersion;
  $("trend-title").textContent = t("trendTitleFor", selectedPair);
  $("chart").innerHTML = `<span>${t("loadingChart")}</span>`;
  resetChartStats();
  try {
    let [base, quote] = selectedPair.split("/");
    const inverse = !supportedPairs.includes(selectedPair) && supportedPairs.includes(quote + "/" + base);
    if (!supportedPairs.includes(selectedPair) && !inverse) {
      drawChart([]);
      $("chart").textContent = t("noMarketHistory");
      return;
    }
    if (inverse) [base, quote] = [quote, base];
    let points = await request(`/rates/${base}/${quote}/history?days=${historyDays}`);
    if (inverse) points = points.map(point => ({...point, midpoint: 1 / Number(point.midpoint)}));
    if (version === historyVersion) drawChart(points);
  } catch (error) {
    if (version === historyVersion) {
      drawChart([]);
      $("chart").textContent = error.message;
    }
  }
}

async function selectPair(pair) {
  if (!validPair(pair)) return;
  selectedPair = pair;
  [settings.converterFrom, settings.converterTo] = pair.split("/");
  $("converter-from").value = settings.converterFrom;
  $("converter-to").value = settings.converterTo;
  const conversion = loadConverterRate();
  $("target-pair").value = supportedPairs.includes(pair) ? pair : supportedPairs[0] || "";
  loadTarget();
  const history = loadHistory();
  await chrome.storage.local.set({converterFrom: settings.converterFrom, converterTo: settings.converterTo});
  await Promise.all([conversion, history]);
}

function marketConverterQuote(base, quote) {
  const direct = rates.find(item => item.base_currency === base && item.quote_currency === quote);
  if (direct && Number.isFinite(Number(direct.midpoint)) && Number(direct.midpoint) > 0) return {rate: Number(direct.midpoint), market: direct};
  const reverse = rates.find(item => item.base_currency === quote && item.quote_currency === base);
  if (reverse && Number.isFinite(Number(reverse.midpoint)) && Number(reverse.midpoint) > 0) return {rate: 1 / Number(reverse.midpoint), market: reverse};
  return null;
}

function converterStatus() {
  if (!converterQuote) return t("converterNoRate");
  if (converterQuote.kind === "identity") return t("converterSameCurrency");
  if (converterQuote.kind === "official") {
    const key = INSTITUTIONS[converterQuote.institution];
    const source = t("converterOfficialSource", key ? t(key) : converterQuote.institution, converterQuote.referenceDate);
    return converterQuote.via ? `${source} · ${t("converterViaCurrency", converterQuote.via)}` : source;
  }
  const provider = converterQuote.market.provider === "mock" ? t("mockData") : t("providerLive");
  const freshness = offline ? t("offlineCache") : converterQuote.market.is_stale ? t("outdated") : "";
  return [t("converterMarketSource", provider), freshness].filter(Boolean).join(" · ");
}

function updateConverter() {
  const base = $("converter-from").value;
  const quote = $("converter-to").value;
  $("from-label").textContent = `${t("amountLabel")} (${base})`;
  $("to-label").textContent = `${t("convertedLabel")} (${quote})`;
  $("amount-error").textContent = "";
  $("converter-status").textContent = converterStatus();
  $("conversion-rate").textContent = converterQuote
    ? `1 ${base} ≈ ${formatRate(converterQuote.rate)} ${quote}` : "";
  $("conversion-rate").title = converterQuote
    ? `1 ${base} = ${converterQuote.rate} ${quote}` : "";
  renderRates();
  const market = currentRate();
  $("status").textContent = market ? t("statusLine", chartTimeLabel(market.captured_at),
    market.provider === "mock" ? t("mockData") : t("providerLive")) : converterStatus();
  if (offline) $("status").textContent += " · " + t("offlineCache");
  if (!converterQuote) { $("converted").textContent = "—"; return; }
  const raw = $("amount").value.trim();
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount < 0 || amount > 1e12) {
    $("converted").textContent = "—";
    $("amount-error").textContent = t("amountRange");
    return;
  }
  const value = amount * converterQuote.rate;
  if (!Number.isFinite(value) || converterQuote.rate <= 0) { $("converted").textContent = "—"; return; }
  $("converted").textContent = `${fmt(value, 2)} ${quote}`;
}

function newestOfficial(rows) {
  return Array.isArray(rows) ? rows
    .filter(item => Number.isFinite(Number(item?.rate)) && Number(item.rate) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(item?.reference_date || ""))
    .sort((a, b) => b.reference_date.localeCompare(a.reference_date))[0] || null : null;
}

async function loadConverterRate() {
  const version = ++converterVersion;
  const base = $("converter-from").value;
  const quote = $("converter-to").value;
  converterQuote = null;
  updateConverter();
  $("converter-status").textContent = t("loadingConverterRate");
  if (!base || !quote) return;
  if (base === quote) converterQuote = {kind: "identity", rate: 1};
  else {
    const market = marketConverterQuote(base, quote);
    if (market) converterQuote = {kind: "market", ...market};
  }
  if (converterQuote) { updateConverter(); return; }
  try {
    const rows = await request(`/official-rates/${base}/${quote}`);
    if (version !== converterVersion) return;
    const newest = newestOfficial(rows);
    if (newest) converterQuote = {
      kind: "official", rate: Number(newest.rate), institution: newest.institution,
      referenceDate: newest.reference_date, via: newest.via_currency || null,
    };
  } catch { /* A valid currency can still lack one institution covering both sides. */ }
  if (version === converterVersion) updateConverter();
}

function targetStatus(pair) {
  const target = settings.targets[pair];
  const rate = rates.find((item) => pairOf(item) === pair);
  if (!target || !rate) return t("noTarget");
  if (offline || rate.is_stale) return t("targetPaused");
  const current = Number(rate.midpoint);
  const reached = target.direction === "above" ? current >= target.value : current <= target.value;
  const sign = target.direction === "above" ? "≥" : "≤";
  return t(reached ? "targetReached" : "targetNotReached", sign, target.value);
}

function loadTarget() {
  const pair = $("target-pair").value || selectedPair;
  const target = settings.targets[pair];
  $("target-direction").value = target?.direction || "above";
  $("target-value").value = target?.value || "";
  $("target-message").textContent = targetStatus(pair);
}


async function loadData(force = false) {
  const version = ++refreshVersion;
  $("refresh-button").classList.add("spinning");
  $("error").classList.add("hidden");
  try {
    let nextPairs, nextRates, coverage, snapshotOffline = false;
    if (chrome.runtime?.sendMessage) {
      const [response, nextCoverage] = await Promise.all([
        chrome.runtime.sendMessage({type: "FX_SNAPSHOT", force: force === true}),
        request("/currencies").catch(() => null),
      ]);
      if (!response?.ok) throw new Error(response?.error || t("cannotConnect"));
      ({pairs: nextPairs, rates: nextRates, offline: snapshotOffline} = response.data);
      coverage = nextCoverage;
    } else [nextPairs, nextRates, coverage] = await Promise.all([
      request("/pairs"), request("/rates"), request("/currencies").catch(() => null),
    ]);
    if (version !== refreshVersion) return;
    if (!Array.isArray(nextPairs) || !nextPairs.every(validPair) || !Array.isArray(nextRates) || !nextRates.every(rate => validPair(pairOf(rate)))) throw new Error(t("badFormat"));
    supportedPairs = nextPairs;
    rates = nextRates;
    officialCurrencies = Array.isArray(coverage?.official_currencies)
      ? coverage.official_currencies.filter(currency => /^[A-Z]{3}$/.test(currency)) : officialCurrencies;
    offline = snapshotOffline;
    await reconcileWatchlist();
    if (version !== refreshVersion) return;
    renderRates();
    renderSelects();
    await loadHistory();
    if (version !== refreshVersion) return;
    updateConverter();
    void loadHealth();
  } catch (error) {
    if (version !== refreshVersion) return;
    offline = true;
    historyVersion++;
    officialVersion++;
    converterVersion++;
    renderRates();
    updateConverter();
    loadTarget();
    $("official-rates").replaceChildren();
    resetChartStats();
    $("error").textContent = error.message;
    $("chart").textContent = t("dataUnavailableCheck");
    $("official-status").textContent = t("dataUnavailableCheck");
    $("error").classList.remove("hidden");
    $("status").textContent = t("connectionFailed");
  } finally {
    if (version === refreshVersion) $("refresh-button").classList.remove("spinning");
  }
}

$("refresh-button").addEventListener("click", () => { watchOfficial.clear(); void loadData(true); });
$("watch-add").addEventListener("click", () => { void addWatch(); });
$("watchlist-panel").addEventListener("toggle", () => { void loadWatchRates(); });
$("settings-button").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("view-toggle").addEventListener("click", async () => {
  settings.viewMode = detailed() ? "simple" : "detail";
  applyViewMode();
  await chrome.storage.local.set({viewMode: settings.viewMode});
  // Simple mode skipped these requests, so the panels are empty until now.
  if (detailed()) await loadHistory();
});
$("amount").addEventListener("input", updateConverter);
async function saveConverterCurrencies() {
  await selectPair($("converter-from").value + "/" + $("converter-to").value);
}

$("converter-from").addEventListener("change", () => { void saveConverterCurrencies(); });
$("converter-to").addEventListener("change", () => { void saveConverterCurrencies(); });
$("reverse-button").addEventListener("click", () => {
  const from = $("converter-from").value;
  $("converter-from").value = $("converter-to").value;
  $("converter-to").value = from;
  void saveConverterCurrencies();
});
$("target-pair").addEventListener("change", loadTarget);
$("target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pair = $("target-pair").value;
  const value = Number($("target-value").value);
  // A blank or zero target used to be stored as 0, which reads as "reached" forever.
  if (!Number.isFinite(value) || value <= 0 || value > 1e12) {
    $("target-message").textContent = t("targetPositive");
    return;
  }
  settings.targets[pair] = { direction: $("target-direction").value, value };
  await chrome.storage.local.set({ targets: settings.targets });
  loadTarget();
});
$("range-buttons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-days]");
  const days = Number(button?.dataset.days);
  if (!RANGE_DAYS.includes(days) || days === historyDays) return;
  historyDays = days;
  document.querySelectorAll("#range-buttons button").forEach((item) =>
    item.classList.toggle("selected", Number(item.dataset.days) === days));
  void loadHistory();
});
$("copy-button").addEventListener("click", async () => {
  const rate = currentRate();
  if (!rate && !converterQuote) return;
  const text = `${selectedPair} ${rate ? rate.midpoint : converterQuote.rate}`;
  try {
    await navigator.clipboard.writeText(text);
    $("copy-button").textContent = t("copied");
    setTimeout(() => $("copy-button").textContent = t("copyRate"), 1200);
  } catch {
    $("copy-fallback").classList.remove("hidden");
    $("copy-value").value = text;
    $("copy-value").focus();
    $("copy-value").select();
  }
});

let officialVersion = 0;
async function loadOfficial() {
  const version = ++officialVersion;
  const pair = selectedPair;
  $("official-title").textContent = t("officialTitleFor", pair);
  $("official-status").textContent = t("loadingOfficial");
  $("official-rates").replaceChildren();
  try {
    const data = pair.split("/")[0] === pair.split("/")[1] ? {official: []} : await request(`/comparisons/${pair}`);
    if (version !== officialVersion) return;
    const rows = data.official || [];
    $("official-status").textContent = rows.length ? t("officialDaily") : t("noOfficial");
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "official-row";
      const label = document.createElement("div");
      const name = document.createElement("b");
      name.textContent = INSTITUTIONS[item.institution] ? t(INSTITUTIONS[item.institution]) : item.institution;
      const date = document.createElement("small");
      const notes = [item.reference_date];
      if (item.via_currency) notes.push(t("converterViaCurrency", item.via_currency));
      else if (item.is_derived) notes.push(t("crossRate"));
      // A source that quietly stopped publishing looks identical to a fresh one
      // unless its age is spelled out.
      const age = Math.floor((Date.now() - Date.parse(`${item.reference_date}T00:00:00Z`)) / 86400000);
      if (Number.isFinite(age) && age >= 3) {
        notes.push(t("sourceStale", age));
        date.classList.add("stale");
      }
      date.textContent = notes.join(" · ");
      label.append(name, date);
      const value = document.createElement("div");
      value.className = "official-value";
      const number = document.createElement("strong");
      number.textContent = formatRate(item.rate);
      value.append(number);
      row.append(label, value);
      $("official-rates").append(row);
    }
  } catch {
    if (version === officialVersion) $("official-status").textContent = t("officialUnavailable");
  }
}

async function loadHealth() {
  // Advisory only: tells "the collector stopped" apart from "this quote is old".
  try {
    let data;
    if (chrome.runtime?.sendMessage) {
      const reply = await chrome.runtime.sendMessage({type: "FX_HEALTH"});
      if (!reply?.ok) return;
      data = reply.data;
    } else {
      const response = await fetch(`${new URL(settings.apiUrl).origin}/health`);
      if (!response.ok) return;
      data = await response.json();
    }
    const jobs = Array.isArray(data?.collector) ? data.collector : [];
    if (jobs.some((job) => job?.is_stalled)) $("status").textContent += ` · ${t("collectorStopped")}`;
  } catch { /* never let a health probe break the popup */ }
}

async function init() {
  await globalThis.FXI18N?.ready;
  settings = await chrome.storage.local.get(DEFAULTS);
  $("target-mode").textContent = t(settings.alertsEnabled ? "targetBackground" : "targetOnOpen");
  settings.watchlist = Array.isArray(settings.watchlist) ? settings.watchlist.filter(validPair) : [...DEFAULTS.watchlist];
  if (!settings.watchlist.length) settings.watchlist = [...DEFAULTS.watchlist];
  applyViewMode();
  await loadData();
}

init();
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.apiUrl) { converterVersion++; converterQuote = null; officialCurrencies = []; rates = []; watchOfficial.clear(); }
  if (changes.apiUrl || changes.watchlist) void init();
  if (changes.language) globalThis.location.reload();
});
