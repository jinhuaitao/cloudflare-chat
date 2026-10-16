// 偏好设置弹窗与底部开关接线（内嵌页面分片；只允许字符串导出）
export default `  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');
  const accessTokenSetting = document.getElementById('accessTokenSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }
  if (accessTokenSetting) {
    accessTokenSetting.value = accessToken;
  }

  function openSettings() {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10);
  }

  settingsToggle.addEventListener('click', openSettings);

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    if (accessTokenSetting) {
      accessToken = accessTokenSetting.value.trim();
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);

  // v7.1.0：一键导出当前会话为 Markdown (.md)
  const exportChatBtn = document.getElementById('exportChatBtn');
  if (exportChatBtn) {
    exportChatBtn.addEventListener('click', () => {
      const s = sessions.find(x => x.id === currentSessionId);
      if (!s || !s.messages || !s.messages.length) {
        showAlert('当前会话还没有任何消息可导出。');
        return;
      }
      const NL = String.fromCharCode(10);
      const lines = ['# ' + (s.title || '对话导出'), '', '> 导出时间：' + new Date().toLocaleString() + ' | 模型：' + (s.model || ''), ''];
      s.messages.forEach((m) => {
        const who = m.role === 'user' ? '## 🧑 用户' : '## 🤖 AI 助手';
        lines.push(who, '', String(m.content || ''), '');
      });
      const blob = new Blob([lines.join(NL)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = String(s.title || 'chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'chat';
      a.download = safeName + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  // 左下角「自动朗读」开关
  const ttsToggleBtn = document.getElementById('ttsToggle');
  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(TTS_AUTO_KEY, autoSpeak ? '1' : '0');
      if (!autoSpeak) stopSpeaking();
      updateTtsToggleUI();
    });
  }
  updateTtsToggleUI();

  // 页面关闭 / 切换标签页时停止朗读
  window.addEventListener('beforeunload', stopSpeaking);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });

`;
