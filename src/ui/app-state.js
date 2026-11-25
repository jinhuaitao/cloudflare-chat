// 会话本地存储、DOM 引用、主题、模型与 Agent 开关（_worker.js 原第 3800-3962 行，内嵌页面分片；只允许字符串导出）
export default `  // 会话本地存储：v6.1 起改用 cfchat_sessions；旧 key（nvidia_ai_sessions）的数据自动迁移
  const STORAGE_KEY = 'cfchat_sessions';
  const LEGACY_STORAGE_KEY = 'nvidia_ai_sessions';
  const MAX_SEND_MSGS = 60;   // 每次请求最多带最近 60 条消息，避免超长会话撑爆请求体
  const MAX_STORE_MSGS = 200; // 每个会话本地最多保留 200 条，超限从最旧开始丢弃
  const MAX_SESSIONS = 50;    // v6.8.9：会话数上限，超出裁掉最旧的，防止 localStorage 被塞爆
  function loadSessions() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
    } catch (e) {}
    return [];
  }
  let sessions = loadSessions();
  try {
    if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (e) {}
  let currentSessionId = null;

  // v6.9.5：切换 / 新建 / 删除当前会话前若正在流式输出，先主动中止旧流，防止跨会话串写
  function abortActiveStream() {
    if (isCurrentlyStreaming && currentAbortController) {
      try { currentAbortController.abort(); } catch (e) {}
    }
  }

  // /api/chat 访问口令：存在本机浏览器，随请求以 X-Access-Token 头发出
  const ACCESS_TOKEN_KEY = 'access_token';
  let accessToken = localStorage.getItem(ACCESS_TOKEN_KEY) || '';

  // ===== Web 对话 R2 同步（/api/sessions）=====
  // localStorage 继续做本地缓存与离线兜底；服务端配了 ACCESS_PASSWORD 时，
  // 再把整份会话同步到 R2。存储键在服务端由口令哈希派生，所以换设备只要
  // 填同一个口令，拉到的就是同一份对话。同步不可用时静默降级为纯本地，
  // 行为与从前一致。
  const SYNC_DELETED_KEY = 'cfchat_deleted_sessions';
  function dedupeSyncDeleted(list) {
    const byId = {};
    const out = [];
    (list || []).forEach(function (d) {
      if (!d || typeof d.id !== 'string' || !Number.isFinite(d.at) || d.at <= 0) return;
      if (!byId[d.id] || byId[d.id] < d.at) byId[d.id] = d.at;
    });
    Object.keys(byId).forEach(function (id) { out.push({ id: id, at: byId[id] }); });
    out.sort(function (a, b) { return b.at - a.at; });
    return out.slice(0, 200);
  }
  function loadSyncDeleted() {
    try {
      const arr = JSON.parse(localStorage.getItem(SYNC_DELETED_KEY) || '[]');
      return Array.isArray(arr) ? dedupeSyncDeleted(arr) : [];
    } catch (e) { return []; }
  }
  let syncDeleted = loadSyncDeleted();
  function saveSyncDeleted() {
    try { localStorage.setItem(SYNC_DELETED_KEY, JSON.stringify(syncDeleted)); } catch (e) {}
  }
  function noteSessionDeleted(id) {
    syncDeleted = dedupeSyncDeleted(syncDeleted.concat([{ id: id, at: Date.now() }]));
    saveSyncDeleted();
    scheduleSyncPush();
  }
  const syncState = { enabled: false, etag: '', timer: null, pushing: false, dirty: false, applying: false };
  function syncReqHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (accessToken) h['X-Access-Token'] = accessToken;
    return h;
  }
  function sessionSyncStamp(s) { return Number.isFinite(s && s.updatedAt) ? s.updatedAt : 0; }
  function mergeSyncSessionsLocal(localList, remoteList, deletedList) {
    const tomb = {};
    (deletedList || []).forEach(function (d) { if (!tomb[d.id] || tomb[d.id] < d.at) tomb[d.id] = d.at; });
    const byId = {};
    function consider(s, isLocal) {
      if (!s || typeof s.id !== 'string' || !Array.isArray(s.messages)) return;
      if (s.messages.length === 0) {
        // 空会话只在本机保留，不跨设备同步：新开的空白页签不该出现在另一台设备上
        if (isLocal && !byId[s.id]) byId[s.id] = s;
        return;
      }
      const prev = byId[s.id];
      if (!prev) { byId[s.id] = s; return; }
      const sAt = sessionSyncStamp(s);
      const pAt = sessionSyncStamp(prev);
      const newer = sAt !== pAt ? sAt > pAt : (s.messages.length !== prev.messages.length ? s.messages.length > prev.messages.length : isLocal);
      if (newer) byId[s.id] = s;
    }
    (remoteList || []).forEach(function (s) { consider(s, false); });
    (localList || []).forEach(function (s) { consider(s, true); });
    const out = [];
    Object.keys(byId).forEach(function (id) {
      const s = byId[id];
      const at = tomb[id];
      if (at && at >= sessionSyncStamp(s)) return;
      out.push(s);
    });
    out.sort(function (a, b) { return sessionSyncStamp(b) - sessionSyncStamp(a); });
    return out.slice(0, MAX_SESSIONS);
  }
  function scheduleSyncPush() {
    if (!syncState.enabled || syncState.applying) return;
    syncState.dirty = true;
    if (syncState.timer) clearTimeout(syncState.timer);
    syncState.timer = setTimeout(function () { pushSyncSessions(false); }, 1500);
  }
  function applyRemoteSync(remoteSessions, remoteDeleted, etag) {
    syncDeleted = dedupeSyncDeleted(syncDeleted.concat(remoteDeleted || []));
    saveSyncDeleted();
    if (typeof etag === 'string') syncState.etag = etag;
    const merged = mergeSyncSessionsLocal(sessions, remoteSessions || [], syncDeleted);
    if (JSON.stringify(merged) === JSON.stringify(sessions)) return false;
    syncState.applying = true;
    sessions = merged;
    saveSessions();
    syncState.applying = false;
    renderSessionList();
    if (sessions.length === 0) { createNewSession(); return true; }
    if (!sessions.some(function (s) { return s.id === currentSessionId; })) switchSession(sessions[0].id);
    else renderMessages();
    return true;
  }
  async function pushSyncSessions(isRetry) {
    if (!syncState.enabled || syncState.pushing) return;
    syncState.pushing = true;
    try {
      const payloadSessions = sessions.filter(function (s) { return Array.isArray(s.messages) && s.messages.length > 0; });
      const res = await fetch('/api/sessions', {
        method: 'PUT',
        headers: syncReqHeaders(),
        body: JSON.stringify({ baseEtag: syncState.etag, sessions: payloadSessions, deleted: syncDeleted })
      });
      if (res.status === 409) {
        const data = await res.json().catch(function () { return null; });
        syncState.pushing = false;
        if (data && !isRetry) {
          applyRemoteSync(data.sessions || [], data.deleted || [], data.etag || '');
          await pushSyncSessions(true);
        }
        return;
      }
      if (!res.ok) { syncState.enabled = false; return; }
      const data = await res.json().catch(function () { return null; });
      if (data && typeof data.etag === 'string') syncState.etag = data.etag;
      syncState.dirty = false;
    } catch (e) {
      // 离线或服务不可达：数据留在本地，下一次保存时再试
    } finally {
      syncState.pushing = false;
    }
  }
  async function pullSyncSessions() {
    try {
      const res = await fetch('/api/sessions', { headers: syncReqHeaders() });
      if (!res.ok) { syncState.enabled = false; return; }
      const data = await res.json().catch(function () { return null; });
      if (!data || data.enabled !== true) { syncState.enabled = false; return; }
      syncState.enabled = true;
      applyRemoteSync(data.sessions || [], data.deleted || [], data.etag || '');
      const localPayload = sessions.filter(function (s) { return Array.isArray(s.messages) && s.messages.length > 0; });
      if (JSON.stringify(localPayload) !== JSON.stringify(data.sessions || [])) scheduleSyncPush();
    } catch (e) {
      syncState.enabled = false;
    }
  }

  const messagesDiv = document.getElementById('messages');
  const emptyState = document.getElementById('emptyState');
  const scrollArea = document.getElementById('scrollArea');
  const scrollBottomBtn = document.getElementById('scrollBottomBtn');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const sessionListDiv = document.getElementById('sessionList');
  const modelSelect = document.getElementById('modelSelect');
  const headerTitle = document.getElementById('headerTitle');
  const modelDisplayText = document.getElementById('modelDisplayText');
  const statusDot = document.getElementById('statusDot');
  
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  let currentTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(currentTheme);

  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', currentTheme);
    applyTheme(currentTheme);
  });

  function applyTheme(theme) {
    // v6.9.0：切换主题时短暂开启全局色彩过渡，深浅色切换更顺滑
    document.body.classList.add('theme-anim');
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    } else {
      document.body.removeAttribute('data-theme');
      themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
    setTimeout(function () { document.body.classList.remove('theme-anim'); }, 400);
  }

  function updateSendButton() {
    const canSend = userInput.value.trim().length > 0;
    sendBtn.classList.toggle('active', canSend && !isCurrentlyStreaming);
    sendBtn.setAttribute('aria-disabled', String(!canSend && !isCurrentlyStreaming));
    const label = isCurrentlyStreaming ? '停止生成' : '发送消息';
    sendBtn.setAttribute('aria-label', label);
    sendBtn.title = label;
  }

  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 190) + 'px';
    updateSendButton();
  });

  function init() {
    updateHeaderDisplay();
    if (sessions.length === 0) createNewSession();
    else switchSession(sessions[0].id);
    renderSessionList();
    // 启动后异步拉一次 R2 同步：本地先照常渲染，远端到了再合并，不阻塞首屏
    pullSyncSessions();
  }

  function saveSessions() {
    try {
      // 同步合并时（applying）不盖时间戳：那是远端数据的原样落盘，
      // 盖上本机时间会让它在下一次合并里假装比别的设备更新
      if (!syncState.applying) {
        var cur = sessions.find(function (s) { return s.id === currentSessionId; });
        if (cur) cur.updatedAt = Date.now();
      }
      for (var i = 0; i < sessions.length; i++) {
        var msgs = sessions[i].messages;
        if (msgs && msgs.length > MAX_STORE_MSGS) {
          sessions[i].messages = msgs.slice(msgs.length - MAX_STORE_MSGS);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {}
    if (!syncState.applying) scheduleSyncPush();
  }

  function setSidebarOpen(open) {
    sidebar.classList.toggle('open', open);
    sidebarOverlay.classList.toggle('active', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? '收起历史对话' : '打开历史对话');
  }
  menuToggle.addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('open')));
  sidebarOverlay.addEventListener('click', () => setSidebarOpen(false));
  window.matchMedia('(max-width: 768px)').addEventListener('change', () => setSidebarOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open') && !document.querySelector('.settings-modal-overlay.active, .modal-mask')) {
      setSidebarOpen(false);
      menuToggle.focus();
    }
  });

  // ===== v6.9.0 交互增强 =====
  // 智能滚动：记录用户是否停在底部附近。向上翻历史时流式输出不再拽走滚动位置，
  // 同时浮现「回到底部」按钮；发送 / 切换会话时复位为贴底。
  let isNearBottom = true;
  function updateScrollState() {
    const d = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
    const near = d < 120;
    if (near !== isNearBottom) {
      isNearBottom = near;
      if (scrollBottomBtn) scrollBottomBtn.classList.toggle('show', !near);
    }
  }
  scrollArea.addEventListener('scroll', updateScrollState, { passive: true });
  if (scrollBottomBtn) {
    scrollBottomBtn.addEventListener('click', () => {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    });
  }

  // 空状态示例卡片：点击把提示语填进输入框（不直接发送，留出修改余地）
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      userInput.value = chip.dataset.prompt || '';
      userInput.dispatchEvent(new Event('input'));
      userInput.focus();
    });
  });

  function updateHeaderDisplay() {
    if (modelSelect) {
      const selectedText = modelSelect.options[modelSelect.selectedIndex]?.text || 'AI 核心处理中枢';
      headerTitle.innerText = selectedText;
      if (modelDisplayText) modelDisplayText.innerText = selectedText;
    }
  }

  function createNewSession() {
    abortActiveStream();
    // v6.8.9：加随机后缀保证会话 id 不可预测（历史遗留：曾用纯时间戳 id）
    const newId = 'session_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const savedDefaultModel = localStorage.getItem('default_model');
    const fallbackModel = modelSelect.options.length > 0 ? modelSelect.options[0].value : "";
    const targetModel = savedDefaultModel || fallbackModel;

    sessions.unshift({ id: newId, title: '新对话', messages: [], model: targetModel, updatedAt: Date.now() });
    if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) setSidebarOpen(false);
  }

  function switchSession(id) {
    if (currentSessionId && currentSessionId !== id) {
      abortActiveStream();
    }
    stopSpeaking();
    currentSessionId = id;
    // 切换会话默认落在最新消息处，并收起「回到底部」按钮
    isNearBottom = true;
    if (scrollBottomBtn) scrollBottomBtn.classList.remove('show');
    const currentSession = sessions.find(s => s.id === id);
    if (currentSession && currentSession.model) {
      const opts = Array.from(modelSelect.options);
      let match = opts.find(opt => opt.value === currentSession.model);
      if (!match) {
        // 兼容旧版会话里存的裸模型名：同一模型被多个通道复用时，
        // 选择键会变成 "id:name" 或 "id:name#2"，这里按 id 再匹配一次，避免静默切回第一个模型
        const bare = String(currentSession.model).split('#')[0].split(':')[0];
        match = opts.find(opt => opt.value.split('#')[0].split(':')[0] === bare);
      }
      if (match) {
        modelSelect.value = match.value;
        if (currentSession.model !== match.value) {
          currentSession.model = match.value;
          saveSessions();
        }
      } else {
        modelSelect.selectedIndex = 0;
        currentSession.model = modelSelect.value;
        saveSessions();
      }
    } else if (modelSelect.options.length > 0) {
      modelSelect.selectedIndex = 0;
    }
    updateHeaderDisplay();
    renderMessages();
    renderSessionList();
    if(window.innerWidth <= 768) { setSidebarOpen(false); userInput.blur(); }
  }

  function onModelChange() {
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if(currentSession) {
      currentSession.model = modelSelect.value;
      saveSessions();
    }
    updateHeaderDisplay();
  }
  modelSelect.addEventListener('change', onModelChange);
  modelSelect.addEventListener('input', onModelChange);

  // v6.6.0: Web 端 Agent 模式开关（默认开启，优先检索知识库文档）
  const agentToggle = document.getElementById('agentToggle');
  let agentMode = localStorage.getItem('cfchat_agent_mode') !== '0';
  function renderAgentToggle() {
    if (!agentToggle) return;
    agentToggle.classList.toggle('active', agentMode);
    agentToggle.textContent = agentMode ? 'Agent 开启' : 'Agent 关闭';
    agentToggle.setAttribute('aria-pressed', String(agentMode));
    agentToggle.title = agentMode
      ? 'Agent 模式已开启：自主规划并调用工具（🔍 搜索 / 📄 网页 / 🧮 计算 / 🌤 天气 / 🕐 时间），回答优先查知识库文档；知识库在本端只读，保存文档/记住信息请通过 Telegram 机器人。点击关闭。'
      : 'Agent 模式已关闭：普通对话，不调用工具。点击开启。';
  }
  if (agentToggle) {
    agentToggle.addEventListener('click', () => {
      agentMode = !agentMode;
      try { localStorage.setItem('cfchat_agent_mode', agentMode ? '1' : '0'); } catch (e) {}
      renderAgentToggle();
    });
    renderAgentToggle();
  }

`;
