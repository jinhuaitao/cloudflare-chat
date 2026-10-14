// 发送与流式接收：Agent 进度、重试、中断处理（_worker.js 原第 4140-4567 行，内嵌页面分片；只允许字符串导出）
export default `  async function sendMessage() {
    const text = userInput.value.trim(); 
    if (!text && !isCurrentlyStreaming) return;
    
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (currentSession.messages.length === 0) {
      currentSession.title = text.length > 14 ? text.substring(0, 14) + '...' : text;
      renderSessionList();
    }
    
    stopSpeaking();
    emptyState.style.display = 'none'; 
    userInput.value = ''; 
    userInput.style.height = 'auto';
    statusDot.classList.add('generating'); 
    
    appendMessageDOM('user', text);
    currentSession.messages.push({ role: 'user', content: text });
    saveSessions();
    syncRegenButtons();   // 上一轮的 AI 回复不再是最后一条，收起它的「重新生成」

    const aiMsgId = 'ai_' + Date.now();
    // 字符串拼接替换模板字符串
    appendMessageDOM('ai', 
      '<div class="reasoning-box" style="display:none;"></div>' +
      '<div class="message-text markdown-body">' +
        '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
      '</div>', aiMsgId);
    
    const bubble = document.getElementById(aiMsgId);
    isCurrentlyStreaming = true;
    syncRegenButtons();   // 进入生成态：收起上一轮的「重新生成」
    
    currentAbortController = new AbortController();
    sendBtn.classList.remove('active');
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>';

    try {
      const reqHeaders = { 'Content-Type': 'application/json' };
      if (accessToken) reqHeaders['X-Access-Token'] = accessToken;

      let aiContent = '';
      let reasoningContent = '';
      let gotDone = false; // 是否收到 SSE 正常结束标记 data: [DONE]
      // 空闲看门狗：超过该时长没收到任何 SSE 字节就主动断开。服务端每 15 秒发一次
      // 保活注释行，正常情况下永远不会触发；只有服务端假死 / 连接半开时才会命中，
      // 否则 reader.read() 会永远挂着，界面就一直停在打字动画上。
      const AGENT_IDLE_TIMEOUT_MS = 90000;
      let idleTimedOut = false; // 区分"用户手动中止"与"看门狗中止"

      const rBox = bubble.querySelector('.reasoning-box');
      const tBox = bubble.querySelector('.message-text');

      let isRenderPending = false;
      let lastRenderTime = 0;
      const cursorHtml = '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';

      function scheduleUpdateUI(force = false) {
        const now = Date.now();
        if (!force && now - lastRenderTime < 60) return;
        if (isRenderPending) return;
        isRenderPending = true;

        requestAnimationFrame(() => {
          isRenderPending = false;
          lastRenderTime = Date.now();

          if (!isCurrentlyStreaming && !force) return;

          if (reasoningContent && rBox) {
            if (rBox.style.display === 'none') rBox.style.display = 'block';
            rBox.textContent = reasoningContent;
            rBox.scrollTop = rBox.scrollHeight;
          }

          if (aiContent || !reasoningContent) {
            tBox.innerHTML = safeHtml(aiContent) + (isCurrentlyStreaming ? cursorHtml : '');
          } else if (reasoningContent && !aiContent) {
            tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
          }

          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        });
      }

      // v6.6.0 Agent 进度条（气泡内，收到正文结束 / 出错 / 中止时清除）
      // 进度事件每步才来一次，而单步等上游可能一两分钟。这里用本地秒表持续刷新
      // "已等待 N 秒"，让用户确知连接还活着，不必怀疑界面卡死。
      let agentProgressEl = null;
      let agentProgressBase = '';
      let agentProgressT0 = 0;
      let agentProgressTimer = null;
      function renderAgentProgress() {
        if (!agentProgressEl) return;
        const s = Math.round((Date.now() - agentProgressT0) / 1000);
        agentProgressEl.textContent = agentProgressBase + (s >= 3 ? '\\n（已等待 ' + s + ' 秒）' : '');
      }
      function showAgentProgress(text) {
        if (!agentProgressEl) {
          agentProgressEl = document.createElement('div');
          agentProgressEl.className = 'agent-progress';
          bubble.appendChild(agentProgressEl);
          agentProgressT0 = Date.now();
          agentProgressTimer = setInterval(renderAgentProgress, 1000);
        }
        agentProgressEl.style.display = '';
        agentProgressBase = text;
        renderAgentProgress();
        const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
        if (distanceToBottom < 120) {
          scrollArea.scrollTop = scrollArea.scrollHeight;
        }
      }
      // 正文开始流式输出后收起进度条，否则"Agent 思考中"会一直挂在答案上方
      function hideAgentProgress() {
        if (agentProgressEl) agentProgressEl.style.display = 'none';
      }
      function clearAgentProgress() {
        if (agentProgressTimer) { clearInterval(agentProgressTimer); agentProgressTimer = null; }
        if (agentProgressEl && agentProgressEl.parentNode) agentProgressEl.parentNode.removeChild(agentProgressEl);
        agentProgressEl = null;
        agentProgressBase = '';
      }
      // 撤回本轮已流式显示的正文：服务端发现刚推来的内容其实是"工具调用开场白"
      // 或 DSML 标记时会发 agent_reset，让我们清屏重来，避免它和最终答案拼在一起。
      function resetStreamedText() {
        aiContent = '';
        reasoningContent = '';
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
        if (agentProgressEl) showAgentProgress(agentProgressBase || '🤖 Agent 正在继续…');
      }

      // 自动重试提示条（只在断流重试时短暂出现）
      let retryNoticeEl = null;
      function setRetryNotice(text) {
        if (!text) {
          if (retryNoticeEl && retryNoticeEl.parentNode) retryNoticeEl.parentNode.removeChild(retryNoticeEl);
          retryNoticeEl = null;
          return;
        }
        if (!retryNoticeEl) {
          retryNoticeEl = document.createElement('div');
          retryNoticeEl.className = 'retry-notice';
          bubble.appendChild(retryNoticeEl);
        }
        retryNoticeEl.textContent = text;
      }

      // 重试前清空本轮残留，重新完整生成一次（避免新旧内容拼接错乱）
      function resetStreamUI() {
        aiContent = '';
        reasoningContent = '';
        gotDone = false;
        clearAgentProgress();
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
      }

      // 单次流式请求。收到 [DONE] 返回 true；网络/鉴权等错误直接 throw。
      // 注意：流被"静默掐断"（done=true 但无 [DONE]）不会抛错，由外层按 gotDone 判定。
      async function runOnce() {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            messages: currentSession.messages.slice(-MAX_SEND_MSGS),
            model: modelSelect.value,
            agent: agentMode,
            session_id: currentSessionId
          }),
          signal: currentAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '网络或服务接口错误' }));
          if (response.status === 401) {
            openSettings();
            const authErr = new Error('访问口令错误或未填写');
            authErr.name = 'AuthError';
            throw authErr;
          }
          throw new Error(errorData.error || '请求失败');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        idleTimedOut = false;
        let idleTimer = null;
        function bumpIdle() {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(function () {
            idleTimedOut = true;
            try { currentAbortController.abort(); } catch (e) {}
          }, AGENT_IDLE_TIMEOUT_MS);
        }
        bumpIdle();

        try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bumpIdle();

          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\\n');
          buffer = lines.pop();

          for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            // 结束标记：兼容 data:[DONE]（无空格）写法
            if (line.slice(5).trim() === '[DONE]') { gotDone = true; continue; }
            // v6.6.0 Agent 事件：进度展示 / 错误（错误直接抛给外层统一处理，不自动重试，避免工具重复执行）
            // v6.8.1：先做子串快速过滤，再要求整行是合法 JSON 且真的携带对应字段，
            // 避免 AI 正文恰好包含 "agent_progress" 子串时整行被误吞
            if (line.indexOf('"agent_progress"') > 0 || line.indexOf('"agent_error"') > 0 || line.indexOf('"agent_reset"') > 0) {
              let handledAsAgentEvent = false;
              try {
                const adata = JSON.parse(line.slice(5).trim());
                if (adata && adata.agent_progress !== undefined) {
                  showAgentProgress(adata.agent_progress);
                  handledAsAgentEvent = true;
                } else if (adata && adata.agent_reset !== undefined) {
                  resetStreamedText();
                  handledAsAgentEvent = true;
                } else if (adata && adata.agent_error !== undefined) {
                  const ae = new Error(adata.agent_error);
                  ae.name = 'AgentError';
                  throw ae;
                }
              } catch (e) {
                if (e && e.name === 'AgentError') throw e;
              }
              if (handledAsAgentEvent) continue;
              // 不是真正的 Agent 事件 → 回落到下面的普通 SSE 解析，不吞行
            }
            // 普通 SSE 解析：解析失败（多半是被截断的半行）静默跳过即可；
            // 但 data.error 是服务端明确的失败信号，必须抛出去 —— 之前整段包在
            // try{}catch(e){} 里，服务端返回的错误被无声吞掉，用户只看到空回复。
            let sseData = null;
            try { sseData = JSON.parse(line.slice(5).trim()); } catch (e) { sseData = null; }
            if (!sseData) continue;
            if (sseData.error) {
              const de = new Error(sseData.error.message || JSON.stringify(sseData.error));
              de.name = 'ServerError';
              throw de;
            }
            if (sseData.choices && sseData.choices[0] && sseData.choices[0].delta) {
              const delta = sseData.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
                aiContent += delta.content;
                hideAgentProgress();   // 正文开始输出 → 收起进度条
              }
              scheduleUpdateUI();
            }
          }
        }
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }

        if (!gotDone && buffer.trim() && buffer.trim().startsWith('data:') && !buffer.includes('[DONE]')) {
          try {
            const data = JSON.parse(buffer.slice(5).trim());
            if (data.choices && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content) aiContent += delta.content;
            }
          } catch(e) {}
        }
      }

      // 主循环：深度思考时间越长越容易撞上边缘掐流/网络抖动，
      // 未收到 [DONE] 即视为异常中断，指数退避后自动重试。
      const MAX_AUTO_RETRY = 3;
      let attempt = 0;
      let streamError = null;
      while (true) {
        attempt++;
        streamError = null;
        try {
          await runOnce();
        } catch (e) {
          const en = (e && e.name) || '';
          // 口令问题 / 服务端明确报错 / 空闲超时：不重试，直接走统一错误处理
          if (en === 'AuthError' || en === 'ServerError' || en === 'IdleTimeout') {
            setRetryNotice(null);
            throw e;
          }
          // 看门狗触发的 abort 和用户手动中止都是 AbortError，靠 idleTimedOut 区分
          if (en === 'AbortError') {
            setRetryNotice(null);
            if (idleTimedOut) {
              const ie = new Error('超过 ' + Math.round(AGENT_IDLE_TIMEOUT_MS / 1000) + ' 秒没有收到服务端任何数据，连接可能已中断，请重试');
              ie.name = 'IdleTimeout';
              throw ie;
            }
            throw e;
          }
          streamError = e;
        }
        if (gotDone) break;
        // 关键顺序：必须先把错误对象补全，再判断是否重试。
        // 之前 agentMode 的 break 排在补错之前，连接被干净关闭（read 返回 done 而不抛错）
        // 且没收到 [DONE] 时会执行 throw null，紧接着 catch 里读 error.name 又抛一次
        // TypeError，异常从 catch 内部逃出，气泡里的打字动画永远得不到替换 ——
        // 这就是用户看到的"一直是思考中"。
        if (!streamError) streamError = new Error('连接意外中断（未收到结束标记）');
        // v6.6.0 Agent 模式不自动重试：重跑会重复执行工具（重复搜索/重复记忆），中断直接走错误展示
        if (agentMode) break;
        if (attempt > MAX_AUTO_RETRY) break;
        resetStreamUI();
        setRetryNotice('连接意外中断，正在自动重试（第 ' + attempt + ' 次）…');
        await new Promise(function (resolve) { setTimeout(resolve, 1200 * attempt); });
      }
      setRetryNotice(null);
      if (!gotDone) throw streamError;

      isCurrentlyStreaming = false;
      if (!reasoningContent && rBox) rBox.remove();
      clearAgentProgress();

      tBox.innerHTML = safeHtml(aiContent);
      if (window.hljs) tBox.querySelectorAll('pre code').forEach((block) => { try { hljs.highlightElement(block); } catch (e) {} });
      bubble.__rawText = aiContent;   // 供「复制」取原始 Markdown
      scrollArea.scrollTop = scrollArea.scrollHeight;

      // 自动朗读（若已在左下角开启）
      if (autoSpeak && aiContent && aiContent.trim()) {
        const sb = bubble.querySelector('.speak-btn');
        if (sb) toggleSpeak(sb, bubble);
      }
      
      currentSession.messages.push({ role: 'assistant', content: aiContent }); 
      saveSessions();
      
    } catch (error) {
      // 兜底：error 绝不能是 null / undefined，否则下面读 error.name 会再抛一次
      // TypeError，异常从 catch 内部逃出，气泡里的打字动画永远得不到替换
      if (!error) error = new Error('连接意外中断（未收到结束标记）');
      isCurrentlyStreaming = false;
      clearAgentProgress();
      const tBox = bubble.querySelector('.message-text');

      if (error.name === 'AgentError') {
        // v6.6.0 Agent 执行错误：红色展示，不记入历史（避免错误文本污染上下文）
        tBox.innerHTML = '<span style="color: #ef4444; font-size: 14px; font-weight: 600;">' + escapeHtml(error.message) + '</span>';
        bubble.parentElement.classList.add('error-msg');
      } else if (error.name === 'AbortError') {
        const interruptNote = '<br><br><span style="color: var(--text-secondary); font-size: 13px; font-weight: 500;">(🛑 生成已手动中止)</span>';
        tBox.innerHTML = safeHtml(aiContent || '已中止') + interruptNote;
        if (aiContent) {
          currentSession.messages.push({ role: 'assistant', content: aiContent });
          bubble.__rawText = aiContent;
        }
      } else if (error.name === 'AuthError') {
        tBox.innerHTML = '<span style="color: var(--brand-color); font-size: 15px; font-weight: 600;">需要访问口令</span>' +
          '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 8px; line-height: 1.6;">请在左下角「设置」中填写与服务端 ACCESS_PASSWORD 一致的口令，保存后重新发送。</div>';
        bubble.parentElement.classList.add('error-msg');
        currentSession.messages.pop();
        userInput.value = text;
        userInput.dispatchEvent(new Event('input'));
      } else {
        if (aiContent || reasoningContent) {
          // 字符串拼接替换模板字符串，彻底规避 CF 编辑器转义 Bug
          tBox.innerHTML = safeHtml(aiContent) + '<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: ' + escapeHtml(error.message) + ')</span>';
          currentSession.messages.push({ role: 'assistant', content: aiContent });
          bubble.__rawText = aiContent;
          if (rBox && reasoningContent) rBox.remove(); 
        } else {
          tBox.innerText = '通信断开: ' + error.message; 
          bubble.parentElement.classList.add('error-msg');
          currentSession.messages.pop(); 
        }
      }
      if (window.hljs) tBox.querySelectorAll('pre code').forEach((block) => { try { hljs.highlightElement(block); } catch (e) {} });
      saveSessions();
    } finally {
      isCurrentlyStreaming = false;
      // 最后一道保险：无论上面走了哪条分支、甚至 catch 里再抛异常，都不允许气泡
      // 停在打字动画上，也不允许进度秒表继续跑。若检测到残留的 typing-indicator，
      // 一律替换成明确提示。
      try {
        clearAgentProgress();
        const tb = bubble.querySelector('.message-text');
        if (tb && tb.querySelector('.typing-indicator')) {
          tb.innerHTML = '<span style="color:#ef4444;font-size:14px;font-weight:600;">连接中断，未收到回复，请重试</span>';
          bubble.parentElement.classList.add('error-msg');
        }
      } catch (e) {}
      currentAbortController = null;
      statusDot.classList.remove('generating'); 
      syncRegenButtons();   // 生成结束：末尾 AI 回复的「重新生成」恢复可用
      
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
      
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      userInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isCurrentlyStreaming && currentAbortController) {
      currentAbortController.abort(); 
    } else {
      sendMessage();
    }
  });

  userInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); 
      if (sendBtn.classList.contains('active') && !isCurrentlyStreaming) { 
        sendMessage(); 
      }
    } 
  });
  
`;
