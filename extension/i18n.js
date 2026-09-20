/* Presentation-only localization; API values and stored currency pairs stay unchanged. */
(() => {
  const entries = [
    ['刷新只重新读取后端数据，不会立即触发上游采集。',null,'Refresh reloads stored backend data; it does not trigger a new provider collection.','更新は保存済みのサーバーデータを読み直します。配信元からの新規取得は実行しません。'],
    ['悬停与工具栏共用后端、行情缓存、语言和自选设置，无需油猴。开启后仅在本机识别网页金额，不上传网页内容。请停用旧油猴脚本，避免重复显示。',null,'Hover and toolbar share the backend, quote cache, language and watchlist. No userscript manager is needed. Amounts are detected locally; page content is not uploaded. Disable the old userscript to avoid duplicate cards.','ホバーとツールバーはサーバー、レートキャッシュ、言語、ウォッチリストを共有します。ユーザースクリプト管理ソフトは不要です。金額は端末内で判定し、ページの内容は送信しません。二重表示を防ぐため旧スクリプトを無効にしてください。'],
    ['开启网页悬停换算',null,'Enable hover conversion on websites','ウェブページでホバー換算を有効にする'],
    ['悬停目标币种',null,'Hover target currency','ホバー換算先の通貨'],
    ['卡片大小',null,'Card size','カードのサイズ'],['卡片模式',null,'Card mode','カードの表示モード'],
    ['小号卡片',null,'Small','小'],['标准卡片',null,'Medium','中'],['大号卡片',null,'Large','大'],
    ['简洁模式',null,'Simple','シンプル'],['详细模式',null,'Detailed','詳細'],
    ['设置已保存',null,'Settings saved','設定を保存しました'],
    ['未获得网页访问权限，悬停未开启',null,'Website permission denied. Hover remains off.','ページへのアクセスが許可されていないため、ホバーは無効のままです。'],
    ['已开启，请刷新网页后使用',null,'Enabled. Reload your web pages to use it.','有効にしました。ウェブページを再読み込みしてください。'],
    ['已关闭网页悬停换算',null,'Hover conversion disabled','ホバー換算を無効にしました'],
    ['悬停设置失败，请重新加载插件',null,'Could not configure hover. Reload the extension.','ホバーを設定できませんでした。拡張機能を再読み込みしてください。'],
    ['数据源已更改，请重试',null,'Data source changed. Please retry.','データソースが変更されました。再試行してください。'],
    ['等待采集',null,'Waiting for collection','データ取得待ち'],
    ['数据不可用',null,'Data unavailable','データを取得できません'],
    ['网页悬停换算',null,'Hover conversion','ページ上での通貨換算'],
    ['悬停工具需单独安装，使用公共日更参考汇率。它不共享本插件的后端地址、自选或语言设置，两者报价可能不同。',null,'Install the hover tool separately. It uses public daily reference rates and has its own settings. Backend address, watchlist and language are not shared, so quotes may differ.','ホバーツールは別途インストールが必要です。公開の日次参考レートを使用し、バックエンドのアドレス、ウォッチリスト、言語設定は共有されないため、表示レートが異なる場合があります。'],
    ['查看悬停工具安装说明',null,'Hover tool installation guide','ホバーツールのインストール方法'],
    ['此货币对未在后端配置',null,'Pair not configured on the server','サーバーに未登録の通貨ペア'],
    ['离线缓存',null,'Offline · cached quote','オフライン・保存済みレート'],
    ['仅有一个观测点',null,'Only one observation','観測データは1件のみ'],
    ['请输入0到1万亿之间的有效金额',null,'Enter a valid amount from 0 to 1 trillion','0から1兆までの有効な金額を入力してください'],
    ['行情不可用，暂停目标价判断',null,'Quotes unavailable; target checks paused','レートを取得できないため目標の判定を停止中'],
    ['请求过于频繁，请稍后重试',null,'Too many requests. Try again later.','リクエストが多すぎます。後で再試行してください。'],
    ['请求超时，请重试',null,'Request timed out. Please retry.','タイムアウトしました。再試行してください。'],
    ['行情数据格式错误',null,'Unexpected API response format','API応答の形式が正しくありません'],
    ['请输入有效的HTTP或HTTPS地址',null,'Enter a valid HTTP or HTTPS address','有効なHTTPまたはHTTPSアドレスを入力してください'],
    ['连接成功，等待首次采集',null,'Connected. Waiting for first collection.','接続済み。初回データ取得待ちです。'],
    ['连接成功，当前为模拟数据',null,'Connected. Demo data is active.','接続済み。デモデータを使用中です。'],
    ['MARKET MIDPOINT','市场中间价','MARKET MIDPOINT','市場仲値'],
    ['OFFICIAL REFERENCE','官方参考价','OFFICIAL REFERENCE','公式参考レート'],
    ['7 DAY TREND','近七日走势','7 DAY TREND','過去7日間の推移'],
    ['QUICK CONVERTER','快捷换算','QUICK CONVERTER','通貨換算'],
    ['EXTENSION SETTINGS','扩展设置','EXTENSION SETTINGS','拡張機能の設定'],
    ['Midpoint = (Bid + Ask) ÷ 2','中间价 =（买入价 + 卖出价）÷ 2','Midpoint = (Bid + Ask) ÷ 2','仲値 =（買値 + 売値）÷ 2'],
    ['市场中间价 = (买入价 + 卖出价) ÷ 2，不是中国人民银行公布的人民币汇率中间价，也不代表银行最终成交价。仅供参考。','市场中间价为买卖报价的平均值，非人民币官方中间价或银行成交价。仅供参考。','The midpoint averages bid and ask prices. It is not the official RMB fixing or a bank transaction rate. For reference only.','仲値は買値と売値の平均です。人民元の公式基準値や銀行の約定レートとは異なります。参考情報です。'],
    ['插件无需账户。自选、目标价与换算偏好只保存在当前浏览器中；后端仅代理并缓存公开汇率数据。',null,'No account required. Your watchlist, targets and conversion preferences stay in this browser. The backend retrieves and caches public exchange rates.','アカウントは不要です。ウォッチリスト、目標レート、換算設定はこのブラウザーにのみ保存されます。サーバーは公開為替データを取得・キャッシュします。'],
    ['插件不会在后台轮询，也不会发送邮件或系统通知。目标价只会在你打开插件时进行比较。部署后端可以保护行情服务密钥，并减少对上游接口的重复请求。',null,'No background polling, emails or system notifications. Targets are checked only when you open the extension. The backend protects provider keys and reduces duplicate requests.','バックグラウンドでの取得やメール・システム通知は行いません。目標レートは拡張機能を開いたときだけ確認します。サーバーはAPIキーを保護し、重複リクエストを減らします。'],
    ['自动复制失败，请按 Ctrl/Cmd+C 手动复制',null,'Automatic copy failed. Press Ctrl/Cmd+C to copy.','自動コピーに失敗しました。Ctrl/Cmd+Cでコピーしてください。'],
    ['按市场中间价估算，不包含银行手续费与点差。',null,'Estimated at the midpoint; bank fees and spreads excluded.','仲値での概算です。銀行手数料・スプレッドは含みません。'],
    ['官方参考价暂时不可用，请稍后刷新',null,'Reference rates unavailable. Please refresh later.','参考レートを取得できません。後でもう一度更新してください。'],
    ['每日参考汇率 · 非银行成交价',null,'Daily reference · Not a bank transaction rate','日次参考レート · 銀行の約定レートではありません'],
    ['正在读取官方参考价…',null,'Loading reference rates…','参考レートを読み込み中…'],
    ['服务器还没有汇率数据',null,'No rates available on the server','サーバーに為替データがありません'],
    ['未获得访问该服务器的权限',null,'Permission to access this server was denied','このサーバーへのアクセスが許可されていません'],
    ['连接成功，设置已保存。',null,'Connected. Settings saved.','接続に成功し、設定を保存しました。'],
    ['正在检查服务器…',null,'Checking connection…','接続を確認中…'],
    ['。请确认后端已经启动。',null,'. Check the backend address and connection.','。サーバーのアドレスと接続を確認してください。'],
    ['Failed to fetch','无法连接服务器','Unable to connect to the server','サーバーに接続できません'],
    ['数据暂不可用，请检查连接',null,'Data unavailable. Check your connection.','データを取得できません。接続を確認してください。'],
    ['模拟数据 · 非真实行情',null,'Demo data · Not live quotes','デモデータ · 実際の相場ではありません'],
    ['仅打开插件时检查',null,'Checked on opening','起動時のみ確認'],
    ['设置保存在本机',null,'Saved on this device','この端末に保存'],
    ['历史数据仍在积累',null,'Collecting historical data','履歴データを収集中'],
    ['暂无官方参考价',null,'No reference rates available','参考レートはありません'],
    ['尚未设置目标价',null,'No target set','目標レートは未設定です'],
    ['高于或等于',null,'At or above','以上'],['低于或等于',null,'At or below','以下'],
    ['输入目标中间价',null,'Enter target midpoint','目標仲値を入力'],
    ['保存并测试连接',null,'Save and test connection','保存して接続を確認'],
    ['后端 API 地址','后端接口地址','Backend API address','サーバーAPIアドレス'],
    ['隐私与运行方式',null,'Privacy and operation','プライバシーと動作'],
    ['数据源设置',null,'Data source settings','データソース設定'],
    ['官方参考价',null,'Reference rates','公式参考レート'],
    ['欧洲央行',null,'European Central Bank','欧州中央銀行'],['加拿大央行',null,'Bank of Canada','カナダ銀行'],
    ['正在读取行情…',null,'Loading rates…','レートを読み込み中…'],
    ['载入走势…',null,'Loading chart…','チャートを読み込み中…'],
    ['暂无可用行情',null,'No rates available','レートはありません'],
    ['七日走势图',null,'7-day chart','7日間チャート'],
    ['自选行情',null,'Watchlist','ウォッチリスト'],['汇率走势',null,'Rate history','為替推移'],
    ['快捷换算',null,'Convert','通貨換算'],['目标价状态',null,'Rate alerts','目標レート'],
    ['管理自选',null,'Edit watchlist','ウォッチリストを編集'],['暂无对比',null,'No comparison','比較データなし'],
    ['数据较旧',null,'Outdated','古いデータ'],['已更新',null,'Updated','更新済み'],
    ['换算结果',null,'You receive','換算結果'],['金额',null,'Amount','金額'],
    ['反转',null,'Swap','入れ替え'],['换算货币对',null,'Currency pair','通貨ペア'],
    ['保存到本机',null,'Save target','端末に保存'],['复制当前汇率',null,'Copy rate','レートをコピー'],
    ['已复制',null,'Copied','コピーしました'],['免登录',null,'No account','登録不要'],
    ['刷新',null,'Refresh','更新'],['设置',null,'Settings','設定'],['日更',null,'Daily','日次'],
    ['数据时间',null,'As of','更新日時'],['连接失败',null,'Connection failed','接続失敗'],
    ['服务器返回',null,'Server returned','サーバー応答'],['保存失败：',null,'Could not save: ','保存できません：'],
    ['已达到目标',null,'Target reached','目標に到達'],['尚未达到 · 目标',null,'Not reached · Target','未到達 · 目標'],
    ['交叉换算',null,'Cross rate','クロスレート'],['走势',null,'History','推移'],
    ['BID','买入','BID','買値'],['ASK','卖出','ASK','売値'],['24h','24小时','24h','24時間'],
    ['低',null,'Low','安値'],['高',null,'High','高値'],['区间',null,'Range','レンジ'],
    ['alpha_vantage','行情服务','Alpha Vantage','為替データ'],
  ].sort((a,b) => b[0].length-a[0].length);
  let language = 'zh';
  const originals = new WeakMap();
  function translate(source) {
    // Single-pass replacement prevents translations from being translated again.
    const pattern = new RegExp(entries.map(e => e[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return source.replace(pattern, key => {
      const entry = entries.find(e => e[0] === key);
      return entry[{zh:1,en:2,ja:3}[language]] || key;
    });
  }
  function render() {
    observer.disconnect();
    if (!globalThis.document?.body) return;
    document.documentElement.lang = {zh:'zh-CN',en:'en',ja:'ja'}[language];
    const walker = document.createTreeWalker(document.body, globalThis.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('script,style,#language-switch')) continue;
      const previous = originals.get(node);
      const source = previous && node.nodeValue === previous.output ? previous.source : node.nodeValue;
      const output = translate(source);
      originals.set(node, {source,output});
      if (node.nodeValue !== output) node.nodeValue = output;
    }
    document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(element => {
      for (const attr of ['title','aria-label','placeholder']) {
        if (!element.hasAttribute(attr)) continue;
        const key = `data-source-${attr}`;
        const source = element.getAttribute(key) || element.getAttribute(attr);
        element.setAttribute(key, source);
        element.setAttribute(attr, translate(source));
      }
    });
    observer.observe(document.body, {childList:true,subtree:true,characterData:true});
  }
  const observer = new globalThis.MutationObserver(render);
  const ready = chrome.storage.local.get({language:'zh'}).then(settings => {
    language = ['zh','en','ja'].includes(settings.language) ? settings.language : 'zh';
    const select = document.createElement('select');
    select.id = 'language-switch';
    const names = {zh:['中文','英文','日文'],en:['Chinese','English','Japanese'],ja:['中国語','英語','日本語']};
    ['zh','en','ja'].forEach((code,index) => select.add(new globalThis.Option(names[language][index],code)));
    select.value = language;
    select.setAttribute('aria-label', {zh:'界面语言',en:'Interface language',ja:'表示言語'}[language]);
    select.addEventListener('change', async () => {
      await chrome.storage.local.set({language:select.value});
      globalThis.location.reload();
    });
    (document.querySelector('.header-actions') || document.querySelector('main')).prepend(select);
    document.title = document.querySelector('#settings-form') ? {zh:'FX Pulse 设置',en:'FX Pulse Settings',ja:'FX Pulse 設定'}[language] : 'FX Pulse';
    render();
  });
  globalThis.FXI18N = {ready};
})();
