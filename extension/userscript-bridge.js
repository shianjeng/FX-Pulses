/* Page-facing bridge for the legacy userscript. Opt-in: it is only injected when
 * the user enables it in options, because while it runs any site can call the
 * gateway, detect the extension and suppress the hover card.
 *
 * Public quote data only — never the backend URL, preferences or keys.
 */
(() => {
  if (globalThis.__fxBridgeInstalled) return;
  globalThis.__fxBridgeInstalled = true;
  let active = 0;
  // A page may defer to itself once per document. Refreshing the window used to
  // let any site keep the extension's own card suppressed indefinitely.
  let deferralsLeft = 1;

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
        ? {type: "FX_SNAPSHOT", fromBridge: true}
        : {type: "FX_OFFICIAL", path: message.path, fromBridge: true});
      if (response?.ok && deferralsLeft > 0) {
        deferralsLeft--;
        globalThis.__fxUserscriptUntil = Date.now() + 90000;
        document.dispatchEvent(new globalThis.CustomEvent("fx-pulse-deferred"));
      }
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
