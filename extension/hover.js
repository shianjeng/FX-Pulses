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
  let coverage = [], coverageAt = 0, coveragePending = false;
  /* Shared with the popup: extension/messages.js is generated from _locales. */
  const KEYS = {
    title: "hoverSectionTitle", source: "hoverSource", target: "hoverTargetField",
    copy: "hoverCopy", settings: "settings", close: "hoverClose", loading: "loadingRates",
    unavailable: "hoverUnavailable", unsupported: "hoverUnsupported", mock: "mockData",
    live: "providerLive", offline: "offlineCache", stale: "hoverStale", time: "asOf",
    guessed: "hoverGuessed", disclaimer: "hoverDisclaimer", manual: "hoverManual",
    copied: "copied", cross: "crossRate", official: "hoverOfficial",
    officialLoading: "loadingOfficial", also: "hoverAlso", market: "hoverMarket",
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
  /* Money follows the currency's own minor unit (2 for CNY, 0 for JPY and KRW,
     3 for KWD). A fixed "0 for JPY, else up to 4" showed 195.2248 CNY. */
  const minorUnits = code => {
    try { return new Intl.NumberFormat("en", {style: "currency", currency: code}).resolvedOptions().maximumFractionDigits; }
    catch { return 2; }
  };
  const format = (amount, code) => {
    const digits = minorUnits(code);
    return new Intl.NumberFormat(locale(), {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(amount);
  };
  // Same display rule as the popup's formatRate(), so a rate reads identically in both.
  const formatRate = value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    if (number < 1e-8) return number.toLocaleString(locale(), {notation: "scientific", maximumSignificantDigits: 5});
    const digits = number >= 100 ? 3 : number >= 1 ? 4 : Math.min(12, Math.max(6, 4 - Math.floor(Math.log10(number))));
    return new Intl.NumberFormat(locale(), {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(number);
  };
  const shortTime = value => new Date(value).toLocaleString(locale(), {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
  // Built node by node: this script runs inside other people's pages, so it
  // never hands markup to innerHTML, not even its own constants.
  const svg = (shapes, label) => {
    const button = el("button", "", "icon");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    const ns = "http://www.w3.org/2000/svg", icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of shapes) {
      const shape = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
      icon.append(shape);
    }
    button.append(icon);
    return button;
  };
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

  /* Every covered currency, so both pickers offer what the popup offers. Asked
     for once a page and cached by the worker for every tab; the message carries
     nothing from the page. A failure retries after a minute, not on every hover. */
  function loadCoverage() {
    if (coveragePending || Date.now() - coverageAt < 600000) return;
    coveragePending = true;
    chrome.runtime.sendMessage({type: "FX_CURRENCIES"})
      .then(reply => {
        const data = reply?.ok ? reply.data : null;
        const codes = [
          ...(Array.isArray(data?.market_pairs) ? data.market_pairs.flatMap(pair => String(pair).split("/")) : []),
          ...(Array.isArray(data?.official_currencies) ? data.official_currencies : []),
        ].filter(validCode);
        if (codes.length) { coverage = [...new Set(codes)]; coverageAt = Date.now(); }
        else coverageAt = Date.now() - 540000;
      })
      .catch(() => { coverageAt = Date.now() - 540000; })
      .finally(() => { coveragePending = false; if (active) render(); });
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.id = "fx-pulse-unified-hover";
    host.style.cssText = "position:fixed!important;z-index:2147483647!important;display:none;";
    shadow = host.attachShadow({mode: "closed"});
    const style = document.createElement("style");
    // Same palette as the popup, scoped to this closed shadow root.
    style.textContent = `:host{all:initial}*{box-sizing:border-box}
.card{--bg:#fff;--bg2:#f2f5f8;--line:#e3e8ee;--text:#121c28;--muted:#5a6878;--faint:#8c98a6;--accent:#0b8a6f;--accent-soft:#e2f4ee;--warn:#a4680a;--warn-soft:#fcf1dc;
width:300px;max-width:calc(100vw - 16px);padding:12px 14px 12px;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--text);
box-shadow:0 2px 6px rgb(18 28 40/6%),0 14px 36px rgb(18 28 40/16%);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans","Noto Sans SC",sans-serif;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.card{--bg:#161e25;--bg2:#1f2932;--line:#2a3640;--text:#e9eef3;--muted:#a0adb9;--faint:#6d7c89;--accent:#3ccf9e;--accent-soft:rgb(60 207 158/14%);--warn:#e7ae4a;--warn-soft:rgb(231 174 74/14%);box-shadow:0 14px 36px rgb(0 0 0/45%)}}
.card[data-size=s]{width:260px;padding:10px 12px}.card[data-size=l]{width:340px;padding:14px 16px}
.head{display:flex;align-items:center;gap:6px;margin-bottom:6px}.head img{width:18px;height:18px}.head strong{flex:1;color:var(--muted);font-size:11.5px;font-weight:600}
.icon{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--faint);cursor:pointer}
.icon:hover{background:var(--bg2);color:var(--text)}.icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.amount{font-size:26px;font-weight:700;letter-spacing:-.6px;line-height:1.15;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.card[data-size=s] .amount{font-size:22px}.card[data-size=l] .amount{font-size:30px}
.approx{color:var(--faint);font-weight:500}.code{font-size:.6em;font-weight:650;color:var(--muted);letter-spacing:0}
.origin{margin-top:2px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.fields{display:flex;align-items:center;gap:6px;margin:10px 0 0}.fields label{flex:1;min-width:0}
.arrow{color:var(--faint);font-size:12px}
select{appearance:none;-webkit-appearance:none;width:100%;height:30px;padding:0 24px 0 10px;border:1px solid var(--line);border-radius:9px;
background:var(--bg2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%238c98a6' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 8px center/10px;
color:var(--text);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.alts{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:8px;color:var(--faint);font-size:11px}
.alts .hint{flex-basis:100%;margin-bottom:1px}
.chip{height:22px;padding:0 8px;border:1px solid var(--line);border-radius:99px;background:transparent;color:var(--muted);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.meta{margin-top:10px;padding-top:9px;border-top:1px solid var(--line);display:grid;gap:3px}
.rate{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
.note{margin:0;color:var(--faint);font-size:11px;overflow-wrap:anywhere}
.badge{display:inline-block;margin-right:5px;padding:1px 6px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:10.5px;font-weight:650}
.warning{color:var(--warn)}.badge.warning{background:var(--warn-soft)}
.details{margin-top:8px;display:grid;gap:2px}
.detail{display:flex;justify-content:space-between;padding:4px 8px;border-radius:7px;background:var(--bg2);font-size:12px;font-variant-numeric:tabular-nums}
.detail span:first-child{color:var(--muted);font-weight:600}
.foot{display:flex;align-items:center;gap:8px;margin-top:10px}
.foot .note{flex:1}
.copy{flex-shrink:0;height:28px;padding:0 12px;border:0;border-radius:99px;background:var(--accent);color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}
.copy:disabled{opacity:.4;cursor:default}
input{width:100%;margin-top:6px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg2);color:var(--text);font:inherit}
button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;
    shadow.append(style);
    card = el("section", "", "card"); card.setAttribute("role", "dialog"); shadow.append(card);
    host.addEventListener("mouseenter", () => { globalThis.clearTimeout(hiding); globalThis.clearTimeout(timer); });
    host.addEventListener("mouseleave", () => { hiding = setTimeout(hide, 350); });
    shadow.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
    document.documentElement.append(host);
  }

  /* Below the amount when it fits, above it when it does not: clamping into the
     viewport used to slide the card up over the very figure being read. */
  function place() {
    host.style.display = "block";
    const {width, height} = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(globalThis.innerWidth - width - 8, active.rect.left));
    const below = active.rect.bottom + 8, above = active.rect.top - 8 - height;
    const fitsBelow = below + height <= globalThis.innerHeight - 8;
    const top = fitsBelow || above < 8 ? Math.max(8, Math.min(globalThis.innerHeight - height - 8, below)) : above;
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  async function setSource(code) {
    if (!active || !validCode(code)) return;
    active.match.code = code; active.confirmed = true;
    await rememberCode(active.match, code);
    render();
  }

  function render() {
    if (!active || !settings.hoverEnabled) return;
    build(); card.replaceChildren(); card.dataset.size = settings.hoverSize;
    card.lang = locale(); card.setAttribute("aria-label", tr("title"));

    const heading = el("div", "", "head"), logo = el("img");
    logo.src = chrome.runtime.getURL("icons/icon.svg"); logo.alt = "";
    const options = svg([["circle", {cx: "12", cy: "12", r: "3"}], ["path", {d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"}]], tr("settings"));
    options.onclick = () => { void chrome.runtime.sendMessage({type: "FX_OPEN_SETTINGS"}); };
    const close = svg([["path", {d: "M6 6l12 12M18 6 6 18"}]], tr("close"));
    close.onclick = hide;
    heading.append(logo, el("strong", "FX Pulse"), options, close);
    card.append(heading);

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

    const amount = el("div", "", "amount");
    if (available) amount.append(el("span", "≈ ", "approx"), el("span", format(value, to)), el("span", ` ${to}`, "code"));
    else amount.textContent = "—";
    card.append(amount, el("div", `${active.match.raw.trim()} · ${from}`, "origin"));

    // Every covered currency, plus the parser's candidates and saved pairs so a
    // choice stays listed even before the list arrives or while offline.
    loadCoverage();
    const alts = Array.isArray(active.match.alts) ? active.match.alts : [];
    const codes = [...new Set([from, to, ...alts, ...coverage, ...(snapshot?.pairs || []), ...settings.watchlist]
      .flatMap(item => String(item).split("/")))].filter(validCode).sort();
    const fields = el("div", "", "fields");
    for (const [key, selected] of [["source", from], ["target", to]]) {
      const label = el("label"), select = el("select");
      label.append(el("span", tr(key), "sr"));
      select.setAttribute("aria-label", tr(key));
      for (const code of codes) { const option = el("option", code); option.value = code; select.append(option); }
      select.value = selected;
      select.onchange = async () => {
        if (!active) return;
        if (key === "source") { await setSource(select.value); return; }
        settings.hoverTarget = select.value; await chrome.storage.local.set({hoverTarget: select.value});
        render();
      };
      label.append(select); fields.append(label);
      if (key === "source") fields.append(el("span", "→", "arrow"));
    }
    card.append(fields);

    // Only ask for a correction when the guess is genuinely uncertain: "4,590円"
    // is yen, "¥100" or "$10" could be several currencies.
    // "$" alone has seven candidates; offer the parser's four likeliest, in its order.
    const score = code => Number(active.match.totals?.[code]) || 0;
    const others = alts.filter(code => validCode(code) && code !== from)
      .sort((a, b) => score(b) - score(a)).slice(0, 4);
    if (!active.confirmed && others.length && (alts.length > 1 || Number(active.match.conf) < 0.8)) {
      const row = el("div", "", "alts");
      row.append(el("span", tr("guessed"), "hint"), el("span", tr("also")));
      for (const code of others) {
        const chip = el("button", code, "chip"); chip.type = "button";
        chip.onclick = () => { void setSource(code); };
        row.append(chip);
      }
      card.append(row);
    }

    const meta = el("div", "", "meta");
    if (available) {
      meta.append(el("div", `1 ${from} = ${formatRate(rate.value)} ${to}`, "rate"));
      if (isOfficial) {
        const line = el("p", "", "note");
        line.append(el("span", tr("official"), "badge"), `${rate.institution} · ${rate.date}${rate.derived ? ` · ${tr("cross")}` : ""}`);
        meta.append(line);
      } else {
        const line = el("p", "", "note");
        if (current.provider === "mock") line.append(el("span", tr("mock"), "badge warning"));
        line.append(`${tr("market")} · ${tr("live")} · ${shortTime(current.captured_at)}`);
        meta.append(line);
        if (snapshot.offline || current.is_stale) meta.append(el("p", tr(snapshot.offline ? "offline" : "stale"), "note warning"));
      }
    } else {
      const pending = officialPending.has(`${from}/${to}`);
      meta.append(el("p", error ? tr("unavailable") : pending ? tr("officialLoading") : snapshot ? tr("unsupported") : tr("loading"), "note warning"));
    }
    card.append(meta);

    if (settings.hoverMode === "detail" && snapshot) {
      const details = el("div", "", "details");
      const targets = [...new Set(settings.watchlist.flatMap(pair => pair.split("/")))]
        .filter(code => validCode(code) && code !== to && code !== from).slice(0, 6);
      for (const code of targets) {
        // Official-only currencies used to show only if some earlier hover had
        // cached them; ask for them, and the card re-renders when they arrive.
        const other = quote(from, code) || officialFor(from, code);
        if (other) { const row = el("div", "", "detail"); row.append(el("span", code), el("span", format(active.match.amount * other.value, code))); details.append(row); }
      }
      if (details.childElementCount) card.append(details);
    }

    const foot = el("div", "", "foot"), copy = el("button", tr("copy"), "copy");
    copy.type = "button";
    copy.disabled = !available;
    copy.onclick = async () => {
      const origin = isOfficial ? `${tr("official")} · ${rate.institution}`
        : `${current.provider === "mock" ? tr("mock") : tr("live")}${snapshot.offline ? ` · ${tr("offline")}` : current.is_stale ? ` · ${tr("stale")}` : ""}`;
      const text = `${active.match.raw.trim()} → ≈ ${format(value, to)} ${to} · ${origin}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = tr("copied"); }
      catch { const input = el("input"); input.readOnly = true; input.value = text; input.setAttribute("aria-label", tr("manual")); card.append(el("p", tr("manual"), "note"), input); input.focus(); input.select(); }
    };
    foot.append(el("p", tr("disclaimer"), "note"), copy);
    card.append(foot);
    place();
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
    active = {match, rect, confirmed: Boolean(remembered)}; error = ""; globalThis.clearTimeout(hiding); render(); void refresh();
  }

  document.addEventListener("mousemove", event => {
    // Only the opt-in bridge can set this, and only once per document.
    if (globalThis.__fxBridgeInstalled && globalThis.__fxUserscriptUntil > Date.now()) { hide(); return; }
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
    if (changes.apiUrl) { snapshot = null; version++; officialCache.clear(); coverage = []; coverageAt = 0; void refresh(); }
    render();
  });
  chrome.storage.local.get(defaults).then(value => { settings = value; });
})();
