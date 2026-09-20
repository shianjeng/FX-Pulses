# 报纸风主题 token

`theme.css` 遵守 `THEME.md` 的 16 个 token。尺寸 `--fxph-scale` 与 `--fxph-max-width` 仍由脚本按 s/m/l 档位设置；其余取值如下。脚本在悬停命中后读取金额所在元素向上的第一个不透明背景色，自动选择主题。

| 主题 | 背景识别 | 背景 `--fxph-bg` | 正文 `--fxph-fg` | 强调 `--fxph-accent` | 弱强调 `--fxph-accent-weak` | 次级 `--fxph-muted` | 边框 `--fxph-border` | 警告 `--fxph-warn` | 错误 `--fxph-danger` |
|---|---|---|---|---|---|---|---|---|
| paper | 中性浅色或不可读背景 | `#fffaf0` | `#28231e` | `#8b341f` | `#684b3b` | `#63594f` | `#a9967e` | `#805018` | `#922d2d` |
| ink | 深色背景 | `#1a2022` | `#f2eee3` | `#d0e4df` | `#becfca` | `#b0bdb7` | `#7b8d89` | `#f1cb80` | `#ffb0a8` |
| marine | 蓝 / 青色浅背景 | `#f2f8f8` | `#1c323a` | `#075b70` | `#365f6a` | `#4e6770` | `#86a7ad` | `#83501a` | `#9b3037` |
| sage | 绿 / 黄绿色浅背景 | `#f5f7ed` | `#263128` | `#356b3d` | `#4c6851` | `#536459` | `#92a392` | `#825316` | `#983b33` |
| clay | 红 / 橙 / 紫色浅背景 | `#fff4ed` | `#372820` | `#a13c2b` | `#775243` | `#70584b` | `#bb9b86` | `#855018` | `#a02c34` |

共用取值：`--fxph-radius:3px`、`--fxph-pad:14px`、`--fxph-gap:8px`、`--fxph-font:Georgia,"Songti SC","Noto Serif CJK SC",serif`、`--fxph-font-mono:ui-monospace,SFMono-Regular,Consolas,"Noto Sans Mono CJK SC",monospace`、`--fxph-shadow:0 12px 30px rgba(36,27,18,.22)`。ink 的阴影在 `theme.css` 内单独覆盖。

编辑 `theme.css` 或 `assets/exchange-globe.png` 后运行 `node embed-theme.mjs`，再将 `fx-pulse-hover.user.js` 安装到 Tampermonkey。页面内设置的自定义 CSS 仍会覆盖内置主题。
