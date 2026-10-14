// 会话列表与消息渲染（_worker.js 原第 4055-4139 行，内嵌页面分片；只允许字符串导出）
export default `  function renderSessionList() {
    sessionListDiv.replaceChildren();
    const fragment = document.createDocumentFragment();

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item ' + (session.id === currentSessionId ? 'active' : '');
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      fragment.appendChild(item);
    });

    sessionListDiv.appendChild(fragment);
  }

  function renderMessages() {
    messagesDiv.replaceChildren();
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (!currentSession) return;
    
    if (currentSession.messages.length === 0) {
      emptyState.style.display = 'flex';
    } else { 
      emptyState.style.display = 'none'; 
      currentSession.messages.forEach(msg => {
        const uiRole = msg.role === 'assistant' ? 'ai' : msg.role;
        appendMessageDOM(uiRole, msg.content, null, false);
      }); 
      syncRegenButtons();
    }
  }

  function appendMessageDOM(role, content, msgId = null, isError = false) {
    let row = msgId ? document.getElementById('row_' + msgId) : null;
    let bubble = msgId ? document.getElementById(msgId) : null;
    
    if (!row) {
      row = document.createElement('div'); 
      row.className = 'message-row ' + role;
      if (msgId) row.id = 'row_' + msgId; 
      if (isError) row.classList.add('error-msg');
      
      bubble = document.createElement('div'); 
      bubble.className = 'message-bubble'; 
      if (msgId) bubble.id = msgId;
      
      row.appendChild(bubble); 
      messagesDiv.appendChild(row);
    }
    
    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + safeHtml(content) + '</div>';
        bubble.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
        // 复制按钮要的是原始 Markdown，不是渲染后的 HTML
        bubble.__rawText = content;
      }
    } else {
      bubble.innerText = content; 
      bubble.__rawText = content;
    }
    ensureMessageActions(bubble);
    
    scrollArea.scrollTop = scrollArea.scrollHeight; 
    
    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

`;
