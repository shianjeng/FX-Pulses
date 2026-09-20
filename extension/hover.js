/* Runs only in Chrome's isolated content-script world, after opt-in. */
(() => {
  if (globalThis.__fxHoverInstalled) return;
  globalThis.__fxHoverInstalled = true;
  const parser = globalThis.FXAmountParser;
  const defaults = {hoverEnabled: false, hoverTarget: "CNY", hoverSize: "m", hoverMode: "simple", language: "zh", watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"]};
  let settings = {...defaults}, host, shadow, card, active, snapshot, error = "", timer, hiding, version = 0, pointerVersion = 0;
  const words = {
    title: ["网页悬停换算", "Hover conversion", "ページ上での通貨換算"],
    source: ["原始币种", "Source currency", "元の通貨"], target: ["目标币种", "Target currency", "換算先の通貨"],
    copy: ["复制", "Copy", "コピー"], settings: ["设置", "Settings", "設定"], close: ["关闭", "Close", "閉じる"],
    loading: ["正在读取行情…", "Loading rates…", "レートを読み込み中…"],
    unavailable: ["行情不可用，请检查后端连接", "Quotes unavailable. Check the backend connection.", "レートを取得できません。サーバー接続を確認してください。"],
    unsupported: ["此币种未配置或尚未采集", "Currency not configured or not collected yet", "未登録または未取得の通貨です"],
    mock: ["模拟数据 · 非真实行情", "Demo data · Not live quotes", "デモデータ · 実際の相場ではありません"],
    live: ["行情服务", "Alpha Vantage", "為替データ"],
    offline: ["离线缓存", "Offline · cached quote", "オフライン・保存済みレート"],
    stale: ["数据较旧", "Outdated quote", "古いレート"],
    time: ["数据时间", "As of", "更新日時"],
    guessed: ["币种为自动识别，可手动校准", "Currency detected automatically; adjust if needed", "通貨は自動判定です。必要に応じて修正してください"],
    disclaimer: ["市场中间价，仅供参考，不含手续费。", "Midpoint estimate; fees excluded.", "仲値による概算です。手数料は含みません。"],
    manual: ["自动复制失败，请手动复制", "Automatic copy failed. Copy the selected text.", "自動コピーに失敗しました。選択した文字列をコピーしてください。"],
    copied: ["已复制", "Copied", "コピーしました"],
  };
  const tr = key => words[key][{zh: 0, en: 1, ja: 2}[settings.language] ?? 0];
  const locale = () => ({zh: "zh-CN", en: "en-US", ja: "ja-JP"}[settings.language] || "zh-CN");
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const validCode = code => typeof code === "string" && /^[A-Z]{3}$/.test(code);
  const hide = () => { version++; pointerVersion++; globalThis.clearTimeout(timer); globalThis.clearTimeout(hiding); active = null; if (host) host.style.display = "none"; };

  function quote(from, to) {
    if (!snapshot) return null;
    const direct = snapshot.rates.find(rate => rate.base_currency === from && rate.quote_currency === to);
    if (direct) return {...direct, value: Number(direct.midpoint)};
    const reverse = snapshot.rates.find(rate => rate.base_currency === to && rate.quote_currency === from);
    if (reverse) return {...reverse, value: 1 / Number(reverse.midpoint)};
    if (from === to) {
      const known = snapshot.rates.find(rate => [rate.base_currency, rate.quote_currency].includes(from));
      if (known) return {...known, value: 1};
    }
    return null;
  }
  const format = (amount, code) => new Intl.NumberFormat(locale(), {minimumFractionDigits: code === "JPY" ? 0 : 2, maximumFractionDigits: code === "JPY" ? 0 : 4}).format(amount);
  const memoryKey = match => `hoverMemory:${globalThis.location.hostname}|${match.marker}`;

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.id = "fx-pulse-unified-hover";
    host.style.cssText = "position:fixed!important;z-index:2147483647!important;display:none;";
    shadow = host.attachShadow({mode: "closed"});
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}*{box-sizing:border-box}.card{width:320px;max-width:calc(100vw - 20px);padding:16px;border:1px solid #ffffffbd;border-radius:20px;background:linear-gradient(135deg,#fffffff5,#eaf1f5f5);backdrop-filter:blur(22px);color:#162535;box-shadow:0 12px 36px #13243530;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card[data-size=s]{width:270px;padding:12px}.card[data-size=l]{width:370px}.head,.actions,.fields{display:flex;align-items:center;gap:8px}.head{margin-bottom:8px}.head strong{flex:1}.amount{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.origin,.note{color:#546473;overflow-wrap:anywhere}.note{font-size:11px;margin:7px 0}.warning{color:#9a3a10;font-weight:600}.fields{margin:10px 0;flex-wrap:wrap}.fields label{display:grid;gap:3px;flex:1;font-size:11px}select,button,input{font:inherit;color:inherit;background:#ffffffb0;border:1px solid #aebec977;border-radius:9px;padding:6px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid #286db5}.actions{margin-top:10px}input{width:100%}.head img{width:28px;height:28px}.head button{margin-left:auto}.detail{display:flex;justify-content:space-between;border-top:1px solid #9bafb733;padding:5px 0}`;
    shadow.append(style);
    card = el("section", "", "card"); card.setAttribute("role", "dialog"); shadow.append(card);
    host.addEventListener("mouseenter", () => { globalThis.clearTimeout(hiding); globalThis.clearTimeout(timer); });
    host.addEventListener("mouseleave", () => { hiding = setTimeout(hide, 350); });
    shadow.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
    document.documentElement.append(host);
  }

  function render() {
    if (!active || !settings.hoverEnabled) return;
    build(); card.replaceChildren(); card.dataset.size = settings.hoverSize;
    card.lang = locale(); card.setAttribute("aria-label", tr("title"));
    const heading = el("div", "", "head"), logo = el("img");
    logo.src = chrome.runtime.getURL("icons/icon.svg"); logo.alt = "";
    heading.append(logo, el("strong", "FX Pulse"));
    const close = el("button", "×"); close.setAttribute("aria-label", tr("close")); close.onclick = hide; heading.append(close); card.append(heading);
    const from = active.match.code, to = settings.hoverTarget;
    const current = quote(from, to), value = current ? active.match.amount * current.value : null;
    const available = value !== null && Number.isFinite(value);
    card.append(el("div", available ? `≈ ${format(value, to)} ${to}` : "—", "amount"));
    card.append(el("div", `${active.match.raw.trim()} · ${from}`, "origin"));
    const codes = [...new Set([from, to, ...(snapshot?.pairs || settings.watchlist).flatMap(pair => pair.split("/"))])].filter(validCode).sort();
    const fields = el("div", "", "fields");
    for (const [key, selected] of [["source", from], ["target", to]]) {
      const label = el("label", tr(key)), select = el("select");
      select.setAttribute("aria-label", tr(key));
      for (const code of codes) { const option = el("option", code); option.value = code; select.append(option); }
      select.value = selected;
      select.onchange = async () => {
        if (!active) return;
        if (key === "source") { active.match.code = select.value; await chrome.storage.local.set({[memoryKey(active.match)]: select.value}); }
        else { settings.hoverTarget = select.value; await chrome.storage.local.set({hoverTarget: select.value}); }
        render();
      };
      label.append(select); fields.append(label);
    }
    card.append(fields, el("p", tr("guessed"), "note"));
    if (available) {
      card.append(el("div", `1 ${from} = ${new Intl.NumberFormat(locale(), {maximumSignificantDigits: 7}).format(current.value)} ${to}`));
      const source = current.provider === "mock" ? tr("mock") : tr("live");
      card.append(el("p", source, current.provider === "mock" ? "note warning" : "note"));
      card.append(el("p", `${tr("time")} ${new Date(current.captured_at).toLocaleString(locale())}`, "note"));
      if (snapshot.offline || current.is_stale) card.append(el("p", tr(snapshot.offline ? "offline" : "stale"), "note warning"));
    } else card.append(el("p", error ? tr("unavailable") : snapshot ? tr("unsupported") : tr("loading"), "note warning"));
    if (settings.hoverMode === "detail" && snapshot) {
      const targets = [...new Set(settings.watchlist.flatMap(pair => pair.split("/")))].filter(code => code !== to && code !== from);
      for (const code of targets) {
        const other = quote(from, code);
        if (other) { const row = el("div", "", "detail"); row.append(el("span", code), el("span", format(active.match.amount * other.value, code))); card.append(row); }
      }
    }
    card.append(el("p", tr("disclaimer"), "note"));
    const actions = el("div", "", "actions"), copy = el("button", tr("copy")), options = el("button", tr("settings"));
    copy.disabled = !available;
    copy.onclick = async () => {
      const text = `${active.match.raw.trim()} → ≈ ${format(value, to)} ${to} · ${current.provider === "mock" ? tr("mock") : tr("live")}${snapshot.offline ? ` · ${tr("offline")}` : current.is_stale ? ` · ${tr("stale")}` : ""}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = tr("copied"); }
      catch { const input = el("input"); input.readOnly = true; input.value = text; input.setAttribute("aria-label", tr("manual")); card.append(el("p", tr("manual"), "note"), input); input.focus(); input.select(); }
    };
    options.onclick = () => { void chrome.runtime.sendMessage({type: "FX_OPEN_SETTINGS"}); };
    actions.append(copy, options); card.append(actions);
    host.style.display = "block";
    host.style.left = `${Math.max(8, Math.min(globalThis.innerWidth - host.getBoundingClientRect().width - 8, active.rect.left))}px`;
    host.style.top = `${Math.max(8, Math.min(globalThis.innerHeight - host.getBoundingClientRect().height - 8, active.rect.bottom + 8))}px`;
  }

  async function refresh() {
    if (!active || !settings.hoverEnabled) return;
    const own = ++version;
    try {
      const response = await chrome.runtime.sendMessage({type: "FX_SNAPSHOT"});
      if (own !== version) return;
      if (!response?.ok) throw new Error(response?.error || "unavailable");
      snapshot = response.data; error = "";
    } catch { if (own !== version) return; error = "unavailable"; snapshot = null; }
    render();
  }

  async function detect(x, y) {
    if (!settings.hoverEnabled) return;
    const target = document.elementFromPoint(x, y);
    if (!target || target === host || target.closest("input,textarea,select,button,script,style,pre,code,[contenteditable]")) return;
    const position = document.caretPositionFromPoint?.(x, y), range = position ? null : document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer, offset = position?.offset ?? range?.startOffset;
    if (!node || node.nodeType !== 3 || !node.parentElement || node.parentElement.closest("input,textarea,select,button,script,style,pre,code,[contenteditable]")) return;
    const start = Math.max(0, offset - 64), text = node.data.slice(start, offset + 64);
    const profile = parser.buildProfile(document, globalThis, node.parentElement.textContent.slice(0, 4000));
    const match = parser.parseAll(text, {host: globalThis.location.hostname, lang: document.documentElement.lang, profile}).accepted.find(item => offset - start >= item.start && offset - start <= item.end);
    if (!match) return;
    const bounds = document.createRange(); bounds.setStart(node, start + match.start); bounds.setEnd(node, start + match.end);
    const rect = bounds.getBoundingClientRect();
    if (x < rect.left - 6 || x > rect.right + 6 || y < rect.top - 6 || y > rect.bottom + 6) return;
    const own = ++version, pointer = pointerVersion;
    const saved = await chrome.storage.local.get(memoryKey(match));
    if (own !== version || pointer !== pointerVersion || !settings.hoverEnabled) return;
    if (validCode(saved[memoryKey(match)])) match.code = saved[memoryKey(match)];
    active = {match, rect}; error = ""; globalThis.clearTimeout(hiding); render(); void refresh();
  }

  document.addEventListener("mousemove", event => {
    pointerVersion++;
    globalThis.clearTimeout(timer);
    if (!settings.hoverEnabled || event.composedPath().includes(host)) { globalThis.clearTimeout(hiding); return; }
    globalThis.clearTimeout(hiding);
    if (active) hiding = setTimeout(hide, 550);
    timer = setTimeout(() => { void detect(event.clientX, event.clientY); }, 200);
  }, {passive: true});
  document.addEventListener("scroll", event => { if (!event.composedPath().includes(host)) hide(); }, {passive: true, capture: true});
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  document.addEventListener("mouseleave", hide);
  globalThis.addEventListener("blur", hide);
  const interval = globalThis.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60000);
  globalThis.addEventListener("pagehide", () => { globalThis.clearInterval(interval); hide(); }, {once: true});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(defaults)) if (changes[key]) settings[key] = changes[key].newValue ?? defaults[key];
    if (!settings.hoverEnabled) { hide(); return; }
    if (changes.apiUrl) { snapshot = null; version++; void refresh(); }
    render();
  });
  chrome.storage.local.get(defaults).then(value => { settings = value; });
})();
