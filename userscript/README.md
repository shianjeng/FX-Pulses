# 历史悬停原型与共享解析器

**正式使用请安装统一版 `extension/`，不再安装这里的油猴脚本。** 工具栏与悬停现在共用同一后端服务、缓存和设置，见 [统一版说明](../UNIFIED-SERVICE.md)。

升级时请在 Tampermonkey 中停用已有 FX Pulse Hover，避免两套悬停同时运行。旧版站点校准数据不会自动导入插件。

## 为什么保留这个目录

- `fx-pulse-hover.user.js` 保留旧版原型和已验证的金额解析逻辑；它不是正式插件的入口。
- `cases.js`、`node-check.mjs` 与 `dom-smoke.cjs` 保留原有回归用例。
- `build-extension-parser.mjs` 仅提取纯解析逻辑，生成 `extension/amount-parser.js`；不会把原型的第三方行情请求或独立设置系统带入正式扩展。
- 主题、图像、自检页面与视觉检查脚本用于历史原型维护。

修改解析器后，在项目根目录运行：

```sh
node userscript/build-extension-parser.mjs
npm test
npm run lint
node userscript/node-check.mjs
node userscript/dom-smoke.cjs
```

正式插件功能与测试位于 `extension/hover.js`、`extension/background.js` 和 `tests/unified-service.test.cjs`。CI 会检查生成解析器与源码一致，并验证共享服务行为。

旧版原型仍使用自身的数据源和配置，仅作开发参考；不要将它与统一版同时启用。
