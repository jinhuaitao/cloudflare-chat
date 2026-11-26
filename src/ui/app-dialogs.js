// 通用弹窗（替换原生 confirm / alert）与删除会话（_worker.js 原第 3963-4054 行，内嵌页面分片；只允许字符串导出）
export default `  // ===== 通用弹窗：替掉浏览器原生 confirm() / alert()，样式跟随主题 =====
  // 原生对话框不受页面 CSS 影响，在换过皮的界面里会显得格格不入。
  const modalFocusStates = new Map();
  let dialogId = 0;

  function getTopModalFocus() {
    const modals = Array.from(document.querySelectorAll('.settings-modal-overlay, .modal-mask'))
      .filter(el => modalFocusStates.has(el) && el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
    const modal = modals.filter(el => el.classList.contains('modal-mask')).pop() || modals.pop();
    const state = modalFocusStates.get(modal);
    if (!state) return null;
    state.targets = Array.from(state.panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]'))
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
    return state;
  }

  function manageModalFocus(modal, close) {
    if (!close) {
      const state = modalFocusStates.get(modal);
      modalFocusStates.delete(modal);
      if (!state) return;
      const top = getTopModalFocus();
      if (state.invoker && state.invoker.isConnected && (!top || top.panel.contains(state.invoker))) {
        state.invoker.focus();
      } else if (top) {
        (top.targets[0] || top.panel).focus();
      }
      return;
    }
    if (!modalFocusStates.has(modal)) {
      modalFocusStates.set(modal, { modal: modal, panel: modal.querySelector('.settings-box, .modal'), invoker: document.activeElement, close: close });
    }
    const state = modalFocusStates.get(modal);
    const focus = function () {
      if (modalFocusStates.get(modal) !== state) return;
      const top = getTopModalFocus();
      if (top && top.modal === modal && !top.targets.includes(document.activeElement)) {
        (top.targets[0] || top.panel).focus();
      }
    };
    if (modal.classList.contains('settings-modal-overlay')) {
      setTimeout(function () {
        if (modalFocusStates.get(modal) !== state) return;
        modal.classList.add('active');
        focus();
      }, 10);
    } else {
      focus();
    }
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' && ev.key !== 'Tab') return;
    const top = getTopModalFocus();
    if (!top) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      top.close();
      return;
    }
    const index = top.targets.indexOf(document.activeElement);
    if (index === -1 || (ev.shiftKey ? index === 0 : index === top.targets.length - 1)) {
      ev.preventDefault();
      (ev.shiftKey ? top.targets[top.targets.length - 1] || top.panel : top.targets[0] || top.panel).focus();
    }
  }, true);

  function openDialog(opts) {
    return new Promise(function (resolve) {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';

      const box = document.createElement('div');
      box.className = 'modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.tabIndex = -1;

      const h = document.createElement('h3');
      h.id = 'dialogTitle' + (++dialogId);
      h.textContent = opts.title || '确认操作';
      box.setAttribute('aria-labelledby', h.id);

      const p = document.createElement('p');
      p.id = 'dialogMessage' + dialogId;
      p.className = 'modal-text';
      box.setAttribute('aria-describedby', p.id);
      p.textContent = opts.message || '';

      const actions = document.createElement('div');
      actions.className = 'actions';

      function finish(value) {
        if (!mask.parentNode) return;
        mask.parentNode.removeChild(mask);
        manageModalFocus(mask);
        resolve(value);
      }

      // 只有一个「知道了」的情况（提示类）
      if (!opts.danger) {
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'btn';
        ok.textContent = opts.okText || '知道了';
        ok.addEventListener('click', function () { finish(true); });
        actions.appendChild(ok);
      } else {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn';
        cancel.textContent = opts.cancelText || '取消';

        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'btn danger';
        ok.textContent = opts.okText || '删除';

        cancel.addEventListener('click', function () { finish(false); });
        ok.addEventListener('click', function () { finish(true); });
        actions.appendChild(cancel);
        actions.appendChild(ok);
      }

      mask.addEventListener('click', function (ev) { if (ev.target === mask) finish(false); });

      box.appendChild(h);
      box.appendChild(p);
      box.appendChild(actions);
      mask.appendChild(box);
      document.body.appendChild(mask);
      manageModalFocus(mask, function () { finish(false); });
    });
  }

  function askConfirm(message) {
    return openDialog({ title: '确认操作', message: message, danger: true, okText: '删除' });
  }

  function showAlert(message, title) {
    return openDialog({ title: title || '提示', message: message });
  }

  async function deleteSession(e, id) {
    e.stopPropagation();
    if (!(await askConfirm('确认删除这个对话吗？删除后无法恢复。'))) return;
    if (currentSessionId === id && typeof abortActiveStream === 'function') {
      abortActiveStream();
    }
    sessions = sessions.filter(s => s.id !== id);
    saveSessions();
    if (sessions.length === 0) createNewSession();
    else if (currentSessionId === id) switchSession(sessions[0].id);
    else renderSessionList();
  }

`;
