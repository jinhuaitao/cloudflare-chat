import { HTML_CONTENT } from './ui/index.js';

// 首页模板在一个 isolate 中通常只对应同一组模型配置。保留单个最近结果，
// 避免每次 GET / 都扫描并重建约 160KB 的 HTML；只缓存一个变体以限制内存。
let cachedOptionsHtml = null;
let cachedAppVersion = null;
let cachedHtml = null;

export function getHomePageHtml(optionsHtml, appVersion) {
  const options = String(optionsHtml);
  const version = String(appVersion);
  if (cachedHtml !== null && cachedOptionsHtml === options && cachedAppVersion === version) {
    return cachedHtml;
  }

  cachedOptionsHtml = options;
  cachedAppVersion = version;
  cachedHtml = HTML_CONTENT
    .replaceAll('{{MODEL_OPTIONS}}', options)
    .replaceAll('{{APP_VERSION}}', version);
  return cachedHtml;
}
