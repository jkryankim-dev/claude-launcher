'use strict';
/* global api, ChatUI, TermUI, FMT, MD */
// 작업 공간: 왼쪽 사이드바(지난 대화) · 가운데(탭 줄 + 채팅/터미널/기록 보기) · 오른쪽 패널(위임 현황·조직도).
// 탭 줄(#tabs)을 여기서 그린다(채팅 탭과 터미널 탭이 같은 줄에 공존).
window.WS = (() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls) => { const d = document.createElement(tag); if (cls) d.className = cls; return d; };
  const md = t => (window.MD ? MD.renderMarkdown(t) : esc(t));
  const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const hasApi = n => typeof api[n] === 'function';
  const LS = { side: 'ws.side', panel: 'ws.panel', project: 'ws.project' };
  const RUN_ICON = { running: '◐', done: '✓', failed: '✕', stopped: '■', timeout: '⏱', unknown: '?' };
  const RUN_STATE = { running: '실행 중', done: '완료', failed: '실패', stopped: '중단', timeout: '시간 초과', unknown: '알 수 없음' };
  const NARROW_SIDE = () => window.matchMedia('(max-width: 639.98px)').matches;
  const NARROW_PANEL = () => window.matchMedia('(max-width: 899.98px)').matches;

  let deps = null;
  const st = {
    ready: false,
    view: 'projects',
    projectId: null,
    tabs: [],          // [{ key: 'chat:<id>'|'term:<sid>', kind, id }]
    active: null,
    hist: null,        // { projectId, sessionId, title, messages, loaded, total, truncated, err, loading }
    sessions: [],
    sessionsErr: '',
    search: { q: '', timer: 0, hits: null },
    panelTab: 'runs',
    runs: null,        // null = 아직 못 읽음, [] = 목록
    runsWatching: null,
    runsDetail: null,  // { kind: 'run'|'agent', id|key, data }
    org: null, orgView: 'tree', orgDetail: null,
    sideCollapsed: false, panelCollapsed: false,
  };

  const cur = () => (deps ? deps.projects().find(p => p.id === st.projectId) : null);
  const canChat = () => hasApi('chatOpen') && hasApi('onChatEvent') && hasApi('chatSend');
  const histKey = () => (st.hist ? `hist:${st.hist.projectId}:${st.hist.sessionId}` : 'hist:\0');

  // ── 화면 전환(프로젝트 목록 ↔ 작업 공간)
  function setView(v) {
    if (v !== 'projects' && v !== 'workspace') v = 'projects';
    st.view = v;
    $('#view-projects').hidden = v !== 'projects';
    $('#workspace').hidden = v !== 'workspace';
    $$('#view-switch [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    if (v === 'workspace') {
      if (!st.projectId) refreshProjects();
      refit();
      refreshSessions(true);
      refreshRuns();
      if (st.panelTab === 'org' && !st.org) refreshOrg();
    }
  }
  function refit() { requestAnimationFrame(() => { if (st.view === 'workspace') TermUI.fitActive(); }); }

  // ── 프로젝트
  function refreshProjects() {
    if (!st.ready) return;
    const ps = deps.projects();
    if (!ps.length) { st.projectId = null; renderProjSelect(); renderSideList(); return; }
    if (!st.projectId || !ps.some(p => p.id === st.projectId)) {
      const remembered = localStorage.getItem(LS.project);
      setProject(ps.some(p => p.id === remembered) ? remembered : ps[0].id, true);
      return;
    }
    renderProjSelect();
  }
  function setProject(id, remember = true) {
    const ps = deps.projects();
    if (!ps.some(p => p.id === id)) id = ps.length ? ps[0].id : null;
    st.projectId = id;
    if (remember && id) { try { localStorage.setItem(LS.project, id); } catch { /* 저장 거부 */ } }
    st.search = { q: '', timer: 0, hits: null };
    const search = $('#ws-search');
    if (search) search.value = '';
    st.sessions = [];
    st.sessionsErr = '';
    st.runs = null;
    st.runsDetail = null;
    st.org = null;
    st.orgDetail = null;
    renderProjSelect();
    renderSideList();
    watchRuns();
    refreshSessions(true);
    refreshRuns();
    if (st.panelTab === 'org') refreshOrg(); else renderPanel();
  }
  function renderProjSelect() {
    const sel = $('#ws-project');
    if (!sel) return;
    const ps = deps.projects();
    sel.innerHTML = ps.map(p => `<option value="${esc(p.id)}"${p.id === st.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    sel.disabled = !ps.length;
    const p = cur();
    const dot = $('#ws-pdot');
    if (dot) dot.className = `dot ${p ? esc(p.mode) : 'split'}`;
    const menu = $('#ws-new-menu');
    if (menu) {
      const chatOk = canChat() && !(p && p.remote);
      $('[data-k="chat"]', menu).hidden = !chatOk;
    }
  }

  // ── 사이드바: 지난 대화 목록
  async function refreshSessions(quiet) {
    if (!st.ready || !st.projectId) return;
    if (st.search.hits) return; // 검색 결과를 보여 주는 중에는 바꾸지 않는다
    if (typeof api.historyList !== 'function') { renderSideList(); return; }
    const p = cur();
    if (p && p.remote) { renderSideList(); return; }
    const listEl = $('#ws-list');
    const top = quiet && listEl ? listEl.scrollTop : 0;
    let r;
    try { r = await api.historyList(st.projectId, { limit: 50 }); }
    catch (e) { st.sessionsErr = deps.errMsg(e); renderSideList(); return; }
    if (!r || !r.ok) { st.sessionsErr = (r && r.error) || '대화 기록을 읽지 못했습니다'; renderSideList(); return; }
    st.sessionsErr = '';
    st.sessions = Array.isArray(r.sessions) ? r.sessions : [];
    renderSideList();
    if (quiet && listEl) listEl.scrollTop = top;
  }
  function renderSideList() {
    const box = $('#ws-list');
    if (!box) return;
    const top = box.scrollTop; // 조용히 다시 그릴 때 스크롤 유지
    if (st.search.hits) { box.innerHTML = searchHTML(); box.scrollTop = top; return; }
    if (!st.projectId) { box.innerHTML = '<p class="muted side-note">프로젝트 목록에서 폴더를 추가하세요</p>'; return; }
    const p = cur();
    if (p && p.remote) { box.innerHTML = '<p class="muted side-note">원격 프로젝트의 대화 기록은 아직 표시하지 않습니다</p>'; return; }
    if (!hasApi('historyList')) { box.innerHTML = '<p class="muted side-note">이 앱 버전에서는 대화 기록을 표시할 수 없습니다</p>'; return; }
    if (st.sessionsErr) { box.innerHTML = `<p class="form-err">${esc(st.sessionsErr)}</p>`; return; }
    if (!st.sessions.length) { box.innerHTML = '<p class="muted side-note">지난 대화가 없습니다. 새 대화를 시작해 보세요</p>'; return; }
    const now = Date.now();
    const views = ChatUI.views();
    const open = new Set(views.map(v => v.sessionId).filter(Boolean));
    const busy = new Set(views.filter(v => v.busy).map(v => v.sessionId));
    const pend = new Set(views.filter(v => v.pending > 0).map(v => v.sessionId));
    let html = '';
    for (const g of FMT.sessionGroups(st.sessions, now)) {
      html += `<div class="s-group">${esc(g.label)}</div>`;
      for (const s of g.items) {
        const isCur = open.has(s.id) || (st.hist != null && st.hist.sessionId === s.id && st.hist.projectId === st.projectId);
        html += `<button type="button" class="s-item${isCur ? ' cur' : ''}" data-sid="${esc(s.id)}" title="${esc(s.title)}">`
          + `<span class="s-title">${esc(s.title)}</span>`
          + `<span class="s-meta">${busy.has(s.id) ? '<i class="s-busy" title="응답 중"></i>' : ''}${pend.has(s.id) ? '<i class="s-pend" title="권한 대기 중"></i>' : ''}`
          + `${esc(FMT.relTime(s.updatedAt, now))} · ${s.messages || 0}개 · ${esc(FMT.shortModel(s.model) || '')}</span></button>`;
      }
    }
    box.innerHTML = html;
    box.scrollTop = top;
  }
  function markSnippet(text) {
    const q = st.search.q.toLowerCase();
    const out = esc(text);
    if (!q) return out;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return out.replace(re, m => `<mark>${m}</mark>`);
  }
  function searchHTML() {
    if (!st.search.hits.length) return '<p class="muted side-note">일치하는 대화가 없습니다</p>';
    const now = Date.now();
    return st.search.hits.map(h => `<button type="button" class="s-item hit" data-sid="${esc(h.id)}" title="${esc(h.title)}">`
      + `<span class="s-title">${markSnippet(h.title)}</span>`
      + `<span class="s-meta">${markSnippet(h.snippet)} · ${esc(FMT.relTime(h.updatedAt, now))}</span></button>`).join('');
  }
  function onSearchInput() {
    const q = $('#ws-search').value.trim();
    clearTimeout(st.search.timer);
    if (q.length < 2) { st.search.q = ''; st.search.hits = null; renderSideList(); return; }
    st.search.timer = setTimeout(() => runSearch(q), 300);
  }
  async function runSearch(q) {
    if (!st.projectId || !hasApi('historySearch')) return;
    st.search.q = q;
    let r;
    try { r = await api.historySearch(st.projectId, q); } catch { return; }
    if (st.search.q !== q) return;
    st.search.hits = r && r.ok && Array.isArray(r.hits) ? r.hits : [];
    renderSideList();
  }

  // ── 새 대화
  function newSession(kind) {
    const p = cur();
    if (!p) { deps.toast('프로젝트를 먼저 추가하세요', 'warn'); return; }
    const k = kind || (p.openWith === 'chat' && canChat() ? 'chat' : 'term');
    if (k === 'chat') openChat(p);
    else openTerm(p);
  }
  function openChat(p) {
    if (!canChat()) { deps.toast('이 앱 버전에서는 채팅을 지원하지 않습니다 (앱 업데이트 필요)', 'warn'); return; }
    ChatUI.open(p);
  }
  function openTerm(p, resume) {
    TermUI.open(p, resume ? { resume } : {});
  }

  // ── 탭 줄
  function ensureTab(kind, id) {
    const key = `${kind}:${id}`;
    if (!st.tabs.some(t => t.key === key)) st.tabs.push({ key, kind, id });
    return key;
  }
  function renderTabs() {
    const strip = $('#tabs');
    if (!strip) return;
    const chatsById = new Map(ChatUI.views().map(v => [v.id, v]));
    const termsBySid = new Map(TermUI.tabs().map(t => [t.sid, t]));
    const parts = [];
    for (const t of st.tabs) {
      if (t.kind === 'chat') {
        const v = chatsById.get(t.id);
        if (!v) continue;
        parts.push(`<button type="button" class="tab chat-tab ${esc(v.mode)}${st.active === t.key ? ' on' : ''}" data-tab="${esc(t.key)}" title="${esc(v.title || '새 대화')}">`
          + `<i class="dot ${esc(v.mode)}"></i><span class="tl">${esc(v.title || '새 대화')}</span>`
          + (v.pending > 0 ? '<i class="tab-pend" title="권한 대기 중"></i>' : '')
          + (v.busy ? '<i class="tab-busy" title="응답 중"></i>' : '')
          + `<span class="x" data-close="${esc(t.key)}" title="탭 닫기">×</span></button>`);
      } else {
        const v = termsBySid.get(t.id);
        if (!v) continue;
        parts.push(`<button type="button" class="tab term-tab ${esc(v.mode)}${st.active === t.key ? ' on' : ''}${v.alive ? '' : ' ended'}" data-tab="${esc(t.key)}" title="${esc(v.title || v.name)}">`
          + `<i class="dot ${esc(v.mode)}"></i><span class="tl">${esc(v.name)}</span>`
          + `<span class="x" data-close="${esc(t.key)}" title="탭 닫기">×</span></button>`);
      }
    }
    parts.push('<button type="button" class="tab add-tab" data-new="1" title="새 대화" aria-label="새 대화">＋</button>');
    strip.innerHTML = parts.join('');
    $('#ws-empty').hidden = !!st.active;
  }
  function setActive(key) {
    st.active = key || null;
    ChatUI.show(st.active && st.active.startsWith('chat:') ? st.active.slice(5) : null);
    const termSid = st.active && st.active.startsWith('term:') ? st.active.slice(5) : null;
    TermUI.show(termSid);
    $('#view-term').hidden = !termSid;
    $('#hist-view').hidden = st.active !== histKey();
    $('#ws-empty').hidden = !!st.active;
    renderTabs();
    refit();
  }
  function pickNextActive(fromIdx) {
    if (!st.tabs.length) { setActive(null); return; }
    const i = Math.max(0, Math.min(fromIdx != null ? fromIdx : st.tabs.length - 1, st.tabs.length - 1));
    setActive(st.tabs[i].key);
  }
  function cycle(d) {
    if (!st.tabs.length) return;
    const i = st.tabs.findIndex(t => t.key === st.active);
    setView('workspace');
    setActive(st.tabs[(i + d + st.tabs.length) % st.tabs.length].key);
  }
  async function closeTab(key) {
    if (key.startsWith('chat:')) { await ChatUI.close(key.slice(5)); return; } // ChatUI가 removeChat으로 정리
    if (key.startsWith('term:')) { await TermUI.close(key.slice(5)); return; } // onTabs → syncTerms가 정리
    if (key === histKey()) { st.hist = null; st.active = null; pickNextActive(); }
  }
  function removeTabKey(key, wasActive) {
    const idx = st.tabs.findIndex(t => t.key === key);
    if (idx >= 0) st.tabs.splice(idx, 1);
    if (wasActive) pickNextActive(idx);
    else renderTabs();
  }
  function syncTerms() {
    const live = new Map(TermUI.tabs().map(t => [t.sid, t]));
    st.tabs = st.tabs.filter(t => t.kind !== 'term' || live.has(t.id));
    for (const sid of live.keys()) ensureTab('term', sid);
    if (st.active && st.active.startsWith('term:') && !live.has(st.active.slice(5))) pickNextActive();
    else renderTabs();
  }
  function addChat(id) {
    ensureTab('chat', id);
    setView('workspace');
    setActive(`chat:${id}`);
  }
  function removeChat(id) { removeTabKey(`chat:${id}`, st.active === `chat:${id}`); }
  function onTermActivate(sid) {
    const t = TermUI.tabs().find(x => x.sid === sid);
    if (t && t.projectId) setProject(t.projectId);
    ensureTab('term', sid);
    setView('workspace');
    setActive(`term:${sid}`);
  }
  function onTermRestore(sid) {
    if (!sid || !TermUI.tabs().some(t => t.sid === sid)) { renderTabs(); return; }
    ensureTab('term', sid);
    setView('workspace');
    setActive(`term:${sid}`);
  }
  function chatState() {
    renderTabs();
    renderSideList();
    updateTitle();
  }
  function onChatResult() { refreshSessions(true); }

  // ── 기록 보기(읽기 전용)
  async function openHistory(projectId, sessionId, title) {
    setProject(projectId);
    setView('workspace');
    st.hist = { projectId, sessionId, title: title || '', messages: [], loaded: 0, total: 0, truncated: false, err: '', loading: false };
    setActive(histKey());
    await loadHistory(true);
  }
  async function loadHistory(first) {
    const h = st.hist;
    if (!h || h.loading) return;
    if (!hasApi('historyRead')) { h.err = '이 앱 버전에서는 대화 기록을 읽을 수 없습니다'; renderHist(); return; }
    h.loading = true;
    try {
      const limit = h.loaded ? h.loaded + 200 : 200;
      let r;
      try { r = await api.historyRead(h.projectId, h.sessionId, { limit, tail: true }); }
      catch (e) { h.err = deps.errMsg(e); renderHist(); return; }
      if (st.hist !== h) return;
      if (!r || !r.ok) { h.err = (r && r.error) || '대화를 읽지 못했습니다'; renderHist(); return; }
      h.err = '';
      const body0 = $('#hist-body');
      const prevH = body0 ? body0.scrollHeight : 0;
      const prevTop = body0 ? body0.scrollTop : 0;
      h.messages = Array.isArray(r.messages) ? r.messages : [];
      h.loaded = h.messages.length;
      h.total = r.total || h.loaded;
      h.truncated = !!r.truncated;
      renderHist();
      const body = $('#hist-body');
      if (body) body.scrollTop = first ? body.scrollHeight : prevTop + (body.scrollHeight - prevH);
    } finally {
      h.loading = false;
    }
  }
  function renderHist() {
    const h = st.hist;
    const view = $('#hist-view');
    if (!h || !view) return;
    const p = deps.projects().find(x => x.id === h.projectId);
    view.innerHTML = `
<div class="hist-head">
<button type="button" class="icon-btn" data-h="close" aria-label="기록 보기 닫기" title="닫기">✕</button>
<div class="hist-title"><b></b><span class="muted"></span></div>
<div class="hist-actions">
<button type="button" class="btn sm" data-h="resume-chat"${canChat() && p && !p.remote ? '' : ' hidden'}>채팅으로 이어하기</button>
<button type="button" class="btn sm" data-h="resume-term">터미널로 이어하기</button>
</div>
</div>
<div class="hist-body" id="hist-body">
<button type="button" class="hist-more" data-h="more"${h.truncated ? '' : ' hidden'}>이전 내용 더 보기</button>
${h.err ? `<p class="form-err">${esc(h.err)}</p>` : ''}
${!h.err && !h.loaded ? '<p class="muted side-note">불러오는 중…</p>' : ''}
</div>`;
    $('.hist-title b', view).textContent = h.title || '(제목 없음)';
    $('.hist-title .muted', view).textContent = `${h.loaded}개 메시지 · 세션 ${String(h.sessionId || '').slice(0, 8)}`;
    const body = $('#hist-body', view);
    for (const m of h.messages) body.appendChild(histMsg(m));
    const more = $('.hist-more', view);
    if (more) more.textContent = `이전 내용 더 보기${h.total ? ` (전체 ${h.total}개 중 ${h.loaded}개)` : ''}`;
    body.addEventListener('scroll', () => { // scroll 이벤트는 버블링되지 않아 대상에 직접 건다
      if (body.scrollTop < 40 && st.hist && st.hist.truncated) loadHistory(false);
    });
  }
  function histMsg(m) {
    if (m.role === 'user') {
      const d = el('div', 'msg user');
      const b = el('div', 'bubble');
      const s = el('span', 'u-text');
      s.textContent = m.text || '';
      b.appendChild(s);
      d.appendChild(b);
      return d;
    }
    const d = el('div', 'msg ai');
    const b = el('div', 'bubble md');
    b.innerHTML = md(m.text || '');
    d.appendChild(b);
    const tools = Array.isArray(m.tools) ? m.tools : [];
    if (tools.length) {
      const line = el('div', 'tools-line');
      for (const t of tools) {
        const chip = el('span', 'tchip');
        chip.textContent = clip(`${t.name} ${t.summary || ''}`, 80);
        line.appendChild(chip);
      }
      d.appendChild(line);
    }
    return d;
  }

  // ── 오른쪽 패널: 위임 현황
  function roleName(id) {
    const org = st.org && st.org.org;
    if (!org || !Array.isArray(org.roles) || !id) return '';
    const r = org.roles.find(x => x.id === id);
    return r ? r.name : '';
  }
  function busyRoleIds() {
    const s = new Set();
    for (const r of st.runs || []) if (r.state === 'running' && r.persona) s.add(r.persona);
    for (const a of ChatUI.agentsOf(st.projectId)) if (a.state === 'running' && a.type) s.add(a.type);
    return s;
  }
  function runningCount() {
    const runs = (st.runs || []).filter(r => r.state === 'running').length;
    const agents = ChatUI.agentsOf(st.projectId).filter(a => a.state === 'running').length;
    return runs + agents;
  }
  function watchRuns() {
    if (!hasApi('runsWatch') || !hasApi('runsUnwatch')) return;
    if (st.runsWatching && st.runsWatching !== st.projectId) { try { api.runsUnwatch(st.runsWatching); } catch { /* 무시 */ } }
    if (st.projectId && st.runsWatching !== st.projectId) {
      try { api.runsWatch(st.projectId); st.runsWatching = st.projectId; } catch { /* 무시 */ }
    }
    if (!st.projectId) st.runsWatching = null;
  }
  async function refreshRuns() {
    if (!st.ready || !st.projectId) return;
    if (!hasApi('runsList')) { st.runs = st.runs || []; renderPanel(); return; }
    const pid = st.projectId;
    let r;
    try { r = await api.runsList(pid); } catch { return; }
    if (st.projectId !== pid) return;
    if (r && r.ok) { st.runs = Array.isArray(r.runs) ? r.runs : []; renderPanel(); }
  }
  function runItemHTML(r) {
    const who = r.persona ? (roleName(r.persona) || r.persona) : (r.role === 'edit' ? '편집' : r.role === 'scan' ? '조사' : '위임');
    const elapsed = r.state === 'running' && r.startedAt
      ? `<span class="run-elapsed" data-start="${Number(r.startedAt) || 0}">${esc(FMT.fmtElapsed(Date.now() - r.startedAt))}</span>`
      : esc(FMT.fmtElapsed(r.elapsedMs));
    const v = r.verify === 'pass' ? ' · 검증 ✓' : r.verify === 'fail' ? ' · 검증 ✕' : '';
    return `<button type="button" class="run-item" data-run="${esc(r.id)}">
<span class="ri-ico ${esc(r.state)}" title="${esc(RUN_STATE[r.state] || r.state)}">${RUN_ICON[r.state] || '?'}</span>
<span class="ri-main">
<span class="ri-title">${esc(r.title || '(제목 없음)')}</span>
<span class="ri-sub">${esc([who, r.model || '', r.effort || ''].filter(Boolean).join(' · '))}</span>
<span class="ri-meta">${elapsed} · 턴 ${r.turns ?? 0} · 파일 ${r.editedFiles ?? 0}${v}</span>
${r.lastAction ? `<span class="ri-last">${esc(r.lastAction)}</span>` : ''}
</span></button>`;
  }
  function agentItemHTML(a) {
    const who = a.type ? (roleName(a.type) || a.type) : '서브에이전트';
    return `<button type="button" class="run-item agent-item" data-agent="${esc(a.chatId)}:${esc(a.id)}">
<span class="ri-ico ${esc(a.state)}" title="${a.state === 'running' ? '실행 중' : '끝남'}">${a.state === 'running' ? '◐' : '✓'}</span>
<span class="ri-main">
<span class="ri-title">하위 에이전트 · ${esc(who)}</span>
<span class="ri-sub">${esc(a.description || '')}</span>
${a.lastAction ? `<span class="ri-last">${esc(a.lastAction)}</span>` : ''}
</span></button>`;
  }
  function actsHTML(acts) {
    return (Array.isArray(acts) ? acts : []).map(a => {
      if (a.kind === 'tool') return `<div class="act tool"><span aria-hidden="true">▸</span> ${esc(clip(`${a.tool || ''} ${a.summary || ''}`.trim(), 120))}</div>`;
      if (a.kind === 'error') return `<div class="act error">${esc(clip(a.summary || a.text || '오류', 160))}</div>`;
      if (a.kind === 'result') return `<div class="act result">${esc(clip(a.summary || a.text || '', 160))}</div>`;
      return `<div class="act text">${esc(clip(a.text || '', 200))}</div>`;
    }).join('');
  }
  function renderRunsList(box) {
    if (!hasApi('runsList')) { box.innerHTML = '<p class="muted side-note">이 앱 버전에서는 위임 실행 기록을 표시할 수 없습니다</p>'; return; }
    if (!st.projectId) { box.innerHTML = '<p class="muted side-note">왼쪽에서 프로젝트를 고르세요</p>'; return; }
    const agents = ChatUI.agentsOf(st.projectId);
    const runs = st.runs || [];
    if (!agents.length && !runs.length) { box.innerHTML = '<p class="muted side-note">위임한 작업이 없습니다. 대화에서 작업을 위임하면 여기에 표시됩니다</p>'; return; }
    box.innerHTML = agents.map(agentItemHTML).join('') + runs.map(runItemHTML).join('');
  }
  async function openRunDetail(runId) {
    if (!hasApi('runsRead')) return;
    const pid = st.projectId;
    let r;
    try { r = await api.runsRead(pid, runId); } catch (e) { deps.toast(deps.errMsg(e), 'err'); return; }
    if (st.projectId !== pid) return;
    st.runsDetail = { kind: 'run', id: runId, data: r && r.ok ? r.run : null };
    renderPanel();
  }
  function renderRunDetailView(box) {
    const d = st.runsDetail;
    const back = '<button type="button" class="btn ghost sm" data-back="1">← 목록</button>';
    if (d.kind === 'agent') {
      const a = ChatUI.agentsOf(st.projectId).find(x => `${x.chatId}:${x.id}` === d.key);
      if (!a) { st.runsDetail = null; renderRunsList(box); return; }
      box.innerHTML = `${back}
<div class="det-head"><b>하위 에이전트 · ${esc(roleName(a.type) || a.type || '')}</b><span class="muted">${esc(a.description || '')} · ${a.state === 'running' ? '실행 중' : '끝남'}</span></div>
<div class="tsec">프롬프트</div><pre class="det-pre">${esc(a.prompt || '(프롬프트 없음)')}</pre>
<div class="tsec">활동</div><div class="det-acts">${actsHTML(a.acts)}</div>
<div class="tsec">결과</div><pre class="det-pre">${esc(a.result || '(아직 없음)')}</pre>`;
      const acts = $('.det-acts', box);
      if (acts) acts.scrollTop = acts.scrollHeight;
      return;
    }
    const r = d.data;
    if (!r) { box.innerHTML = `${back}<p class="form-err">실행 기록을 읽지 못했습니다</p>`; return; }
    const who = r.persona ? (roleName(r.persona) || r.persona) : '';
    const elapsed = r.state === 'running' && r.startedAt
      ? `<span class="run-elapsed" data-start="${Number(r.startedAt) || 0}">${esc(FMT.fmtElapsed(Date.now() - r.startedAt))}</span>`
      : esc(FMT.fmtElapsed(r.elapsedMs));
    const origin = r.origin && r.origin.spec
      ? `<div class="tsec">이어받은 원래 명세 — ${esc(r.origin.title || r.origin.id || '')}</div><div class="md det-md">${md(r.origin.spec)}</div>`
      : '';
    box.innerHTML = `${back}
<div class="det-head"><b>${esc(r.title || '(제목 없음)')}</b><span class="muted">${esc([who, RUN_STATE[r.state] || r.state, r.model || '', r.effort || ''].filter(Boolean).join(' · '))} · ${elapsed} · 턴 ${r.turns ?? 0}</span></div>
<div class="tsec">프롬프트</div>
${origin}
<div class="md det-md">${md(r.spec || '(명세 없음)')}</div>
<details class="det-fold"><summary>실제 전달된 전체 프롬프트</summary><pre class="det-pre">${esc(r.prompt || '')}</pre></details>
<div class="tsec">활동</div><div class="det-acts">${actsHTML(r.activity)}</div>
<div class="tsec">결과</div>
<ul class="det-files">${(Array.isArray(r.files) ? r.files : []).map(f => `<li><code>${esc(f)}</code></li>`).join('') || '<li class="muted">바꾼 파일 없음</li>'}</ul>
${r.verify ? `<div class="det-verify ${r.verify === 'pass' ? 'ok' : 'bad'}">${r.verify === 'pass' ? '검증 통과' : '검증 실패'}</div><pre class="det-pre">${esc(r.verifyOutput || '')}</pre>` : ''}
${r.report ? `<div class="tsec">보고서</div><div class="md det-md">${md(r.report)}</div>` : ''}
${(Array.isArray(r.warnings) && r.warnings.length) ? `<ul class="det-warn">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
    const acts = $('.det-acts', box);
    if (acts && r.state === 'running') acts.scrollTop = acts.scrollHeight;
  }
  async function refreshRunDetail() {
    const d = st.runsDetail;
    if (!d || d.kind !== 'run' || !d.id) return;
    const acts = $('#ws-panel .det-acts');
    const atBottom = acts ? acts.scrollHeight - acts.scrollTop - acts.clientHeight < 40 : true;
    const pid = st.projectId;
    let r;
    try { r = await api.runsRead(pid, d.id); } catch { return; }
    if (st.projectId !== pid || !st.runsDetail || st.runsDetail.kind !== 'run') return;
    st.runsDetail = { kind: 'run', id: d.id, data: r && r.ok ? r.run : st.runsDetail.data };
    renderPanel();
    const acts2 = $('#ws-panel .det-acts');
    if (acts2 && atBottom) acts2.scrollTop = acts2.scrollHeight;
  }

  // ── 오른쪽 패널: 조직도
  async function refreshOrg() {
    if (!st.ready) return;
    if (!hasApi('studioOrg')) { st.org = { unsupported: true }; renderPanel(); return; }
    if (!st.projectId) { st.org = null; renderPanel(); return; }
    const pid = st.projectId;
    let r;
    try { r = await api.studioOrg(pid); } catch (e) { if (st.projectId === pid) { st.org = { error: deps.errMsg(e) }; renderPanel(); } return; }
    if (st.projectId !== pid) return;
    st.org = r && r.ok ? r : { error: (r && r.error) || '조직도를 읽지 못했습니다' };
    st.orgDetail = null;
    renderPanel();
  }
  const orgFoot = () => '<div class="org-foot"><span class="muted">조직을 바꾸려면 이 폴더의 대화에서 디렉터와 의논하세요</span><button type="button" class="btn ghost sm" data-act="org-refresh">새로 고침</button></div>';
  function renderOrg(box) {
    const o = st.org;
    if (!st.projectId) { box.innerHTML = '<p class="muted side-note">왼쪽에서 프로젝트를 고르세요</p>'; return; }
    if (!o) { box.innerHTML = '<p class="muted side-note">조직도를 읽는 중…</p>'; return; }
    if (o.unsupported) { box.innerHTML = '<p class="muted side-note">이 앱 버전에서는 조직도를 표시할 수 없습니다</p>'; return; }
    if (o.error) { box.innerHTML = `<p class="form-err">${esc(o.error)}</p>${orgFoot()}`; return; }
    if (!o.enabled) { box.innerHTML = '<p class="muted side-note">이 폴더는 게임 스튜디오 조직도를 쓰지 않습니다 — 프로젝트 편집에서 켤 수 있습니다</p>' + orgFoot(); return; }
    const org = o.org;
    if (!org) { box.innerHTML = '<p class="muted side-note">폴더를 한 번 열면 조직도가 만들어집니다</p>' + orgFoot(); return; }
    const busyIds = busyRoleIds();
    if (st.orgDetail) { renderRoleDetail(box, org, busyIds); return; }
    const toggle = `<div class="org-view-toggle" role="group" aria-label="조직도 보기">
<button type="button" data-orgview="tree"${st.orgView === 'tree' ? ' class="on"' : ''}>트리</button>
<button type="button" data-orgview="dept"${st.orgView === 'dept' ? ' class="on"' : ''}>부서별</button></div>`;
    const warn = Array.isArray(o.warnings) && o.warnings.length ? `<ul class="det-warn">${o.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    box.innerHTML = toggle + (st.orgView === 'tree' ? orgTreeHTML(org, busyIds) : orgDeptHTML(org, busyIds)) + warn + orgFoot();
  }
  function orgTreeHTML(org, busyIds) {
    const kids = new Map();
    for (const r of org.roles || []) {
      const k = r.reports_to || 'director';
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(r);
    }
    const node = r => {
      const sub = (kids.get(r.id) || []).map(node).join('');
      return `<details class="org-node${busyIds.has(r.id) ? ' busy' : ''}" open>
<summary><span class="org-role">${roleChip(r)}</span><span class="org-model muted">${esc([r.model, r.effort].filter(Boolean).join(' · '))}</span></summary>
${sub ? `<div class="org-children">${sub}</div>` : ''}
</details>`;
    };
    return `<div class="org-tree">
<div class="org-root"><b>${esc((org.director && org.director.name) || '디렉터')}</b><span class="muted">${esc((org.director && org.director.note) || '')}</span></div>
<div class="org-children">${(kids.get('director') || []).map(node).join('')}</div>
</div>`;
  }
  const roleChip = r => `<button type="button" class="org-role-btn${r.engine === 'glm' ? ' glm' : ''}" data-role="${esc(r.id)}"><i class="dot ${r.engine === 'glm' ? 'glm' : 'claude'}"></i><span>${esc(r.name)}</span></button>`;
  function orgDeptHTML(org, busyIds) {
    return (org.departments || []).map(d => {
      const roles = (org.roles || []).filter(r => r.dept === d.id);
      if (!roles.length) return '';
      return `<div class="org-dept"><div class="s-group">${esc(d.name)}</div>`
        + (d.mission ? `<p class="muted dept-mission">${esc(d.mission)}</p>` : '')
        + `<div class="org-dept-roles">${roles.map(r => `<button type="button" class="org-role-btn${r.engine === 'glm' ? ' glm' : ''}${busyIds.has(r.id) ? ' busy' : ''}" data-role="${esc(r.id)}"><i class="dot ${r.engine === 'glm' ? 'glm' : 'claude'}"></i><span>${esc(r.name)}</span><span class="org-model muted">${esc([r.model, r.effort].filter(Boolean).join(' · '))}</span></button>`).join('')}</div></div>`;
    }).join('');
  }
  function renderRoleDetail(box, org, busyIds) {
    const r = (org.roles || []).find(x => x.id === st.orgDetail);
    if (!r) { st.orgDetail = null; renderOrg(box); return; }
    box.innerHTML = `<button type="button" class="btn ghost sm" data-back="1">← 조직도</button>
<div class="det-head"><b><i class="dot ${r.engine === 'glm' ? 'glm' : 'claude'}"></i> ${esc(r.name)}</b><span class="muted">${esc([r.model, r.effort].filter(Boolean).join(' · '))}${busyIds.has(r.id) ? ' · 지금 일하는 중' : ''}</span></div>
${r.when ? `<div class="tsec">언제 부르나</div><p>${esc(r.when)}</p>` : ''}
${Array.isArray(r.duties) && r.duties.length ? `<div class="tsec">책임</div><ul class="det-list">${r.duties.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
${Array.isArray(r.outputs) && r.outputs.length ? `<div class="tsec">산출물</div><ul class="det-list">${r.outputs.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : ''}
${Array.isArray(r.tools) && r.tools.length ? `<div class="tsec">도구</div><p>${esc(r.tools.join(', '))}</p>` : ''}
${r.brief ? `<div class="tsec">지침</div><pre class="det-pre">${esc(r.brief)}</pre>` : ''}`;
  }

  // ── 패널 공통
  function renderPanel() {
    if (!st.ready) return;
    const box = $('#panel-body');
    if (!box) return;
    $$('#ws-panel .panel-tabs [data-t]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.t === st.panelTab)));
    $('#pt-runs').textContent = runningCount() ? `위임 현황 ${runningCount()}` : '위임 현황';
    if (st.panelTab === 'runs') { if (st.runsDetail) renderRunDetailView(box); else renderRunsList(box); }
    else renderOrg(box);
  }
  function setPanelTab(t) {
    st.panelTab = t;
    st.runsDetail = null;
    renderPanel();
    if (t === 'org' && !st.org) refreshOrg();
    if (t === 'runs') refreshRuns();
  }

  // ── 창 제목 표시(권한 대기 중 + 비활성)
  function updateTitle() {
    const pending = ChatUI.views().some(v => v.pending > 0);
    document.title = pending && !document.hasFocus() ? '● Claude 런처' : 'Claude 런처';
  }

  // ── 사이드바·패널 접기/서랍
  function applyChrome() {
    const side = $('#ws-side'), panel = $('#ws-panel');
    if (side) side.dataset.collapsed = st.sideCollapsed ? '1' : '';
    if (panel) panel.dataset.collapsed = st.panelCollapsed ? '1' : '';
  }
  function toggleSide() {
    if (NARROW_SIDE()) {
      const side = $('#ws-side');
      side.dataset.open = side.dataset.open === '1' ? '' : '1';
      return;
    }
    st.sideCollapsed = !st.sideCollapsed;
    try { localStorage.setItem(LS.side, st.sideCollapsed ? '1' : '0'); } catch { /* 무시 */ }
    applyChrome();
    refit();
  }
  function togglePanel() {
    if (NARROW_PANEL()) {
      const panel = $('#ws-panel');
      panel.dataset.open = panel.dataset.open === '1' ? '' : '1';
      return;
    }
    st.panelCollapsed = !st.panelCollapsed;
    try { localStorage.setItem(LS.panel, st.panelCollapsed ? '1' : '0'); } catch { /* 무시 */ }
    applyChrome();
    refit();
  }
  function closeDrawers() {
    const side = $('#ws-side'), panel = $('#ws-panel');
    if (NARROW_SIDE() && side) side.dataset.open = '';
    if (NARROW_PANEL() && panel) panel.dataset.open = '';
  }

  // ── 시작·이벤트 연결
  function init(d) {
    deps = d;
    st.sideCollapsed = localStorage.getItem(LS.side) === '1';
    st.panelCollapsed = localStorage.getItem(LS.panel) === '1';
    $('#ws-side').innerHTML = `
<div class="side-head">
<div class="side-proj"><span id="ws-pdot" class="dot split"></span><select id="ws-project" aria-label="프로젝트"></select></div>
<div class="side-new">
<button type="button" id="ws-new" class="btn sm">새 대화</button>
<button type="button" id="ws-new-choose" class="btn ghost sm" aria-label="새 대화 방식 고르기" title="새 대화 방식 고르기">▾</button>
<div class="menu" id="ws-new-menu" hidden>
<button type="button" data-k="chat">채팅으로 새 대화</button>
<button type="button" data-k="term">터미널로 새 대화</button>
</div>
</div>
</div>
<div class="side-search"><input type="search" id="ws-search" placeholder="지난 대화 검색" aria-label="지난 대화 검색"></div>
<div class="side-list" id="ws-list" role="list"></div>`;
    $('#ws-panel').innerHTML = `
<div class="panel-head">
<div class="panel-tabs" role="tablist" aria-label="패널 탭">
<button type="button" id="pt-runs" role="tab" data-t="runs" aria-selected="true">위임 현황</button>
<button type="button" id="pt-org" role="tab" data-t="org" aria-selected="false">조직도</button>
</div>
<button type="button" id="ws-panel-close" class="icon-btn" aria-label="패널 닫기" title="패널 닫기">✕</button>
</div>
<div class="panel-body" id="panel-body"></div>`;
    applyChrome();

    $('#ws-project').addEventListener('change', e => setProject(e.target.value));
    $('#ws-new').addEventListener('click', () => newSession());
    $('#ws-new-choose').addEventListener('click', e => {
      e.stopPropagation();
      const menu = $('#ws-new-menu');
      menu.hidden = !menu.hidden;
    });
    $('#ws-new-menu').addEventListener('click', e => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      $('#ws-new-menu').hidden = true;
      newSession(b.dataset.k);
    });
    $('#ws-search').addEventListener('input', onSearchInput);
    $('#ws-list').addEventListener('click', e => {
      const b = e.target.closest('[data-sid]');
      if (!b) return;
      const s = st.sessions.find(x => x.id === b.dataset.sid) || (st.search.hits || []).find(x => x.id === b.dataset.sid);
      openHistory(st.projectId, b.dataset.sid, s ? s.title : '');
    });
    $('#ws-menu').addEventListener('click', toggleSide);
    $('#ws-panel-toggle').addEventListener('click', togglePanel);
    $('#ws-panel-close').addEventListener('click', () => { if (NARROW_PANEL()) closeDrawers(); else togglePanel(); });
    $('#tabs').addEventListener('click', e => {
      const x = e.target.closest('[data-close]');
      if (x) { e.stopPropagation(); closeTab(x.dataset.close); return; }
      if (e.target.closest('[data-new]')) { newSession(); return; }
      const b = e.target.closest('[data-tab]');
      if (b) { setView('workspace'); setActive(b.dataset.tab); }
    });
    $('#tabs').addEventListener('auxclick', e => {
      const b = e.target.closest('[data-tab]');
      if (e.button === 1 && b) closeTab(b.dataset.tab);
    });
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'Tab' && st.tabs.length) { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Escape') {
        const menu = $('#ws-new-menu');
        if (menu && !menu.hidden) { menu.hidden = true; return; }
        closeDrawers();
      }
    });
    document.addEventListener('click', e => {
      const menu = $('#ws-new-menu');
      if (menu && !menu.hidden && !e.target.closest('.side-new')) menu.hidden = true;
      const side = $('#ws-side'), panel = $('#ws-panel');
      if (NARROW_SIDE() && side.dataset.open === '1' && !side.contains(e.target) && !e.target.closest('#ws-menu')) side.dataset.open = '';
      if (NARROW_PANEL() && panel.dataset.open === '1' && !panel.contains(e.target) && !e.target.closest('#ws-panel-toggle')) panel.dataset.open = '';
    });
    $('#hist-view').addEventListener('click', e => {
      const b = e.target.closest('[data-h]');
      if (!b || !st.hist) return;
      const p = deps.projects().find(x => x.id === st.hist.projectId);
      if (b.dataset.h === 'close') { st.hist = null; st.active = null; pickNextActive(); }
      else if (b.dataset.h === 'more') loadHistory(false);
      else if (b.dataset.h === 'resume-chat' && p) ChatUI.open(p, { resume: st.hist.sessionId, title: st.hist.title });
      else if (b.dataset.h === 'resume-term' && p) TermUI.open(p, { resume: st.hist.sessionId });
    });
    $('#ws-panel').addEventListener('click', e => {
      const tab = e.target.closest('.panel-tabs [data-t]');
      if (tab) { setPanelTab(tab.dataset.t); return; }
      if (e.target.closest('[data-back]')) {
        if (st.panelTab === 'runs') st.runsDetail = null;
        else st.orgDetail = null;
        renderPanel();
        return;
      }
      if (e.target.closest('[data-act="org-refresh"]')) { refreshOrg(); return; }
      const ov = e.target.closest('[data-orgview]');
      if (ov) { st.orgView = ov.dataset.orgview; renderPanel(); return; }
      const role = e.target.closest('[data-role]');
      if (role) { e.preventDefault(); st.orgDetail = role.dataset.role; renderPanel(); return; }
      const run = e.target.closest('[data-run]');
      if (run) { openRunDetail(run.dataset.run); return; }
      const ag = e.target.closest('[data-agent]');
      if (ag) { st.runsDetail = { kind: 'agent', key: ag.dataset.agent }; renderPanel(); }
    });
    window.addEventListener('focus', () => {
      updateTitle();
      if (st.view === 'workspace') refreshSessions(true);
    });
    window.addEventListener('blur', updateTitle);
    if (hasApi('onRunsChanged')) {
      api.onRunsChanged(ev => {
        if (!ev || ev.projectId !== st.projectId) return;
        refreshRuns();
        refreshRunDetail();
      });
    }
    if (hasApi('onChatRequestOpen')) {
      api.onChatRequestOpen(ev => {
        if (!ev || !ev.projectId) return;
        const p = deps.projects().find(x => x.id === ev.projectId);
        if (p) openChat(p);
      });
    }
    setInterval(() => {
      if (st.view !== 'workspace') return;
      $$('#ws-panel .run-elapsed[data-start]').forEach(n => {
        const s = Number(n.dataset.start);
        if (s > 0) n.textContent = FMT.fmtElapsed(Date.now() - s);
      });
    }, 1000);
    st.ready = true;
    refreshProjects();
  }

  return {
    init, setView, refreshProjects, openChat, openTerm, addChat, removeChat, chatState, onChatResult,
    syncTerms, onTermActivate, onTermRestore, openHistory,
  };
})();
