const DEFAULTS = {
  apiUrl: "http://localhost:8000/api/v1",
  watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"],
  targets: {},
};

let settings = { ...DEFAULTS };
let rates = [];
let selectedPair = "USD/CNY";
let reversed = false;

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 4) => Number(value).toLocaleString("zh-CN", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const pairOf = (rate) => `${rate.base_currency}/${rate.quote_currency}`;

async function request(path) {
  const response = await fetch(`${settings.apiUrl.replace(/\/$/, "")}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `服务器返回 ${response.status}`);
  }
  return response.json();
}

function rateCard(rate) {
  const pair = pairOf(rate);
  const change = Number(rate.change_percent || 0);
  const digits = pair.includes("JPY") ? 3 : 4;
  return `<button class="rate-card ${pair === selectedPair ? "selected" : ""}" data-pair="${pair}">
    <div class="rate-top"><span class="pair">${pair}</span><span class="change ${change >= 0 ? "positive" : "negative"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span></div>
    <strong>${fmt(rate.midpoint, digits)}</strong>
    <div class="rate-bottom"><span>BID ${fmt(rate.bid, digits)} · ASK ${fmt(rate.ask, digits)}</span><span class="${rate.is_stale ? "stale" : ""}">${rate.is_stale ? "数据较旧" : "已更新"}</span></div>
  </button>`;
}

function currentRate() {
  return rates.find((rate) => pairOf(rate) === selectedPair) || rates[0];
}

function renderRates() {
  const visible = rates.filter((rate) => settings.watchlist.includes(pairOf(rate)));
  if (!visible.length && rates.length) {
    settings.watchlist = [pairOf(rates[0])];
    chrome.storage.local.set({ watchlist: settings.watchlist });
    return renderRates();
  }
  if (visible.length && !visible.some((rate) => pairOf(rate) === selectedPair)) {
    selectedPair = pairOf(visible[0]);
  }
  $("rates").innerHTML = visible.map(rateCard).join("") || "<p class='status'>暂无可用行情</p>";
  document.querySelectorAll(".rate-card").forEach((card) => card.addEventListener("click", () => selectPair(card.dataset.pair)));
}

function renderSelects() {
  const options = rates.map((rate) => `<option value="${pairOf(rate)}">${pairOf(rate)}</option>`).join("");
  $("converter-pair").innerHTML = options;
  $("target-pair").innerHTML = options;
  $("converter-pair").value = selectedPair;
  $("target-pair").value = selectedPair;
  $("watchlist-options").innerHTML = rates.map((rate) => {
    const pair = pairOf(rate);
    return `<label class="watch-option"><span>${pair}</span><input type="checkbox" value="${pair}" ${settings.watchlist.includes(pair) ? "checked" : ""}></label>`;
  }).join("");
  document.querySelectorAll(".watch-option input").forEach((input) => input.addEventListener("change", saveWatchlist));
  updateConverter();
  loadTarget();
}

function drawChart(points) {
  if (!points.length) {
    $("chart").innerHTML = "<span>历史数据仍在积累</span>";
    ["stat-low", "stat-high", "stat-position"].forEach((id) => $(id).textContent = "—");
    return;
  }
  const values = points.map((point) => Number(point.midpoint));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const width = 340;
  const height = 82;
  const range = high - low || 1;
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
    const y = 7 + (high - value) / range * (height - 14);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${height} ${coords} ${width},${height}`;
  $("chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${selectedPair} 七日走势图"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#56e39f" stop-opacity=".28"/><stop offset="1" stop-color="#56e39f" stop-opacity="0"/></linearGradient></defs><polygon points="${area}" fill="url(#fill)"/><polyline points="${coords}" fill="none" stroke="#56e39f" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  const digits = selectedPair.includes("JPY") ? 3 : 4;
  $("stat-low").textContent = fmt(low, digits);
  $("stat-high").textContent = fmt(high, digits);
  const position = high === low ? 50 : (values.at(-1) - low) / (high - low) * 100;
  $("stat-position").textContent = `${position.toFixed(0)}%`;
}

async function loadHistory() {
  $("trend-title").textContent = `${selectedPair} 走势`;
  const rate = currentRate();
  const change = Number(rate?.change_percent || 0);
  $("trend-change").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  $("trend-change").className = `change ${change >= 0 ? "positive" : "negative"}`;
  $("chart").innerHTML = "<span>载入走势…</span>";
  try {
    const [base, quote] = selectedPair.split("/");
    drawChart(await request(`/rates/${base}/${quote}/history?days=7`));
  } catch {
    drawChart([]);
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
  if (!rate) return;
  const [base, quote] = pair.split("/");
  const amount = Number($("amount").value || 0);
  const midpoint = Number(rate.midpoint);
  const value = reversed ? amount / midpoint : amount * midpoint;
  $("from-label").textContent = reversed ? quote : base;
  $("to-label").textContent = reversed ? base : quote;
  $("converted").textContent = `${fmt(value, 2)} ${reversed ? base : quote}`;
}

function targetStatus(pair) {
  const target = settings.targets[pair];
  const rate = rates.find((item) => pairOf(item) === pair);
  if (!target || !rate) return "尚未设置目标价";
  const current = Number(rate.midpoint);
  const reached = target.direction === "above" ? current >= target.value : current <= target.value;
  return reached ? `● 已达到目标 ${target.direction === "above" ? "≥" : "≤"} ${target.value}` : `○ 尚未达到 · 目标 ${target.direction === "above" ? "≥" : "≤"} ${target.value}`;
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
  renderRates();
  await loadHistory();
}

async function loadData() {
  $("refresh-button").classList.add("spinning");
  $("error").classList.add("hidden");
  try {
    rates = await request("/rates");
    if (!rates.length) throw new Error("服务器还没有汇率数据");
    renderRates();
    renderSelects();
    await loadHistory();
    const newest = Math.max(...rates.map((rate) => new Date(rate.captured_at).getTime()));
    $("status").textContent = `数据时间 ${new Date(newest).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${rates[0].provider}`;
  } catch (error) {
    $("error").textContent = `${error.message}。请确认后端已经启动。`;
    $("error").classList.remove("hidden");
    $("status").textContent = "连接失败";
  } finally {
    $("refresh-button").classList.remove("spinning");
  }
}

$("refresh-button").addEventListener("click", loadData);
$("settings-button").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("amount").addEventListener("input", updateConverter);
$("converter-pair").addEventListener("change", () => { reversed = false; updateConverter(); });
$("reverse-button").addEventListener("click", () => { reversed = !reversed; updateConverter(); });
$("target-pair").addEventListener("change", loadTarget);
$("target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pair = $("target-pair").value;
  settings.targets[pair] = { direction: $("target-direction").value, value: Number($("target-value").value) };
  await chrome.storage.local.set({ targets: settings.targets });
  loadTarget();
});
$("copy-button").addEventListener("click", async () => {
  const rate = currentRate();
  if (!rate) return;
  await navigator.clipboard.writeText(`${pairOf(rate)} ${rate.midpoint}`);
  $("copy-button").textContent = "已复制";
  setTimeout(() => $("copy-button").textContent = "复制当前汇率", 1200);
});

async function init() {
  settings = await chrome.storage.local.get(DEFAULTS);
  await loadData();
}

init();
