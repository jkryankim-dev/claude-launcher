'use strict';
/* global api, Terminal, FitAddon, WebLinksAddon, Unicode11Addon */
// 런처 안 터미널: 탭마다 xterm.js 화면 하나. 실제 프로세스는 메인 프로세스의 의사 터미널(node-pty)이 돌린다.
window.TermUI = (() => {
  const $ = s => document.querySelector(s);
  const terms = new Map();
  let active = 'projects';
  let deps = null;
  const pick = (g, name) => (g && (g[name] || g)) || null;
  const FitCtor = typeof FitAddon !== 'undefined' ? pick(FitAddon, 'FitAddon') : null;
  const LinksCtor = typeof WebLinksAddon !== 'undefined' ? pick(WebLinksAddon, 'WebLinksAddon') : null;
  const UniCtor = typeof Unicode11Addon !== 'undefined' ? pick(Unicode11Addon, 'Unicode11Addon') : null;
  const available = typeof Terminal !== 'undefined' && !!FitCtor;
  const THEME = {
    background: '#16181c', foreground: '#e2e4e8', cursor: '#e2e4e8', cursorAccent: '#16181c', selectionBackground: '#3a4150',
    black: '#1e2126', red: '#e5797a', green: '#8fc163', yellow: '#e6b450', blue: '#79aee8', magenta: '#a99ff0', cyan: '#56c2a0', white: '#d5d7dc',
    brightBlack: '#6b717b', brightRed: '#f09595', brightGreen: '#a8d27f', brightYellow: '#f0c674', brightBlue: '#9cc5f0', brightMagenta: '#c2baf5', brightCyan: '#7fd6b9', brightWhite: '#f4f5f7',
  };
  const esc = s => deps.esc(s);

  function render() {
    const el = $('#tabs');
    el.hidden = terms.size === 0;
    if (!terms.size) return;
    const tabs = [`<button class="tab${active === 'projects' ? ' on' : ''}" data-tab="projects">프로젝트</button>`];
    for (const t of terms.values()) {
      tabs.push(`<button class="tab term-tab ${esc(t.mode)}${active === t.sid ? ' on' : ''}${t.alive ? '' : ' ended'}" data-tab="${esc(t.sid)}" title="${esc(t.title || t.name)}">`
        + `<i class="dot ${esc(t.mode)}"></i><span class="tl">${esc(t.name)}</span><span class="x" data-close="${esc(t.sid)}" title="탭 닫기">×</span></button>`);
    }
    el.innerHTML = tabs.join('');
  }
  function activate(tab) {
    if (tab !== 'projects' && !terms.has(tab)) tab = 'projects';
    active = tab;
    $('#view-projects').hidden = tab !== 'projects';
    $('#view-term').hidden = tab === 'projects';
    for (const t of terms.values()) t.el.hidden = t.sid !== tab;
    render();
    const t = terms.get(tab);
    if (t) requestAnimationFrame(() => { fit(t); t.term.focus(); });
  }
  function fit(t) {
    if (!t || t.el.hidden) return;
    try { t.fit.fit(); api.termResize(t.sid, t.term.cols, t.term.rows); } catch { /* 크기가 0일 때 */ }
  }
  function cycle(dir) {
    const order = ['projects', ...terms.keys()];
    activate(order[(order.indexOf(active) + dir + order.length) % order.length]);
  }
  function markEnded(t, code) {
    t.alive = false;
    t.term.write(`\r\n\x1b[2m[세션이 끝났습니다${code != null ? ` (코드 ${code})` : ''}. 탭을 닫거나 목록에서 다시 여세요]\x1b[0m\r\n`);
    render();
  }
  function copySel(t) {
    const s = t.term.getSelection();
    if (s) navigator.clipboard.writeText(s).catch(() => {});
    t.term.clearSelection();
  }
  function keyHandler(t, e) {
    if (e.type !== 'keydown') return true;
    const k = e.key;
    if (e.ctrlKey && k === 'Tab') return false; // 탭 전환은 문서 단축키가 처리
    if (e.ctrlKey && !e.altKey && (k === 'c' || k === 'C') && t.term.hasSelection()) { e.preventDefault(); copySel(t); return false; }
    if (e.ctrlKey && !e.altKey && (k === 'v' || k === 'V')) return false; // 붙여넣기는 브라우저 paste 이벤트로
    if (e.shiftKey && !e.ctrlKey && !e.altKey && k === 'Enter') { e.preventDefault(); api.termInput(t.sid, '\x1b\r'); return false; } // Claude Code 입력 줄바꿈
    return true;
  }
  function add(r) {
    const el = document.createElement('div');
    el.className = 'term';
    el.hidden = true;
    $('#view-term').appendChild(el);
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", "D2Coding", Consolas, "Malgun Gothic", monospace',
      fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: THEME,
    });
    const fitA = new FitCtor();
    term.loadAddon(fitA);
    if (LinksCtor) term.loadAddon(new LinksCtor((_e, uri) => api.openExternal(uri)));
    if (UniCtor) { try { term.loadAddon(new UniCtor()); term.unicode.activeVersion = '11'; } catch { /* 선택 기능 */ } }
    term.open(el);
    const t = { sid: r.id, projectId: r.projectId, name: r.name || '세션', mode: r.mode || 'split', title: r.title || '', term, fit: fitA, el, alive: true, attached: false, seq: 0 };
    term.attachCustomKeyEventHandler(e => keyHandler(t, e));
    term.onData(d => api.termInput(t.sid, d));
    term.onBinary(d => api.termInput(t.sid, d));
    term.onResize(({ cols, rows }) => api.termResize(t.sid, cols, rows));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (term.hasSelection()) { copySel(t); deps.toast('복사했습니다'); }
      else navigator.clipboard.readText().then(s => { if (s) term.paste(s); }).catch(() => {});
    });
    terms.set(t.sid, t);
    return t;
  }
  async function attach(t) {
    let a = null;
    try { a = await api.termAttach(t.sid); } catch { /* 없음 */ }
    if (!a) { markEnded(t, null); return; }
    if (a.buf) t.term.write(a.buf);
    t.seq = a.seq;
    t.attached = true;
    if (!a.alive) markEnded(t, a.code);
  }
  async function open(p) {
    const live = [...terms.values()].find(t => t.projectId === p.id && t.alive);
    if (live) { activate(live.sid); return; }
    if (!available) { deps.toast('런처 안 터미널 부품을 불러오지 못해 터미널 탭으로 엽니다', 'warn'); deps.openFallback(p.id); return; }
    let r;
    try { r = await api.termOpen(p.id, 120, 32); } catch (e) { deps.toast(deps.errMsg(e), 'err'); return; }
    if (!r.ok) {
      deps.toast(r.message || '열지 못했습니다', r.fallback ? 'warn' : 'err');
      if (r.fallback) deps.openFallback(p.id);
      return;
    }
    const t = add(r);
    activate(t.sid);
    await attach(t);
  }
  async function close(sid) {
    const t = terms.get(sid);
    if (!t) return;
    if (t.alive && !confirm(`${t.name} 세션을 끝낼까요? 실행 중인 작업도 멈춥니다.`)) return;
    try { await api.termKill(sid); } catch { /* 무시 */ }
    t.term.dispose();
    t.el.remove();
    terms.delete(sid);
    if (active === sid) { const rest = [...terms.keys()]; activate(rest.length ? rest[rest.length - 1] : 'projects'); }
    else render();
  }
  async function restore() {
    if (!available) return;
    let list = [];
    try { list = await api.termList(); } catch { /* 없음 */ }
    for (const s of list) { if (!terms.has(s.id)) await attach(add(s)); }
    if (list.length) activate(list[list.length - 1].id);
  }
  function init(d) {
    deps = d;
    $('#tabs').addEventListener('click', e => {
      const x = e.target.closest('[data-close]');
      if (x) { e.stopPropagation(); close(x.dataset.close); return; }
      const b = e.target.closest('[data-tab]');
      if (b) activate(b.dataset.tab);
    });
    $('#tabs').addEventListener('auxclick', e => {
      const b = e.target.closest('[data-tab]');
      if (e.button === 1 && b && b.dataset.tab !== 'projects') close(b.dataset.tab);
    });
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'Tab' && terms.size) { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
    });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fit(terms.get(active))).observe($('#view-term'));
    api.onTermData(m => {
      const t = terms.get(m.id);
      if (!t || !t.attached || m.seq <= t.seq) return;
      t.seq = m.seq;
      t.term.write(m.data);
    });
    api.onTermExit(m => { const t = terms.get(m.id); if (t && t.alive) markEnded(t, m.code); });
  }
  return { init, open, restore, available, count: () => terms.size };
})();
