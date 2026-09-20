const DEFAULTS = {
  apiUrl: "http://localhost:8000/api/v1",
  watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"],
  targets: {},
};

let settings = { ...DEFAULTS };
let rates = [];
let selectedPair = "USD/CNY";
let reversed = false;
let historyVersion = 0;

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 4) => Number(value).toLocaleString("zh-CN", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const pairOf = (rate) => `${rate.base_currency}/${rate.quote_currency}`;
const changeText = (value) => value === null || value === undefined ? "暂无对比" :
  `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;

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
    <div class="rate-top"><span class="pair">${pair}</span><span class="change ${change >= 0 ? "positive" : "negative"}">${changeText(rate.change_percent)}</span></div>
    <strong>${fmt(rate.midpoint, digits)}</strong>
    <div class="rate-bottom"><span>BID ${fmt(rate.bid, digits)} · ASK ${fmt(rate.ask, digits)}</span><span class="${rate.is_stale ? "stale" : ""}">${rate.is_stale ? "数据较旧" : "已更新"}</span></div>
  </button>`;
}

function currentRate() {
  return rates.find((rate) => pairOf(rate) === selectedPair) || rates[0];
}

async function reconcileWatchlist() {
  let visible = rates.filter((rate) => settings.watchlist.includes(pairOf(rate)));
  if (!visible.length && rates.length) {
    settings.watchlist = [pairOf(rates[0])];
    await chrome.storage.local.set({ watchlist: settings.watchlist });
    visible = [rates[0]];
  }
  if (visible.length && !visible.some((rate) => pairOf(rate) === selectedPair)) {
    selectedPair = pairOf(visible[0]);
  }
}

function renderRates() {
  const visible = rates.filter((rate) => settings.watchlist.includes(pairOf(rate)));
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

function chartTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

function smoothPath(points) {
  if (points.length === 1) {
    const [point] = points;
    return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] || points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

function drawChart(points) {
  const root = $("chart");
  if (!points.length) {
    root.innerHTML = "<span>历史数据仍在积累</span>";
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
  const digits = selectedPair.includes("JPY") ? 3 : 4;
  const plotted = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = 7 + ((high - value) / range) * (height - 14);
    return {
      x,
      y,
      value,
      time: points[index].captured_at,
    };
  });

  const line = smoothPath(plotted);
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${selectedPair} 七日走势图">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#56e39f" stop-opacity=".22"/>
          <stop offset="1" stop-color="#56e39f" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#fill)"></path>
      <path d="${line}" fill="none" stroke="#56e39f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
      <line class="chart-guide" x1="0" y1="4" x2="0" y2="${height - 2}" stroke="#edf8f2" stroke-opacity=".18" stroke-dasharray="3 4" visibility="hidden"></line>
      <circle class="chart-dot" cx="0" cy="0" r="3.6" fill="#07120e" stroke="#56e39f" stroke-width="2" visibility="hidden"></circle>
      <rect class="chart-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    </svg>
    <div class="chart-tip" aria-hidden="true">
      <small>—</small>
      <b>—</b>
    </div>
  `;

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
    const index = Math.round(ratio * (plotted.length - 1));
    return Math.min(plotted.length - 1, Math.max(0, index));
  };

  hit.addEventListener("mousemove", (event) => showAt(pickIndex(event)));
  hit.addEventListener("mouseleave", hideTip);
}

async function loadHistory() {
  const version = ++historyVersion;
  $("trend-title").textContent = `${selectedPair} 走势`;
  const rate = currentRate();
  const change = Number(rate?.change_percent || 0);
  $("trend-change").textContent = `24h · ${changeText(rate?.change_percent)}`;
  $("trend-change").className = `change ${change >= 0 ? "positive" : "negative"}`;
  $("chart").innerHTML = "<span>载入走势…</span>";
  try {
    const [base, quote] = selectedPair.split("/");
    const points = await request(`/rates/${base}/${quote}/history?days=7`);
    if (version === historyVersion) drawChart(points);
  } catch {
    if (version === historyVersion) drawChart([]);
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
  await reconcileWatchlist();
  renderRates();
  renderSelects();
  await loadHistory();
}

async function loadData() {
  $("refresh-button").classList.add("spinning");
  $("error").classList.add("hidden");
  try {
    rates = await request("/rates");
    if (!rates.length) throw new Error("服务器还没有汇率数据");
    await reconcileWatchlist();
    renderRates();
    renderSelects();
    await loadHistory();
    const newest = Math.max(...rates.map((rate) => new Date(rate.captured_at).getTime()));
    $("status").textContent = `数据时间 ${new Date(newest).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${rates[0].provider === "mock" ? "模拟数据 · 非真实行情" : rates[0].provider}`;
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
  const text = `${pairOf(rate)} ${rate.midpoint}`;
  try {
    await navigator.clipboard.writeText(text);
    $("copy-button").textContent = "已复制";
    setTimeout(() => $("copy-button").textContent = "复制当前汇率", 1200);
  } catch {
    $("copy-fallback").classList.remove("hidden");
    $("copy-value").value = text;
    $("copy-value").focus();
    $("copy-value").select();
  }
});

async function init() {
  settings = await chrome.storage.local.get(DEFAULTS);
  await loadData();
}

init();
