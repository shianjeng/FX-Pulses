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
let live = null;
const validPair = pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair);

const RANGE_DAYS = [1, 7, 30, 90, 365];
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
const institutionName = name => String(name).split(" + ")
  .map(part => INSTITUTIONS[part] ? t(INSTITUTIONS[part]) : part).join(" + ");
const fmt = (value, digits = 4) => Number(value).toLocaleString(docLocale(), {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
/* Money in the target currency's own minor unit (0 for JPY and KRW, 3 for KWD),
   as the hover card shows it; "147,912.00 JPY" had decimals yen do not have.
   Below one unit, two significant digits survive instead of rounding a real
   amount to 0.00. hover.js applies the same rule. */
function minorUnits(code) {
  try { return new Intl.NumberFormat("en", {style: "currency", currency: code}).resolvedOptions().maximumFractionDigits; }
  catch { return 2; }
}
function formatMoney(amount, code) {
  const small = amount > 0 && amount < 1 ? Math.min(8, Math.ceil(-Math.log10(amount)) + 1) : 0;
  return fmt(amount, Math.max(minorUnits(code), small));
}
// "3 hours ago" next to the clock time: a time alone did not say whether it was old.
function timeAgo(value) {
  const minutes = Math.round((Date.now() - parseUtc(value)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  const relative = new Intl.RelativeTimeFormat(docLocale(), {numeric: "auto"});
  // A live rate fetched seconds ago reads "now", not "1 minute ago".
  const text = minutes < 1 ? relative.format(0, "second") : minutes < 60 ? relative.format(-minutes, "minute")
    : minutes < 2880 ? relative.format(-Math.round(minutes / 60), "hour")
      : relative.format(-Math.round(minutes / 1440), "day");
  return t("timeAgo", text);
}
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
  // A live rate has no bid or ask of its own; the backend's would be hours older.
  const detail = rate.live ? `<span class="pro-only">${t("converterLiveSource")}</span>`
    : `<span class="pro-only">${t("bid")} ${formatRate(rate.bid)} · ${t("ask")} ${formatRate(rate.ask)}</span>`;
  const [state, label] = rate.live ? ["live", t("liveBadge")] : offline ? ["stale", t("offlineCache")]
    : rate.is_stale ? ["stale", t("outdated")] : ["", t("updated")];
  return `<button class="rate-card ${pair === selectedPair ? "selected" : ""}" data-pair="${pair}">
    <div class="rate-top"><span class="pair">${pair}</span><span class="change ${rate.change_percent === null || rate.change_percent === undefined ? "" : change >= 0 ? "positive" : "negative"}">${changeText(rate.change_percent)}</span></div>
    <strong>${formatRate(rate.midpoint)}</strong>
    <div class="rate-bottom">${detail}<span class="${state}">${label}</span></div>
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

/* Live mid-market rates (Coinbase, through the worker's one-minute cache): the
   number shown and converted with whenever they are on and current. History,
   bid/ask and official references still come from the backend. */
const LIVE_FRESH_MS = 10 * 60000;
const liveCurrent = () => live && Date.now() - live.fetchedAt <= LIVE_FRESH_MS ? live : null;
function liveRate(base, quote) {
  const value = liveCurrent()?.rates?.[quote] / liveCurrent()?.rates?.[base];
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function loadLive(force = false) {
  if (!chrome.runtime?.sendMessage) return;
  try {
    const reply = await chrome.runtime.sendMessage({type: "FX_LIVE", force: force === true});
    const data = reply?.ok ? reply.data : null;
    live = data?.rates && typeof data.rates === "object" && Number.isFinite(data.fetchedAt) ? data : null;
  } catch { live = null; }
}

// What the card shows: the live rate when there is one, over the backend's quote.
function shownRate() {
  const market = currentRate();
  const [base, quote] = selectedPair.split("/");
  const value = liveRate(base, quote);
  if (value === null) return market;
  return {...market, base_currency: base, quote_currency: quote, midpoint: value, live: true,
    change_percent: market?.change_percent ?? null, captured_at: new Date(live.fetchedAt).toISOString(), is_stale: false};
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
  const current = liveRate(base, quote);
  if (current !== null) return current;
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
    return liveRate(base, quote) === null && !marketConverterQuote(base, quote) && !watchOfficial.has(pair);
  });
  await Promise.all(missing.map(async pair => {
    try {
      const chosen = preferredOfficial(await request(`/official-rates/${pair}`));
      if (chosen) watchOfficial.set(pair, Number(chosen.rate));
    } catch { /* Shown as "—"; the next opening tries again. */ }
  }));
  if (version === watchVersion) renderWatchlist();
}

function renderRates() {
  const rate = shownRate();
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
    // Without a market quote the subtitle already carries this exact sentence;
    // only the offline notice says something the subtitle does not.
    source.hidden = !offline;
    card.append(title, value, source);
    $("rates").append(card);
  }
  $("copy-button").disabled = (offline && !rate?.live) || (!rate && !converterQuote);
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
    // Every currency the live rates cover, about 160 of them.
    ...Object.keys(liveCurrent()?.rates || {}),
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
function chartSegments(points, daily = false) {
  const gaps = points.slice(1)
    .map((point, index) => parseUtc(point.time) - parseUtc(points[index].time))
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[(gaps.length - 1) >> 1] : 0;
  // A daily series skips weekends and holidays by design; only a longer silence is a gap.
  const limit = Math.max(typical * 2.5, daily ? 6 * 86400000 : 60000);
  const segments = [];
  points.forEach((point, index) => {
    if (!index || parseUtc(point.time) - parseUtc(points[index - 1].time) > limit) segments.push([]);
    segments.at(-1).push(point);
  });
  return segments;
}

/* A smooth line that still cannot invent a high or low between two samples:
   monotone cubic interpolation (Steffen's method, as d3's curveMonotoneX).
   Every Bezier keeps its control points within its two samples' values, so
   the curve does too, and a flat run stays flat. Two samples stay a straight
   line. The straight polyline this replaces read as jagged and stiff. */
function smoothPath(segment) {
  const f = value => value.toFixed(2);
  const [first] = segment, n = segment.length;
  if (n < 3) return segment.map((point, index) => `${index ? "L" : "M"} ${f(point.x)} ${f(point.y)}`).join(" ");
  const slope = segment.slice(1).map((point, index) => {
    const dx = point.x - segment[index].x;
    return dx ? (point.y - segment[index].y) / dx : 0;
  });
  const tangent = segment.map((point, i) => {
    if (!i || i === n - 1) return 0;
    const h0 = point.x - segment[i - 1].x, h1 = segment[i + 1].x - point.x;
    const s0 = slope[i - 1], s1 = slope[i], mean = (s0 * h1 + s1 * h0) / ((h0 + h1) || 1);
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(mean)) || 0;
  });
  tangent[0] = (3 * slope[0] - tangent[1]) / 2;
  tangent[n - 1] = (3 * slope[n - 2] - tangent[n - 2]) / 2;
  let path = `M ${f(first.x)} ${f(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = segment[i], b = segment[i + 1], third = (b.x - a.x) / 3;
    path += ` C ${f(a.x + third)} ${f(a.y + third * tangent[i])} ${f(b.x - third)} ${f(b.y - third * tangent[i + 1])} ${f(b.x)} ${f(b.y)}`;
  }
  return path;
}

/* Filled per segment and closed straight down to the baseline, so an outage
   stays a visible gap instead of a slope, and a lone sample never becomes a
   filled triangle. */
function areaPaths(segments, height) {
  return segments.filter(segment => segment.length > 1).map(segment =>
    `<path class="chart-area" d="${smoothPath(segment)} L ${segment.at(-1).x.toFixed(2)} ${height} L ${segment[0].x.toFixed(2)} ${height} Z" fill="url(#chart-fill)"></path>`).join("");
}

// Round steps for the price scale: 157.0 / 157.5 / 158.0, not 157.182 / 157.713.
function axisTicks(low, high) {
  const raw = (high - low) / 5;
  if (!(raw > 0)) return {ticks: [], digits: 0};
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(candidate => candidate >= raw * 0.999);
  let digits = 0;
  while (digits < 8 && Math.abs(Math.round(step * 10 ** digits) - step * 10 ** digits) > 1e-6) digits++;
  const ticks = [];
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) ticks.push(value);
  return {ticks, digits};
}

function resetChartStats() {
  ["stat-high", "stat-low", "stat-avg", "stat-change"].forEach(id => { $(id).textContent = "—"; });
  $("stat-change").className = "";
}

const CHART_HEIGHT = 132;   // plot height in px; the time axis sits below it
const CHART_GUTTER = 44;    // right-hand price scale

function drawChart(points, {daily = false} = {}) {
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
  // Measured, so one SVG unit is one pixel and the labels line up with the line.
  const width = root.clientWidth || 340 + CHART_GUTTER;
  const plotWidth = width - CHART_GUTTER;
  const height = CHART_HEIGHT;
  // Headroom above the high and below the low; a flat period sits mid-height.
  const pad = (high - low) * 0.18 || Math.abs(high) * 0.001 || 1;
  const top = high + pad, bottom = low - pad;
  const yOf = value => (top - value) / (top - bottom) * height;
  const start = parseUtc(points[0].captured_at);
  const duration = parseUtc(points.at(-1).captured_at) - start;
  const plotted = values.map((value, index) => ({
    x: duration ? (parseUtc(points[index].captured_at) - start) / duration * plotWidth : plotWidth / 2,
    y: yOf(value),
    value,
    time: points[index].captured_at,
  }));

  const segments = chartSegments(plotted, daily);
  const f = value => value.toFixed(2);
  // Only the period's high and low get a marker; a dot on every sample turned
  // a 90-day line into a string of beads that hid its own shape.
  const marker = (point, name, r = 3) => `<circle class="${name}" cx="${f(point.x)}" cy="${f(point.y)}" r="${r}"></circle>`;
  const extremes = high === low ? "" :
    marker(plotted[values.indexOf(high)], "chart-extreme") + marker(plotted[values.indexOf(low)], "chart-extreme");
  // A segment of one sample has no length to stroke, so it would vanish.
  const lone = segments.filter(segment => segment.length === 1).map(([point]) => marker(point, "chart-lone")).join("");
  // An outage is a faint dashed span with no fill under it: visibly missing,
  // without breaking the line into unrelated pieces.
  const gaps = segments.slice(1).map((segment, index) => {
    const from = segments[index].at(-1), to = segment[0];
    return `<path class="chart-gap" d="M ${f(from.x)} ${f(from.y)} L ${f(to.x)} ${f(to.y)}" fill="none"></path>`;
  }).join("");
  const latest = plotted.at(-1);
  const now = marker(latest, "chart-now-halo", 4) + marker(latest, "chart-now", 3.5);
  const {ticks, digits} = axisTicks(bottom, top);
  const scale = ticks.filter(value => yOf(value) > 8 && yOf(value) < height - 8);
  const grid = scale.map(value => `<line class="chart-grid" x1="0" x2="${f(plotWidth)}" y1="${f(yOf(value))}" y2="${f(yOf(value))}"></line>`).join("");
  const priceLabels = scale.map(value => `<span class="chart-y" style="left:${f(plotWidth + 8)}px;top:${f(yOf(value))}px">${fmt(value, digits)}</span>`).join("");
  // A year runs from one October to the next, so its ends are told apart by the year.
  const stamp = time => new Date(time).toLocaleString(docLocale(), historyDays === 1
    ? {hour: "2-digit", minute: "2-digit", hourCycle: "h23"}
    : historyDays === 365 ? {year: "numeric", month: "numeric"} : {month: "numeric", day: "numeric"});
  const timeLabels = (duration ? [[0, start], [0.5, start + duration / 2], [1, start + duration]] : [[0.5, start]])
    .map(([share, time]) => `<span style="left:${f(share * plotWidth)}px;transform:translateX(-${share * 100}%)">${stamp(time)}</span>`).join("");
  const line = segments.map(smoothPath).join(" ");

  root.innerHTML = `
    <div class="chart-plot">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${t("chartAria", selectedPair, t(`range${historyDays}`))}">
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-opacity=".26"/>
            <stop offset="1" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}${areaPaths(segments, height)}${gaps}
        <path class="chart-line" d="${line}" fill="none" pathLength="1"></path>
        ${lone}${extremes}${now}
        <line class="chart-guide" x1="0" y1="0" x2="0" y2="${height}" visibility="hidden"></line>
        <circle class="chart-dot" cx="0" cy="0" r="4" visibility="hidden"></circle>
        <rect class="chart-hit" x="0" y="0" width="${f(plotWidth)}" height="${height}" fill="transparent"></rect>
      </svg>
      ${priceLabels}
    </div>
    <div class="chart-x">${timeLabels}</div>
    <div class="chart-tip" aria-hidden="true">
      <small>—</small>
      <b>—</b>
      <em></em>
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
  const tipChange = tip.querySelector("em");

  const showAt = (index) => {
    const point = plotted[index];
    if (!point) return;
    guide.setAttribute("x1", point.x);
    guide.setAttribute("x2", point.x);
    guide.setAttribute("visibility", "visible");
    dot.setAttribute("cx", point.x);
    dot.setAttribute("cy", point.y);
    dot.setAttribute("visibility", "visible");
    // A daily reference has a date, not a time of day.
    tipTime.textContent = daily
      ? point.time.slice(historyDays === 365 ? 0 : 5, 10).split("-").map(Number).join("/") : chartTimeLabel(point.time);
    tipValue.textContent = `${selectedPair}  ${formatRate(point.value)}`;
    // How far this sample is from the start of the range.
    const moved = (point.value - values[0]) / values[0] * 100;
    tipChange.textContent = index ? changeText(moved) : "";
    tipChange.className = moved >= 0 ? "positive" : "negative";
    tip.style.left = `${Math.min(width - 64, Math.max(64, point.x))}px`;
    tip.style.top = `${point.y}px`;
    // Near the top the tip would cover the range tabs, so it opens below the point.
    tip.classList.toggle("below", point.y < 64);
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
    const x = (event.clientX - box.left) / box.width * width;
    return plotted.reduce((best, point, index) => Math.abs(point.x - x) < Math.abs(plotted[best].x - x) ? index : best, 0);
  };

  // Pointer events, so a pen or a finger on a touch screen reads the line too.
  hit.addEventListener("pointerdown", (event) => showAt(pickIndex(event)));
  hit.addEventListener("pointermove", (event) => showAt(pickIndex(event)));
  hit.addEventListener("pointerleave", hideTip);
}

function detailed() {
  return settings.viewMode === "detail";
}

function applyViewMode() {
  document.body.dataset.view = detailed() ? "detail" : "simple";
  $("view-toggle").textContent = detailed() ? t("showSimple") : t("showDetails");
}

/* The ECB's daily reference rates for one pair, from a file holding one column
   per currency against EUR: a cross is one column divided by another, the same
   arithmetic as the backend's OfficialTable.quote. */
function referenceSeries(data, base, quote, days) {
  const dates = Array.isArray(data?.dates) ? data.dates : [];
  const column = code => code === data?.anchor_currency ? dates.map(() => 1) : data?.rates?.[code];
  const from = column(base), to = column(quote);
  if (!Array.isArray(from) || !Array.isArray(to)) return [];
  const since = Date.now() - days * 86400000;
  return dates.map((date, index) => ({midpoint: Number(to[index]) / Number(from[index]), captured_at: `${date}T12:00:00Z`}))
    .filter(point => Number.isFinite(point.midpoint) && point.midpoint > 0 && Date.parse(point.captured_at) >= since);
}

function showHistory(points, source, daily = false) {
  drawChart(points, {daily});
  $("chart-source").textContent = source;
}

async function loadHistory() {
  // Hiding the panels would still spend a request per pair selection on data
  // nobody is looking at, so the simple view never asks for it.
  if (!detailed()) return;
  void loadOfficial();
  const version = ++historyVersion;
  $("trend-title").textContent = t("trendTitleFor", selectedPair);
  $("chart").innerHTML = `<span>${t("loadingChart")}</span>`;
  $("chart-source").textContent = "";
  resetChartStats();
  try {
    const [base, quote] = selectedPair.split("/");
    const inverse = !supportedPairs.includes(selectedPair) && supportedPairs.includes(`${quote}/${base}`);
    let market = [];
    if (supportedPairs.includes(selectedPair) || inverse) {
      const [from, to] = inverse ? [quote, base] : [base, quote];
      market = await request(`/rates/${from}/${to}/history?days=${historyDays}`);
      if (inverse) market = market.map(point => ({...point, midpoint: 1 / Number(point.midpoint)}));
    }
    if (version !== historyVersion) return;
    // Collected quotes while they span the range. Collection began on 23
    // September 2026, so one month or three used to show that one week
    // stretched out; before the collector catches up, and for every pair it
    // does not track, the ECB's daily reference rates give the real line.
    const first = market.length ? parseUtc(market[0].captured_at) : Infinity;
    if (market.length && (historyDays === 1 || first <= Date.now() - historyDays * 86400000 * 0.85)) {
      showHistory(market, t("chartSourceMarket"));
      return;
    }
    const reference = referenceSeries(await request("/reference-history").catch(() => null), base, quote, historyDays);
    if (version !== historyVersion) return;
    if (reference.length > 1) showHistory(reference, t("chartSourceReference"), true);
    else if (market.length) showHistory(market, t("chartSourceMarket"));
    else {
      drawChart([]);
      $("chart").textContent = t("noMarketHistory");
    }
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
  if (converterQuote.kind === "live") return t("converterLiveSource");
  if (converterQuote.kind === "official") {
    const source = t("converterOfficialSource", institutionName(converterQuote.institution), converterQuote.referenceDate);
    return converterQuote.via ? `${source} · ${t("converterViaCurrency", converterQuote.via)}` : source;
  }
  const provider = converterQuote.market.provider === "mock" ? t("mockData") : t("providerLive");
  const freshness = offline ? t("offlineCache") : converterQuote.market.is_stale ? t("outdated") : "";
  return [t("converterMarketSource", provider), freshness].filter(Boolean).join(" · ");
}

/* Either box takes a figure, and the other is worked out from it. The box typed
   into last is the anchor: a change of currency, a refresh or a live update
   recomputes the other box from it, and the swap button swaps only the
   currencies, so the figure typed stays where it is. */
let anchor = "from";

// "1,000", "1 000" and a full-width "１，０００" all read as 1000.
function parseAmount(raw) {
  const text = String(raw).trim()
    .replace(/[\uFF10-\uFF19]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/\uFF0E/g, ".")
    .replace(/[,\uFF0C\s\u00A0\u202F']/g, "");
  return /^(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
}

function updateConverter() {
  const base = $("converter-from").value;
  const quote = $("converter-to").value;
  const reverse = anchor === "to";
  const typed = reverse ? $("converted") : $("amount");
  const worked = reverse ? $("amount") : $("converted");
  $("from-label").textContent = `${t(reverse ? "convertedLabel" : "amountLabel")} (${base})`;
  $("to-label").textContent = `${t(reverse ? "amountLabel" : "convertedLabel")} (${quote})`;
  $("from-code").textContent = base;
  $("to-code").textContent = quote;
  typed.parentElement.classList.remove("computed");
  worked.parentElement.classList.add("computed");
  $("amount-error").textContent = "";
  $("converter-status").textContent = converterStatus();
  $("conversion-rate").textContent = converterQuote
    ? `1 ${base} ≈ ${formatRate(converterQuote.rate)} ${quote}` : "";
  $("conversion-rate").title = converterQuote
    ? `1 ${base} = ${converterQuote.rate} ${quote}` : "";
  renderRates();
  const shown = shownRate();
  $("status").textContent = shown ? t("statusLine", chartTimeLabel(shown.captured_at) + timeAgo(shown.captured_at),
    shown.live ? t("liveSource") : shown.provider === "mock" ? t("mockData") : t("providerLive")) : converterStatus();
  // Same reason: for an official-only pair the subtitle states the source, so a
  // third copy under the converter was noise. A market pair's line differs.
  $("converter-status").hidden = !shown;
  if (offline && !shown?.live) $("status").textContent += " · " + t("offlineCache");
  if (!converterQuote) { worked.value = ""; return; }
  const amount = parseAmount(typed.value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) {
    worked.value = "";
    $("amount-error").textContent = t("amountRange");
    return;
  }
  const value = reverse ? amount / converterQuote.rate : amount * converterQuote.rate;
  if (!Number.isFinite(value) || converterQuote.rate <= 0) { worked.value = ""; return; }
  worked.value = formatMoney(value, reverse ? base : quote);
}

/* Which official reference to convert with when several institutions publish
   a pair. The newest used to win, which on a Monday morning meant the People's
   Bank of China for almost everything, pairs without CNY included: its CNY
   fixing is administered and sat 0.42% from the market, and every cross through
   it inherited that. Against same-moment market quotes and two independent
   daily sources across 37 currencies (2026-09-28), the median error was 0.05%
   for the Bank of Canada, 0.08% for the ECB, 0.27% for the PBOC, 0.53% for the
   Bank of Japan and 0.54% for the Federal Reserve, which publishes a week late.
   Rank by that; freshness only decides among references within four days of
   the newest, so a weekend never pushes Friday's ECB rate aside, while a source
   that stopped publishing does lose its place. hover.js applies the same rule. */
const OFFICIAL_RANK = {"Bank of Canada": 0, "European Central Bank": 0, "People's Bank of China": 1, "Bank of Japan": 1, "Federal Reserve Board": 2};
const OFFICIAL_FRESH_MS = 4 * 86400000;
function preferredOfficial(rows) {
  const valid = Array.isArray(rows) ? rows.filter(item => Number.isFinite(Number(item?.rate)) && Number(item.rate) > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(item?.reference_date || "")) : [];
  if (!valid.length) return null;
  const day = item => Date.parse(`${item.reference_date}T00:00:00Z`);
  const newest = Math.max(...valid.map(day));
  // A bridge through a second institution compounds two references.
  const rank = item => item.via_currency ? 9 : OFFICIAL_RANK[item.institution] ?? 5;
  return valid.filter(item => newest - day(item) <= OFFICIAL_FRESH_MS)
    .sort((a, b) => rank(a) - rank(b) || day(b) - day(a))[0];
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
    const current = liveRate(base, quote);
    const market = marketConverterQuote(base, quote);
    if (current !== null) converterQuote = {kind: "live", rate: current};
    else if (market) converterQuote = {kind: "market", ...market};
  }
  if (converterQuote) { updateConverter(); return; }
  try {
    const rows = await request(`/official-rates/${base}/${quote}`);
    if (version !== converterVersion) return;
    const chosen = preferredOfficial(rows);
    if (chosen) converterQuote = {
      kind: "official", rate: Number(chosen.rate), institution: chosen.institution,
      referenceDate: chosen.reference_date, via: chosen.via_currency || null,
    };
  } catch { /* A valid currency can still lack one institution covering both sides. */ }
  if (version === converterVersion) updateConverter();
}

function targetStatus(pair) {
  const target = settings.targets[pair];
  const rate = rates.find((item) => pairOf(item) === pair);
  const liveValue = liveRate(...pair.split("/"));
  const current = liveValue ?? (rate ? Number(rate.midpoint) : null);
  if (!target || current === null) return t("noTarget");
  if (liveValue === null && (offline || rate.is_stale)) return t("targetPaused");
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
        loadLive(force),
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
    $("chart-source").textContent = "";
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
$("amount").addEventListener("input", () => { anchor = "from"; updateConverter(); });
$("converted").addEventListener("input", () => { anchor = "to"; updateConverter(); });
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
  const rate = shownRate();
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
      name.textContent = institutionName(item.institution);
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
// While the popup stays open the live rate follows the market, about once a
// minute; history and official references are left as they are.
if (chrome.runtime?.sendMessage) globalThis.setInterval(async () => {
  await loadLive();
  const [base, quote] = [$("converter-from").value, $("converter-to").value];
  if (converterQuote?.kind === "live" || (base !== quote && liveRate(base, quote) !== null)) void loadConverterRate();
  else renderRates();
  loadTarget();
}, 60000);
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.liveRates) { live = null; void loadData(); }
  if (changes.apiUrl) { converterVersion++; converterQuote = null; officialCurrencies = []; rates = []; watchOfficial.clear(); }
  if (changes.apiUrl || changes.watchlist) void init();
  if (changes.language) globalThis.location.reload();
});
