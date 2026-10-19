"""Preview the popup, the settings page and the hover card in an ordinary browser.

    python3 tools/preview.py [port]      # or: make preview

Serves extension/ on http://127.0.0.1:8765 with a stand-in for the Chrome
extension APIs. The worker (background.js) runs in the same page, so the
popup reads the real static backend and live rates exactly as installed.
Settings are kept in the page's localStorage. /hover-demo.html has prices
written the ways shops write them, for trying hover and select-to-convert.

Development only: it binds to 127.0.0.1 and serves nothing but extension/.
"""
import http.server
import pathlib
import sys

EXT = pathlib.Path(__file__).resolve().parent.parent / "extension"

SHIM = """<script>
/* Chrome extension APIs, enough for the popup, the settings page and the worker in one page. */
(() => {
  const KEY = "fxPreviewStore";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
  const store = load();
  const save = () => localStorage.setItem(KEY, JSON.stringify(store));
  const lists = {changed: [], message: [], other: []};
  const event = list => ({addListener: fn => list.push(fn), removeListener() {}});
  const get = async keys => {
    if (keys === null || keys === undefined) return {...store};
    if (typeof keys === "string") return keys in store ? {[keys]: store[keys]} : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d]));
  };
  const set = async values => {
    const changes = {};
    for (const [k, v] of Object.entries(values)) { changes[k] = {oldValue: store[k], newValue: v}; store[k] = v; }
    save(); lists.changed.forEach(fn => fn(changes, "local"));
  };
  const remove = async keys => { for (const k of [].concat(keys)) delete store[k]; save(); };
  const origin = location.origin + "/";
  globalThis.chrome = {
    storage: {local: {get, set, remove}, onChanged: event(lists.changed)},
    runtime: {
      id: "preview", getURL: path => origin + path,
      onMessage: event(lists.message), onInstalled: event(lists.other), onStartup: event(lists.other),
      openOptionsPage() { location.href = "/options.html"; },
      sendMessage: message => new Promise(resolve => {
        const sender = {id: "preview", url: origin + "popup.html"};
        for (const fn of lists.message) if (fn(message, sender, resolve)) return;
        resolve(undefined);
      }),
    },
    permissions: {contains: async () => true, request: async () => true, onRemoved: event(lists.other)},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
    alarms: {onAlarm: event(lists.other), get: async () => undefined, create: async () => {}, clear: async () => true},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async () => {}},
  };
})();
</script>"""
# The worker runs after config.js and messages.js, which it reads as it starts,
# and before the page's own scripts ask it anything.
WORKER = '<script src="/amount-parser.js"></script><script src="/background.js?preview"></script>'


DEMO = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Hover demo</title>
<style>body{max-width:560px;padding:24px;font:16px/1.7 -apple-system,sans-serif}.off{position:absolute;opacity:0}.big{font-size:26px}</style>
<!--shim-->
<script>chrome.storage.local.set({hoverEnabled: true});</script>
</head><body>
<h3>Hover demo</h3>
<p>Plain: 価格 <b>¥26,990</b>（税込）・送料無料</p>
<p>Amazon: <span class="big"><span class="off">¥12,800</span><span aria-hidden="true"><span>¥</span><span>12,800</span></span></span></p>
<p>amazon.com: <span class="big"><span>$</span><span>29<span>.</span></span><span>99</span></span></p>
<p>Chinese: 售价 1,299 元，会员价 ￥1,199</p>
<p>Two prices: $10 or $20, whichever you prefer.</p>
<p><textarea>¥5,000 in a form field</textarea></p>
<script src="/config.js"></script><script src="/messages.js"></script><!--worker--><script src="/hover.js"></script>
</body></html>"""

TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
         ".svg": "image/svg+xml", ".png": "image/png"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0].lstrip("/") or "popup.html"
        if path == "hover-demo.html":
            return self.send(DEMO.replace("<!--shim-->", SHIM).replace("<!--worker-->", WORKER).encode(), ".html")
        local = (EXT / path).resolve()
        if EXT not in local.parents or not local.is_file():
            return self.send_error(404)
        body = local.read_bytes()
        if path == "background.js" and "preview" in self.path:
            # The worker shares the page here; keep its names out of the page's scope.
            body = b"(() => {\n" + body + b"\n})();\n"
        if local.suffix == ".html":
            text = body.decode().replace("<head>", "<head>" + SHIM, 1)
            body = text.replace('<script src="i18n.js"></script>', WORKER + '<script src="i18n.js"></script>', 1).encode()
        self.send(body, local.suffix)

    def send(self, body, suffix):
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(suffix, "application/octet-stream") + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"FX Pulse preview on http://127.0.0.1:{port}/  (hover demo: /hover-demo.html)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
