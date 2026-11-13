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
        appendMessageDOM(uiRole, msg.content, null, false, msg.t, msg.personaTrace, msg.personaDetail);
      }); 
      syncRegenButtons();
    }
  }

  // 「谁答的」胶囊：一行摘要 + 可展开详情（等价于网页版 /agent why）。
  // 明细由服务端算好（与 /agent why 同一份确定性打分），前端只排版、不重复判定。
  function personaNode(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fillPersonaDetail(box, d) {
    const reason = d.reasonText || d.reason || '';
    const thr = d.minScore ? '（阈值 ' + d.minScore + ' 分' + (d.score ? '，本轮 ' + d.score + ' 分' : '') + '）' : '';
    // 手动固定时「阈值/得分」与实际执行无关，只在下面留一条恢复提示，避免同一句话出现两次
    if (d.source !== 'manual') {
      box.appendChild(personaNode('div', 'ap-reason', '结论：' + reason + thr));
    }

    if (d.stages && d.stages.length) {
      const list = personaNode('ol', 'ap-stages');
      d.stages.forEach(st => {
        const li = personaNode('li', 'ap-stage');
        li.appendChild(personaNode('span', 'ap-seg', '「' + st.segment + '」'));
        li.appendChild(personaNode('span', 'ap-arrow', '→'));
        li.appendChild(personaNode('span', 'ap-who', st.emoji + ' ' + st.name));
        li.appendChild(personaNode('span', 'ap-score', st.score + ' 分'));
        if (st.matched && st.matched.length) {
          li.appendChild(personaNode('span', 'ap-words', '命中 ' + st.matched.join('、')));
        }
        list.appendChild(li);
      });
      box.appendChild(list);
    } else if (d.matched && d.matched.length) {
      const chips = personaNode('div', 'ap-chips');
      chips.appendChild(personaNode('span', 'ap-chips-label', '命中'));
      d.matched.forEach(w => chips.appendChild(personaNode('span', 'ap-chip', w)));
      box.appendChild(chips);
    }

    if (d.ranked && d.ranked.length) {
      const max = d.ranked.reduce((a, r) => Math.max(a, r.score || 0), 1);
      // 上面已用 chip 列出首位角色的命中词时，打分表首行不再重复
      const chipsShown = !(d.stages && d.stages.length) && !!(d.matched && d.matched.length);
      const rank = personaNode('div', 'ap-rank');
      d.ranked.forEach(r => {
        const row = personaNode('div', 'ap-rank-row');
        // 名字与命中词放同一格上下排：这样每行是一个整体，跨行的列仍能对齐
        const cell = personaNode('span', 'ap-cell');
        cell.appendChild(personaNode('span', 'ap-who', r.emoji + ' ' + r.name));
        // 首位角色的命中词上面已经用 chip 列过了，不再重复一行
        const dup = chipsShown && r.id === d.persona.id;
        if (r.matched && r.matched.length && !dup) {
          cell.appendChild(personaNode('span', 'ap-words', r.matched.join('、')));
        }
        row.appendChild(cell);
        const bar = personaNode('span', 'ap-bar');
        const fill = personaNode('i', 'ap-bar-fill');
        fill.style.width = Math.max(6, Math.round(((r.score || 0) / max) * 100)) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(personaNode('span', 'ap-score', (r.score || 0) + ' 分'));
        rank.appendChild(row);
      });
      box.appendChild(rank);
    }

    if (d.continuedFrom) {
      box.appendChild(personaNode('div', 'ap-note', '承接上一轮：' + d.continuedFrom.emoji + ' ' + d.continuedFrom.name));
    }
    if (d.source === 'manual') {
      box.appendChild(personaNode('div', 'ap-note', '已手动固定，未走自动路由。发 /agent auto 可恢复自动匹配。'));
    }
    if (!box.childNodes.length) {
      box.appendChild(personaNode('div', 'ap-note', '本轮按通用助手处理。'));
    }
  }

  let personaCardSeq = 0;

  function createPersonaCard(trace, detail) {
    const text = String(trace || '').trim();
    if (!text) return null;
    const wrap = personaNode('div', 'agent-persona');
    // 没有明细就保持旧形态：一行静态胶囊，点开也没东西可看
    if (!detail || typeof detail !== 'object') {
      wrap.className = 'agent-persona static';
      wrap.textContent = text;
      return wrap;
    }
    const body = personaNode('div', 'agent-persona-body');
    body.hidden = true;
    personaCardSeq += 1;
    body.id = 'ap-body-' + personaCardSeq;
    fillPersonaDetail(body, detail);
    const head = personaNode('button', 'agent-persona-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', body.id);
    // 窄屏上胶囊会截断，hover 时给出完整摘要
    head.title = text;
    head.appendChild(personaNode('span', 'agent-persona-text', text));
    head.appendChild(personaNode('span', 'agent-persona-chev', '▾'));
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
      body.hidden = open;
      wrap.classList.toggle('open', !open);
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  function appendMessageDOM(role, content, msgId = null, isError = false, time = null, personaTrace = '', personaDetail = null) {
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

    // v6.9.0：时间戳（旧会话数据没有 t 字段则为 null，不显示）
    bubble.__time = time || null;

    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        // v6.9.5：isCurrentlyStreaming 为 false 时，safeHtml 内部的 marked renderer 已完成代码高亮，无需二次调用 hljs.highlightElement
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + safeHtml(content) + '</div>';
        // 复制按钮要的是原始 Markdown，不是渲染后的 HTML
        bubble.__rawText = content;
      }
    } else {
      bubble.innerText = content; 
      bubble.__rawText = content;
    }

    // 历史消息重绘时把「谁答的」一起还原：徽标只存在消息对象里，DOM 重建后要重新插入
    if (role === 'ai' && personaTrace) {
      const personaEl = createPersonaCard(personaTrace, personaDetail);
      if (personaEl) bubble.insertBefore(personaEl, bubble.firstChild);
    }
    ensureMessageActions(bubble);

    // v6.9.0：智能滚动 —— 用户自己的消息永远贴底；AI 消息只在用户
    // 停在底部附近时跟随（向上翻历史时不被流式输出拽走）
    if (role === 'user' || isNearBottom) {
      isNearBottom = true;
      scrollArea.scrollTop = scrollArea.scrollHeight;
    }

    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

`;
