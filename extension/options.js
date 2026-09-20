const DEFAULT_API_URL = "http://localhost:8000/api/v1";
const apiInput = document.getElementById("api-url");
const result = document.getElementById("result");

function cleanUrl(value) { return value.trim().replace(/\/$/, ""); }

async function requestOriginPermission(url) {
  const origin = new URL(url).origin;
  if (origin === "http://localhost:8000") return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  result.textContent = "正在检查服务器…";
  const apiUrl = cleanUrl(apiInput.value);
  try {
    if (!await requestOriginPermission(apiUrl)) throw new Error("未获得访问该服务器的权限");
    const response = await fetch(`${apiUrl.replace(/\/api\/v1$/, "")}/health`);
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    await chrome.storage.local.set({ apiUrl });
    result.textContent = "连接成功，设置已保存。";
  } catch {
    result.textContent = "数据暂不可用，请检查连接";
  }
});

chrome.storage.local.get({ apiUrl: DEFAULT_API_URL }).then(({ apiUrl }) => { apiInput.value = apiUrl; });
