// 页面样式：设计令牌、布局、深浅色主题（_worker.js 原第 2647-3372 行，内嵌页面分片；只允许字符串导出）
export default `  <style>
    /* ============================================================
       设计令牌（浅色 / 深色）
       与原页面内联样式引用的旧变量名（--text-secondary / --brand-color 等）
       保持别名映射，避免改动任何内联 style。
       ============================================================ */
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --bg-soft: #f5f6fa;
      --panel: #ffffff;
      --border: #e9ebf2;
      --border-strong: #d6dae5;
      --text: #222738;
      --text-2: #525e73;
      --muted: #6d788b;
      --accent: #4f5ee8;
      --accent-2: #8974ed;
      --accent-gradient: linear-gradient(135deg, #4f5ee8, #8974ed);
      --accent-soft: #edf0ff;
      --user-bubble: #f2f4fa;
      --danger: #dc2626;
      --shadow: 0 2px 6px rgba(34, 39, 56, .03), 0 12px 36px rgba(34, 39, 56, .06);
      --code-bg: #181c27;
      --code-text: #e8eaf0;
      --radius: 16px;
      --hover: rgba(94, 108, 148, .09);
      --warn-bg: #fff8e6;
      --warn-border: #efd08a;
      --warn-text: #7a5300;

      /* —— 兼容旧变量名（内联 style 与脚本里仍在引用） —— */
      --bg-base: var(--bg);
      --text-main: var(--text);
      --text-secondary: var(--text-2);
      --text-sub: var(--muted);
      --bg-main: var(--bg-soft);
      --brand-color: var(--accent);
      --brand-gradient: var(--accent);
      --glass-bg: var(--panel);
      --glass-border: var(--border);
      --glass-shadow: var(--shadow);
      --hover-bg: var(--hover);
      --input-bg: var(--panel);
      --border-radius: var(--radius);
      --user-msg: var(--user-bubble);
      --user-text: var(--text);
    }

    /* 主题由脚本设在 document.body 上（applyTheme），故选择器用 body[...] */
    body[data-theme="dark"] {
      color-scheme: dark;
      --bg: #11131b;
      --bg-soft: #171a24;
      --panel: #1b1e2a;
      --border: #292d3e;
      --border-strong: #3b4157;
      --text: #eceef7;
      --text-2: #b8bfd2;
      --muted: #939db4;
      --accent: #9ca6ff;
      --accent-2: #b5a4ff;
      --accent-gradient: linear-gradient(135deg, #6574ef, #9b80ee);
      --accent-soft: #252a46;
      --user-bubble: #242839;
      --danger: #f87171;
      --shadow: 0 2px 6px rgba(0, 0, 0, .12), 0 12px 36px rgba(0, 0, 0, .2);
      --code-bg: #0e1018;
      --code-text: #e8eaf0;
      --hover: rgba(156, 166, 220, .1);
      --warn-bg: #2b2312;
      --warn-border: #6b5423;
      --warn-text: #f0d089;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; margin: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
            "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
    }

    button, input, select, textarea { font: inherit; color: inherit; }
    button { touch-action: manipulation; }
    button:focus-visible, summary:focus-visible, a:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 3px;
    }
    ::selection { background: var(--accent-soft); color: var(--text); }
    * { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    ::-webkit-scrollbar-track { background: transparent; }

    /* ---------------- 离线提示条 ---------------- */
    .offline-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; letter-spacing: .2px;
      color: var(--warn-text);
      background: var(--warn-bg);
      border-bottom: 1px solid var(--warn-border);
      box-shadow: 0 4px 18px rgba(16, 18, 24, .10);
      transform: translateY(-105%);
      transition: transform .32s cubic-bezier(.4, 0, .2, 1);
      pointer-events: none;
    }
    .offline-banner.show { transform: translateY(0); }
    .offline-banner .spin { animation: offlineSpin 1s linear infinite; flex-shrink: 0; }
    @keyframes offlineSpin { to { transform: rotate(360deg); } }

    /* ---------------- 整体布局 ---------------- */
    .app-container {
      display: flex;
      height: 100dvh;
      width: 100%;
      overflow: hidden;
      background: var(--bg);
    }

    /* ---------------- 侧边栏 ---------------- */
    .sidebar {
      width: 268px;
      flex: 0 0 268px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-soft);
      border-right: 1px solid var(--border);
    }

    .sidebar-header { padding: 22px 16px 16px; }

    .brand {
      display: flex; align-items: center; gap: 10px;
      padding: 0 4px 24px;
      font-weight: 650; font-size: 15px; letter-spacing: -.2px;
    }
    .brand-dot {
      width: 32px; height: 32px; border-radius: 10px;
      background: var(--accent-gradient); color: #fff;
      display: grid; place-items: center;
      font-size: 12px; font-weight: 700;
      flex-shrink: 0;
      box-shadow: 0 3px 10px rgba(79, 94, 232, .18);
    }
    .brand-name { color: var(--text); }

    .new-chat-btn {
      width: 100%;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      border: 1px solid var(--border-strong);
      background: var(--panel);
      color: var(--text);
      border-radius: 12px;
      padding: 11px 12px;
      font-size: 13.5px; font-weight: 550;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
    }
    .new-chat-btn svg { color: var(--accent); }
    .new-chat-btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    .session-label { padding: 2px 22px 10px; color: var(--muted); font-size: 11.5px; letter-spacing: .4px; }

    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px 8px;
      min-height: 0;
    }

    .session-item {
      position: relative;
      display: flex; align-items: center; gap: 8px;
      padding: 9px 10px;
      border-radius: 10px;
      cursor: pointer;
      color: var(--text-2);
      transition: background .12s ease, color .12s ease;
    }
    .session-item:hover { background: var(--hover); color: var(--text); }
    .session-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 550; }
    .session-item::before {
      content: '';
      position: absolute; left: 0; top: 22%; bottom: 22%;
      width: 3px; border-radius: 2px;
      background: var(--accent);
      opacity: 0;
      transition: opacity .14s ease;
    }
    .session-item.active::before { opacity: 1; }

    .session-title {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 13px; font-weight: inherit;
      background: transparent; border: 0; padding: 4px 0;
      text-align: left; cursor: pointer;
    }
    .session-item:focus-within { background: var(--hover); }
    .session-item.active:focus-within { background: var(--accent-soft); }
    .session-item:focus-within .delete-btn { opacity: 1; }

    .delete-btn {
      border: 0; background: transparent; cursor: pointer;
      color: var(--muted);
      display: grid; place-items: center;
      padding: 3px; border-radius: 6px;
      opacity: 0;
      transition: opacity .12s ease, background .12s ease, color .12s ease;
    }
    .session-item:hover .delete-btn { opacity: 1; }
    .delete-btn:hover { background: rgba(220, 38, 38, .14); color: var(--danger); }

    .sidebar-footer {
      border-top: 1px solid var(--border);
      padding: 12px 16px max(16px, env(safe-area-inset-bottom));
      display: flex; flex-direction: column; align-items: stretch; gap: 10px;
    }
    .side-tools { display: flex; justify-content: space-between; gap: 2px; }
    .side-version { font-size: 11px; color: var(--muted); text-align: center; letter-spacing: .4px; }

    .theme-toggle {
      width: 36px; height: 36px;
      border: 1px solid transparent; border-radius: 9px;
      background: transparent; color: var(--text-2);
      display: grid; place-items: center;
      cursor: pointer;
      transition: background .12s ease, color .12s ease;
    }
    .theme-toggle:hover { background: var(--hover); color: var(--text); }
    .theme-toggle.active { background: var(--accent-soft); color: var(--accent); }
    .theme-toggle[hidden] { display: none; }

    .sidebar-overlay {
      display: none;
      position: fixed; inset: 0; z-index: 40;
      background: rgba(15, 18, 32, .4);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    }
    .sidebar-overlay.active { display: block; }

    /* ---------------- 主区域 ---------------- */
    .chat-area {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      min-height: 0;
      background: var(--bg);
    }

    .header {
      display: flex; align-items: center; gap: 8px;
      padding: max(14px, env(safe-area-inset-top)) 28px 14px;
      border-bottom: 1px solid var(--border);
      min-height: 64px;
      flex-shrink: 0;
    }
    .header-inner { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; }

    .menu-toggle {
      display: none;
      border: 1px solid transparent; border-radius: 10px;
      background: transparent; color: var(--text-2);
      padding: 6px 9px; cursor: pointer;
      transition: background .12s ease, color .12s ease;
      flex-shrink: 0;
    }
    .menu-toggle:hover { background: var(--hover); color: var(--text); }

    .header-title {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 8px;
      font-weight: 550; font-size: 14.5px;
    }
    .header-title span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #10b981; flex-shrink: 0;
      transition: background .3s ease;
    }
    .status-dot.generating {
      background: var(--accent);
      animation: breathing 1.5s infinite;
    }
    @keyframes breathing {
      0%   { box-shadow: 0 0 0 0 rgba(37, 99, 235, .45); }
      70%  { box-shadow: 0 0 0 8px rgba(37, 99, 235, 0); }
      100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
    }

    /* ---------------- 消息区 ---------------- */
    .messages-container {
      flex: 1;
      overflow-y: auto; overflow-x: hidden;
      min-height: 0;
      padding: 8px 20px 20px;
      scroll-behavior: smooth;
    }

    .messages {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
    }

    .scroll-bottom-btn {
      position: sticky;
      bottom: 12px;
      z-index: 5;
      width: 36px; height: 36px;
      margin: -48px auto 0;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      color: var(--text-2);
      display: grid; place-items: center;
      cursor: pointer;
      box-shadow: var(--shadow);
      opacity: 0; visibility: hidden; pointer-events: none;
      transform: translateY(6px);
      transition: opacity .18s ease, visibility .18s ease, transform .18s ease, color .12s ease, border-color .12s ease;
    }
    .scroll-bottom-btn.show {
      opacity: 1; visibility: visible; pointer-events: auto;
      transform: translateY(0);
    }
    .scroll-bottom-btn:hover { color: var(--accent); border-color: var(--accent); }
    .scroll-bottom-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .scroll-bottom-btn svg { width: 18px; height: 18px; }

    .message-row {
      display: flex;
      gap: 14px;
      padding: 24px 0;
      animation: slideUp .24s ease both;
    }
    .message-row.user { justify-content: flex-end; padding-bottom: 16px; }
    .message-row.user::before { display: none; }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: none; }
    }

    .message-row::before {
      content: 'AI';
      flex: 0 0 32px;
      width: 32px; height: 32px;
      border-radius: 10px;
      background: var(--accent-gradient);
      color: #fff;
      display: grid; place-items: center;
      font-size: 11px; font-weight: 650;
      user-select: none;
    }

    .message-bubble {
      flex: 1; min-width: 0;
      font-size: 15px; line-height: 1.7;
      overflow-wrap: anywhere; word-break: break-word;
    }
    .message-row.user .message-bubble {
      flex: 0 1 auto; max-width: 85%;
      background: var(--user-bubble);
      border-radius: 18px 18px 6px 18px;
      padding: 12px 18px;
      white-space: pre-wrap;
    }
    .message-row.user .msg-actions { justify-content: flex-end; }
    .message-row:focus-within .msg-actions { opacity: 1; }
    .message-row.ai .message-bubble { padding-top: 3px; }
    .message-row.error-msg .message-bubble { color: var(--danger); }

    /* ---------------- Markdown 正文 ---------------- */
    .markdown-body { overflow-wrap: anywhere; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body p { margin: 0 0 12px; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      margin: 20px 0 10px; line-height: 1.35; font-weight: 650;
    }
    .markdown-body h1 { font-size: 20px; }
    .markdown-body h2 { font-size: 18px; }
    .markdown-body h3 { font-size: 16.5px; }
    .markdown-body h4 { font-size: 15.5px; }
    .markdown-body ul, .markdown-body ol { margin: 0 0 12px; padding-left: 22px; }
    .markdown-body li { margin: 4px 0; }
    .markdown-body a {
      color: var(--accent); text-decoration: none;
      border-bottom: 1px solid transparent;
      word-break: break-all;
    }
    .markdown-body a:hover { border-bottom-color: currentColor; }
    .markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 18px 0; }
    .markdown-body blockquote {
      margin: 0 0 12px;
      padding: 4px 0 4px 14px;
      border-left: 3px solid var(--border-strong);
      color: var(--text-2);
    }
    .markdown-body blockquote p { margin: 4px 0; }
    .markdown-body code {
      background: var(--hover);
      padding: 1.5px 5px; border-radius: 5px;
      font-size: .9em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .markdown-body del { color: var(--muted); }
    .markdown-body table {
      display: block; overflow-x: auto; white-space: nowrap;
      border-collapse: collapse; margin: 0 0 12px; width: 100%; font-size: 14px;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border); padding: 9px 14px; text-align: left;
    }
    .markdown-body th { background: var(--bg-soft); font-weight: 600; }
    .markdown-body tr:nth-child(even) td { background: var(--bg-soft); }
    .markdown-body img { max-width: 100%; height: auto; border-radius: 8px; margin-top: 8px; }

    /* ---------------- 代码块 ---------------- */
    .code-wrapper {
      margin: 0 0 14px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--code-bg);
    }
    .code-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px 6px 13px;
      font-size: 11.5px; letter-spacing: .4px; text-transform: uppercase;
      color: #8f97a8;
      background: rgba(255, 255, 255, .045);
    }
    .code-header > span:first-child {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .copy-btn {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid transparent; border-radius: 7px;
      background: transparent; color: #a7aebd;
      font-size: 11.5px; letter-spacing: 0;
      padding: 4px 8px; cursor: pointer;
      transition: background .12s ease, color .12s ease;
    }
    .copy-btn:hover { background: rgba(255, 255, 255, .12); color: #fff; }
    .copy-btn svg { display: block; flex-shrink: 0; }
    .code-wrapper pre {
      margin: 0; padding: 13px 15px;
      overflow-x: auto; background: transparent;
    }
    .code-wrapper pre code {
      background: transparent; padding: 0;
      color: var(--code-text);
      font-size: 13px; line-height: 1.62;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }

    /* ---------------- 推理过程（折叠胶囊）/ 工具轨迹胶囊 / 消息操作 ---------------- */
    /* 与工具轨迹胶囊同一套视觉语言：一行摘要，点开才展开思考原文。
       旧版是一个 160px 高的常驻滚动框，长思考会把正文挤到看不见。 */
    .reasoning {
      margin: 0 0 12px;
      border: 1px solid var(--border);
      background: var(--bg-soft);
      border-radius: 10px;
      font-size: 12.5px;
      color: var(--text-2);
      overflow: hidden;
    }
    .reasoning[hidden] { display: none; }
    .reasoning-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 550;
      user-select: none;
      list-style: none;
      transition: background .12s ease, color .12s ease;
    }
    .reasoning-summary::-webkit-details-marker { display: none; }
    .reasoning-summary::after {
      content: '▾';
      font-size: 12px;
      color: var(--muted);
      transition: transform .15s ease;
    }
    .reasoning[open] .reasoning-summary::after { transform: rotate(180deg); }
    .reasoning-summary:hover { background: var(--hover); color: var(--text); }
    .reasoning-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 生成中：标题走品牌色 + 呼吸小点，与「已经想完」的静态态区分 */
    .reasoning.live .reasoning-title { color: var(--brand-color); }
    .reasoning.live .reasoning-title::after {
      content: '';
      display: inline-block;
      width: 5px; height: 5px;
      margin-left: 6px;
      border-radius: 50%;
      background: var(--brand-color);
      vertical-align: middle;
      animation: speakPulse 1.2s infinite ease-in-out;
    }
    .reasoning-box {
      padding: 8px 12px 10px;
      border-top: 1px solid var(--border);
      white-space: pre-wrap; line-height: 1.62;
      max-height: 240px; overflow-y: auto;
      overflow-wrap: anywhere;
      font-size: 12.5px;
      color: var(--text-2);
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, .3); border-radius: 4px; }

    /* v7.0.0：可折叠「工具调用轨迹胶囊」 */
    /* 「谁答的」胶囊：默认只有一行，点开才显示打分明细（等价于 /agent why） */
    .agent-persona {
      margin: 0 0 10px;
      font-size: 12.5px;
      line-height: 1.6;
      color: var(--text-2);
    }
    /* 没有明细（旧会话数据）时保持原来的静态胶囊观感 */
    .agent-persona.static {
      display: inline-block;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-soft);
      user-select: none;
    }
    .agent-persona-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-soft);
      color: var(--text-2);
      font: inherit;
      text-align: left;
      cursor: pointer;
      user-select: none;
      transition: background .12s ease, color .12s ease, border-color .12s ease;
    }
    .agent-persona-head:hover { background: var(--hover); color: var(--text); border-color: var(--border); }
    .agent-persona-head:focus-visible { outline: 2px solid var(--brand-color); outline-offset: 2px; }
    .agent-persona-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-persona-chev { font-size: 10px; color: var(--muted); transition: transform .15s ease; }
    .agent-persona.open .agent-persona-chev { transform: rotate(180deg); }
    .agent-persona-body {
      margin-top: 8px;
      padding: 9px 11px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-soft);
      font-size: 12px;
      color: var(--text-2);
      user-select: text;
    }
    .agent-persona-body[hidden] { display: none; }
    .ap-reason { font-weight: 550; color: var(--text); margin-bottom: 6px; }
    .ap-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 6px; }
    .ap-chips-label { color: var(--muted); margin-right: 2px; }
    .ap-chip {
      padding: 0 7px;
      border-radius: 6px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 11.5px;
      line-height: 18px;
    }
    .ap-stages { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .ap-stage { display: flex; flex-wrap: wrap; gap: 5px; align-items: baseline; }
    .ap-seg { color: var(--text); }
    .ap-arrow { color: var(--muted); }
    .ap-who { color: var(--text); }
    /* 名字列用固定宽度，跨行才能对齐；用 flex 而不是 grid，是为了让每行仍是一个整体 */
    .ap-cell { display: flex; flex-direction: column; min-width: 0; flex: 0 0 108px; }
    .ap-score { color: var(--muted); font-variant-numeric: tabular-nums; flex: 0 0 auto; text-align: right; }
    .ap-words { color: var(--muted); font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .ap-rank { display: flex; flex-direction: column; gap: 7px; margin-top: 2px; }
    .ap-rank-row { display: flex; align-items: center; gap: 10px; }
    .ap-bar { display: block; flex: 1 1 auto; min-width: 40px; height: 5px; border-radius: 3px; background: var(--border); overflow: hidden; }
    .ap-bar-fill { display: block; height: 100%; background: var(--brand-color); border-radius: 3px; }
    .ap-note { margin-top: 6px; color: var(--muted); }
    /* 窄屏：名字列收窄，把宽度让给分数条 */
    @media (max-width: 420px) {
      .ap-cell { flex-basis: 92px; }
      .ap-rank-row { gap: 8px; }
    }
    .agent-trace {
      margin: 0 0 12px;
      border: 1px solid var(--border);
      background: var(--bg-soft);
      border-radius: 10px;
      font-size: 12.5px;
      color: var(--text-2);
      overflow: hidden;
    }
    .agent-trace-summary {
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 550;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background .12s ease, color .12s ease;
    }
    .agent-trace-summary::-webkit-details-marker { display: none; }
    .agent-trace-summary::after {
      content: '▾';
      font-size: 12px;
      color: var(--muted);
      transition: transform .15s ease;
    }
    .agent-trace[open] .agent-trace-summary::after {
      transform: rotate(180deg);
    }
    .agent-trace-summary:hover {
      background: var(--hover);
      color: var(--text);
    }
    .agent-trace-list {
      padding: 6px 12px 10px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      line-height: 1.5;
    }
    .agent-trace-item {
      color: var(--text-2);
      overflow-wrap: anywhere;
    }

    .msg-actions {
      display: flex; gap: 2px; align-items: center;
      margin-top: 8px; flex-wrap: wrap;
      opacity: 0;
      transition: opacity .14s ease;
    }
    .message-row:hover .msg-actions { opacity: 1; }

    .msg-time {
      font-size: 11px; color: var(--muted);
      margin-right: 7px; line-height: 27px;
      user-select: none; white-space: nowrap;
    }

    .icon-btn, .speak-btn {
      width: 27px; height: 27px; padding: 0;
      display: grid; place-items: center;
      border: 1px solid transparent; border-radius: 8px;
      background: transparent; color: var(--muted);
      cursor: pointer; font-family: inherit; line-height: 1;
      transition: background .12s ease, color .12s ease, transform .1s ease;
    }
    .icon-btn:hover, .speak-btn:hover { background: rgba(127, 140, 170, .18); color: var(--text); }
    .icon-btn:active, .speak-btn:active { transform: scale(.92); }
    .icon-btn:focus-visible, .speak-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .icon-btn svg, .speak-btn svg { width: 16px; height: 16px; display: block; pointer-events: none; }

    .icon-btn.done { color: var(--accent); }
    .icon-btn.done:hover { background: var(--accent-soft); }

    .speak-btn.speaking { background: var(--accent-soft); color: var(--accent); }
    .speak-btn.speaking svg { animation: speakPulse 1s infinite ease-in-out; }
    @keyframes speakPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

    .agent-progress, .retry-notice {
      font-size: 12px; color: var(--text-2);
      margin-top: 10px; padding: 8px 12px;
      background: var(--bg-soft);
      border-radius: 10px;
      white-space: pre-line;
      overflow-wrap: anywhere;
    }
    /* 进度条现在插在正文之前，补一点下间距，别和回答首行粘在一起 */
    .agent-progress { animation: speakPulse 1.6s infinite ease-in-out; margin-bottom: 10px; }

    /* ---------------- 打字指示器 ---------------- */
    .typing-indicator {
      display: inline-flex; gap: 5px; align-items: center;
      padding: 4px 2px; height: 24px;
    }
    .typing-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
      animation: typing 1.4s infinite ease-in-out both;
    }
    .typing-dot:nth-child(1) { animation-delay: -.32s; }
    .typing-dot:nth-child(2) { animation-delay: -.16s; }
    @keyframes typing {
      0%, 80%, 100% { transform: scale(.4); opacity: .4; }
      40%           { transform: scale(1);  opacity: 1; }
    }

    /* ---------------- 空状态 ---------------- */
    .empty-state {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      min-height: min(560px, calc(100dvh - 260px));
      max-width: 820px;
      margin: 0 auto;
      padding: 40px 0 24px;
    }
    .welcome-mark {
      width: 72px; height: 72px; border-radius: 24px;
      display: grid; place-items: center; margin-bottom: 24px;
      color: var(--accent); background: var(--accent-soft);
    }
    .welcome-mark svg { width: 36px; height: 36px; }
    .empty-state h2 {
      margin: 0; font-size: clamp(23px, 2.5vw, 32px); font-weight: 650;
      letter-spacing: -1px; line-height: 1.4; color: var(--text);
      text-wrap: balance;
    }
    .empty-state p { margin: 12px 0 0; font-size: 14px; color: var(--muted); line-height: 1.7; }
    .empty-state .welcome-capabilities { margin-top: 22px; font-size: 11.5px; }

    .suggestion-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      width: 100%; max-width: 600px;
      margin-top: 32px;
    }
    .suggestion-chip {
      display: flex; align-items: center; gap: 14px;
      min-width: 0; padding: 18px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--panel); color: var(--text-2);
      font-size: 13px; text-align: left;
      cursor: pointer;
      transition: border-color .16s ease, background .16s ease, transform .16s ease, box-shadow .16s ease;
    }
    .suggestion-chip:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
      transform: translateY(-2px);
      box-shadow: var(--shadow);
    }
    .suggestion-chip > svg {
      width: 32px; height: 32px; padding: 7px; border-radius: 10px;
      color: var(--accent); background: var(--accent-soft); flex-shrink: 0;
    }
    .suggestion-chip:nth-child(2) > svg { color: #a06b20; background: rgba(192, 139, 52, .12); }
    .suggestion-chip:nth-child(3) > svg { color: #258373; background: rgba(43, 154, 132, .12); }
    .suggestion-chip:nth-child(4) > svg { color: #9165cc; background: rgba(145, 101, 204, .12); }
    body[data-theme="dark"] .suggestion-chip:nth-child(2) > svg { color: #e1b777; }
    body[data-theme="dark"] .suggestion-chip:nth-child(3) > svg { color: #77cfbb; }
    body[data-theme="dark"] .suggestion-chip:nth-child(4) > svg { color: #bd99eb; }
    .suggestion-copy { min-width: 0; }
    .suggestion-copy strong { display: block; color: var(--text); font-size: 13.5px; font-weight: 550; margin-bottom: 3px; }
    .suggestion-copy small { display: block; color: var(--muted); font-size: 12px; line-height: 1.5; }

    /* ---------------- 输入区 ---------------- */
    .input-wrapper {
      flex-shrink: 0; padding: 10px 28px max(18px, env(safe-area-inset-bottom));
      background: var(--bg);
    }

    .input-box {
      max-width: 820px;
      margin: 0 auto;
      display: flex; flex-direction: column; gap: 8px;
      border: 1px solid var(--border-strong);
      background: var(--panel);
      border-radius: 20px;
      padding: 14px 14px 12px 18px;
      box-shadow: var(--shadow);
      transition: border-color .14s ease, box-shadow .14s ease;
    }
    .input-box:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow);
    }

    .input-top { display: flex; align-items: flex-end; gap: 9px; }

    .input-box textarea {
      flex: 1; min-height: 24px;
      border: 0; background: transparent;
      padding: 6px 0; outline: none;
      resize: none; max-height: 190px;
      line-height: 1.55; font-size: 15px;
      box-shadow: none;
    }
    .input-box textarea::placeholder { color: var(--muted); }

    .send-btn {
      flex-shrink: 0;
      width: 38px; height: 38px;
      padding: 0; border: 0; border-radius: 50%;
      background: var(--hover); color: var(--muted);
      display: grid; place-items: center;
      cursor: not-allowed;
      transition: background .14s ease, color .14s ease, transform .1s ease, box-shadow .14s ease;
    }
    .send-btn.active {
      background: var(--accent-gradient); color: #fff; cursor: pointer;
      box-shadow: 0 4px 14px rgba(37, 99, 235, .32);
    }
    .send-btn.active:hover { transform: scale(1.06); }
    .send-btn.stop-mode {
      background: rgba(220, 38, 38, .12); color: var(--danger); cursor: pointer;
    }
    .send-btn.stop-mode:hover { background: rgba(220, 38, 38, .2); transform: scale(1.06); }
    .send-btn.stop-mode svg { fill: currentColor; stroke: currentColor; }

    .input-bottom {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      min-width: 0;
    }

    .model-selector-container {
      position: relative;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 10px;
      border: 1px solid transparent; border-radius: 9px;
      background: var(--hover);
      cursor: pointer;
      flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden;
      transition: border-color .12s ease;
    }
    .model-selector-container > svg { flex-shrink: 0; }
    .model-selector-container:hover { border-color: var(--border-strong); }
    .model-selector-container:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
    .model-select option { background: var(--panel); color: var(--text); }
    .model-display-text {
      font-size: 12.5px; font-weight: 550; color: var(--text-2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 160px; pointer-events: none;
    }
    .model-select {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      opacity: 0; cursor: pointer;
      border: 0; outline: none;
      -webkit-appearance: none; appearance: none;
    }

    .agent-toggle {
      display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
      font-size: 12px; font-weight: 550;
      color: var(--muted); background: transparent;
      border: 1px solid var(--border-strong); border-radius: 9px;
      padding: 5px 10px; cursor: pointer; white-space: nowrap;
      transition: background .14s ease, color .14s ease, border-color .14s ease;
    }
    .agent-toggle::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .agent-toggle:hover { color: var(--text); border-color: var(--muted); }
    .agent-toggle.active { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--accent); }

    .disclaimer {
      max-width: 820px;
      margin: 7px auto 0;
      font-size: 11.5px; color: var(--muted); text-align: center;
    }

    /* ---------------- 设置弹窗 ---------------- */
    .settings-modal-overlay {
      position: fixed; inset: 0; z-index: 70;
      background: rgba(15, 18, 32, .4);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: center; justify-content: center;
      padding: 24px;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .settings-modal-overlay.active { opacity: 1; }

    .settings-box {
      width: 100%; max-width: 420px; min-height: 0;
      max-height: calc(100dvh - 48px); overflow-y: auto;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px; padding: 28px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .2);
      animation: slideUp .2s ease both;
    }
    .settings-box h3 { margin: 0 0 24px; font-size: 18px; font-weight: 650; letter-spacing: -.3px; }
    .settings-box input { min-width: 0; }
    #kbModal .settings-box { height: min(560px, calc(100dvh - 48px)); }
    #kbModal .settings-actions { flex-shrink: 0; }
    #kbListBox { overscroll-behavior: contain; }
    .kb-doc { padding: 16px 0; border-bottom: 1px solid var(--border); }
    .kb-doc-title { font-weight: 550; overflow-wrap: anywhere; }
    .kb-doc-meta { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
    .kb-doc-tags { font-size: 11.5px; color: var(--accent); margin-top: 4px; }
    .kb-list-heading { font-size: 12px; font-weight: 550; color: var(--muted); margin-bottom: 4px; }

    .settings-field { margin-bottom: 18px; }
    .settings-field:last-of-type { margin-bottom: 0; }

    .settings-label {
      display: block;
      font-size: 13px; font-weight: 550; color: var(--text-2);
      margin-bottom: 8px;
    }

    .settings-select, .settings-input {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid var(--border-strong); border-radius: 10px;
      background: var(--panel);
      font-size: 13.5px; outline: none;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    .settings-select { cursor: pointer; }
    .settings-select:focus, .settings-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .settings-hint {
      font-size: 12px; color: var(--muted);
      margin-top: 8px; line-height: 1.55;
    }

    .settings-actions { display: flex; justify-content: flex-end; margin-top: 24px; }
    .settings-btn {
      border: 1px solid var(--accent); border-radius: 10px;
      background: var(--accent-gradient); color: #fff;
      padding: 10px 18px;
      font-size: 13.5px; font-weight: 550;
      cursor: pointer;
      transition: filter .12s ease;
    }
    .settings-btn:hover { filter: brightness(1.06); }

    /* ---------------- 通用按钮 / 确认弹窗 ---------------- */
    .btn {
      border: 1px solid var(--border-strong);
      background: var(--panel);
      color: var(--text);
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13.5px;
      transition: background .12s ease, border-color .12s ease, opacity .12s ease;
      white-space: nowrap;
    }
    .btn:hover { background: var(--bg-soft); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 550; }
    .btn.danger:hover { filter: brightness(1.06); }

    .modal-mask {
      position: fixed; inset: 0; z-index: 80;
      background: rgba(15, 18, 32, .4);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      display: grid; place-items: center; padding: 24px;
    }
    .modal {
      width: 100%; max-width: 380px;
      max-height: calc(100dvh - 48px); overflow-y: auto;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px; padding: 26px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .2);
      animation: slideUp .2s ease both;
    }
    .modal h3 { margin: 0 0 14px; font-size: 16px; font-weight: 650; }
    .modal .modal-text { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.6; }
    .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }

    /* ---------------- 主题切换过渡 / 动效减弱 ---------------- */
    body.theme-anim, body.theme-anim *, body.theme-anim *::before, body.theme-anim *::after {
      transition: background-color .25s ease, border-color .25s ease, color .25s ease, box-shadow .25s ease, fill .25s ease, stroke .25s ease !important;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }

    /* ---------------- 移动端 ---------------- */
    @media (max-width: 768px) {
      .sidebar {
        position: fixed; top: 0; left: 0; bottom: 0;
        width: min(288px, 86vw); z-index: 50;
        transform: translateX(-100%); visibility: hidden;
        transition: transform .22s ease, visibility .22s;
        box-shadow: var(--shadow);
        padding-top: env(safe-area-inset-top);
      }
      .sidebar.open { transform: translateX(0); visibility: visible; }
      .menu-toggle { display: grid; padding: 7px; }
      .header { padding-left: 12px; padding-right: 16px; min-height: 58px; }
      .messages-container { padding: 4px 16px 16px; }
      .input-wrapper { padding: 8px 12px max(12px, env(safe-area-inset-bottom)); }
      .input-box { padding: 10px 12px; border-radius: 18px; }
      .input-box textarea { font-size: 16px; }
      .empty-state { min-height: calc(100dvh - 248px); padding: 28px 0 16px; }
      .empty-state h2 { font-size: 23px; letter-spacing: -.6px; }
      .welcome-mark { width: 56px; height: 56px; border-radius: 18px; margin-bottom: 18px; }
      .welcome-mark svg { width: 28px; height: 28px; }
      .suggestion-grid { gap: 10px; margin-top: 24px; }
      .suggestion-chip { padding: 14px 12px; gap: 10px; }
      .empty-state .welcome-capabilities { margin-top: 18px; font-size: 11px; }
      .message-row { gap: 10px; padding: 18px 0; }
      .message-row::before { flex-basis: 28px; width: 28px; height: 28px; border-radius: 9px; }
      .message-row.user .message-bubble { max-width: 90%; padding: 10px 14px; }
      .scroll-bottom-btn { bottom: 10px; }
      .msg-actions { opacity: 1; }
      .delete-btn { opacity: 1; }
      .settings-modal-overlay, .modal-mask { padding: 16px; }
      .settings-box { padding: 22px; max-height: calc(100dvh - 32px); }
      .settings-input, .settings-select { font-size: 16px; }
    }
    @media (max-width: 420px) {
      .suggestion-chip { align-items: flex-start; gap: 8px; }
      .suggestion-chip > svg { width: 28px; height: 28px; padding: 6px; }
      .suggestion-copy strong { font-size: 12.5px; }
      .suggestion-copy small { font-size: 11px; }
      .model-display-text { max-width: 120px; }
      .disclaimer { font-size: 10.5px; }
    }
    @media (max-height: 680px) {
      .empty-state { min-height: 0; padding: 16px 0 12px; }
      .welcome-mark { width: 48px; height: 48px; border-radius: 16px; margin-bottom: 12px; }
      .welcome-mark svg { width: 26px; height: 26px; }
      .empty-state h2 { font-size: 22px; }
      .empty-state p { font-size: 13px; margin-top: 8px; }
      .suggestion-grid { margin-top: 16px; }
      .suggestion-chip { padding: 10px; }
      .empty-state .welcome-capabilities { margin-top: 12px; }
    }
    @media (hover: none) {
      .msg-actions, .delete-btn { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .messages-container { scroll-behavior: auto; }
    }
  </style>
`;
