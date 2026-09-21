/* Key-based localization for extension pages.
 *
 * The previous implementation walked every text node and replaced the longest
 * matching Chinese string. That made ordering significant, re-translated its own
 * output, silently missed any string nobody had registered, and rebuilt a
 * hundred-alternative RegExp per node. Markup now names a key instead:
 *
 *   <h1 data-i18n="watchlistTitle">自选行情</h1>
 *   <button data-i18n-attr="title:refresh,aria-label:refresh">↻</button>
 *
 * The in-page text is the zh fallback, so the popup still reads correctly if
 * this script never runs. Dynamic strings go through FXI18N.t(key, ...values),
 * where $1, $2 ... are substituted positionally.
 */
(() => {
  const LANGUAGES = ["zh", "en", "ja"];
  const DOC_LANG = {zh: "zh-CN", en: "en", ja: "ja"};
  const tables = globalThis.FXMessages || {};
  let language = "zh";

  function uiDefault() {
    const tag = (chrome.i18n?.getUILanguage?.() || "").toLowerCase();
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("zh")) return "zh";
    if (tag) return "en";
    return "zh";
  }

  function t(key, ...values) {
    const message = tables[language]?.[key] ?? tables.zh?.[key] ?? key;
    return values.length
      ? message.replace(/\$(\d)/g, (match, index) => values[Number(index) - 1] ?? match)
      : message;
  }

  function apply(root = document) {
    for (const node of root.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of root.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of node.dataset.i18nAttr.split(",")) {
        const [attribute, key] = pair.split(":").map((part) => part.trim());
        if (attribute && key) node.setAttribute(attribute, t(key));
      }
    }
  }

  function addSwitcher() {
    if (document.getElementById("language-switch")) return;
    const select = document.createElement("select");
    select.id = "language-switch";
    for (const code of LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = t(`lang${code[0].toUpperCase()}${code[1]}`);
      select.append(option);
    }
    select.value = language;
    select.setAttribute("aria-label", t("languageLabel"));
    select.addEventListener("change", async () => {
      await chrome.storage.local.set({language: select.value});
      globalThis.location.reload();
    });
    (document.querySelector(".header-actions") || document.querySelector("main"))?.prepend(select);
  }

  const ready = (async () => {
    let stored;
    try { stored = (await chrome.storage.local.get({language: null})).language; } catch { /* defaults */ }
    language = LANGUAGES.includes(stored) ? stored : uiDefault();
    document.documentElement.lang = DOC_LANG[language];
    document.title = document.querySelector("#settings-form") ? t("optionsDocTitle") : "FX Pulse";
    apply();
    addSwitcher();
    return language;
  })();

  globalThis.FXI18N = {ready, t, apply, get language() { return language; }};
})();
