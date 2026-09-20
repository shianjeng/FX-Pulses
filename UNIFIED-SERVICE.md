# FX Pulse 统一版 2.1.0

## 现在如何使用

只安装 `extension/` 这一个 Chrome 扩展。工具栏查汇率和网页金额悬停由同一扩展运行，不再需要 Tampermonkey。

1. 合并更新文件到现有仓库；保留 `.env` 和数据库。
2. 在 `chrome://extensions` 重新加载 FX Pulse，并确认版本 2.1.0。
3. 打开插件设置，确认后端连接正常。
4. 打开“开启网页悬停换算”，按浏览器提示授权网页访问。
5. 在 Tampermonkey 中停用旧 FX Pulse Hover，避免出现两张卡片。
6. 刷新网页，再悬停在 `$10`、`100元` 或 `1,000円` 等金额文字上。

旧脚本保存的按站点币种校准不会自动迁移。插件保留原有后端地址、自选、目标价、语言设置和方案 B Logo。默认目标币种、卡片大小与简洁/详细模式在同一个插件设置页调整。

## 统一了哪些内容

| 内容 | 统一方式 |
| --- | --- |
| 行情来源 | 工具栏与悬停均读取用户配置的 FastAPI `/rates`，不再从 ER-API/Frankfurter 另取一套行情 |
| 请求与缓存 | `background.js` 统一网络出口、合并同一批并发请求；快照缓存在 session storage，服务工作线程休眠重启后可复用 |
| 更新频率 | 正常快照 60 秒有效；可见悬停卡片每分钟检查。手动刷新工具栏可绕过缓存，但不会直接触发上游采集 |
| 设置 | 后端地址、语言和自选保存在同一份 `chrome.storage.local`；悬停语言与目标币种更改会更新已打开卡片 |
| 数据口径 | 使用后端直接报价或其倒数；不会用其他源或隐含交叉价替代配置的直接货币对 |
| 失败状态 | 旧缓存明确标为离线；无缓存显示不可用；未采集币种明确提示；模拟数据和过期报价明确标记 |
| 隐私 | 页面金额识别与站点校准仅在本机进行，发往后台的行情请求不含页面文字、金额或网址 |
| 安装与标识 | 一个插件，保留方案 B 图标，无需另外安装油猴脚本 |

不同界面在各自刷新时读取同一缓存，不保证所有已打开卡片在每一毫秒同时重绘；可见卡片最多约一分钟后重新检查。

## 权限与安全

- 默认关闭网页悬停。用户明确开启时才申请 HTTP/HTTPS 网页访问权限。
- 动态内容脚本在隔离环境运行，只在顶层页面注入；界面使用封闭 Shadow DOM。
- 停用会注销动态脚本并让已注入页面停止识别；浏览器已授予的权限不会自动撤销，以免误伤自定义后端权限。可在 Chrome 扩展详情中撤销；再次开启需重新授权。
- 内容脚本不能指定任意后台抓取 URL，不能强制绕过共享缓存，也不能读取历史 API。后台只接受本扩展消息与固定接口路径。
- 仅 SVG Logo 被声明为网页可访问资源。API key 仍只保存在后端。
- 没有邮件/系统通知；目标价仍只在工具栏打开时检查。后台不设采集闹钟，也不直接请求 Alpha Vantage。

## 支持范围和取舍

默认配置覆盖 USD/CNY、USD/JPY、CNY/JPY。网页上的欧元等其他货币会被识别，但没有对应后端报价时不会换算；若需要更多货币，应统一扩展后端配置并重新评估上游额度。

目前不支持 iframe、文件网址、浏览器内部页或受保护页面。不自动扫描全文，仅在鼠标停留处识别，并使用附近文本辅助判断币种。保留手动原始币种校准、简洁/详细模式、三档大小与复制失败兜底；旧油猴的任意自定义 CSS、调试菜单与全页扫描功能没有搬入正式扩展。

旧 `userscript/` 作为解析器源码与回归用例保留，不属于正式扩展运行路径。`build-extension-parser.mjs` 只提取纯解析逻辑，生成 `extension/amount-parser.js`，不包含旧脚本的网络请求或界面。修改解析器后运行构建命令，CI 会检查生成文件是否同步。

## 验证

```sh
npm ci
node userscript/build-extension-parser.mjs
npm test
npm run lint
node userscript/node-check.mjs
node userscript/dom-smoke.cjs
```

新增覆盖：跨标签请求合并、线程重启缓存恢复、断线退避、后端切换竞态、消息边界、授权注册与撤销、真实货币对口径、悬停三语同步、关闭立即隐藏、手动复制兜底，以及工具栏使用同一缓存。新旧解析器逐条对比全部既有样例。

验证环境为 Node/jsdom、模拟 Chrome API 与后端测试数据库，尚未在真实 Chrome/Tampermonkey、Docker 或真实 Alpha Vantage 网络请求中完成端到端测试。

实现参考：[Chrome 内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[动态脚本注册](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[消息通信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)。
