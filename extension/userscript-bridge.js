/* Public quote data only. Runs on sites explicitly enabled for hover. */
(() => {
  if (globalThis.__fxBridgeInstalled) return;
  globalThis.__fxBridgeInstalled = true;
  let active = 0;
  document.addEventListener("fx-pulse-request", async event => {
    if (typeof event.detail !== "string" || event.detail.length > 256 || active >= 4) return;
    let message;
    try { message = JSON.parse(event.detail); } catch { return; }
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(message.id || "")) return;
    const snapshot = message.type === "FX_SNAPSHOT";
    const official = message.type === "FX_OFFICIAL" && /^\/official-rates\/[A-Z]{3}\/[A-Z]{3}$/.test(message.path || "");
    if (!snapshot && !official) return;
    active++;
    try {
      const response = await chrome.runtime.sendMessage(snapshot
        ? {type: "FX_SNAPSHOT"}
        : {type: "FX_OFFICIAL", path: message.path});
      if (response?.ok) globalThis.__fxUserscriptUntil = Date.now() + 90000;
      // Never expose the backend URL, preferences, or keys to the page.
      const data = snapshot && response?.ok
        ? {rates: response.data.rates, offline: response.data.offline, fetchedAt: response.data.fetchedAt}
        : response?.ok ? response.data : null;
      document.dispatchEvent(new globalThis.CustomEvent("fx-pulse-response", {
        detail: JSON.stringify({id: message.id, ok: Boolean(response?.ok), data}),
      }));
    } catch {
      document.dispatchEvent(new globalThis.CustomEvent("fx-pulse-response", {
        detail: JSON.stringify({id: message.id, ok: false}),
      }));
    } finally { active--; }
  });
  document.dispatchEvent(new globalThis.CustomEvent("fx-pulse-ready"));
})();
