# FX Pulse Hover 2.5.0

可选的 Tampermonkey 悬停界面与插件共享解析器源码。

## 安装与数据来源

1. 安装或更新 FX Pulse 插件到 2.5.0。
2. 在后端设置 `FX_PROVIDER=alpha_vantage` 与自己的 `ALPHA_VANTAGE_API_KEY`，重启后端。
3. 在插件设置中开启网页悬停换算，并授予网页访问权限。
4. 在 Tampermonkey 更新安装 `fx-pulse-hover.user.js`，然后刷新网页。

油猴只通过插件的只读通道请求行情快照及官方参考价，移除了 ER-API/Frankfurter 请求与独立持久化行情缓存。直接货币对报价优先于反向报价；缺少市场报价时使用同一后端的最新官方参考价，并显示机构和日期。没有插件时显示不可用，不会自动改用其他数据源。

插件后台持有后端地址并合并请求，API Key 只在服务端。网页桥接只交换公开报价；宿主网页脚本可以观察或伪造这些页面事件，不应把油猴界面视作经过认证的金融数据通道。在不可信网页上请使用原生插件界面。

油猴连接期间，插件原生悬停界面让位，避免双卡片。两者的外观、目标币种、校准等偏好没有迁移或合并。若不需要油猴界面，可停用脚本，只使用插件。

HTTP/HTTPS 顶层网页受支持；不支持文件网址、iframe、浏览器内部页或其他受保护页面。

## 开发

`build-extension-parser.mjs` 只提取脚本的纯解析逻辑到 `extension/amount-parser.js`。修改解析逻辑后运行：

```bash
node userscript/build-extension-parser.mjs
npm run check:parser   # CI 也会检查生成文件是否与脚本一致
npm test
npm run test:userscript
npm run lint
```

DOM 与接口行为由 jsdom 和模拟 Chrome API 检查；这些检查不能替代真实 Chrome/Tampermonkey 联调。
