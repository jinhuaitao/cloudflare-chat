// 知识库面板：统计 / 检索命中片段 / 文档列表 / 阅读 / 上传导入 / 删除 / 重建索引
// v7.5.0 新增。注意：本段位于外层模板字符串内，不写反引号与 ${}，
// 换行符一律写成双反斜杠加 n，正则里的反斜杠同样双写，避免两层转义破坏脚本。
export default `  // ===== v7.5.0 知识库 Agent 面板 =====
  const KB_TOKEN_KEY = 'cfchat_kb_admin_token';
  const kbModal = document.getElementById('kbModal');
  const kbModalToggle = document.getElementById('kbModalToggle');
  const closeKbModalBtn = document.getElementById('closeKbModalBtn');
  const kbStatsEl = document.getElementById('kbStats');
  const kbSearchInput = document.getElementById('kbSearchInput');
  const kbSearchBtn = document.getElementById('kbSearchBtn');
  const kbSearchResults = document.getElementById('kbSearchResults');
  const kbDocList = document.getElementById('kbDocList');
  const kbListTitle = document.getElementById('kbListTitle');
  const kbRefreshBtn = document.getElementById('kbRefreshBtn');
  const kbReindexBtn = document.getElementById('kbReindexBtn');
  const kbAdminTokenInput = document.getElementById('kbAdminToken');
  const kbTitleInput = document.getElementById('kbTitleInput');
  const kbSourceInput = document.getElementById('kbSourceInput');
  const kbFileInput = document.getElementById('kbFileInput');
  const kbContentInput = document.getElementById('kbContentInput');
  const kbSaveBtn = document.getElementById('kbSaveBtn');
  const kbFetchBtn = document.getElementById('kbFetchBtn');
  const kbReader = document.getElementById('kbReader');
  const kbReaderTitle = document.getElementById('kbReaderTitle');
  const kbReaderBody = document.getElementById('kbReaderBody');
  const kbReaderClose = document.getElementById('kbReaderClose');
  const kbReaderMore = document.getElementById('kbReaderMore');

  let kbToken = '';
  try { kbToken = localStorage.getItem(KB_TOKEN_KEY) || ''; } catch (e) {}
  let kbReaderState = null;
  let kbBusy = false;

  function kbAttr(v) {
    return String(v == null ? '' : v)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#39;');
  }

  // 阅读器展示时剥掉 save_doc 写入的 frontmatter（--- title/saved_at ---），
  // 只在 offset=0 时处理：后续翻页仍按原始字符偏移推进，保证与检索命中的 offset 对齐。
  function kbStripFrontmatter(text) {
    const s = String(text || '');
    const m = /^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?/.exec(s);
    return m ? s.slice(m[0].length) : s;
  }

  function kbHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (kbToken) h['X-Kb-Admin-Token'] = kbToken;
    if (accessToken) h['X-Access-Token'] = accessToken;
    return h;
  }

  async function kbApi(path, options) {
    const opt = options || {};
    const init = { method: opt.method || 'GET', headers: kbHeaders() };
    if (opt.body) init.body = JSON.stringify(opt.body);
    try {
      const res = await fetch('/api/kb/' + path, init);
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: !!(res.ok && data && data.ok), status: res.status, data: data || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { error: '网络请求失败：' + (e && e.message ? e.message : String(e)) } };
    }
  }

  function kbRenderStats(st) {
    if (!kbStatsEl) return;
    if (!st || !st.ok) {
      kbStatsEl.innerHTML = '<span style="color:#dc2626;">⚠️ 知识库状态读取失败' + (st && st.data && st.data.error ? '：' + escapeHtml(st.data.error) : '') + '</span>';
      return;
    }
    const chars = Math.max(1, Math.round((st.chars || 0) / 1000));
    const writeText = st.canWrite
      ? '网页写入已解锁'
      : (st.writeLocked
        ? '网页写入未启用（未配置 KB_ADMIN_SECRET，可用机器人写入）'
        : '网页写入未解锁（在下方填写管理员密钥后重试）');
    let html = '<b>📄 ' + (st.docs || 0) + ' 篇文档 · 🧩 ' + (st.chunks || 0) + ' 个检索块 · ✍️ 约 ' + chars + ' 千字</b>';
    html += '<div class="kb-stats-sub">'
      + (st.r2 ? 'R2 已接通' : '⚠️ R2 未绑定，知识库不可用')
      + ' · 分块 ' + (st.chunkSize || 700) + ' 字/块'
      + ' · 检索默认 ' + (st.topK || 6) + ' 段'
      + ' · 预检索' + (st.preRetrieve ? '已开启' : '已关闭')
      + ' · ' + writeText
      + '</div>';
    kbStatsEl.innerHTML = html;
  }

  function kbRenderList(docs, total) {
    if (!kbDocList) return;
    if (kbListTitle) kbListTitle.textContent = '文档列表（' + (total || 0) + '）';
    if (!docs || !docs.length) {
      kbDocList.innerHTML = '<div class="kb-empty">知识库还是空的：展开下方「新建 / 导入文档」，粘贴正文或选择文件即可入库。</div>';
      return;
    }
    const rows = docs.map(function (d) {
      const meta = [d.sizeText, (d.updatedAt || '').slice(0, 10) || '—'];
      if (d.source) meta.push(d.source.slice(0, 46));
      return '<div class="kb-doc-row">'
        + '<div class="kb-doc-main">'
        + '<div class="kb-doc-title">' + escapeHtml(d.title) + '</div>'
        + '<div class="kb-doc-meta">' + escapeHtml(meta.join(' · ')) + '</div>'
        + '</div>'
        + '<div class="kb-doc-acts">'
        + '<button type="button" class="btn kb-open" data-file="' + kbAttr(d.file) + '">查看</button>'
        + '<button type="button" class="btn danger kb-del" data-file="' + kbAttr(d.file) + '" data-title="' + kbAttr(d.title) + '">删除</button>'
        + '</div></div>';
    });
    kbDocList.innerHTML = rows.join('');
    kbDocList.querySelectorAll('.kb-open').forEach(function (btn) {
      btn.addEventListener('click', function () { kbOpenDoc(btn.getAttribute('data-file'), 0); });
    });
    kbDocList.querySelectorAll('.kb-del').forEach(function (btn) {
      btn.addEventListener('click', function () { kbDeleteDoc(btn.getAttribute('data-file'), btn.getAttribute('data-title')); });
    });
  }

  function kbRenderHits(hits, tookMs) {
    if (!kbSearchResults) return;
    kbSearchResults.style.display = 'block';
    if (!hits || !hits.length) {
      kbSearchResults.innerHTML = '<div class="kb-empty">没有检索到相关内容。换个更具体的关键词，或先确认文档是否已入库。</div>';
      return;
    }
    const head = '<div class="kb-hits-head">命中 ' + hits.length + ' 段' + (tookMs ? ' · ' + tookMs + 'ms' : '') + '</div>';
    const body = hits.map(function (h, i) {
      return '<div class="kb-hit">'
        + '<div class="kb-hit-head"><span class="kb-hit-title">' + (i + 1) + '. 《' + escapeHtml(h.title) + '》</span>'
        + '<span class="kb-hit-score">相关度 ' + Math.round((h.rel || 0) * 100) + '% · offset ' + h.offset + '</span></div>'
        + '<div class="kb-hit-body">' + escapeHtml(h.snippet || '') + '</div>'
        + '<button type="button" class="btn kb-hit-open" data-file="' + kbAttr(h.file) + '" data-offset="' + (h.offset || 0) + '">在原文中查看</button>'
        + '</div>';
    });
    kbSearchResults.innerHTML = head + body.join('');
    kbSearchResults.querySelectorAll('.kb-hit-open').forEach(function (btn) {
      btn.addEventListener('click', function () {
        kbOpenDoc(btn.getAttribute('data-file'), parseInt(btn.getAttribute('data-offset'), 10) || 0);
      });
    });
  }

  async function kbLoadStats() {
    const r = await kbApi('stats');
    kbRenderStats(Object.assign({ ok: r.ok }, r.data));
  }

  async function kbLoadList() {
    if (kbDocList) kbDocList.innerHTML = '正在加载…';
    const r = await kbApi('list?limit=100');
    if (!r.ok) {
      if (kbDocList) kbDocList.innerHTML = '<div class="kb-empty" style="color:#dc2626;">加载失败：' + escapeHtml(r.data.error || ('HTTP ' + r.status)) + '</div>';
      return;
    }
    kbRenderList(r.data.docs, r.data.total);
  }

  async function kbRefreshAll() {
    await Promise.all([kbLoadStats(), kbLoadList()]);
  }

  async function kbDoSearch() {
    if (!kbSearchInput) return;
    const q = kbSearchInput.value.trim();
    if (!q) {
      if (kbSearchResults) kbSearchResults.style.display = 'none';
      return;
    }
    if (kbSearchBtn) { kbSearchBtn.disabled = true; kbSearchBtn.textContent = '检索中…'; }
    const r = await kbApi('search', { method: 'POST', body: { query: q, top_k: 8 } });
    if (kbSearchBtn) { kbSearchBtn.disabled = false; kbSearchBtn.textContent = '🔍 检索'; }
    if (!r.ok) {
      if (kbSearchResults) {
        kbSearchResults.style.display = 'block';
        kbSearchResults.innerHTML = '<div class="kb-empty" style="color:#dc2626;">' + escapeHtml(r.data.error || '检索失败') + '</div>';
      }
      return;
    }
    kbRenderHits(r.data.hits, r.data.tookMs);
  }

  async function kbOpenDoc(file, offset) {
    if (!file || !kbReader) return;
    kbReader.style.display = 'block';
    kbReaderState = { file: file, offset: offset || 0, total: 0, title: '' };
    kbReaderBody.textContent = '正在读取…';
    if (kbReaderMore) kbReaderMore.style.display = 'none';
    const r = await kbApi('doc?file=' + encodeURIComponent(file) + '&offset=' + (offset || 0) + '&limit=12000');
    if (!r.ok) {
      kbReaderBody.textContent = '读取失败：' + (r.data.error || ('HTTP ' + r.status));
      return;
    }
    kbReaderState.total = r.data.total || 0;
    kbReaderState.title = (r.data.doc && r.data.doc.title) || file;
    kbReaderState.offset = (r.data.offset || 0) + (r.data.content || '').length;
    if (kbReaderTitle) {
      kbReaderTitle.textContent = '📖 ' + kbReaderState.title + '（全文 ' + kbReaderState.total + ' 字符）';
    }
    const rawContent = r.data.content || '';
    kbReaderBody.textContent = ((offset || 0) === 0 ? kbStripFrontmatter(rawContent) : rawContent) || '（空文档）';
    if (kbReaderMore) kbReaderMore.style.display = r.data.hasMore ? 'inline-block' : 'none';
    if (kbReader.scrollIntoView) { try { kbReader.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  async function kbReaderLoadMore() {
    if (!kbReaderState || !kbReaderState.file) return;
    if (kbReaderMore) { kbReaderMore.disabled = true; kbReaderMore.textContent = '加载中…'; }
    const r = await kbApi('doc?file=' + encodeURIComponent(kbReaderState.file) + '&offset=' + kbReaderState.offset + '&limit=12000');
    if (kbReaderMore) { kbReaderMore.disabled = false; kbReaderMore.textContent = '加载更多'; }
    if (!r.ok) return;
    kbReaderState.offset = (r.data.offset || 0) + (r.data.content || '').length;
    kbReaderBody.textContent = kbReaderBody.textContent + (r.data.content || '');
    if (kbReaderMore) kbReaderMore.style.display = r.data.hasMore ? 'inline-block' : 'none';
  }

  async function kbDeleteDoc(file, title) {
    if (!file) return;
    if (!window.confirm('确定删除知识库文档《' + (title || file) + '》？此操作不可撤销。')) return;
    const r = await kbApi('delete', { method: 'POST', body: { file: file } });
    if (!r.ok) {
      window.alert('删除失败：' + (r.data.error || ('HTTP ' + r.status)));
      return;
    }
    if (kbReaderState && kbReaderState.file === file && kbReader) kbReader.style.display = 'none';
    await kbRefreshAll();
  }

  async function kbSaveDoc() {
    if (kbBusy) return;
    const title = kbTitleInput ? kbTitleInput.value.trim() : '';
    const content = kbContentInput ? kbContentInput.value : '';
    const source = kbSourceInput ? kbSourceInput.value.trim() : '';
    if (!title) { window.alert('请先填写标题'); return; }
    if (!content.trim()) { window.alert('请粘贴正文或先选择文件'); return; }
    kbBusy = true;
    if (kbSaveBtn) { kbSaveBtn.disabled = true; kbSaveBtn.textContent = '保存中…'; }
    const r = await kbApi('save', { method: 'POST', body: { title: title, content: content, source: source } });
    kbBusy = false;
    if (kbSaveBtn) { kbSaveBtn.disabled = false; kbSaveBtn.textContent = '💾 保存到知识库'; }
    window.alert(r.ok ? (r.data.message || '已保存') : ('保存失败：' + (r.data.error || ('HTTP ' + r.status))));
    if (r.ok) {
      if (kbTitleInput) kbTitleInput.value = '';
      if (kbSourceInput) kbSourceInput.value = '';
      if (kbContentInput) kbContentInput.value = '';
      if (kbFileInput) kbFileInput.value = '';
      await kbRefreshAll();
    }
  }

  async function kbFetchUrl() {
    const url = kbSourceInput ? kbSourceInput.value.trim() : '';
    if (!url) { window.alert('请先在上方「来源链接」填入要抓取的网址'); return; }
    if (kbFetchBtn) { kbFetchBtn.disabled = true; kbFetchBtn.textContent = '抓取中…'; }
    const r = await kbApi('fetch', { method: 'POST', body: { url: url, title: kbTitleInput ? kbTitleInput.value.trim() : '' } });
    if (kbFetchBtn) { kbFetchBtn.disabled = false; kbFetchBtn.textContent = '📥 从链接抓取入库'; }
    window.alert(r.ok ? (r.data.message || '已入库') : ('抓取入库失败：' + (r.data.error || ('HTTP ' + r.status))));
    if (r.ok) await kbRefreshAll();
  }

  async function kbReindex() {
    if (kbReindexBtn) { kbReindexBtn.disabled = true; kbReindexBtn.textContent = '重建中…'; }
    const r = await kbApi('reindex', { method: 'POST', body: {} });
    if (kbReindexBtn) { kbReindexBtn.disabled = false; kbReindexBtn.textContent = '重建索引'; }
    window.alert(r.ok ? (r.data.message || '索引已重建') : ('重建失败：' + (r.data.error || ('HTTP ' + r.status))));
    if (r.ok) await kbRefreshAll();
  }

  function kbOpenModal() {
    if (!kbModal) return;
    if (kbAdminTokenInput && !kbAdminTokenInput.value && kbToken) kbAdminTokenInput.value = kbToken;
    kbModal.style.display = 'flex';
    setTimeout(function () { kbModal.classList.add('active'); }, 10);
    kbRefreshAll();
  }

  function kbCloseModal() {
    if (!kbModal) return;
    if (kbAdminTokenInput) {
      kbToken = kbAdminTokenInput.value.trim();
      try {
        if (kbToken) localStorage.setItem(KB_TOKEN_KEY, kbToken);
        else localStorage.removeItem(KB_TOKEN_KEY);
      } catch (e) {}
    }
    kbModal.classList.remove('active');
    setTimeout(function () { kbModal.style.display = 'none'; }, 300);
  }

  if (kbModalToggle) kbModalToggle.addEventListener('click', kbOpenModal);
  if (closeKbModalBtn) closeKbModalBtn.addEventListener('click', kbCloseModal);
  if (kbModal) {
    kbModal.addEventListener('click', function (e) { if (e.target === kbModal) kbCloseModal(); });
  }
  if (kbSearchBtn) kbSearchBtn.addEventListener('click', kbDoSearch);
  if (kbSearchInput) {
    kbSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); kbDoSearch(); }
    });
  }
  if (kbRefreshBtn) kbRefreshBtn.addEventListener('click', function () { kbRefreshAll(); });
  if (kbReindexBtn) kbReindexBtn.addEventListener('click', kbReindex);
  if (kbSaveBtn) kbSaveBtn.addEventListener('click', kbSaveDoc);
  if (kbFetchBtn) kbFetchBtn.addEventListener('click', kbFetchUrl);
  if (kbReaderClose) {
    kbReaderClose.addEventListener('click', function () {
      if (kbReader) kbReader.style.display = 'none';
      kbReaderState = null;
    });
  }
  if (kbReaderMore) kbReaderMore.addEventListener('click', kbReaderLoadMore);
  if (kbAdminTokenInput) {
    kbAdminTokenInput.addEventListener('change', function () {
      kbToken = kbAdminTokenInput.value.trim();
      try {
        if (kbToken) localStorage.setItem(KB_TOKEN_KEY, kbToken);
        else localStorage.removeItem(KB_TOKEN_KEY);
      } catch (e) {}
      kbLoadStats();
    });
  }

  // 选择本地文件 → 读入正文（.html 由服务端抽取正文，其余按纯文本原样入库）
  if (kbFileInput) {
    kbFileInput.addEventListener('change', function () {
      const f = kbFileInput.files && kbFileInput.files[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) { window.alert('文件超过 4MB，请拆分后再导入'); kbFileInput.value = ''; return; }
      const reader = new FileReader();
      reader.onload = function () {
        if (kbContentInput) kbContentInput.value = String(reader.result || '');
        if (kbTitleInput && !kbTitleInput.value.trim()) {
          kbTitleInput.value = f.name.replace(/\\.[^.]+$/, '');
        }
        if (kbSourceInput && !kbSourceInput.value.trim()) kbSourceInput.value = '';
      };
      reader.readAsText(f, 'utf-8');
    });
  }

`;
