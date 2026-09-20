# fx-pulse-hover · UI 接口契约（外包设计师交付文档）

**给谁看**：外部视觉设计师
**不需要看的东西**：JS 源码（本文件已覆盖全部可画元素、状态与命名）
**一句话背景**：这是一个油猴脚本（userscript / 浏览器扩展形态）。鼠标悬停到网页上的金额文本（如 `$100.00`）时，在光标附近弹出一个小卡片，显示实时汇率换算结果。卡片渲染在 **Shadow DOM** 内，宿主元素为页面里的 `#fxph-host`（0×0 固定定位在页面左上角，本身不承载任何视觉）。

**边界**：脚本逻辑不动。所有视觉效果必须由 **① CSS 自定义属性（token）取值** 和 **② 一份可替换的 CSS 覆盖** 完成。DOM 结构（元素层级、`data-part` 名、`data-mode` / `data-size` 属性）由脚本产出，**设计师不改 DOM**。

**当前内置实现（v0.3）**：`theme.css` / `tokens.md` 是已交付的报纸风主题。用户额外要求的 GPT-Image 版画图位于 `assets/exchange-globe.png`，由 `embed-theme.mjs` 转成 data URL 内嵌到 userscript，因此实际安装仍为单文件。脚本只在金额命中时识别该位置网页背景色，并在 Shadow Host 上设置 `data-palette="paper|ink|marine|sage|clay"`；各色的 token 取值见 `tokens.md`。下文对**外部设计师交付**的「不要交 PNG」约束不限制这个已内嵌资产。

---

## 1. 这份文档怎么用

| 步骤 | 谁做 | 产出 |
|---|---|---|
| ① 读第 2 章拿 `data-part` 清单 + 第 4 章状态矩阵 | 设计师 | 知道要画哪些区块、哪些状态 |
| ② 按第 5 章三档尺寸 + 第 6 章线框出设计稿（Figma / Sketch） | 设计师 | 每个 mode × state × size 的静态稿（建议用第 9 章 prompt 生成风格参考，再手工精修） |
| ③ 填第 3 章 token 表（只改「取值」列） | 设计师 | token 表（改好的默认值） |
| ④ 写一份 CSS 覆盖（可以整份重写内置样式） | 设计师 | `theme.css` |
| ⑤ 把 token 表 + `theme.css` 接进脚本 | 脚本作者 | 生效 |

**产出物格式（只需交这两样）**

1. **Token 表**：Markdown / CSV 皆可，两列 `变量名 → 取值`。变量名必须逐字使用第 3 章的名字，一个都不能改、不能加前缀、不能删。
2. **CSS**：一个 `.css` 文本文件，选择器只允许使用第 2 章的 `data-part` / `data-mode` / `data-size` / 状态属性（状态用 `data-*` 或 class 暴露，见第 4 章），以及 `:host`（只放 token）。

**不要交付**：HTML 结构改动、JS、SVG/PNG 切图、外部字体文件、图标字体、CDN 链接。

---

## 2. DOM 结构契约

选择器写法示例：`[data-part="amount-main"]`、`[data-part="card"][data-mode="detail"][data-size="l"]`。

| `data-part` | 中文说明 | 出现条件 | 子元素 / 内容 |
|---|---|---|---|
| `card` | 卡片根元素（唯一根） | 总是 | 同时带 `data-mode="simple\|detail"` 与 `data-size="s\|m\|l"`；承载全部 token |
| `amount-main` | 换算后的主数字 | 总是 | 文本，如 `≈ ¥697.60` |
| `amount-main-code` | 主数字的货币代码 | 总是 | 文本，如 `CNY` |
| `amount-origin` | 原始金额文本 | 总是 | 文本，如 `$100.00` |
| `amount-origin-code` | 原始金额的货币代码 | 总是 | 文本，如 `USD` |
| `origin-select` | 原始币种校准下拉 | **总是**（与 `target-select` 并列，两个下拉常驻） | `<select>`，选项为常见币种 |
| `target-select` | 目标币种下拉 | 总是 | `<select>` |
| `multi-list` | 多币种换算列表容器 | 仅 detail 模式（`size-l`） | 若干 `multi-row` |
| `multi-row` | 单条多币种换算行 | 仅 detail 模式 | `multi-value` + `multi-code` |
| `multi-value` | 多币种换算数值 | 仅 detail 模式 | 文本，如 `≈ ¥697.60` / `≈ ¥15,714` |
| `multi-code` | 多币种货币代码 | 仅 detail 模式 | 文本，如 `CNY` / `JPY` / `EUR` |
| `rate-line` | 单位汇率行 | size-s 隐藏，size-m/l 显示 | 文本，如 `1 USD = 6.6976 CNY` |
| `timestamp` | 数据时间。simple 只显示「2 分钟前」；detail 显示完整 UTC 时间 + 数据源 + 缓存 TTL | 总是 | 文本，如 `2026-09-20 00:02 UTC · ER-API · 缓存 2 分钟前` |
| `evidence` | 识别置信度与证据列表 | 仅 detail 模式 | 文本，如 `置信度 0.78 · lang=zh-CN(+4)、域名 .cn(+5)` |
| `parse-detail` | 解析细节 | 仅 detail 模式 | 文本，如 `原始 "$1,000.00" · 标记 ¥ · 量级 无 · 数值 1000` |
| `badge-guess` | 「猜测」徽章（识别置信度低） | ambiguous 状态 | 文本，如 `猜测 0.50` |
| `badge-adjust` | 「已校准」徽章（用户手动改过币种） | adjusted 状态 | 文本，如 `已校准` |
| `warn-stale` | 汇率刷新失败、使用旧缓存 警告条 | stale 状态 | 文本，如 `汇率刷新失败 · 显示 2 分钟前的缓存` |
| `warn-offline` | 无可用汇率的警告条 | offline 状态 | 文本，如 `汇率暂不可用，请稍后重试` |
| `warn-error` | 完全取不到汇率 警告条 | error 状态 | 文本，如 `无法获取汇率` |
| `actions` | 按钮行容器 | 仅 detail 模式 | `action-settings` + `action-copy` + `action-close` |
| `action-settings` | 打开设置面板按钮 | detail 模式 | `<button>` |
| `action-copy` | 复制换算结果按钮 | detail 模式 | `<button>` |
| `action-close` | 关闭卡片按钮（解除 pinned） | detail 模式 | `<button>` |
| `toast` | 右键复制后的「已复制」轻提示 | 复制动作触发后短暂出现 | 文本 `已复制` |
| `settings` | 设置面板根元素 | settings-open 状态 | 面板容器 |
| `settings-head` | 设置面板标题栏 | settings-open | 标题 + 关闭按钮 |
| `settings-row` | 单条设置项行 | settings-open | `settings-label` + `settings-control` |
| `settings-label` | 设置项名称 | settings-open | 文本，如 `目标币种` |
| `settings-control` | 设置项控件（开关 / 下拉 / 数字输入） | settings-open | `<input>` / `<select>` / `<button>` |
| `settings-actions` | 设置面板底部操作区（保存 / 重置 / 恢复默认） | settings-open | `<button>` × N |
| `settings-memory` | 本域名校准记忆列表（该站点记住的币种修正） | settings-open 且有记忆 | 列表，每项形如 `.cn → CNY` |

---

## 3. 设计 token（CSS 变量）表

全部定义在 shadow root 的 `:host` 上。**设计师只改「取值」列，变量名一字不改。**

| 变量名 | 实现默认值（深色基线） | 用途 |
|---|---|---|
| `--fxph-scale` | `1` | 整体缩放系数，由大中小三档给出（s=`0.9` / m=`1` / l=`1.15`）。卡片内所有尺寸写成 `calc(<基准> * var(--fxph-scale))` |
| `--fxph-bg` | `#fffaf0` | 卡片背景色（含 toast、settings 面板、下拉控件底色） |
| `--fxph-fg` | `#28231e` | 主文本色（原始金额、多币种数值） |
| `--fxph-accent` | `#8b341f` | 强调色：换算后的主数字、汇率行、hover 边框、toast |
| `--fxph-accent-weak` | `#684b3b` | 强调色的弱化：货币代码、证据文本 |
| `--fxph-muted` | `#63594f` | 次级文本色：时间戳、解析细节 |
| `--fxph-border` | `#a9967e` | 卡片描边、控件与按钮边框、settings 分隔线 |
| `--fxph-warn` | `#805018` | 警告色：`warn-stale`、`warn-offline` |
| `--fxph-danger` | `#922d2d` | 错误色：`warn-error` |
| `--fxph-radius` | `3px` | 圆角（报纸风为接近直角的边缘） |
| `--fxph-pad` | `14px` | 卡片内边距基准（各档位按 `calc(pad * scale)` 派生） |
| `--fxph-gap` | `8px` | 区块与行之间的纵向间距基准 |
| `--fxph-font` | `Georgia, "Songti SC", "Noto Serif CJK SC", serif` | 正文 / 标签字体栈（禁止外部字体） |
| `--fxph-font-mono` | `ui-monospace, SFMono-Regular, Consolas, "Noto Sans Mono CJK SC", monospace` | 数字 / 货币代码 / 时间戳 / 证据文本（等宽，防数字跳动） |
| `--fxph-shadow` | `0 12px 30px rgba(36,27,18,.22)` | 卡片投影（唯一浮层阴影，不要给子元素再加投影） |
| `--fxph-max-width` | `340px` | 卡片最大宽度；由脚本按档位写入 `300 / 340 / 460px`（详细模式不小于 420px），CSS 侧再用 `min(…, calc(100vw - 16px))` 夹取 |

> 备注 1：`--fxph-scale` 与 `--fxph-max-width` 由脚本按 `data-size` 写在宿主元素的行内样式上，**设计师改这两个不会生效**，只提供 s/m/l 三档建议取值即可。
> 备注 2：以上是默认 paper 配色，其余四组自动配色见 `tokens.md`。设计师可以整套替换 —— 只要把 16 个 token 全部给出取值，不需要改任何选择器。
> 备注 3：交付 CSS 时**不要**再写 `:host{...}` 里的 token 定义之外的布局覆盖；布局由脚本的基础 CSS 负责，你的 CSS 通过 `<style id="fxph-theme">` 追加在内置样式**之后**，同优先级下后者生效（这也是为什么不需要 `!important`）。

---

## 4. 状态矩阵

状态通过卡片上的 `data-*` 属性（或 class）暴露，选择器示例：`[data-part="card"][data-state~="stale"]`。**每个状态都要在设计稿里出现一次。**

| 状态名 | 触发条件 | 视觉上要区分什么 |
|---|---|---|
| `default` | 卡片刚出现（未悬停、未钉住） | 基准样式：中性背景、常态阴影、无高亮 |
| `hover` | 鼠标悬停在卡片上 | 卡片可交互提示：边框/阴影略强；行 hover 用 `--fxph-accent-weak`；按钮 hover 态 |
| `pinned` | 已钉住（点击后鼠标移开也不消失） | 与 default 明显不同：例如 accent 描边 / 左侧色条 / 顶部「已钉住」视觉锚点，让用户知道卡片不会自己消失 |
| `ambiguous` | 币种识别置信度低 | 出现 `badge-guess`（`猜测 0.50`）。需给「待用户确认」的视觉重量：warn 系徽章色。注意：两个下拉（`origin-select` / `target-select`）在任何状态下都存在，不属于 ambiguous 独有 |
| `adjusted` | 用户手动校准过币种 | 出现 `badge-adjust`（`已校准`）；用 accent 系而非 warn 系，表达「已确定」 |
| `stale` | 汇率刷新失败，用旧缓存 | 顶部/底部显示 `warn-stale` 条（warn 色 + 弱底）；`timestamp` 的缓存时长需被强调 |
| `offline` | 网络不可用，且没有有效缓存 | 显示 `warn-offline` 条；不提供示例换算结果 |
| `error` | 完全取不到汇率 | 显示 `warn-error` 条（danger 色）；主数字位置改为不可用占位，保留原始金额与目标币种选择 |
| `settings-open` | 设置面板打开 | `settings` 面板覆盖/紧贴卡片；需给出面板与卡片的层级关系、`settings-row` 分隔、`settings-actions` 底部固定区、`settings-memory` 列表样式 |
| `size-s` | 小档 | 信息密度最高：主数字 + 两个下拉（目标/原始）+ 原始金额 + 时间戳（`rate-line`、多币种、证据、按钮行都不出现） |
| `size-m` | 中档（默认） | 主数字 + 两个下拉 + 原始金额 + `rate-line` + 时间戳 |
| `size-l` | 大档（详细模式） | 多币种列表、证据、解析细节、按钮行全部显示 |

**正交关系**：`size-*` 与 `data-mode` 绑定，数据状态（`stale` / `offline` / `error` / `ambiguous` / `adjusted`）可与 `hover` / `pinned` / `settings-open` 叠加。请按「基础档位 × 数据状态 × 交互状态」给出关键组合稿，不必穷举全部笛卡尔积，但至少覆盖：`simple + size-s + default`、`simple + size-m + hover`、`simple + size-m + pinned`、`simple + size-m + ambiguous`、`simple + size-m + adjusted`、`simple + size-m + stale`、`simple + size-m + offline`、`simple + size-m + error`、`detail + size-l + default`、`detail + size-l + settings-open`。

---

## 5. 三档尺寸规格

| 项目 | `size-s` 小 | `size-m` 中（默认） | `size-l` 大 |
|---|---|---|---|
| `--fxph-scale` | `0.9` | `1` | `1.15` |
| 卡片宽度（`--fxph-max-width`） | `300px` | `340px` | `460px` |
| 主数字字号（`amount-main`） | `18px` | `20px` | `23px` |
| 正文字号（其余文本） | `10.8px` | `12px` | `13.8px` |
| 内边距（卡片 `padding`） | `9px` | `10px` | `11.5px` |
| 行距（`line-height`） | 1.5（主数字 1.3） | 1.5（主数字 1.3） | 1.5（主数字 1.3） |
| 内容 | 由 `data-mode` 决定，与档位正交（见第 6 章）；档位只改尺寸与最大宽度，`size-l` 常用于详细模式 | | |

> 上表中的 px = `calc(基准 × var(--fxph-scale))`。所有宽度必须写成「受 `100vw` 夹取」的形式（`min(var(--fxph-max-width), calc(100vw - 16px))`），保证 320px 视口下卡片完整可见、不横向裁切（第 7 章硬要求）。

---

## 6. 简单模式与详细模式的线框

### 6.1 `data-mode="simple"`（size-s / size-m）

```
                    ╭─ [data-part="card"]  data-mode="simple"  data-size="m"
                    │   圆角 var(--fxph-radius) · 投影 var(--fxph-shadow)
┌───────────────────┴──────────────────────────────────────┐
│ [data-part="amount-main"]  ≈ ¥697.60                     │
│ [data-part="amount-main-code"]  CNY        [data-part="badge-guess"] 猜测 0.50
│                                                          │
│ [data-part="amount-origin"]  $100.00                     │
│ [data-part="amount-origin-code"]  USD                    │
│ [data-part="origin-select"]  原始 [ USD ▾ ]  ← 总是出现（与目标下拉并列）
│ [data-part="target-select"]  目标 [ CNY ▾ ]              │
│                                                          │
│ [data-part="rate-line"]  1 USD = 6.6976 CNY   ← size-m 起显示
│ [data-part="timestamp"]  2 分钟前                        │
│ [data-part="badge-adjust"]  已校准   ← 仅 adjusted 时出现 │
│ [data-part="warn-stale"]  汇率刷新失败 · 显示 2 分钟前的缓存
│ [data-part="warn-offline"]  离线示例汇率 · 仅供参考
│ [data-part="warn-error"]  无法获取汇率
└──────────────────────────────────────────────────────────┘
        △ size-s 只保留：amount-main / amount-main-code /
          amount-origin / amount-origin-code / timestamp /
          badge-* / warn-*
```

### 6.2 `data-mode="detail"`（size-l）

```
╭─ [data-part="card"]  data-mode="detail"  data-size="l"
│
┌────────────────────────────────────────────────────────────────┐
│ [amount-main] ≈ ¥697.60          [amount-main-code] CNY        │
│                            [badge-guess] 猜测 0.50  [badge-adjust] 已校准
├────────────────────────────────────────────────────────────────┤
│ [amount-origin] $100.00   [amount-origin-code] USD             │
│ [origin-select] 原始 [USD ▾]      [target-select] 目标 [CNY ▾] │
├────────────────────────────────────────────────────────────────┤
│ [multi-list]                                                   │
│   [multi-row]  [multi-value] ≈ ¥697.60   [multi-code] CNY       │
│   [multi-row]  [multi-value] ≈ ¥15,714   [multi-code] JPY       │
│   [multi-row]  [multi-value] ≈ €86.97    [multi-code] EUR       │
├────────────────────────────────────────────────────────────────┤
│ [rate-line]  1 USD = 6.6976 CNY                                │
│ [timestamp]  2026-09-20 00:02 UTC · ER-API · 缓存 2 分钟前      │
│ [evidence]   置信度 0.78 · lang=zh-CN(+4)、域名 .cn(+5)         │
│ [parse-detail] 原始 "$1,000.00" · 标记 ¥ · 量级 无 · 数值 1000   │
├────────────────────────────────────────────────────────────────┤
│ [actions]                                                      │
│   [action-settings] 设置  [action-copy] 复制  [action-close] 关闭 │
└────────────────────────────────────────────────────────────────┘
        △ [warn-stale] / [warn-offline] / [warn-error] 出现在
          header 下方或 actions 上方（设计师定，需在三档都成立）
```

### 6.3 `settings-open` 与 `toast`（叠加浮层）

```
┌ [settings] ───────────────────────────┐     ┌ [toast] ────────┐
│ [settings-head] 设置              [×] │     │     已复制      │
├───────────────────────────────────────┤     └─────────────────┘
│ [settings-row]                        │      紧贴卡片一角，
│   [settings-label] 目标币种            │      出现约 1.2s 后淡出
│   [settings-control] [ CNY ▾ ]        │
│ [settings-row]                        │
│   [settings-label] 悬停即换算          │
│   [settings-control] [ ●——— ]         │
├───────────────────────────────────────┤
│ [settings-memory]                     │
│   .cn → CNY                           │
│   .jp → JPY                           │
├───────────────────────────────────────┤
│ [settings-actions]  [恢复默认] [保存]  │
└───────────────────────────────────────┘
```

---

## 7. 交付要求

| # | 要求 |
|---|---|
| 1 | **只交 CSS + token**。不改 DOM 结构、不改 `data-part` 名、不新增 `data-part`、不动 `data-mode` / `data-size` |
| 2 | **只能用系统字体栈**（`--fxph-font` / `--fxph-font-mono`）。禁止外部字体（Web Font）、禁止图标字体（Font Awesome / Material Icons 等）、禁止任何 CDN 资源与图片引用 |
| 3 | **不要用 `!important`**。优先级靠选择器自身解决 |
| 4 | **不要写 `z-index`**。层级由脚本管理（卡片 / 面板 / toast 之间的前后关系在稿子里用视觉层级表达即可，实现层级由脚本负责） |
| 5 | **必须支持中日文字体栈**：CJK 字形与西文数字混排要检查；金额数字建议用 `--fxph-font-mono` 或 `font-variant-numeric: tabular-nums`，避免刷新时数字宽度跳动 |
| 6 | **对比度**：正文/数值文本对比度 ≥ **4.5:1**；≥24px（或 ≥18.66px 粗体）的大号主数字 ≥ **3:1**；徽章与警告条的文字与其底色同样按 4.5:1 校验；不要仅靠颜色区分状态（同时给图标位/文字/形状差异） |
| 7 | **320px 视口不裁切**：`320 × 最小的三档宽度` 三者都要在 `viewport width = 320px` 下完整显示，含阴影安全边距；卡片不做横向滚动 |
| 8 | **数字格式化**：千分位（`15,714`）、货币符号位置、`≈` 前缀、`·` 分隔符都按内容示例呈现，不要自行改写成其他排版约定 |
| 9 | **颜色与尺寸尽量集中在 token**；CSS 里出现的魔法数字要能追溯到某个 token |
| 10 | 交付文件命名：`theme.css` + `tokens.md`（或 `.csv`） |

---

## 8. 常见坑

| 坑 | 说明 / 应对 |
|---|---|
| Shadow DOM 隔离 | 卡片在 Shadow Root 内。**外部字体（@font-face / Web Font）、图标字体、CDN 资源、外部图片全部不可用**（不是"不推荐"，是不生效）。图形只能用 CSS 绘制（`border` / `::before` / `::after` / `background: linear-gradient` / `mask`）+ 内联 SVG 字符 |
| 容器查询 | **不要依赖 `@container`**。宿主是 0×0，容器尺寸语义不可靠。响应式请用卡片自身的 `max-width` + `100vw` 夹取，或 `@media` 视口查询 |
| `:host` 用法 | **`:host` 上只放 token（第 3 章的变量）**。不要在 `:host` 上写 `display` / `width` / `padding` / `background` 等布局与视觉属性——会打到 0×0 的宿主上 |
| 不要给 `#fxph-host` 写样式 | 该元素位于**页面文档**（不在 shadow 内），会被站点 CSS 影响（`!important` 满天飞的站点尤其严重）。任何样式写在那里都不可靠，也会污染宿主页面。视觉一律写在 shadow 内的 `[data-part]` 上 |
| `all: initial` 已用过 | shadow 内已做过重置（`all: initial`），所以**不要指望浏览器默认样式**（`button` / `select` / `input` 都已被抹平）：按钮的 padding、下拉的箭头、输入框的边框都要设计师显式给。同时注意 `all: initial` 之后 `box-sizing` 不是 `border-box`，写 CSS 时自行声明 |
| 数字抖动 | 汇率刷新时数字重绘。等宽字体或 `tabular-nums` 可避免宽度跳动 |
| 深色站点 | 卡片要有自己的背景色（`--fxph-bg`），不要用 `transparent` / `inherit`，否则在深色页面上不可读；如要跟随系统深色，用 `@media (prefers-color-scheme: dark)` 覆盖 token 或在 token 表里给出两套取值 |
| 下拉开合 | `<select>` 的原生下拉弹层在部分浏览器由 OS 绘制，**无法样式化**。只保证闭合态外观，不要为弹层出稿 |
| 文本过长 | `evidence` / `parse-detail` / `timestamp` 在 detail 模式可能很长，需给出换行规则（建议 2 行截断 + `line-clamp`），并确认在 size-l 宽度下的实际观感 |

---

## 9. 给 GPT-image 的 prompt 模板

填三个变量即可：`{MODE}` = `simple | detail`，`{STATE}` = `default | hover | pinned | ambiguous | adjusted | stale | offline | error | settings-open`，`{SIZE}` = `s | m | l`。

```
A clean, production-ready UI design sheet for a browser currency-conversion hover card
(non-commercial design reference, NOT an illustration, NOT a poster, NOT concept art).

Subject: a small floating tooltip card that appears next to a web page's cursor when the
user hovers over a money amount. Render the card alone, centered, on a flat neutral
background (#f2f3f5), with a subtle drop shadow. Show the card at 2x for legibility.

Variables:
- MODE = {MODE}          (simple = compact single-conversion card; detail = expanded card
                          with a multi-currency list, diagnostics lines and a button row)
- STATE = {STATE}        (default / hover / pinned = visually marked as locked-open /
                          ambiguous = shows a "guess" badge. NOTE: both currency dropdowns
                          (origin + target) are always present in every mode and every state /
                          adjusted = shows a "manually corrected" badge /
                          stale = amber warning strip "refresh failed, cached" /
                          offline = amber strip "offline sample rates" /
                          error = red strip "rate unavailable", main number replaced by a
                          placeholder / settings-open = an attached settings panel with rows,
                          toggles, a per-domain memory list and a bottom action bar)
- SIZE = {SIZE}          (s = highest density, only main number + original amount +
                          timestamp; m = default, adds target-currency dropdown and the
                          "1 USD = 6.6976 CNY" rate line; l = large, everything visible)

Required visible content (use EXACTLY these strings, real data, no lorem ipsum):
- main converted amount: "≈ ¥697.60" with currency code "CNY"
- original amount: "$100.00" with currency code "USD"
- multi-currency rows: "≈ ¥697.60 CNY", "≈ ¥15,714 JPY", "≈ €86.97 EUR"
- rate line: "1 USD = 6.6976 CNY"
- timestamp: "2026-09-20 00:02 UTC · ER-API · 缓存 2 分钟前"
- evidence line: "置信度 0.78 · lang=zh-CN(+4)、域名 .cn(+5)"
- parse detail: "原始 "$1,000.00" · 标记 ¥ · 量级 无 · 数值 1000"
- guess badge text: "猜测 0.50"; corrected badge text: "已校准"
- buttons: "设置" "复制" "关闭"; toast text: "已复制"

Layout and style rules:
- Vertical card, generous but tight spacing, 10px rounded corners, 1px hairline border.
- Hierarchy: the converted main number is the largest element (accent blue, bold,
  tabular figures), the original amount is secondary and muted, currency codes are small
  uppercase labels, diagnostics lines are the smallest and lowest-contrast text.
- Palette: white surface, near-black text, one accent blue for the main number and
  interactive states, amber for warnings/guess badge, red only for the error strip,
  light blue tint for hover rows and secondary buttons.
- Typography: modern system UI sans-serif, must render Latin AND Chinese (Simplified)
  text cleanly; numerals in a monospace or tabular style so digits do not shift.
- Icons: only simple geometric shapes drawn with CSS/borders; do not use icon fonts or
  raster images.
- Accessibility: body text contrast at least 4.5:1, large number at least 3:1, and never
  signal a state by color alone (pair color with a label or a shape).
- Output: one high-resolution image, straight-on flat UI mockup, crisp pixel-aligned
  edges, no perspective, no device frame, no browser chrome, no human figures, no
  decorative background, no drop shadows on inner elements, no watermark, no UI text
  other than the strings listed above.
```

---

*契约版本：v1 · 变量名与 `data-part` 名为稳定接口，改动需脚本作者与设计师双方确认。*
