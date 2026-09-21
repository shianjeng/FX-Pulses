const t = (key, ...values) => globalThis.FXI18N.t(key, ...values);
const DEFAULT_API_URL = "http://localhost:8000/api/v1";
const apiInput = document.getElementById("api-url");
const result = document.getElementById("result");

function cleanUrl(value) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(t("invalidUrl"));
  url.pathname = url.pathname.replace(/\/+$/, "") || "/api/v1";
  return url.toString().replace(/\/$/, "");
}

async function checkJson(url) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {signal:controller.signal});
    if (!response.ok) throw new Error(response.status === 429 ? t("tooManyRequests") : t("serverReturned", response.status));
    try { return await response.json(); } catch { throw new Error(t("badFormat")); }
  } catch(error) {
    if (error.name === "AbortError") throw new Error(t("timeout"));
    if (error instanceof TypeError || error.message === "Failed to fetch") throw new Error(t("cannotConnect"));
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
  result.textContent = t("checking");
  try {
    const apiUrl = cleanUrl(apiInput.value);
    if (!await requestOriginPermission(apiUrl)) throw new Error(t("serverPermissionDenied"));
    const health = await checkJson(`${new URL(apiUrl).origin}/health`);
    if (health.status !== "ok" || !["mock","alpha_vantage"].includes(health.provider)) throw new Error(t("badFormat"));
    const pairs = await checkJson(`${apiUrl}/pairs`);
    const rates = await checkJson(`${apiUrl}/rates`);
    if (!Array.isArray(pairs) || !pairs.length || !pairs.every(pair => typeof pair === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(pair)) || !Array.isArray(rates) || !rates.every(rate => pairs.includes(`${rate.base_currency}/${rate.quote_currency}`) && Number(rate.midpoint) > 0)) throw new Error(t("badFormat"));
    await chrome.storage.local.set({ apiUrl });
    apiInput.value = apiUrl;
    result.textContent = t(!rates.length ? "connectedWaiting" : health.provider === "mock" ? "connectedMock" : "connectedSaved");
  } catch (error) {
    result.textContent = t("saveFailed", error.message);
  }
});

chrome.storage.local.get({ apiUrl: DEFAULT_API_URL }).then(({ apiUrl }) => { apiInput.value = apiUrl; });

const hoverInfo = document.createElement("section");
const hoverHeading = document.createElement("h2");
hoverHeading.textContent = t("hoverSectionTitle");
const hoverDescription = document.createElement("p");
hoverDescription.textContent = t("hoverDescription");
const hoverLabel = document.createElement("label");
hoverLabel.className = "hover-toggle";
const hoverEnabled = document.createElement("input");
hoverEnabled.id = "hover-enabled"; hoverEnabled.type = "checkbox";
const hoverLabelText = document.createElement("span"); hoverLabelText.textContent = t("hoverEnable");
hoverLabel.append(hoverEnabled, hoverLabelText);
const hoverResult = document.createElement("p"); hoverResult.id = "hover-result"; hoverResult.setAttribute("role", "status");
hoverInfo.append(hoverHeading, hoverDescription, hoverLabel);
const hoverDefaults = {hoverEnabled: false, hoverTarget: "CNY", hoverSize: "m", hoverMode: "simple"};
const hoverControls = {};
for (const [key, title, choices] of [
  ["hoverTarget", "hoverTargetLabel", [["CNY", "CNY"], ["JPY", "JPY"], ["USD", "USD"]]],
  ["hoverSize", "cardSize", [["s", "sizeS"], ["m", "sizeM"], ["l", "sizeL"]]],
  ["hoverMode", "cardMode", [["simple", "modeSimple"], ["detail", "modeDetail"]]],
]) {
  const label = document.createElement("label"); label.textContent = t(title);
  const select = document.createElement("select"); select.id = key;
  for (const [value, text] of choices) { const option = document.createElement("option"); option.value = value; option.textContent = /^[A-Z]{3}$/.test(text) ? text : t(text); select.append(option); }
  select.addEventListener("change", async () => { await chrome.storage.local.set({[key]: select.value}); hoverResult.textContent = t("settingsSaved"); });
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
      hoverResult.textContent = t("hoverPermissionDenied");
      return;
    }
    await chrome.storage.local.set(enabled ? {hoverEnabled: true} : {hoverEnabled: false, bridgeEnabled: false});
    if (!enabled) { const box = document.getElementById("bridge-enabled"); if (box) box.checked = false; }
    const reply = await chrome.runtime.sendMessage({type: "FX_SYNC_HOVER"});
    if (!reply?.ok) throw new Error(reply?.error || t("cannotConnect"));
    hoverResult.textContent = t(enabled ? "hoverEnabledMessage" : "hoverDisabledMessage");
  } catch {
    await chrome.storage.local.set({hoverEnabled: false}); hoverEnabled.checked = false;
    hoverResult.textContent = t("hoverFailed");
  } finally { hoverEnabled.disabled = false; }
});

/* ---- Target alerts (opt-in, background checks) ---------------------------- */
const alertInfo = document.createElement("section");
const alertHeading = document.createElement("h2");
alertHeading.textContent = t("alertsSectionTitle");
const alertDescription = document.createElement("p");
alertDescription.textContent = t("alertsDescription");
const alertLabel = document.createElement("label");
alertLabel.className = "hover-toggle";
const alertsEnabled = document.createElement("input");
alertsEnabled.id = "alerts-enabled"; alertsEnabled.type = "checkbox";
const alertLabelText = document.createElement("span");
alertLabelText.textContent = t("alertsEnable");
alertLabel.append(alertsEnabled, alertLabelText);
const alertResult = document.createElement("p");
alertResult.id = "alert-result"; alertResult.setAttribute("role", "status");
const intervalLabel = document.createElement("label");
intervalLabel.textContent = t("alertIntervalLabel");
const intervalSelect = document.createElement("select");
intervalSelect.id = "alert-interval";
for (const value of ["30", "60", "180", "360"]) {
  const option = document.createElement("option");
  option.value = value; option.textContent = t(`interval${value}`); intervalSelect.append(option);
}
intervalLabel.append(intervalSelect);
alertInfo.append(alertHeading, alertDescription, alertLabel, intervalLabel, alertResult);
document.querySelector("main").append(alertInfo);

const alertDefaults = {alertsEnabled: false, alertIntervalMinutes: 30};
chrome.storage.local.get(alertDefaults).then(value => {
  alertsEnabled.checked = value.alertsEnabled;
  intervalSelect.value = String(value.alertIntervalMinutes);
});

async function syncAlerts() {
  const reply = await chrome.runtime.sendMessage({type: "FX_SYNC_ALERTS"});
  if (!reply?.ok) throw new Error(reply?.error || t("cannotConnect"));
}

alertsEnabled.addEventListener("change", async () => {
  const enabled = alertsEnabled.checked;
  alertsEnabled.disabled = true;
  try {
    if (enabled && !await chrome.permissions.request({permissions: ["notifications"]})) {
      alertsEnabled.checked = false;
      alertResult.textContent = t("alertsPermissionDenied");
      return;
    }
    await chrome.storage.local.set({alertsEnabled: enabled});
    await syncAlerts();
    alertResult.textContent = t(enabled ? "alertsOn" : "alertsOff");
  } catch {
    await chrome.storage.local.set({alertsEnabled: false});
    alertsEnabled.checked = false;
    alertResult.textContent = t("alertsFailed");
  } finally { alertsEnabled.disabled = false; }
});

intervalSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({alertIntervalMinutes: Number(intervalSelect.value)});
  try { await syncAlerts(); alertResult.textContent = t("settingsSaved"); }
  catch { alertResult.textContent = t("alertsFailed"); }
});

/* ---- Userscript bridge (opt-in) ------------------------------------------- */
const bridgeInfo = document.createElement("section");
const bridgeHeading = document.createElement("h2");
bridgeHeading.textContent = t("bridgeSectionTitle");
const bridgeDescription = document.createElement("p");
bridgeDescription.textContent = t("bridgeDescription");
const bridgeLabel = document.createElement("label");
bridgeLabel.className = "hover-toggle";
const bridgeEnabled = document.createElement("input");
bridgeEnabled.id = "bridge-enabled"; bridgeEnabled.type = "checkbox";
const bridgeLabelText = document.createElement("span");
bridgeLabelText.textContent = t("bridgeEnable");
bridgeLabel.append(bridgeEnabled, bridgeLabelText);
const bridgeResult = document.createElement("p");
bridgeResult.id = "bridge-result"; bridgeResult.setAttribute("role", "status");
bridgeInfo.append(bridgeHeading, bridgeDescription, bridgeLabel, bridgeResult);
document.querySelector("main").append(bridgeInfo);

chrome.storage.local.get({bridgeEnabled: false}).then(value => {
  bridgeEnabled.checked = value.bridgeEnabled;
});

bridgeEnabled.addEventListener("change", async () => {
  const enabled = bridgeEnabled.checked;
  bridgeEnabled.disabled = true;
  try {
    // The bridge only exists inside the hover content script.
    if (enabled && !(await chrome.storage.local.get({hoverEnabled: false})).hoverEnabled) {
      bridgeEnabled.checked = false;
      bridgeResult.textContent = t("bridgeRequiresHover");
      return;
    }
    await chrome.storage.local.set({bridgeEnabled: enabled});
    const reply = await chrome.runtime.sendMessage({type: "FX_SYNC_HOVER"});
    if (!reply?.ok) throw new Error(reply?.error || t("cannotConnect"));
    bridgeResult.textContent = t(enabled ? "bridgeOn" : "bridgeOff");
  } catch {
    await chrome.storage.local.set({bridgeEnabled: false});
    bridgeEnabled.checked = false;
    bridgeResult.textContent = t("hoverFailed");
  } finally { bridgeEnabled.disabled = false; }
});
