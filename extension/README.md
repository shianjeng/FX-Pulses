# FX Pulse extension

Chrome/Edge Manifest V3 extension. It requires no account and stores its watchlist and target prices in `chrome.storage.local`.

1. Start the FastAPI backend.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable developer mode and choose **Load unpacked**.
4. Select this `extension` directory.

5. In the extension settings, optionally enable **Hover conversion** and approve website access.
6. Reload the webpages where you want to use hover conversion. Disable the old Tampermonkey script.

The popup and hover UI share a service worker, the backend address, a one-minute quote cache, language and watchlist. The worker fetches only on demand. A visible hover card can revalidate once per minute; it does not contact Alpha Vantage directly, and background tabs do not poll. Targets are checked only in the popup; no system notifications are sent.

Hover is opt-in and top-frame only. Chrome internal pages, the Chrome Web Store, browser PDF viewers and file URLs are not supported. Settings include source-currency calibration, target currency, simple/detailed mode and card size. The UI uses the scheme B logo.

Only configured/collected backend currency pairs and their inverses can be converted. The extension never substitutes a different provider's reference rate. It identifies mock, stale and offline values explicitly.

See [UNIFIED-SERVICE.md](../UNIFIED-SERVICE.md) for migration, privacy and testing.
