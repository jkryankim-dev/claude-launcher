'use strict';
/* global api */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MODE = { split: '분담', claude: 'Claude만', glm: 'GLM만' };
  const OPENW = { inapp: '런처 안', tab: '터미널 탭', window: '새 창', vscode: 'VS Code' };
  const ICON = { ok: '✓', warn: '!', error: '✕', info: 'i' };
  const dlg = $('#dlg'), dlgOut = $('#dlg-out');
  let S = null;
  const selected = new Set();
  let dismissedKey = '';
  let toastTimer = null;

  const errMsg = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  async function call(fn, ...args) {
    try { return await fn(...args); } catch (e) { toast(errMsg(e), 'err'); throw e; }
  }
  function toast(text, level = 'info') {
    const t = $('#toast');
    t.textContent = text;
    t.className = `toast ${level}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, level === 'err' ? 7000 : 3500);
  }

  // ── 모델·effort
  const models = kind => (S.catalog[kind] && S.catalog[kind].models) || [];
  function effortsFor(kind, id) {
    const m = models(kind).find(x => x.id === id);
    return m ? (m.efforts || []) : kind === 'glm' ? ['low', 'high', 'max'] : ['low', 'medium', 'high', 'max'];
  }
  function pickEffort(list, cur) {
    if (cur === 'off' || list.includes(cur)) return cur;
    if (!list.length) return 'off';
    return list.includes('high') ? 'high' : list[list.length - 1];
  }
  function modelLabel(kind, id) { const m = models(kind).find(x => x.id === id); return m ? m.label || m.id : id; }
  function effortOptions(list, cur) {
    const opts = list.slice();
    if (cur && cur !== 'off' && !opts.includes(cur)) opts.unshift(cur);
    return opts.map(e => `<option value="${esc(e)}"${e === cur ? ' selected' : ''}>${esc(e)}</option>`).join('')
      + `<option value="off"${cur === 'off' ? ' selected' : ''}>기본</option>`;
  }
  function pairHTML(kind, key, v) {
    const ms = models(kind);
    let mo = ms.map(m => `<option value="${esc(m.id)}"${m.id === v.model ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('');
    if (!ms.some(m => m.id === v.model)) mo = `<option value="${esc(v.model)}" selected>${esc(v.model)} (목록에 없음)</option>${mo}`;
    const who = key === 'main' ? '메인' : '작업자';
    return `<div class="pair"><select data-f="${key}.model" aria-label="${who} 모델">${mo}</select>`
      + `<select data-f="${key}.effort" aria-label="${who} effort">${effortOptions(effortsFor(kind, v.model), v.effort)}</select></div>`;
  }
  const options = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v}</option>`).join('');
  function profileText(d) {
    const e = x => (x === 'off' ? '' : ` ${x}`);
    if (d.mode === 'glm') return `GLM만, ${modelLabel('glm', d.worker.model)}${e(d.worker.effort)}`;
    const main = `${modelLabel('claude', d.main.model)}${e(d.main.effort)}`;
    return d.mode === 'claude' ? `Claude만, ${main}` : `분담, 메인 ${main} / 작업자 ${modelLabel('glm', d.worker.model)}${e(d.worker.effort)}`;
  }
  function profileHTML(d) {
    return `<div class="grid2">
<label class="field"><span>모드</span><select data-f="mode">${options(MODE, d.mode)}</select></label>
<label class="field"><span>열기 방식</span><select data-f="openWith">${options(OPENW, d.openWith)}</select></label>
<div class="field"><span>메인 모델과 effort (Claude 구독)</span>${pairHTML('claude', 'main', d.main)}</div>
<div class="field"><span>작업자 모델과 effort (GLM, z.ai)</span>${pairHTML('glm', 'worker', d.worker)}</div>
</div>`;
  }
  function readProfile(root) {
    const g = f => { const el = root.querySelector(`[data-f="${f}"]`); return el ? el.value : undefined; };
    return { mode: g('mode'), openWith: g('openWith'), main: { model: g('main.model'), effort: g('main.effort') }, worker: { model: g('worker.model'), effort: g('worker.effort') } };
  }
  function wirePairs(root) {
    root.addEventListener('change', e => {
      const f = e.target.dataset && e.target.dataset.f;
      if (!f || !f.endsWith('.model')) return;
      const key = f.split('.')[0];
      const eff = root.querySelector(`[data-f="${key}.effort"]`);
      const list = effortsFor(key === 'main' ? 'claude' : 'glm', e.target.value);
      eff.innerHTML = effortOptions(list, pickEffort(list, eff.value));
    });
  }

  // ── 화면
  async function refresh() { S = await api.state(); render(); }
  function render() { renderTop(); renderBanner(); renderList(); renderFoot(); }
  const chip = (level, label, title) => `<span class="chip ${level}" title="${esc(title)}"><i>${ICON[level] || ''}</i>${esc(label)}</span>`;
  const pendingCount = () => {
    const u = S.update || {};
    return (u.catalog && u.catalog.state === 'available' ? 1 : 0) + (u.app && ['ready', 'downloading'].includes(u.app.state) ? 1 : 0);
  };
  function renderTop() {
    $('#ver').textContent = `v${S.version}`;
    const items = (S.checks && S.checks.items) || [];
    const cl = items.find(i => i.id === 'claude');
    const chips = [cl ? chip(cl.level, cl.label, cl.detail) : chip('info', 'Claude Code 점검 중', '')];
    const node = items.find(i => i.id === 'node');
    if (node && node.level === 'error') chips.push(chip('error', node.label, node.detail));
    chips.push(S.keySaved ? chip('ok', 'z.ai 키', '저장됨') : chip('warn', 'z.ai 키 없음', '설정에서 저장하세요'));
    chips.push(chip(S.rate.peak ? 'warn' : 'info', S.rate.label, S.rate.detail));
    $('#chips').innerHTML = chips.join('');
    const n = pendingCount();
    const b = $('#upd-badge');
    b.hidden = !n;
    b.textContent = n;
  }
  function diffText(diff) {
    const list = diff || [];
    const t = list.slice(0, 4).map(d => (d.type === 'model' ? `${d.kind === 'glm' ? '작업자' : '메인'} 모델 ${d.id}` : d.type === 'effort' ? `${d.id} effort ${d.efforts.join('/')}` : `${d.id} 빠짐`));
    return t.join(', ') + (list.length > 4 ? ` 외 ${list.length - 4}개` : '');
  }
  function renderBanner() {
    const u = S.update || {};
    const parts = [];
    if (u.catalog && u.catalog.state === 'available') parts.push(`<span>새 모델 목록 v${esc(u.catalog.version)}: ${esc(diffText(u.catalog.diff))}</span><button class="btn sm" data-act="apply-catalog">적용</button>`);
    if (u.app && u.app.state === 'ready') parts.push(`<span>앱 v${esc(u.app.version)}을 받아 두었습니다${u.app.notes ? `: ${esc(u.app.notes)}` : ''}</span><button class="btn sm" data-act="install-app">재시작해서 적용</button>`);
    else if (u.app && u.app.state === 'downloading') parts.push(`<span>앱 v${esc(u.app.version || '')} 받는 중 ${u.app.percent || 0}%</span>`);
    const key = JSON.stringify([u.catalog && u.catalog.version, u.catalog && u.catalog.state, u.app && u.app.version, u.app && u.app.state]);
    const el = $('#banner');
    if (!parts.length || dismissedKey === key) { el.hidden = true; return; }
    el.innerHTML = `<div class="banner-items">${parts.map(p => `<div class="bi">${p}</div>`).join('')}</div><button class="btn ghost sm" data-act="dismiss">나중에</button>`;
    el.dataset.key = key;
    el.hidden = false;
  }
  function rowHTML(p) {
    const main = p.mode === 'glm' ? '<div class="na">z.ai 단독 세션</div>' : pairHTML('claude', 'main', p.main);
    const work = p.mode === 'claude' ? '<div class="na">위임 안 함</div>' : pairHTML('glm', 'worker', p.worker);
    return `<div class="row ${esc(p.mode)}" data-id="${esc(p.id)}">
<input type="checkbox" class="sel"${selected.has(p.id) ? ' checked' : ''} aria-label="${esc(p.name)} 선택">
<div class="proj"><div class="name-line"><span class="name" title="${esc(p.name)}">${esc(p.name)}</span><select class="mode" data-f="mode" aria-label="모드">${options(MODE, p.mode)}</select></div>
<button class="path" data-act="reveal" title="탐색기에서 열기">${esc(p.path)}</button></div>
${main}${work}
<div class="open"><button class="btn open-btn" data-act="open">열기</button><select data-f="openWith" aria-label="열기 방식">${options(OPENW, p.openWith)}</select></div>
<button class="icon-btn" data-act="edit" aria-label="${esc(p.name)} 편집" title="이름·폴더·추가 인자">⋯</button>
</div>`;
  }
  function renderList() {
    const ids = new Set(S.config.projects.map(p => p.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    const list = $('#list');
    if (!S.config.projects.length) {
      list.innerHTML = `<div class="empty"><p class="empty-title">작업할 폴더를 추가하세요</p>
<p class="muted">저장소 폴더를 고르거나 이 창으로 끌어다 놓으면 새 폴더 기본값(${esc(profileText(S.config.defaults))})으로 등록됩니다.</p>
<button class="btn" data-act="add">폴더 추가</button></div>`;
    } else list.innerHTML = S.config.projects.map(rowHTML).join('');
    renderSelCount();
  }
  function renderSelCount() { $('#sel-count').textContent = selected.size ? `${selected.size}개 선택` : ''; }
  function renderFoot() {
    $('#foot').innerHTML = `<span>새 폴더 기본값: ${esc(profileText(S.config.defaults))}</span><button class="btn ghost sm" data-act="defaults">바꾸기</button>`;
  }

  // ── 목록 조작
  async function openIds(ids, layout) {
    if (!layout) { // '런처 안' 대상은 런처 탭으로, 나머지는 외부 터미널로
      const inapp = ids.map(id => S.config.projects.find(p => p.id === id)).filter(p => p && p.openWith === 'inapp');
      for (const p of inapp) await TermUI.open(p);
      ids = ids.filter(id => !inapp.some(p => p.id === id));
      if (!ids.length) return;
    }
    const r = await call(api.open, ids, layout);
    if (!r.ok) { toast(r.message || '열지 못했습니다', 'err'); return; }
    if (r.warn) toast(r.warn, 'warn');
    else toast(r.fallback ? 'Windows Terminal이 없어 기본 콘솔 창으로 열었습니다' : '열었습니다', r.fallback ? 'warn' : 'ok');
  }
  async function addFolders() { S = await call(api.addProjects); render(); }
  $('#list').addEventListener('change', async e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const p = S.config.projects.find(x => x.id === row.dataset.id);
    if (!p) return;
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) selected.add(p.id); else selected.delete(p.id);
      renderSelCount();
      return;
    }
    const f = e.target.dataset.f;
    if (!f) return;
    const next = JSON.parse(JSON.stringify(p));
    if (f.includes('.')) {
      const [a, b] = f.split('.');
      next[a][b] = e.target.value;
      if (b === 'model') next[a].effort = pickEffort(effortsFor(a === 'main' ? 'claude' : 'glm', next[a].model), next[a].effort);
    } else next[f] = e.target.value;
    S = await call(api.saveProject, next);
    render();
  });
  $('#list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'add') { addFolders(); return; }
    const row = btn.closest('.row');
    const p = row && S.config.projects.find(x => x.id === row.dataset.id);
    if (!p) return;
    if (act === 'open') openIds([p.id]);
    else if (act === 'reveal') call(api.reveal, p.id);
    else if (act === 'edit') openProjectDialog(p);
  });
  $('#list').addEventListener('dblclick', e => {
    const row = e.target.closest('.row');
    if (row && !e.target.closest('select, button, input')) openIds([row.dataset.id]);
  });
  $('#btn-add').addEventListener('click', addFolders);
  $('#btn-split').addEventListener('click', () => {
    const ids = S.config.projects.filter(p => selected.has(p.id)).map(p => p.id);
    if (ids.length < 2) { toast('분할 창으로 열 폴더를 2개 이상 선택하세요', 'warn'); return; }
    openIds(ids, 'split');
  });
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#foot').addEventListener('click', e => { if (e.target.closest('[data-act="defaults"]')) openSettings(); });
  $('#btn-update').addEventListener('click', async () => {
    toast('업데이트를 확인하는 중…');
    dismissedKey = '';
    S = await call(api.checkUpdates, true);
    render();
    const c = S.update.catalog || {};
    if (pendingCount()) return;
    if (c.state === 'error') toast(`모델 목록 확인 실패: ${c.message}`, 'warn');
    else toast(`모델 목록은 최신입니다 (v${S.catalog.version})`, 'ok');
  });
  $('#banner').addEventListener('click', async e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'apply-catalog') { S = await call(api.applyCatalog); render(); toast('모델 목록을 업데이트했습니다', 'ok'); }
    else if (act === 'install-app') { toast('업데이트를 설치하고 다시 시작합니다'); await call(api.installApp); }
    else if (act === 'dismiss') { dismissedKey = $('#banner').dataset.key; renderBanner(); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const paths = [...((e.dataTransfer && e.dataTransfer.files) || [])].map(f => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    S = await call(api.addPaths, paths);
    render();
  });

  // ── 대화상자
  function openDialog(html, onMount, lock = false) {
    dlg.dataset.lock = lock ? '1' : '0';
    dlg.innerHTML = html;
    if (!dlg.open) dlg.showModal();
    if (onMount) onMount(dlg.firstElementChild);
  }
  function closeDialog() { dlg.dataset.lock = '0'; if (dlg.open) dlg.close(); }
  dlg.addEventListener('cancel', e => { if (dlg.dataset.lock === '1') e.preventDefault(); });
  async function runTool(title, fn) {
    dlgOut.innerHTML = `<div class="dlg-body"><div class="dlg-head"><h2>${esc(title)}</h2></div><pre class="out">실행 중…</pre><div class="actions"><span class="grow"></span><button class="btn" data-act="close-out">닫기</button></div></div>`;
    dlgOut.showModal();
    dlgOut.querySelector('[data-act="close-out"]').addEventListener('click', () => dlgOut.close());
    const pre = dlgOut.querySelector('pre');
    try {
      const r = await fn();
      pre.textContent = String((r && r.output) || '').trim() || '(출력 없음)';
      pre.classList.toggle('bad', !r || r.code !== 0);
    } catch (e) { pre.textContent = errMsg(e); pre.classList.add('bad'); }
  }
  function checksHTML() {
    const items = S.checks && S.checks.items;
    if (!items) return '<p class="muted">환경을 점검하는 중…</p>';
    return `<ul class="checks">${items.map(i => `<li class="${esc(i.level)}"><i>${ICON[i.level] || ''}</i><b>${esc(i.label)}</b><span>${esc(i.detail || '')}</span></li>`).join('')}</ul>`;
  }
  function openSetup() {
    openDialog(`<form class="dlg-body" id="setup" autocomplete="off">
<h2>Claude 런처 시작하기</h2>
<p class="muted">폴더마다 메인(Claude 구독)과 작업자(GLM) 모델을 정해 두고, 클릭 한 번으로 그 설정의 Claude Code를 엽니다.</p>
<h3>1. 환경 점검</h3><div id="setup-checks">${checksHTML()}</div>
<h3>2. z.ai API 키</h3>
<label class="field"><span>GLM 위임과 GLM 전용 세션에 씁니다. Windows 계정으로 암호화해 저장합니다. 나중에 설정에서 넣어도 됩니다.</span>
<input type="password" id="setup-key" placeholder="z.ai API 키"></label>
<h3>3. 새 폴더 기본값</h3>
<div id="setup-prof">${profileHTML(S.config.defaults)}</div>
<label class="check"><input type="checkbox" id="setup-md" checked> 전역 CLAUDE.md(~/.claude/CLAUDE.md)에 분담 규칙 추가</label>
<p class="muted">시작하면 GLM 위임 스킬을 ~/.claude/skills/glm-delegate에 설치합니다.</p>
<div class="actions"><button type="button" class="btn" id="setup-recheck">다시 점검</button><span class="grow"></span><button type="submit" class="btn primary">시작하기</button></div>
</form>`, root => {
      wirePairs(root);
      root.querySelector('#setup-recheck').addEventListener('click', async () => {
        $('#setup-checks').innerHTML = '<p class="muted">점검하는 중…</p>';
        S = await call(api.runChecks);
        $('#setup-checks').innerHTML = checksHTML();
        renderTop();
      });
      root.addEventListener('submit', async e => {
        e.preventDefault();
        const d = { key: root.querySelector('#setup-key').value.trim(), defaults: readProfile(root.querySelector('#setup-prof')), claudeMd: root.querySelector('#setup-md').checked };
        S = await call(api.completeSetup, d);
        closeDialog();
        render();
        toast('준비됐습니다. 작업할 폴더를 추가하세요', 'ok');
      });
    }, true);
  }
  function appStateText() {
    const a = (S.update && S.update.app) || {};
    return { dev: '개발 모드', idle: '확인 전', checking: '확인 중', latest: '최신', downloading: `v${a.version} 받는 중 ${a.percent || 0}%`, ready: `v${a.version} 설치 대기`, error: `오류: ${a.message || ''}` }[a.state] || a.state || '';
  }
  function userModelsHTML() {
    const rows = ['claude', 'glm'].flatMap(k => (S.config.userModels[k] || []).map(m => `<li><code>${esc(m.id)}</code><span class="muted">${k === 'glm' ? '작업자' : '메인'}, effort ${esc((m.efforts || []).join('/') || '기본')}</span><button type="button" class="btn ghost sm" data-act="rm-model" data-kind="${k}" data-id="${esc(m.id)}">빼기</button></li>`));
    return rows.length ? `<ul class="user-models">${rows.join('')}</ul>` : '';
  }
  function openSettings() {
    const st = S.config.settings;
    const repo = S.repo ? `${S.repo.owner}/${S.repo.repo}` : '설정 안 된 빌드';
    openDialog(`<div class="dlg-body" id="settings">
<div class="dlg-head"><h2>설정</h2><button type="button" class="icon-btn" data-act="close" aria-label="닫기">✕</button></div>
<section><h3>z.ai 키</h3>
<p class="muted">${S.keySaved ? '저장되어 있습니다 (Windows 계정 암호화).' : '저장된 키가 없습니다.'}</p>
<div class="inline"><input type="password" id="key" placeholder="${S.keySaved ? '새 키로 바꾸기' : 'z.ai API 키'}" autocomplete="off"><button type="button" class="btn" data-act="save-key">저장</button>${S.keySaved ? '<button type="button" class="btn ghost danger" data-act="del-key">삭제</button>' : ''}<button type="button" class="btn" data-act="glm-check">위임 연결 점검</button></div></section>
<section><h3>새 폴더 기본값</h3><div id="defaults">${profileHTML(S.config.defaults)}</div>
<div class="actions"><button type="button" class="btn" data-act="save-defaults">기본값 저장</button><button type="button" class="btn ghost" data-act="apply-open-all">이 열기 방식을 모든 폴더에 적용</button></div></section>
<section><h3>터미널</h3>
<label class="check"><input type="checkbox" id="keepShell"${st.keepShell ? ' checked' : ''}> Claude Code가 끝나도 그 폴더의 PowerShell을 열어 둠</label>
<label class="field"><span>여는 프로그램</span><select id="terminal"><option value="wt"${st.terminal === 'wt' ? ' selected' : ''}>Windows Terminal</option><option value="console"${st.terminal === 'console' ? ' selected' : ''}>기본 콘솔 창</option></select></label>
<label class="check"><input type="checkbox" id="claudeMd"${st.claudeMd ? ' checked' : ''}> 전역 CLAUDE.md에 분담 규칙 유지</label></section>
<section><h3>업데이트</h3>
<p class="muted">저장소 ${esc(repo)}, 앱 <span id="app-state">${esc(appStateText())}</span>, 모델 목록 v${esc(S.catalog.version)}</p>
<label class="check"><input type="checkbox" id="autoUpdate"${st.autoUpdate ? ' checked' : ''}> 시작할 때 자동으로 확인하고 받기</label>
<label class="field"><span>비공개 저장소 토큰 (공개 저장소면 비워 두기)</span><input type="password" id="ghToken" value="${esc(st.githubToken)}" autocomplete="off" placeholder="github_pat_..."></label>
<div class="actions"><button type="button" class="btn" data-act="save-settings">설정 저장</button><span class="grow"></span><button type="button" class="btn ghost" data-act="claude-update">Claude Code 업데이트</button><button type="button" class="btn ghost" data-act="reinstall">위임 스킬 다시 설치</button></div></section>
<section><h3>모델 직접 추가</h3>
<p class="muted">목록에 아직 없는 모델을 이 PC에서 먼저 쓸 때. 나중에 모델 목록에 같은 이름이 들어오면 그쪽 정보를 씁니다.</p>
<div class="inline"><select id="m-kind"><option value="glm">작업자 (GLM)</option><option value="claude">메인 (Claude)</option></select><input id="m-id" placeholder="glm-5.4"><input id="m-eff" placeholder="effort, 예: low,high,max"><button type="button" class="btn" data-act="add-model">추가</button></div>
${userModelsHTML()}</section>
</div>`, root => {
      wirePairs(root);
      root.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const v = id => root.querySelector(`#${id}`);
        switch (b.dataset.act) {
          case 'close': closeDialog(); break;
          case 'save-key': {
            const k = v('key').value.trim();
            if (!k) { toast('키를 입력하세요', 'warn'); return; }
            S = await call(api.saveKey, k); render(); openSettings(); toast('z.ai 키를 저장했습니다', 'ok'); break;
          }
          case 'del-key':
            if (!confirm('저장된 z.ai 키를 삭제할까요?')) return;
            S = await call(api.deleteKey); render(); openSettings(); break;
          case 'glm-check': runTool('위임 연결 점검', () => api.glmCheck()); break;
          case 'save-defaults': S = await call(api.saveDefaults, readProfile(v('defaults'))); render(); toast('새 폴더 기본값을 저장했습니다', 'ok'); break;
          case 'apply-open-all': {
            const ow = readProfile(v('defaults')).openWith;
            S = await call(api.applyOpenWithAll, ow); render(); toast(`모든 폴더를 '${OPENW[ow]}'(으)로 열도록 바꿨습니다`, 'ok'); break;
          }
          case 'save-settings':
            S = await call(api.saveSettings, { keepShell: v('keepShell').checked, terminal: v('terminal').value, claudeMd: v('claudeMd').checked, autoUpdate: v('autoUpdate').checked, githubToken: v('ghToken').value });
            render(); toast('설정을 저장했습니다', 'ok'); break;
          case 'claude-update': runTool('Claude Code 업데이트', () => api.claudeUpdate()); break;
          case 'reinstall': runTool('위임 스킬 다시 설치', () => api.reinstall()); break;
          case 'add-model': {
            const id = v('m-id').value.trim();
            if (!id) { toast('모델 이름을 입력하세요', 'warn'); return; }
            S = await call(api.addModel, v('m-kind').value, { id, efforts: v('m-eff').value }); render(); openSettings(); toast(`${id}을(를) 추가했습니다`, 'ok'); break;
          }
          case 'rm-model': S = await call(api.removeModel, b.dataset.kind, b.dataset.id); render(); openSettings(); break;
          default: break;
        }
      });
    });
  }
  function openProjectDialog(p) {
    openDialog(`<form class="dlg-body" id="proj" autocomplete="off">
<div class="dlg-head"><h2>${esc(p.name)}</h2><button type="button" class="icon-btn" data-act="close" aria-label="닫기">✕</button></div>
<label class="field"><span>이름</span><input id="p-name" value="${esc(p.name)}"></label>
<div class="field"><span>폴더</span><div class="inline"><span class="path-code">${esc(p.path)}</span><button type="button" class="btn sm" data-act="change-path">바꾸기</button></div></div>
<div id="p-prof">${profileHTML(p)}</div>
<label class="field"><span>claude 추가 인자 (선택)</span><input id="p-extra" value="${esc(p.extraArgs || '')}" placeholder="--permission-mode plan"></label>
<div class="actions"><button type="button" class="btn ghost danger" data-act="remove">목록에서 빼기</button><button type="button" class="btn ghost" data-act="up">위로</button><button type="button" class="btn ghost" data-act="down">아래로</button><span class="grow"></span><button type="submit" class="btn primary">저장</button></div>
</form>`, root => {
      wirePairs(root);
      root.addEventListener('submit', async e => {
        e.preventDefault();
        const next = { ...p, ...readProfile(root.querySelector('#p-prof')), name: root.querySelector('#p-name').value.trim() || p.name, extraArgs: root.querySelector('#p-extra').value.trim() };
        S = await call(api.saveProject, next); render(); closeDialog(); toast('저장했습니다', 'ok');
      });
      root.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'close') closeDialog();
        else if (act === 'change-path') {
          S = await call(api.changePath, p.id); render();
          const np = S.config.projects.find(x => x.id === p.id);
          if (np) openProjectDialog(np);
        } else if (act === 'remove') {
          if (!confirm(`${p.name}을(를) 목록에서 뺄까요? 폴더와 파일은 그대로 남습니다.`)) return;
          S = await call(api.removeProject, p.id); selected.delete(p.id); render(); closeDialog();
        } else if (act === 'up' || act === 'down') { S = await call(api.moveProject, p.id, act === 'up' ? -1 : 1); render(); }
      });
    });
  }

  // ── 이벤트·시작
  api.onEvent(ev => {
    if (ev.type === 'toast') { toast(ev.text, ev.level); return; }
    if (!S) return;
    if (ev.type === 'update') {
      S.update = ev.update; renderTop(); renderBanner();
      const el = $('#app-state'); if (el) el.textContent = appStateText();
    } else if (ev.type === 'checks') {
      S.checks = ev.checks; renderTop();
      const el = $('#setup-checks'); if (el) el.innerHTML = checksHTML();
    }
  });
  setInterval(async () => {
    try { const st = await api.state(); S.rate = st.rate; S.keySaved = st.keySaved; renderTop(); } catch { /* 무시 */ }
  }, 60000);
  TermUI.init({ esc, toast, errMsg, openFallback: id => openIds([id], 'wt') });
  refresh().then(() => { if (S.firstRun) openSetup(); return TermUI.restore(); }).catch(e => toast(errMsg(e), 'err'));
})();
