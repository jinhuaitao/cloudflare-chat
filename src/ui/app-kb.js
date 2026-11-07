// 网页端「📚 知识库」只读面板
//
// 为什么需要它：知识库文档全部落在 R2 的 kb/docs/ 下，写入入口只有 Telegram 与微信 ClawBot。
// 网页端此前既不能写、也没有任何查看入口，用户只能靠 Agent 在对话里"说"库里有几篇 ——
// 一旦模型答错（或压根没存进去），用户无从核对，于是就有了"提示已保存、知识库里却没有"。
// 这里给一个只读清单：标题 / 大小 / 时间 / 标签，数据来自 GET /api/kb/list，
// 服务端会顺带核对索引与实际文件，所以它显示的就是 R2 里真实存在的文档。
export default `  // ===== 知识库只读面板（📚） =====
  const kbModal = document.getElementById('kbModal');
  const kbModalToggle = document.getElementById('kbModalToggle');
  const kbCloseBtn = document.getElementById('kbCloseBtn');
  const kbRefreshBtn = document.getElementById('kbRefreshBtn');
  const kbListBox = document.getElementById('kbListBox');

  function kbFmtBytes(b) {
    const n = Number(b) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function kbFmtDay(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function kbRenderNote(msg, color) {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;font-size:11.5px;line-height:1.6;color:' + (color || 'var(--muted)') + ';';
    box.textContent = msg;
    kbListBox.appendChild(box);
  }

  function kbRenderMsg(msg) {
    kbListBox.innerHTML = '';
    const p = document.createElement('div');
    p.style.cssText = 'color:var(--text-2);';
    p.textContent = msg;
    kbListBox.appendChild(p);
  }

  function kbRenderRow(doc, idx) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:9px 0;border-bottom:1px dashed var(--border);';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;word-break:break-all;';
    title.textContent = (idx + 1) + '. ' + doc.title;
    row.appendChild(title);

    const bits = [kbFmtBytes(doc.size)];
    const day = kbFmtDay(doc.updated_at);
    if (day) bits.push(day);
    if (doc.chars) bits.push(doc.chars + ' 字符');
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:11.5px;color:var(--muted);margin-top:2px;';
    meta.textContent = bits.join(' · ');
    row.appendChild(meta);

    if (doc.tags && doc.tags.length) {
      const tag = document.createElement('div');
      tag.style.cssText = 'font-size:11.5px;color:var(--brand-color);margin-top:2px;';
      tag.textContent = '🏷 ' + doc.tags.join('、');
      row.appendChild(tag);
    }
    return row;
  }

  async function kbLoadList() {
    if (!kbListBox) return;
    kbRenderMsg('正在读取知识库…');
    const headers = {};
    if (accessToken) headers['X-Access-Token'] = accessToken;
    try {
      const res = await fetch('/api/kb/list', { headers: headers, cache: 'no-store' });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data || data.ok !== true) {
        kbRenderMsg('⚠️ 读取知识库失败：' + ((data && data.error) || ('HTTP ' + res.status)));
        return;
      }
      if (data.r2Bound === false) {
        kbRenderMsg('⚠️ 服务端未绑定 R2 存储桶，知识库无法持久化。请在 Cloudflare 控制台绑定 R2 后重新部署。');
        return;
      }
      if (!data.docs || !data.docs.length) {
        kbRenderMsg('知识库当前为空。在 Telegram 或微信 ClawBot 里上传文件（附言「存进知识库」）或发送 /savekb 即可入库，存完点「刷新」即可在这里看到。');
        return;
      }
      kbListBox.innerHTML = '';
      const head = document.createElement('div');
      head.style.cssText = 'font-weight:600;margin-bottom:4px;';
      head.textContent = '共 ' + data.count + ' 篇'
        + (data.docs.length < data.count ? '（按更新时间显示最近 ' + data.docs.length + ' 篇）' : '');
      kbListBox.appendChild(head);
      data.docs.forEach(function (d, i) { kbListBox.appendChild(kbRenderRow(d, i)); });
      if (data.repaired > 0) {
        kbRenderNote('🔧 索引与实际文件不一致，已按文件自动修复，补回 ' + data.repaired + ' 篇此前未列出的文档。', '#b45309');
      }
      kbRenderNote('💡 网页端只读。需要读取正文时直接在对话里问「读一下《标题》」，或到 Telegram / 微信端发送 /readdoc。');
    } catch (e) {
      kbRenderMsg('⚠️ 读取知识库失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  function kbOpenModal() {
    if (!kbModal) return;
    kbModal.style.display = 'flex';
    setTimeout(function () { kbModal.classList.add('active'); }, 10);
    kbLoadList();
  }

  function kbCloseModal() {
    if (!kbModal) return;
    kbModal.classList.remove('active');
    setTimeout(function () { kbModal.style.display = 'none'; }, 300);
  }

  if (kbModalToggle) kbModalToggle.addEventListener('click', kbOpenModal);
  if (kbCloseBtn) kbCloseBtn.addEventListener('click', kbCloseModal);
  if (kbRefreshBtn) kbRefreshBtn.addEventListener('click', kbLoadList);
  if (kbModal) {
    kbModal.addEventListener('click', function (e) { if (e.target === kbModal) kbCloseModal(); });
  }

`;
