const DEFAULTS = {
  apiUrl: "http://localhost:8000/api/v1",
  watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"],
  targets: {},
  alertsEnabled: false,
};

let settings = { ...DEFAULTS };
let rates = [];
let selectedPair = "USD/CNY";
let reversed = false;
let historyVersion = 0;
let refreshVersion = 0;
let supportedPairs = [];
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
  const digits = pair.includes("JPY") ? 3 : 4;
  return `<button class="rate-card ${pair === selectedPair ? "selected" : ""}" data-pair="${pair}">
    <div class="rate-top"><span class="pair">${pair}</span><span class="change ${rate.change_percent === null || rate.change_percent === undefined ? "" : change >= 0 ? "positive" : "negative"}">${changeText(rate.change_percent)}</span></div>
    <strong>${fmt(rate.midpoint, digits)}</strong>
    <div class="rate-bottom"><span>${t("bid")} ${fmt(rate.bid, digits)} · ${t("ask")} ${fmt(rate.ask, digits)}</span><span class="${offline || rate.is_stale ? "stale" : ""}">${offline ? t("offlineCache") : rate.is_stale ? t("outdated") : t("updated")}</span></div>
    <small class="quote-time">${chartTimeLabel(rate.captured_at)}</small>
  </button>`;
}

function currentRate() {
  return rates.find((rate) => pairOf(rate) === selectedPair);
}

async function reconcileWatchlist() {
  if (!settings.watchlist.includes(selectedPair)) selectedPair = settings.watchlist[0];
}

function renderRates() {
  $("rates").innerHTML = settings.watchlist.map(pair => {
    const rate = rates.find(item => pairOf(item) === pair);
    return rate ? rateCard(rate) : `<button class="rate-card ${pair === selectedPair ? "selected" : ""}" data-pair="${pair}"><span class="pair">${pair}</span><strong>—</strong><span>${offline ? t("dataUnavailable") : supportedPairs.includes(pair) ? t("waitingCollection") : t("pairNotConfigured")}</span></button>`;
  }).join("");
  $("copy-button").disabled = offline || !currentRate();
  document.querySelectorAll(".rate-card").forEach((card) => card.addEventListener("click", () => selectPair(card.dataset.pair)));
}

function renderSelects() {
  const pairs = [...new Set([...supportedPairs, ...settings.watchlist])];
  const options = pairs.map(pair => `<option value="${pair}">${pair}</option>`).join("");
  $("converter-pair").innerHTML = options;
  $("target-pair").innerHTML = options;
  $("converter-pair").value = selectedPair;
  $("target-pair").value = selectedPair;
  $("watchlist-options").innerHTML = pairs.map((pair) => {
    return `<label class="watch-option"><span>${pair}</span><input type="checkbox" value="${pair}" ${settings.watchlist.includes(pair) ? "checked" : ""}></label>`;
  }).join("");
  document.querySelectorAll(".watch-option input").forEach((input) => input.addEventListener("change", saveWatchlist));
  updateConverter();
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

function smoothPath(points) {
  // Straight segments cannot invent extrema between observations. The break
  // threshold follows the observed sampling interval instead of a hardcoded six
  // hours, which turned the whole line into loose dots on slower collectors.
  const gaps = points.slice(1)
    .map((point, index) => parseUtc(point.time) - parseUtc(points[index].time))
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[(gaps.length - 1) >> 1] : 0;
  const limit = Math.max(typical * 2.5, 60000);
  return points.map((point, index) => {
    const gap = index && parseUtc(point.time) - parseUtc(points[index - 1].time) > limit;
    return `${!index || gap ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(" ");
}

function drawChart(points) {
  const root = $("chart");
  points = points.filter(point => Number.isFinite(Number(point.midpoint)) && Number(point.midpoint) > 0 && Number.isFinite(parseUtc(point.captured_at))).sort((a,b) => parseUtc(a.captured_at) - parseUtc(b.captured_at));
  if (!points.length) {
    root.innerHTML = `<span>${t("chartCollecting")}</span>`;
    ["stat-low", "stat-high", "stat-position"].forEach((id) => {
      $(id).textContent = "—";
    });
    return;
  }

  const values = points.map((point) => Number(point.midpoint));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const width = 340;
  const height = 82;
  const range = high - low || 1;
  const start = parseUtc(points[0].captured_at);
  const duration = parseUtc(points.at(-1).captured_at) - start;
  const digits = selectedPair.includes("JPY") ? 3 : 4;
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

  const line = smoothPath(plotted);

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${t("chartAria", selectedPair, t(`range${historyDays}`))}">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#56e39f" stop-opacity=".22"/>
          <stop offset="1" stop-color="#56e39f" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${line}" fill="none" stroke="#56e39f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
      ${plotted.map(point => `<circle cx="${point.x}" cy="${point.y}" r="2.5" fill="#168b79"/>`).join("")}
      <line class="chart-guide" x1="0" y1="4" x2="0" y2="${height - 2}" stroke="#edf8f2" stroke-opacity=".18" stroke-dasharray="3 4" visibility="hidden"></line>
      <circle class="chart-dot" cx="0" cy="0" r="3.6" fill="#07120e" stroke="#56e39f" stroke-width="2" visibility="hidden"></circle>
      <rect class="chart-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    </svg>
    <div class="chart-tip" aria-hidden="true">
      <small>—</small>
      <b>—</b>
    </div>
  ${points.length === 1 ? `<span class="single-point-note">${t("singlePoint")}</span>` : ""}`;

  $("stat-low").textContent = fmt(low, digits);
  $("stat-high").textContent = fmt(high, digits);
  const position = high === low ? 50 : ((values.at(-1) - low) / (high - low)) * 100;
  $("stat-position").textContent = `${position.toFixed(0)}%`;

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
    tipValue.textContent = `${selectedPair}  ${fmt(point.value, digits)}`;
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

async function loadHistory() {
  void loadOfficial();
  const version = ++historyVersion;
  $("trend-title").textContent = t("trendTitleFor", selectedPair);
  const rate = currentRate();
  const change = Number(rate?.change_percent || 0);
  $("trend-change").textContent = t("change24h", changeText(rate?.change_percent));
  $("trend-change").className = `change ${rate?.change_percent === null || rate?.change_percent === undefined ? "" : change >= 0 ? "positive" : "negative"}`;
  $("chart").innerHTML = `<span>${t("loadingChart")}</span>`;
  ["stat-low", "stat-high", "stat-position"].forEach(id => $(id).textContent = "—");
  try {
    const [base, quote] = selectedPair.split("/");
    const points = await request(`/rates/${base}/${quote}/history?days=${historyDays}`);
    if (version === historyVersion) drawChart(points);
  } catch (error) {
    if (version === historyVersion) {
      drawChart([]);
      $("chart").textContent = error.message;
    }
  }
}

async function selectPair(pair) {
  selectedPair = pair;
  renderRates();
  $("converter-pair").value = pair;
  $("target-pair").value = pair;
  reversed = false;
  updateConverter();
  loadTarget();
  await loadHistory();
}

function updateConverter() {
  const pair = $("converter-pair").value || selectedPair;
  const rate = rates.find((item) => pairOf(item) === pair);
  const [base, quote] = pair.split("/");
  $("from-label").textContent = reversed ? quote : base;
  $("to-label").textContent = reversed ? base : quote;
  $("amount-error").textContent = "";
  $("converter-status").textContent = offline ? t("offlineCache") : rate?.is_stale ? t("outdated") : "";
  if (!rate) { $("converted").textContent = "—"; return; }
  const raw = $("amount").value.trim();
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount < 0 || amount > 1e12) {
    $("converted").textContent = "—";
    $("amount-error").textContent = t("amountRange");
    return;
  }
  const midpoint = Number(rate.midpoint);
  const value = reversed ? amount / midpoint : amount * midpoint;
  if (!Number.isFinite(value) || midpoint <= 0) { $("converted").textContent = "—"; return; }
  $("from-label").textContent = reversed ? quote : base;
  $("to-label").textContent = reversed ? base : quote;
  $("converted").textContent = `${fmt(value, 2)} ${reversed ? base : quote}`;
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

async function saveWatchlist() {
  const checked = [...document.querySelectorAll(".watch-option input:checked")].map((input) => input.value);
  if (!checked.length) {
    this.checked = true;
    return;
  }
  settings.watchlist = checked;
  await chrome.storage.local.set({ watchlist: checked });
  await reconcileWatchlist();
  renderRates();
  renderSelects();
  await loadHistory();
}

async function loadData(force = false) {
  const version = ++refreshVersion;
  $("refresh-button").classList.add("spinning");
  $("error").classList.add("hidden");
  try {
    let nextPairs, nextRates, snapshotOffline = false;
    if (chrome.runtime?.sendMessage) {
      const response = await chrome.runtime.sendMessage({type: "FX_SNAPSHOT", force: force === true});
      if (!response?.ok) throw new Error(response?.error || t("cannotConnect"));
      ({pairs: nextPairs, rates: nextRates, offline: snapshotOffline} = response.data);
    } else [nextPairs, nextRates] = await Promise.all([request("/pairs"), request("/rates")]);
    if (version !== refreshVersion) return;
    if (!Array.isArray(nextPairs) || !nextPairs.every(validPair) || !Array.isArray(nextRates) || !nextRates.every(rate => validPair(pairOf(rate)))) throw new Error(t("badFormat"));
    supportedPairs = nextPairs;
    rates = nextRates;
    offline = snapshotOffline;
    await reconcileWatchlist();
    if (version !== refreshVersion) return;
    renderRates();
    renderSelects();
    await loadHistory();
    if (version !== refreshVersion) return;
    if (!rates.length) { $("status").textContent = t("waitingCollection"); return; }
    const newest = Math.max(...rates.map((rate) => parseUtc(rate.captured_at)));
    $("status").textContent = t("statusLine",
      new Date(newest).toLocaleString(docLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      rates[0].provider === "mock" ? t("mockData") : t("providerLive"));
    if (offline) $("status").textContent += ` · ${t("offlineCache")}`;
    void loadHealth();
  } catch (error) {
    if (version !== refreshVersion) return;
    offline = true;
    historyVersion++;
    officialVersion++;
    renderRates();
    updateConverter();
    loadTarget();
    $("official-rates").replaceChildren();
    ["stat-low", "stat-high", "stat-position", "trend-change"].forEach(id => $(id).textContent = "—");
    $("error").textContent = error.message;
    $("chart").textContent = t("dataUnavailableCheck");
    $("official-status").textContent = t("dataUnavailableCheck");
    $("error").classList.remove("hidden");
    $("status").textContent = t("connectionFailed");
  } finally {
    if (version === refreshVersion) $("refresh-button").classList.remove("spinning");
  }
}

$("refresh-button").addEventListener("click", () => { void loadData(true); });
$("settings-button").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("amount").addEventListener("input", updateConverter);
$("converter-pair").addEventListener("change", () => { reversed = false; updateConverter(); });
$("reverse-button").addEventListener("click", () => { reversed = !reversed; updateConverter(); });
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
  if (!rate) return;
  const text = `${pairOf(rate)} ${rate.midpoint}`;
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
    const data = await request(`/comparisons/${pair}`);
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
      date.textContent = `${item.reference_date}${item.is_derived ? ` · ${t("crossRate")}` : ""}`;
      label.append(name, date);
      const value = document.createElement("div");
      value.className = "official-value";
      const number = document.createElement("strong");
      number.textContent = fmt(item.rate, pair.includes("JPY") ? 3 : 4);
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
  await loadData();
}

init();
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.apiUrl || changes.watchlist) void init();
  if (changes.language) globalThis.location.reload();
});
