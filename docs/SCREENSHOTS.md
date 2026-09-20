# Real popup capture and browser acceptance

Do not use a drawn SVG or fabricated quote values as a product screenshot.

1. Start the migrated API with FX_PROVIDER=mock and run bootstrap/collector.
2. Load extension/ in Chrome or Edge. The extension requires storage and
   clipboardWrite; no notification or background alarm permissions.
3. Open the toolbar popup. Confirm Chinese labels and "模拟数据 · 非真实行情".
4. Use the OS screenshot tool to capture the actual popup (no text/data edits).
   Save as docs/screenshots/extension.png, then add it to README.
   Mock values fluctuate around 7.12 / 148.4 / 20.84; they are not fixed values.
5. Copy a quote and paste into a text editor; compare exact pair and midpoint.
6. Deny clipboard access where supported or test document focus loss. If copying
   fails, the selectable fallback should appear; verify Cmd/Ctrl+C works.
7. Change watchlist, close and reopen; verify persistence. Keep at least one pair.
8. Reverse the converter, save a target and switch pairs. Check chart/title agree.
9. Stop API and reopen. Verify a connection error, not a fake successful update.

Current automated coverage: jsdom interaction tests (not an installed-extension
browser test). A real screenshot is intentionally not claimed until captured.
