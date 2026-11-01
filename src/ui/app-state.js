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
  let currentTheme = localStorage.getItem('theme') || 'light';
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

  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    sendBtn.classList.toggle('active', this.value.trim().length > 0);
  });

  function init() {
    updateHeaderDisplay();
    if (sessions.length === 0) createNewSession();
    else switchSession(sessions[0].id);
    renderSessionList();
  }

  function saveSessions() {
    try {
      for (var i = 0; i < sessions.length; i++) {
        var msgs = sessions[i].messages;
        if (msgs && msgs.length > MAX_STORE_MSGS) {
          sessions[i].messages = msgs.slice(msgs.length - MAX_STORE_MSGS);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {}
  }

  menuToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
  sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });

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

    sessions.unshift({ id: newId, title: '新对话', messages: [], model: targetModel });
    if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) sidebar.classList.remove('open');
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
      const exists = Array.from(modelSelect.options).some(opt => opt.value === currentSession.model);
      if (exists) {
        modelSelect.value = currentSession.model;
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
    if(window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); userInput.blur(); }
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
    agentToggle.textContent = agentMode ? '🤖 Agent 开' : '🤖 Agent';
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
