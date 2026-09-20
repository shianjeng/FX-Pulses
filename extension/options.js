const DEFAULT_API_URL = "http://localhost:8000/api/v1";
const apiInput = document.getElementById("api-url");
const result = document.getElementById("result");

function cleanUrl(value) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入有效的HTTP或HTTPS地址");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/api/v1";
  return url.toString().replace(/\/$/, "");
}

async function checkJson(url) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {signal:controller.signal});
    if (!response.ok) throw new Error(response.status === 429 ? "请求过于频繁，请稍后重试" : `服务器返回 ${response.status}`);
    try { return await response.json(); } catch { throw new Error("行情数据格式错误"); }
  } catch(error) {
    if (error.name === "AbortError") throw new Error("请求超时，请重试");
    if (error instanceof TypeError) throw new Error("Failed to fetch");
    throw error;
  } finally { globalThis.clearTimeout(timeout); }
}

async function requestOriginPermission(url) {
  const origin = new URL(url).origin;
  if (origin === "http://localhost:8000") return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  result.textContent = "正在检查服务器…";
  try {
    const apiUrl = cleanUrl(apiInput.value);
    if (!await requestOriginPermission(apiUrl)) throw new Error("未获得访问该服务器的权限");
    const health = await checkJson(`${new URL(apiUrl).origin}/health`);
    if (health.status !== "ok" || !["mock","alpha_vantage"].includes(health.provider)) throw new Error("行情数据格式错误");
    const pairs = await checkJson(`${apiUrl}/pairs`);
    const rates = await checkJson(`${apiUrl}/rates`);
    if (!Array.isArray(pairs) || !pairs.length || !pairs.every(pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair)) || !Array.isArray(rates) || !rates.every(rate => pairs.includes(`${rate.base_currency}/${rate.quote_currency}`) && Number(rate.midpoint) > 0)) throw new Error("行情数据格式错误");
    await chrome.storage.local.set({ apiUrl });
    apiInput.value = apiUrl;
    result.textContent = !rates.length ? "连接成功，等待首次采集" : health.provider === "mock" ? "连接成功，当前为模拟数据" : "连接成功，设置已保存。";
  } catch (error) {
    result.textContent = `保存失败：${error.message}`;
  }
});

chrome.storage.local.get({ apiUrl: DEFAULT_API_URL }).then(({ apiUrl }) => { apiInput.value = apiUrl; });

const hoverInfo = document.createElement("section");
const hoverHeading = document.createElement("h2");
hoverHeading.textContent = "网页悬停换算";
const hoverDescription = document.createElement("p");
hoverDescription.textContent = "悬停与工具栏共用后端、行情缓存、语言和自选设置，无需油猴。开启后仅在本机识别网页金额，不上传网页内容。请停用旧油猴脚本，避免重复显示。";
const hoverLabel = document.createElement("label");
hoverLabel.className = "hover-toggle";
const hoverEnabled = document.createElement("input");
hoverEnabled.id = "hover-enabled"; hoverEnabled.type = "checkbox";
const hoverLabelText = document.createElement("span"); hoverLabelText.textContent = "开启网页悬停换算";
hoverLabel.append(hoverEnabled, hoverLabelText);
const hoverResult = document.createElement("p"); hoverResult.id = "hover-result"; hoverResult.setAttribute("role", "status");
hoverInfo.append(hoverHeading, hoverDescription, hoverLabel);
const hoverDefaults = {hoverEnabled: false, hoverTarget: "CNY", hoverSize: "m", hoverMode: "simple"};
const hoverControls = {};
for (const [key, title, choices] of [
  ["hoverTarget", "悬停目标币种", [["CNY", "CNY"], ["JPY", "JPY"], ["USD", "USD"]]],
  ["hoverSize", "卡片大小", [["s", "小号卡片"], ["m", "标准卡片"], ["l", "大号卡片"]]],
  ["hoverMode", "卡片模式", [["simple", "简洁模式"], ["detail", "详细模式"]]],
]) {
  const label = document.createElement("label"); label.textContent = title;
  const select = document.createElement("select"); select.id = key;
  for (const [value, text] of choices) { const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option); }
  select.addEventListener("change", async () => { await chrome.storage.local.set({[key]: select.value}); hoverResult.textContent = "设置已保存"; });
  hoverControls[key] = select; label.append(select); hoverInfo.append(label);
}
hoverInfo.append(hoverResult);
document.querySelector("main").append(hoverInfo);
chrome.storage.local.get(hoverDefaults).then(value => {
  hoverEnabled.checked = value.hoverEnabled;
  for (const [key, select] of Object.entries(hoverControls)) select.value = value[key];
});
hoverEnabled.addEventListener("change", async () => {
  const enabled = hoverEnabled.checked;
  hoverEnabled.disabled = true;
  try {
    if (enabled && !await chrome.permissions.request({origins: ["https://*/*", "http://*/*"]})) {
      hoverEnabled.checked = false;
      hoverResult.textContent = "未获得网页访问权限，悬停未开启";
      return;
    }
    await chrome.storage.local.set({hoverEnabled: enabled});
    const reply = await chrome.runtime.sendMessage({type: "FX_SYNC_HOVER"});
    if (!reply?.ok) throw new Error(reply?.error || "Failed to fetch");
    hoverResult.textContent = enabled ? "已开启，请刷新网页后使用" : "已关闭网页悬停换算";
  } catch {
    await chrome.storage.local.set({hoverEnabled: false}); hoverEnabled.checked = false;
    hoverResult.textContent = "悬停设置失败，请重新加载插件";
  } finally { hoverEnabled.disabled = false; }
});
