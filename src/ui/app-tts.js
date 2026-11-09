// 语音朗读（Web Speech API，浏览器原生，无需 API Key）（_worker.js 原第 3548-3698 行，内嵌页面分片；只允许字符串导出）
//
// cleanForSpeech / containsCJK 不再写在本分片里 —— 它们来自 src/ui/speech.js，
// 以源码字符串形式插入。原因：分片内有「两层转义」，写反斜杠会被吃掉，
// 而这两个函数全是正则；同一段逻辑还要供 tts-demo.html 使用，必须单一来源。
import { CLEAN_FOR_SPEECH_SRC, CONTAINS_CJK_SRC } from './speech.js';

export default `  // ===== 语音朗读（Web Speech API，浏览器原生，无需任何 API Key）=====
  const TTS_AUTO_KEY = 'tts_auto';
  let autoSpeak = localStorage.getItem(TTS_AUTO_KEY) === '1';
  let activeSpeakBtn = null;

  const SPEAK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
  // 消息操作图标（纯字符串拼接，不写反引号/反斜杠，避免模板字符串两层转义）
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const REGEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 5 22 10 17 10"></polyline><path d="M19.7 14.6A8 8 0 1 1 17.7 6.3L22 10"></path></svg>';

  // 复制文本：优先用剪贴板 API，非安全上下文（http 非 localhost）降级到 execCommand
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 点击后短暂换成「已完成」图标，让纯图标按钮有明确反馈
  function flashIcon(btn, doneIcon, backIcon) {
    btn.innerHTML = doneIcon;
    btn.classList.add('done');
    clearTimeout(btn.__flashTimer);
    btn.__flashTimer = setTimeout(function () {
      btn.innerHTML = backIcon;
      btn.classList.remove('done');
    }, 1300);
  }

  function updateTtsToggleUI() {
    const btn = document.getElementById('ttsToggle');
    if (btn) {
      btn.classList.toggle('active', autoSpeak);
      btn.title = autoSpeak ? '自动朗读：已开启（点击关闭）' : '自动朗读：已关闭（点击开启）';
    }
  }

  // 把 Markdown / 代码块清理成适合朗读的纯文本（实现见 src/ui/speech.js，此处只插入源码）
${CLEAN_FOR_SPEECH_SRC}

  // 是否包含中日韩字符（用于选择朗读语言）
${CONTAINS_CJK_SRC}

  function getBubbleText(bubble) {
    const box = bubble.querySelector('.message-text') || bubble;
    return (box.innerText || box.textContent || '').trim();
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeakBtn) {
      activeSpeakBtn.classList.remove('speaking');
      activeSpeakBtn.title = '朗读这条回复';
      activeSpeakBtn.setAttribute('aria-label', '朗读这条回复');
      activeSpeakBtn = null;
    }
  }

  function toggleSpeak(btn, bubble) {
    if (btn.classList.contains('speaking')) { stopSpeaking(); return; }

    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      showAlert('当前浏览器不支持语音朗读，请使用 Chrome / Edge / Safari 较新版本。');
      return;
    }

    stopSpeaking();

    const text = cleanForSpeech(getBubbleText(bubble));
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = containsCJK(text) ? 'zh-CN' : 'en-US';
    utter.rate = 1;
    utter.pitch = 1;

    const reset = () => {
      if (activeSpeakBtn === btn) {
        btn.classList.remove('speaking');
        btn.title = '朗读这条回复';
        btn.setAttribute('aria-label', '朗读这条回复');
        activeSpeakBtn = null;
      }
    };
    utter.onend = reset;
    utter.onerror = reset;

    activeSpeakBtn = btn;
    btn.classList.add('speaking');
    btn.title = '停止朗读';
    btn.setAttribute('aria-label', '停止朗读');

    window.speechSynthesis.speak(utter);
  }

`;
