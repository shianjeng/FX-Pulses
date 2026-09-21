/* Runs only in Chrome's isolated content-script world, after opt-in. */
(() => {
  if (globalThis.__fxHoverInstalled) return;
  globalThis.__fxHoverInstalled = true;
  const parser = globalThis.FXAmountParser;
  const defaults = {hoverEnabled: false, hoverTarget: "CNY", hoverSize: "m", hoverMode: "simple", language: "zh", watchlist: ["USD/CNY", "USD/JPY", "CNY/JPY"]};
  let settings = {...defaults}, host, shadow, card, active, snapshot, error = "", timer, hiding, version = 0, pointerVersion = 0;
  const MEMORY_LIMIT = 200;
  const officialCache = new Map();   // "FROM/TO" -> observation | null
  const officialPending = new Set();
  /* Shared with the popup: extension/messages.js is generated from _locales. */
  const KEYS = {
    title: "hoverSectionTitle", source: "hoverSource", target: "hoverTargetField",
    copy: "hoverCopy", settings: "settings", close: "hoverClose", loading: "loadingRates",
    unavailable: "hoverUnavailable", unsupported: "hoverUnsupported", mock: "mockData",
    live: "providerLive", offline: "offlineCache", stale: "hoverStale", time: "asOf",
    guessed: "hoverGuessed", disclaimer: "hoverDisclaimer", manual: "hoverManual",
    copied: "copied", cross: "crossRate", official: "hoverOfficial",
    officialLoading: "loadingOfficial",
  };
  const tr = key => {
    const table = globalThis.FXMessages || {};
    const name = KEYS[key];
    return table[settings.language]?.[name] ?? table.zh?.[name] ?? name;
  };
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

  /* Per-site currency corrections used to be written forever, eventually filling
     the 10 MB chrome.storage.local quota. Keep the most recently used ones. */
  async function rememberCode(match, code) {
    const key = memoryKey(match);
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(name => name.startsWith("hoverMemory:") && name !== key);
      if (keys.length >= MEMORY_LIMIT) {
        const stale = keys
          .map(name => [name, all[name]?.at ?? 0])
          .sort((a, b) => a[1] - b[1])
          .slice(0, keys.length - MEMORY_LIMIT + 1)
          .map(([name]) => name);
        if (stale.length) await chrome.storage.local.remove(stale);
      }
      await chrome.storage.local.set({[key]: {code, at: Date.now()}});
    } catch { /* a full quota must not break the card */ }
  }
  const storedCode = value => validCode(value) ? value : validCode(value?.code) ? value.code : null;

  function officialFor(from, to) {
    const key = `${from}/${to}`;
    const cached = officialCache.get(key);
    if (cached) {
      const ttl = cached.missing ? 60000 : 600000;
      if (Date.now() - cached.cachedAt < ttl) return cached.missing ? null : cached;
      officialCache.delete(key);
    }
    if (officialPending.has(key) || from === to) return undefined;
    officialPending.add(key);
    chrome.runtime.sendMessage({type: "FX_OFFICIAL", path: `/official-rates/${from}/${to}`})
      .then(reply => {
        const rows = reply?.ok && Array.isArray(reply.data) ? reply.data : [];
        // Providers update on different calendars. Prefer the newest observation
        // instead of whichever institution happens to be returned first.
        const best = rows
          .filter(row => Number(row?.rate) > 0 && Number.isFinite(Date.parse(row.reference_date)))
          .sort((a, b) => Date.parse(b.reference_date) - Date.parse(a.reference_date))[0];
        officialCache.set(key, best ? {
          value: Number(best.rate), institution: best.institution,
          date: best.reference_date, derived: best.is_derived, cachedAt: Date.now(),
        } : {missing: true, cachedAt: Date.now()});
      })
      .catch(() => officialCache.set(key, {missing: true, cachedAt: Date.now()}))
      .finally(() => { officialPending.delete(key); render(); });
    return undefined;
  }

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
    const current = quote(from, to);
    // The parser recognises far more currencies than the market feed tracks;
    // an official daily reference is offered instead of an empty card, labelled
    // as such so a reference rate is never shown as a live quote.
    const fallback = current || !snapshot ? undefined : officialFor(from, to);
    const rate = current || fallback || null;
    const value = rate ? active.match.amount * rate.value : null;
    const available = value !== null && Number.isFinite(value);
    const isOfficial = !current && Boolean(fallback);
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
        if (key === "source") { active.match.code = select.value; await rememberCode(active.match, select.value); }
        else { settings.hoverTarget = select.value; await chrome.storage.local.set({hoverTarget: select.value}); }
        render();
      };
      label.append(select); fields.append(label);
    }
    card.append(fields, el("p", tr("guessed"), "note"));
    if (available) {
      card.append(el("div", `1 ${from} = ${new Intl.NumberFormat(locale(), {maximumSignificantDigits: 7}).format(rate.value)} ${to}`));
      if (isOfficial) {
        card.append(el("p", tr("official"), "note warning"));
        card.append(el("p", `${rate.institution} · ${rate.date}${rate.derived ? ` · ${tr("cross")}` : ""}`, "note"));
      } else {
        const source = current.provider === "mock" ? tr("mock") : tr("live");
        card.append(el("p", source, current.provider === "mock" ? "note warning" : "note"));
        card.append(el("p", `${tr("time")} ${new Date(current.captured_at).toLocaleString(locale())}`, "note"));
        if (snapshot.offline || current.is_stale) card.append(el("p", tr(snapshot.offline ? "offline" : "stale"), "note warning"));
      }
    } else card.append(el("p", error ? tr("unavailable") : officialPending.size ? tr("officialLoading") : snapshot ? tr("unsupported") : tr("loading"), "note warning"));
    if (settings.hoverMode === "detail" && snapshot) {
      const targets = [...new Set(settings.watchlist.flatMap(pair => pair.split("/")))].filter(code => code !== to && code !== from);
      for (const code of targets) {
        const cachedOther = officialCache.get(`${from}/${code}`);
        const other = quote(from, code) || (cachedOther?.missing ? null : cachedOther);
        if (other) { const row = el("div", "", "detail"); row.append(el("span", code), el("span", format(active.match.amount * other.value, code))); card.append(row); }
      }
    }
    card.append(el("p", tr("disclaimer"), "note"));
    const actions = el("div", "", "actions"), copy = el("button", tr("copy")), options = el("button", tr("settings"));
    copy.disabled = !available;
    copy.onclick = async () => {
      const origin = isOfficial ? `${tr("official")} · ${rate.institution}`
        : `${current.provider === "mock" ? tr("mock") : tr("live")}${snapshot.offline ? ` · ${tr("offline")}` : current.is_stale ? ` · ${tr("stale")}` : ""}`;
      const text = `${active.match.raw.trim()} → ≈ ${format(value, to)} ${to} · ${origin}`;
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
    const remembered = storedCode(saved[memoryKey(match)]);
    if (remembered) match.code = remembered;
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
    if (changes.apiUrl) { snapshot = null; version++; officialCache.clear(); void refresh(); }
    render();
  });
  chrome.storage.local.get(defaults).then(value => { settings = value; });
})();
