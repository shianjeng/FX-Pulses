# FX Pulse extension

Chrome/Edge Manifest V3 extension. It requires no account and stores its watchlist and target prices in `chrome.storage.local`.

1. Start the FastAPI backend.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable developer mode and choose **Load unpacked**.
4. Select this `extension` directory.

The extension makes requests only while its popup is open. It does not run a background service worker or send notifications.
