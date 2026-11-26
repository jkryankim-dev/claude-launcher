'use strict';
/* global api, MD, FMT */
// 런처 안 채팅: 탭 하나가 대화 세션 하나. 실제 세션은 메인 프로세스의 채팅 호스트(SDK)가 돌리고
// 이벤트(api.onChatEvent)를 받아 그린다. 탭 줄·사이드바는 workspace.js가 담당한다.
window.ChatUI = (() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = t => (window.MD ? MD.renderMarkdown(t) : esc(t));
  const el = (tag, cls) => { const d = document.createElement(tag); if (cls) d.className = cls; return d; };
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

  const IMAGE_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/gif': 1 };
  const IMAGE_MAX = 5;
  const IMAGE_BYTES = 5 * 1024 * 1024;
  const FOLD_KEEP = 400; // 이 개수를 넘게 되면 오래된 것부터 접는다
  const FOLD_AT = 500;
  const OUTCOME = { allow: '허용함', always: '항상 허용함', deny: '거부함', answered: '답변함', timeout: '시간 초과', cancelled: '취소됨' };

  const chats = new Map(); // chatId → 세션
  let deps = null;

  async function safe(fn, fallback) {
    try { return await fn(); } catch (e) { deps.toast(deps.errMsg(e), 'err'); return fallback; }
  }
  const hasApi = n => typeof api[n] === 'function';

  // ── 화면 만들기
  function create(project, chatId, title) {
    const root = el('div', 'chat');
    root.dataset.chat = chatId;
    root.hidden = true;
    $('#ws-body').appendChild(root);
    root.innerHTML = `
<div class="chat-list" role="log" aria-live="polite"><button type="button" class="chat-fold" hidden></button></div>
<button type="button" class="chat-jump" hidden>새 메시지 ↓</button>
<div class="chat-bottom">
  <div class="chat-imgs" hidden></div>
  <div class="chat-inputrow">
    <textarea class="chat-ta" rows="1" placeholder="메시지를 입력하세요 — Enter 보내기 · Shift+Enter 줄바꿈 · / 명령" aria-label="메시지 입력"></textarea>
    <button type="button" class="btn primary chat-send">보내기</button>
    <button type="button" class="btn chat-stop" hidden>중단</button>
  </div>
  <div class="chat-ac" hidden></div>
  <div class="chat-status">
    <select class="chat-model" aria-label="모델"></select>
    <select class="chat-perm" aria-label="권한 모드">
      <option value="default">권한: 기본</option>
      <option value="acceptEdits">권한: 편집 자동 허용</option>
      <option value="plan">권한: 계획</option>
      <option value="bypassPermissions">권한: 전부 허용</option>
    </select>
    <button type="button" class="chat-sid" title="세션 id 복사" hidden></button>
    <span class="chat-stat muted"></span>
    <span class="grow"></span>
    <button type="button" class="btn ghost sm chat-toterm">터미널로 이어가기</button>
  </div>
  <div class="chat-reopen" hidden><span class="muted">세션이 닫혔습니다</span><button type="button" class="btn sm chat-reopen-btn">다시 열기</button></div>
</div>`;
    const c = {
      id: chatId, projectId: project.id, project, title: title || '',
      el: root,
      list: $('.chat-list', root), ta: $('.chat-ta', root), sendBtn: $('.chat-send', root), stopBtn: $('.chat-stop', root),
      imgsEl: $('.chat-imgs', root), acEl: $('.chat-ac', root), modelSel: $('.chat-model', root), permSel: $('.chat-perm', root),
      sidBtn: $('.chat-sid', root), statEl: $('.chat-stat', root), jumpBtn: $('.chat-jump', root),
      foldBtn: $('.chat-fold', root), reopenBar: $('.chat-reopen', root),
      sessionId: null, model: null, permissionMode: null, busy: false, closed: false,
      thinking: null, stream: null,
      tools: new Map(), agents: new Map(), reqs: new Map(),
      images: [], commands: null, cmdLoading: false,
      ac: { open: false, items: [], idx: -1 },
      lastEsc: 0, folded: [], foldedOpen: false, agentTypes: null,
    };
    wire(c);
    chats.set(chatId, c);
    return c;
  }

  // ── 스크롤·접기
  const nearBottom = c => c.list.scrollHeight - c.list.scrollTop - c.list.clientHeight < 60;
  const scrollEnd = c => { c.list.scrollTop = c.list.scrollHeight; c.jumpBtn.hidden = true; };
  function append(c, node) {
    const stick = nearBottom(c);
    c.list.appendChild(node);
    fold(c);
    if (stick) scrollEnd(c);
    else if (!node.classList.contains('thinking')) c.jumpBtn.hidden = false;
  }
  function fold(c) {
    if (c.foldedOpen) return;
    const nodes = c.list.children;
    if (nodes.length <= FOLD_AT) return;
    let hide = nodes.length - FOLD_KEEP;
    for (let i = 0; hide > 0 && i < nodes.length; i++) {
      const n = nodes[i];
      if (n === c.foldBtn || n.hidden) continue;
      n.hidden = true; c.folded.push(n); hide--;
    }
    c.foldBtn.hidden = false;
    updateFold(c);
  }
  function updateFold(c) { c.foldBtn.textContent = `이전 메시지 ${c.folded.length}개 보기`; }
  function unfold(c) {
    for (const n of c.folded) n.hidden = false;
    c.folded = [];
    c.foldedOpen = true;
    c.foldBtn.hidden = true;
  }

  // ── 메시지
  function setTitle(c, text) {
    const cps = Array.from(String(text || '').trim().replace(/\s+/g, ' '));
    c.title = cps.slice(0, 20).join('') + (cps.length > 20 ? '…' : '');
    deps.onState(c);
  }
  function addUser(c, text, images, queued) {
    const d = el('div', 'msg user');
    d.innerHTML = `<div class="bubble">${images ? `<span class="u-imgs" title="이미지 ${images}장">🖼 ${images}</span>` : ''}<span class="u-text"></span>${queued ? '<span class="queued">대기 중</span>' : ''}</div>`;
    $('.u-text', d).textContent = text;
    append(c, d);
    if (!c.title && text) setTitle(c, text);
  }
  function appendText(c, text) {
    const d = el('div', 'msg ai');
    const b = el('div', 'bubble md');
    b.innerHTML = md(text);
    d.appendChild(b);
    append(c, d);
  }
  function showThinking(c) {
    if (c.thinking) return;
    const d = el('div', 'msg ai thinking');
    d.innerHTML = '<div class="bubble"><span class="think-dots"><i></i><i></i><i></i></span> 생각 중…</div>';
    c.list.appendChild(d);
    if (nearBottom(c)) scrollEnd(c);
    c.thinking = d;
  }
  function hideThinking(c) { if (c.thinking) { c.thinking.remove(); c.thinking = null; } }

  // ── 스트리밍 조각: requestAnimationFrame으로 묶어 그린다
  function ensureStream(c, agent) {
    const target = agent || c;
    if (target.stream) return target.stream;
    const d = el('div', 'msg ai');
    const b = el('div', 'bubble md stream');
    d.appendChild(b);
    if (agent) agent.el.appendChild(d); else c.list.appendChild(d);
    target.stream = { buf: '', el: b, raf: 0 };
    return target.stream;
  }
  function onDelta(c, ev) {
    if (ev.parent) {
      const a = c.agents.get(ev.parent);
      if (!a) return;
      const s = ensureStream(c, a);
      s.buf += ev.text || '';
      paintStream(c, s);
      return;
    }
    hideThinking(c);
    const s = ensureStream(c, null);
    s.buf += ev.text || '';
    paintStream(c, s);
  }
  function paintStream(c, s) {
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      s.el.innerHTML = md(s.buf);
      if (nearBottom(c)) scrollEnd(c);
    });
  }
  function settleStream(c, holder, text) { // 그리던 임시 글을 완성본으로 바꾼다. holder = 채팅(c) 또는 에이전트(a)
    const s = holder ? holder.stream : c.stream;
    if (s && s.el) {
      if (s.raf) cancelAnimationFrame(s.raf);
      s.el.classList.remove('stream');
      if (text != null) s.el.innerHTML = md(text);
    }
    holder.stream = null;
  }

  // ── 도구 카드
  function toolPairs(input) { // Edit/Write 계열의 −/+ 줄 쌍
    const i = input && typeof input === 'object' ? input : {};
    const pairs = [];
    if (typeof i.old_string === 'string' || typeof i.new_string === 'string') pairs.push([i.old_string, i.new_string]);
    if (Array.isArray(i.edits)) for (const e of i.edits) if (e && typeof e === 'object' && (typeof e.old_string === 'string' || typeof e.new_string === 'string')) pairs.push([e.old_string, e.new_string]);
    if (typeof i.content === 'string' && !pairs.length) pairs.push([null, i.content]);
    return pairs;
  }
  function diffHTML(pairs) {
    const rows = [];
    for (const [o, n] of pairs) {
      for (const l of (window.FMT ? FMT.lineDiff(o, n) : [])) rows.push(`<span class="dl ${l.t}">${l.t === '-' ? '−' : '+'} ${esc(l.s)}</span>`);
    }
    return rows.join('');
  }
  function addTool(c, b, agent) {
    const isAgent = b.name === 'Agent' || b.name === 'Task';
    const root = el('div', 'tcard' + (isAgent ? ' agent' : ''));
    if (b.id) root.dataset.tu = b.id;
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const sum = String(b.summary || '');
    root.innerHTML = `<button type="button" class="tcard-line" aria-expanded="false">
<span class="tmark" aria-hidden="true">▸</span><span class="tname"></span><span class="tsum"></span><span class="tprog" title="진행 중"></span>
</button>
<div class="tcard-body" hidden>
${isAgent ? '<div class="agent-prompt"><div class="tsec">메인이 쓴 프롬프트</div><pre></pre></div><div class="agent-acts"></div>' : '<div class="tcard-input"></div>'}
<div class="tcard-result" hidden></div>
</div>`;
    $('.tname', root).textContent = isAgent ? `하위 에이전트 · ${input.subagent_type || '?'}` : b.name;
    $('.tsum', root).textContent = isAgent ? `${input.description || input.prompt || ''}`.slice(0, 120) : sum;
    const rec = {
      id: b.id, name: b.name, summary: sum, input, isAgent, root,
      body: $('.tcard-body', root), resultEl: $('.tcard-result', root), prog: $('.tprog', root),
      resultText: null, isError: false, rendered: false, agent: null,
    };
    if (isAgent) {
      const a = {
        id: b.id, chatId: c.id, type: input.subagent_type || '', description: input.description || '',
        prompt: typeof input.prompt === 'string' ? input.prompt : '', rec,
        acts: [], result: null, done: false, lastAction: '', stream: null,
        el: $('.agent-acts', root),
      };
      $('.agent-prompt pre', root).textContent = a.prompt || '(프롬프트 없음)';
      c.agents.set(b.id, a);
      rec.agent = a;
      logAct(a, { kind: 'text', tool: '', summary: '', text: `하위 에이전트 시작: ${a.description || a.type}` });
    }
    c.tools.set(b.id, rec);
    if (agent) { agent.el.appendChild(root); logAct(agent, { kind: 'tool', tool: b.name, summary: sum, text: '' }); }
    else append(c, root);
    return rec;
  }
  function expandTool(rec) {
    rec.rendered = true;
    rec.body.hidden = false;
    if (!rec.isAgent) {
      const box = $('.tcard-input', rec.root);
      if (box && !box.dataset.done) {
        box.dataset.done = '1';
        const pairs = toolPairs(rec.input);
        if (pairs.length) {
          const d = el('div', 'tdiff');
          d.innerHTML = diffHTML(pairs);
          box.appendChild(d);
        }
        const pre = el('pre', 'tjson');
        pre.textContent = JSON.stringify(rec.input, null, 2);
        box.appendChild(pre);
      }
    }
    if (rec.resultText != null) renderToolResult(rec);
  }
  function renderToolResult(rec) {
    rec.resultEl.hidden = false;
    rec.resultEl.classList.toggle('bad', !!rec.isError);
    const pre = el('pre', 'tresult');
    pre.textContent = rec.resultText || (rec.isError ? '(오류)' : '(결과 없음)');
    rec.resultEl.replaceChildren(pre);
  }
  function setToolResult(c, ev) {
    const rec = c.tools.get(ev.toolUseId);
    if (!rec) return;
    rec.resultText = ev.text || '';
    rec.isError = !!ev.isError;
    if (rec.prog) rec.prog.remove();
    if (!rec.body.hidden) renderToolResult(rec);
    if (rec.agent) {
      rec.agent.done = true;
      rec.agent.result = rec.resultText || (rec.isError ? '오류' : '');
      settleStream(c, rec.agent, null);
      logAct(rec.agent, { kind: 'tool', tool: '결과', summary: (rec.isError ? '오류: ' : '') + clip(rec.resultText, 80), text: rec.resultText });
      deps.onState(c);
    } else {
      const wrap = rec.root.closest('.tcard.agent'); // 서브에이전트 안의 도구면 겉 활동에 한 줄 남긴다
      const outer = wrap && c.agents.get(wrap.dataset.tu);
      if (outer) logAct(outer, { kind: ev.isError ? 'error' : 'tool', tool: rec.name, summary: clip(rec.resultText, 80), text: rec.resultText });
    }
  }
  const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  function logAct(a, act) {
    if (act.kind === 'tool' && act.tool) a.lastAction = `${act.tool} ${act.summary || ''}`.trim();
    else if (act.kind === 'error') a.lastAction = `오류: ${act.summary || clip(act.text, 60)}`;
    a.acts.push(act);
    if (a.acts.length > 300) a.acts.splice(0, a.acts.length - 300);
  }
  function agentBlocks(c, a, blocks) {
    let firstText = true;
    for (const b of blocks) {
      if (b.kind === 'text') {
        if (firstText && a.stream && a.stream.el) settleStream(c, a, b.text);
        else {
          const d = el('div', 'msg ai sub');
          const bb = el('div', 'bubble md');
          bb.innerHTML = md(b.text);
          d.appendChild(bb);
          a.el.appendChild(d);
        }
        firstText = false;
        logAct(a, { kind: 'text', tool: '', summary: '', text: clip(b.text, 300) });
      } else if (b.kind === 'tool' && b.id) {
        addTool(c, b, a);
        a.lastAction = `${b.name} ${b.summary || ''}`.trim();
      }
    }
    if (!blocks.some(b => b.kind === 'text') && a.stream) settleStream(c, a, null);
  }

  // ── 대기 카드(권한·질문·계획). 서브에이전트가 묻는 것도 대화 맨 아래에 띄운다(접힌 카드 안에 숨지 않게).
  function cardShell(c, cls, ev) {
    const card = el('div', `card ${cls}`);
    if (ev.requestId) card.dataset.req = ev.requestId;
    append(c, card);
    return card;
  }
  function addPermCard(c, ev) {
    const card = cardShell(c, 'perm', ev);
    card.innerHTML = `
<div class="card-title"><b class="ct-tool"></b><span class="ct-sum"></span></div>
${ev.reason ? '<div class="card-sub reason"></div>' : ''}
${ev.blockedPath ? '<div class="card-sub"><span class="lbl">대상</span><code class="bpath"></code></div>' : ''}
<div class="card-detail" hidden><pre></pre></div>
<div class="card-actions">
<button type="button" class="btn sm primary" data-a="allow">허용</button>
${ev.canAlways ? '<button type="button" class="btn sm" data-a="always">항상 허용</button>' : ''}
<button type="button" class="btn sm" data-a="deny">거부</button>
<button type="button" class="btn ghost sm" data-a="detail">입력 보기</button>
</div>
<div class="card-deny" hidden><input type="text" placeholder="거부 사유 (선택)"><button type="button" class="btn sm" data-a="deny-ok">거부 확정</button></div>`;
    $('.ct-tool', card).textContent = ev.tool || '도구';
    $('.ct-sum', card).textContent = ev.summary || '';
    if (ev.reason) $('.reason', card).textContent = `사유: ${ev.reason}`;
    if (ev.blockedPath) $('.bpath', card).textContent = ev.blockedPath;
    const detail = $('.card-detail', card);
    $('pre', detail).textContent = JSON.stringify(ev.input ?? {}, null, 2);
    const rec = { kind: 'perm', card, one: `${ev.tool || '도구'} ${ev.summary || ''}`.trim() };
    c.reqs.set(ev.requestId, rec);
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'allow') respond(c, ev.requestId, { allow: true });
      else if (a === 'always') respond(c, ev.requestId, { allow: true, always: true });
      else if (a === 'deny') { const d = $('.card-deny', card); d.hidden = false; $('input', d).focus(); }
      else if (a === 'deny-ok') respond(c, ev.requestId, { allow: false, message: $('.card-deny input', card).value.trim() || undefined });
      else if (a === 'detail') detail.hidden = !detail.hidden;
    });
    card.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); respond(c, ev.requestId, { allow: true }); }
      else if (e.key === 'Escape') { e.preventDefault(); respond(c, ev.requestId, { allow: false }); }
    });
    card.tabIndex = -1;
    focusCard(c, card);
    deps.onState(c);
  }
  function focusCard(c, card) {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
    if (!typing && !c.el.hidden) {
      const b = $('.card-actions [data-a="allow"], .card-actions [data-a="send"]', card) || card;
      b.focus();
    }
  }
  function addQuestionCard(c, ev) {
    const card = cardShell(c, 'ask', ev);
    const qs = (Array.isArray(ev.questions) ? ev.questions : []).map((q, qi) => `
<fieldset class="ask-q" data-qi="${qi}">
<legend></legend>
${(Array.isArray(q.options) ? q.options : []).map((o, oi) => `
<label class="ask-opt"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${c.id}-${qi}" value="${oi}">
<span class="ao"><span class="ao-l"></span><span class="ao-d muted"></span></span></label>`).join('')}
<label class="ask-other"><span class="muted">직접 입력</span><input type="text" placeholder="다른 답을 직접 적으세요"></label>
</fieldset>`).join('');
    card.innerHTML = `${qs}<div class="card-actions"><button type="button" class="btn sm primary" data-a="send" disabled>보내기</button><button type="button" class="btn ghost sm" data-a="skip">건너뛰기</button></div>`;
    (Array.isArray(ev.questions) ? ev.questions : []).forEach((q, qi) => {
      const fs = $(`.ask-q[data-qi="${qi}"]`, card);
      $('legend', fs).textContent = q.header || q.question || `질문 ${qi + 1}`;
      const labs = $$('.ask-opt', fs);
      (Array.isArray(q.options) ? q.options : []).forEach((o, oi) => {
        if (!labs[oi]) return;
        $('.ao-l', labs[oi]).textContent = o.label || '';
        $('.ao-d', labs[oi]).textContent = o.description || '';
      });
      fs.addEventListener('change', () => checkAsk(card));
      fs.addEventListener('input', () => checkAsk(card));
    });
    const rec = { kind: 'ask', card, one: '질문' };
    c.reqs.set(ev.requestId, rec);
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'send') {
        const answers = {}, other = {};
        (Array.isArray(ev.questions) ? ev.questions : []).forEach((q, qi) => {
          const fs = $(`.ask-q[data-qi="${qi}"]`, card);
          const oth = $('.ask-other input', fs).value.trim();
          if (oth) { other[q.question] = oth; return; } // 직접 입력이 우선
          const checked = $$('.ask-opt input:checked', fs).map(i => Number(i.value));
          const opts = Array.isArray(q.options) ? q.options : [];
          const vals = checked.map(i => opts[i] && opts[i].label).filter(v => v != null);
          if (vals.length) answers[q.question] = q.multiSelect ? vals : vals[0];
        });
        respond(c, ev.requestId, { answers, other });
      } else if (b.dataset.a === 'skip') respond(c, ev.requestId, { cancel: true });
    });
    focusCard(c, card);
    deps.onState(c);
  }
  function checkAsk(card) {
    const btn = $('.card-actions [data-a="send"]', card);
    if (!btn) return;
    let all = true;
    for (const fs of $$('.ask-q', card)) {
      const answered = $$('.ask-opt input:checked', fs).length > 0 || $('.ask-other input', fs).value.trim() !== '';
      if (!answered) { all = false; break; }
    }
    btn.disabled = !all;
  }
  function addPlanCard(c, ev) {
    const card = cardShell(c, 'plan', ev);
    card.innerHTML = `<div class="tsec">계획</div><div class="plan-md md"></div>
<div class="card-actions">
<button type="button" class="btn sm primary" data-a="ok">승인</button>
<button type="button" class="btn sm" data-a="edit">수정 요청</button>
</div>
<div class="card-edit" hidden><input type="text" placeholder="무엇을 바꿀지 적으세요"><button type="button" class="btn sm" data-a="edit-ok">보내기</button></div>`;
    $('.plan-md', card).innerHTML = md(ev.plan || '');
    const rec = { kind: 'plan', card, one: '계획' };
    c.reqs.set(ev.requestId, rec);
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'ok') respond(c, ev.requestId, { allow: true });
      else if (b.dataset.a === 'edit') { const d = $('.card-edit', card); d.hidden = false; $('input', d).focus(); }
      else if (b.dataset.a === 'edit-ok') {
        const v = $('.card-edit input', card).value.trim();
        if (!v) { deps.toast('수정 요청 내용을 입력하세요', 'warn'); return; }
        respond(c, ev.requestId, { allow: false, message: v });
      }
    });
    focusCard(c, card);
    deps.onState(c);
  }
  function respond(c, requestId, answer) {
    if (!c.reqs.has(requestId)) return;
    if (hasApi('chatRespond')) api.chatRespond(c.id, requestId, answer).catch(() => {});
  }
  function onDone(c, ev) {
    const rec = c.reqs.get(ev.requestId);
    if (!rec) return;
    c.reqs.delete(ev.requestId);
    const label = OUTCOME[ev.outcome] || String(ev.outcome || '완료');
    rec.card.classList.add('done');
    rec.card.replaceChildren();
    rec.card.tabIndex = -1;
    const line = el('div', 'card-done');
    line.textContent = `${label} · ${rec.one}`;
    rec.card.appendChild(line);
    deps.onState(c);
  }

  // ── 상태·결과·오류
  function syncModelSel(c) {
    const kind = c.project.mode === 'glm' ? 'glm' : 'claude';
    const list = deps.models(kind) || [];
    const cur = c.model || '';
    let html = list.map(m => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('');
    if (cur && !list.some(m => m.id === cur)) html = `<option value="${esc(cur)}" selected>${esc(cur)} (현재)</option>${html}`;
    c.modelSel.innerHTML = html || `<option value="${esc(cur)}">${esc(cur || '모델')}</option>`;
  }
  function setBusy(c, busy, text) {
    c.busy = !!busy;
    c.stopBtn.hidden = !c.busy;
    if (c.busy && text) c.statEl.textContent = text;
    deps.onState(c);
  }
  function onResult(c, ev) {
    hideThinking(c);
    settleStream(c, c, null);
    $$('.queued', c.list).forEach(n => n.remove());
    const u = ev.usage || {};
    const sec = Math.round((ev.durationMs || 0) / 1000);
    const parts = [`입력 ${num(u.input).toLocaleString('en-US')}`, `출력 ${num(u.output).toLocaleString('en-US')}`, `${sec}초`];
    if (ev.turns) parts.unshift(`${ev.turns}턴`);
    c.statEl.textContent = parts.join(' · ');
    c.statEl.title = `캐시 읽기 ${num(u.cacheRead).toLocaleString('en-US')} · 캐시 쓰기 ${num(u.cacheCreate).toLocaleString('en-US')}`
      + (ev.costUsd ? ` · $${Number(ev.costUsd).toFixed(2)}` : '');
    deps.onState(c, 'result');
  }
  function onError(c, ev) {
    const box = el('div', 'card errc');
    if (ev.auth) {
      box.innerHTML = `<div class="card-title">로그인이 필요합니다</div><p class="muted">터미널에서 <code>claude</code>를 실행해 로그인한 뒤 다시 시도하세요.</p><div class="card-actions"><button type="button" class="btn sm" data-a="term">터미널 열기</button><button type="button" class="btn sm ghost" data-a="dismiss">닫기</button></div>`;
      $('[data-a="term"]', box).addEventListener('click', () => deps.openTerm(c.project, null));
      $('[data-a="dismiss"]', box).addEventListener('click', () => box.remove());
    } else {
      const pre = el('pre', 'errpre');
      pre.textContent = [ev.message, ev.stderr].filter(Boolean).join('\n');
      const title = el('div', 'card-title');
      title.textContent = '오류';
      box.appendChild(title);
      box.appendChild(pre);
    }
    const d = el('div', 'msg ai');
    d.appendChild(box);
    append(c, d);
  }
  function onClosed(c) {
    c.closed = true;
    c.busy = false;
    c.ta.disabled = true;
    c.sendBtn.hidden = true;
    c.stopBtn.hidden = true;
    c.reopenBar.hidden = false;
    hideThinking(c);
    settleStream(c, c, null);
    deps.onState(c);
  }

  // 권한 모드 셀렉트: 목록에 없는 모드(예: 설정의 auto)가 오면 항목을 만들어 빈 칸이 되지 않게 한다
  const PERM_LABEL = { auto: '권한: 자동', dontAsk: '권한: 묻지 않음' };
  function setPermSel(c) {
    const v = c.permissionMode || 'default';
    if (![...c.permSel.options].some(o => o.value === v)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = PERM_LABEL[v] || `권한: ${v}`;
      c.permSel.appendChild(o);
    }
    c.permSel.value = v;
  }

  // ── 입력
  function autosize(c) {
    c.ta.style.height = 'auto';
    const max = Math.max(80, Math.round(c.el.clientHeight * 0.4));
    const need = c.ta.scrollHeight + 2; // 테두리 2px 포함(border-box)
    c.ta.style.height = `${Math.min(need, max)}px`;
    c.ta.style.overflowY = need > max ? 'auto' : 'hidden'; // 내용이 넘칠 때만 스크롤 막대
  }
  async function send(c) {
    if (c.closed) return;
    const text = c.ta.value.replace(/\s+$/, '');
    if (!text.trim() && !c.images.length) return;
    const images = c.images.map(i => ({ mediaType: i.mediaType, data: i.data }));
    const r = await safe(() => api.chatSend(c.id, { text, images }));
    if (!r || !r.ok) { deps.toast((r && r.error) || '보내지 못했습니다', 'err'); return; }
    c.ta.value = '';
    autosize(c);
    closeAc(c);
    c.images = [];
    renderImages(c);
  }
  function interrupt(c) { if (hasApi('chatInterrupt')) safe(() => api.chatInterrupt(c.id)); }

  // ── 이미지 붙여넣기·끌어다 놓기
  function readImage(file) {
    return new Promise(resolve => {
      if (!IMAGE_TYPES[file.type]) { resolve({ err: 'png·jpeg·webp·gif 이미지만 넣을 수 있습니다' }); return; }
      if (file.size > IMAGE_BYTES) { resolve({ err: '이미지가 장당 5MB를 넘습니다' }); return; }
      const r = new FileReader();
      r.onload = () => resolve({ mediaType: file.type, data: String(r.result).split(',')[1] || '', name: file.name || '이미지', size: file.size });
      r.onerror = () => resolve({ err: '이미지를 읽지 못했습니다' });
      r.readAsDataURL(file);
    });
  }
  async function addImages(c, files) {
    for (const f of files) {
      if (c.images.length >= IMAGE_MAX) { deps.toast(`이미지는 최대 ${IMAGE_MAX}장까지입니다`, 'warn'); break; }
      if (!f.type.startsWith('image/')) continue;
      const r = await readImage(f);
      if (r.err) { deps.toast(r.err, 'warn'); continue; }
      c.images.push(r);
    }
    renderImages(c);
  }
  function renderImages(c) {
    c.imgsEl.hidden = c.images.length === 0;
    c.imgsEl.replaceChildren(...c.images.map((im, i) => {
      const chip = el('span', 'img-chip');
      const name = el('span', 'img-name');
      name.textContent = `${im.name} (${(im.size / 1024 / 1024).toFixed(1)}MB)`;
      const x = el('button', 'img-x');
      x.type = 'button';
      x.setAttribute('aria-label', '이미지 빼기');
      x.textContent = '×';
      x.addEventListener('click', () => { c.images.splice(i, 1); renderImages(c); });
      chip.append(name, x);
      return chip;
    }));
  }

  // ── / 명령 자동완성
  function loadCommands(c) {
    if (c.commands) return Promise.resolve(c.commands);
    if (c.cmdLoading || !hasApi('chatCommands')) return Promise.resolve([]);
    c.cmdLoading = true;
    return api.chatCommands(c.id)
      .then(r => { c.commands = r && Array.isArray(r.commands) ? r.commands : []; return c.commands; })
      .catch(() => []) // 실패해도 다시 시도할 수 있게 캐시하지 않는다
      .finally(() => { c.cmdLoading = false; });
  }
  function closeAc(c) { c.ac = { open: false, items: [], idx: -1 }; c.acEl.hidden = true; }
  function updateAc(c) {
    const v = c.ta.value;
    if (!/^\/[A-Za-z0-9가-힣-]*$/.test(v)) { closeAc(c); return; }
    loadCommands(c).then(cmds => {
      if (c.ta.value !== v) return;
      const q = v.slice(1).toLowerCase();
      const items = cmds.filter(x => x.name && x.name.toLowerCase().includes(q)).slice(0, 8);
      if (!items.length) { closeAc(c); return; }
      c.ac = { open: true, items, idx: 0 };
      c.acEl.hidden = false;
      c.acEl.innerHTML = items.map((x, i) => `<button type="button" class="ac-item${i === 0 ? ' on' : ''}" data-i="${i}"><b>${esc(x.name)}</b><span class="muted">${esc(x.argumentHint || '')}</span><span class="ac-desc">${esc(x.description || '')}</span></button>`).join('');
    });
  }
  function pickAc(c) {
    const item = c.ac.items[c.ac.idx];
    if (!item) return;
    c.ta.value = `/${item.name} `;
    closeAc(c);
    autosize(c);
    c.ta.focus();
  }
  function moveAc(c, d) {
    if (!c.ac.open || !c.ac.items.length) return;
    c.ac.idx = (c.ac.idx + d + c.ac.items.length) % c.ac.items.length;
    $$('.ac-item', c.acEl).forEach((n, i) => n.classList.toggle('on', i === c.ac.idx));
  }

  // ── 이벤트 연결
  function wire(c) {
    c.ta.addEventListener('input', () => { autosize(c); updateAc(c); });
    c.ta.addEventListener('keydown', e => {
      if (c.ac.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(c, 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(c, -1); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); pickAc(c); return; }
        if (e.key === 'Escape') { closeAc(c); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(c); return; }
      if (e.key === 'Escape' && c.busy) { // Esc 두 번 = 중단
        const now = Date.now();
        if (now - c.lastEsc < 700) { interrupt(c); c.lastEsc = 0; }
        else c.lastEsc = now;
      }
    });
    c.ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addImages(c, files); }
    });
    c.el.addEventListener('dragover', e => e.preventDefault());
    c.el.addEventListener('drop', e => {
      e.preventDefault();
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (files.length) addImages(c, files);
    });
    c.sendBtn.addEventListener('click', () => send(c));
    c.stopBtn.addEventListener('click', () => interrupt(c));
    c.jumpBtn.addEventListener('click', () => scrollEnd(c));
    c.foldBtn.addEventListener('click', () => unfold(c));
    c.modelSel.addEventListener('change', async () => {
      const r = await safe(() => api.chatSetModel(c.id, c.modelSel.value));
      if (r && r.ok) c.model = c.modelSel.value;
      else syncModelSel(c);
    });
    c.permSel.addEventListener('change', async () => {
      const v = c.permSel.value;
      if (v === 'bypassPermissions' && !confirm('전부 허용은 모든 도구 실행을 묻지 않고 진행합니다. 계속할까요?')) { setPermSel(c); return; }
      const r = await safe(() => api.chatSetPermissionMode(c.id, v));
      if (r && r.ok) c.permissionMode = (r.mode || v);
      else setPermSel(c);
    });
    c.sidBtn.addEventListener('click', () => {
      if (c.sessionId) navigator.clipboard.writeText(c.sessionId).then(() => deps.toast('세션 id를 복사했습니다')).catch(() => {});
    });
    $('.chat-toterm', c.el).addEventListener('click', () => toTerm(c));
    $('.chat-reopen-btn', c.reopenBar).addEventListener('click', () => reopen(c));
    c.list.addEventListener('scroll', () => { c.jumpBtn.hidden = nearBottom(c); });
    c.list.addEventListener('click', e => {
      const line = e.target.closest('.tcard-line');
      if (line) {
        const rec = c.tools.get(line.parentElement.dataset.tu);
        line.setAttribute('aria-expanded', String(!!rec && rec.body.hidden));
        if (rec && rec.body.hidden) expandTool(rec);
        else if (rec) rec.body.hidden = true;
      }
      // 코드 복사 버튼과 http(s) 링크는 app.js의 문서 단위 위임이 처리한다
    });
    c.acEl.addEventListener('mousedown', e => e.preventDefault()); // 클릭해도 입력창 포커스 유지
    c.acEl.addEventListener('click', e => {
      const b = e.target.closest('.ac-item');
      if (b) { c.ac.idx = Number(b.dataset.i) || 0; pickAc(c); }
    });
  }

  // ── 터미널로 옮기기·다시 열기
  async function toTerm(c) {
    if (c.busy && !confirm('응답 중입니다. 중단하고 터미널로 옮길까요?')) return;
    const sid = c.sessionId;
    const p = c.project;
    await close(c.id, { force: true });
    deps.openTerm(p, sid);
  }
  async function reopen(c) {
    const p = c.project;
    const sid = c.sessionId;
    const title = c.title;
    discard(c.id);
    await open(p, { resume: sid, title });
  }
  function discard(id) { // 화면만 지운다(호스트에는 아무 요청도 보내지 않는다)
    const c = chats.get(id);
    if (!c) return;
    if (c.stream && c.stream.raf) cancelAnimationFrame(c.stream.raf);
    c.el.remove();
    chats.delete(id);
    deps.onClosed(id);
  }

  // ── 이벤트 배분
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const c = chats.get(ev.chat);
    if (!c) return; // 모르는 chatId는 조용히 무시한다
    switch (ev.type) {
      case 'init':
        c.sessionId = ev.sessionId || c.sessionId;
        if (ev.model) c.model = ev.model;
        if (ev.permissionMode) c.permissionMode = ev.permissionMode;
        if (Array.isArray(ev.agents)) c.agentTypes = ev.agents;
        c.sidBtn.hidden = !c.sessionId;
        c.sidBtn.textContent = String(c.sessionId || '').slice(0, 8);
        c.sidBtn.title = `세션 id 복사: ${c.sessionId || ''}`;
        syncModelSel(c);
        setPermSel(c);
        break;
      case 'user': addUser(c, ev.text || '', num(ev.images), !!ev.queued); break;
      case 'thinking': if (!ev.parent) showThinking(c); break;
      case 'delta': onDelta(c, ev); break;
      case 'assistant': onAssistant(c, ev); break;
      case 'tool-result': onToolResult(c, ev); break;
      case 'permission': addPermCard(c, ev); break;
      case 'question': addQuestionCard(c, ev); break;
      case 'plan': addPlanCard(c, ev); break;
      case 'request-done': onDone(c, ev); break;
      case 'status': setBusy(c, ev.busy, ev.text); break;
      case 'compact': {
        const d = el('div', 'msg ai');
        const b = el('div', 'bubble compact-note');
        b.textContent = '대화를 압축했습니다';
        d.appendChild(b);
        append(c, d);
        break;
      }
      case 'result': onResult(c, ev); break;
      case 'error': onError(c, ev); break;
      case 'closed': onClosed(c); break;
      default: break; // raw 등 모르는 type은 조용히 무시
    }
  }
  function onAssistant(c, ev) {
    const blocks = Array.isArray(ev.blocks) ? ev.blocks : [];
    if (ev.parent) {
      const a = c.agents.get(ev.parent);
      if (a) agentBlocks(c, a, blocks);
      return;
    }
    hideThinking(c);
    let firstText = true;
    for (const b of blocks) {
      if (b.kind === 'text') {
        if (firstText && c.stream && c.stream.el) settleStream(c, c, b.text);
        else appendText(c, b.text);
        firstText = false;
      } else if (b.kind === 'tool' && b.id) addTool(c, b, null);
    }
    if (!blocks.some(b => b.kind === 'text') && c.stream) settleStream(c, c, null);
    if (ev.model) { c.model = ev.model; syncModelSel(c); }
    deps.onState(c);
  }
  function onToolResult(c, ev) {
    if (ev.parent && !c.tools.has(ev.toolUseId)) {
      const a = c.agents.get(ev.parent);
      if (a) logAct(a, { kind: ev.isError ? 'error' : 'tool', tool: '', summary: clip(ev.text, 80), text: ev.text || '' });
    }
    if (c.tools.has(ev.toolUseId)) setToolResult(c, ev);
  }

  // ── 공개 API
  // 이어 열 때: 지난 대화를 먼저 그려 둔다(읽기 전용. 도구 사용은 한 줄 요약으로)
  async function paintHistory(c, projectId, sessionId) {
    if (!hasApi('historyRead')) return;
    const r = await safe(() => api.historyRead(projectId, sessionId, { limit: 200, tail: true }));
    if (!r || !r.ok || !Array.isArray(r.messages) || !r.messages.length) return;
    if (r.truncated) { const n = el('div', 'hist-note muted'); n.textContent = `이전 메시지 ${r.total - r.messages.length}개는 지난 대화 목록의 기록 보기에서 볼 수 있습니다`; append(c, n); }
    for (const m of r.messages) {
      if (m.role === 'user') { if (m.text) addUser(c, m.text, 0, false); continue; }
      if (m.text) appendText(c, m.text);
      if (Array.isArray(m.tools) && m.tools.length) {
        const t = el('div', 'hist-tools muted');
        for (const x of m.tools) { const line = el('div', ''); line.textContent = `▸ ${x.name} ${x.summary || ''}`; t.appendChild(line); }
        append(c, t);
      }
    }
    const sep = el('div', 'hist-sep muted'); sep.textContent = '여기까지 지난 대화'; append(c, sep);
    requestAnimationFrame(() => scrollEnd(c)); // 이어 열면 맨 아래(가장 최근)부터 보이게
  }
  async function open(project, opts = {}) {
    if (!hasApi('chatOpen') || !hasApi('onChatEvent')) { deps.toast('이 앱 버전에서는 채팅을 지원하지 않습니다 (앱 업데이트 필요)', 'warn'); return null; }
    if (opts.resume) {
      const hit = [...chats.values()].find(c => c.sessionId === opts.resume);
      if (hit) { deps.onActivate(hit.id); return hit; }
    }
    const r = await safe(() => api.chatOpen({ projectId: project.id, resume: opts.resume || undefined }));
    if (!r || !r.ok) { deps.toast((r && r.error) || '채팅을 열지 못했습니다', 'err'); return null; }
    const c = create(project, r.chatId, opts.title || '');
    syncModelSel(c);
    c.permSel.value = 'default';
    if (opts.resume) await paintHistory(c, project.id, opts.resume);
    deps.onSession(c.id);
    return c;
  }
  async function close(id, opts = {}) {
    const c = chats.get(id);
    if (!c) return true;
    if (!opts.force && (c.busy || c.reqs.size > 0) && !confirm('응답 중인 대화 탭을 닫을까요? 진행 중인 작업이 멈춥니다.')) return false;
    if (hasApi('chatClose')) { try { await api.chatClose(id); } catch { /* 이미 닫힘 */ } }
    discard(id);
    return true;
  }
  const show = id => { for (const c of chats.values()) c.el.hidden = c.id !== id; };
  const info = c => ({ id: c.id, title: c.title, projectId: c.projectId, sessionId: c.sessionId, busy: c.busy, pending: c.reqs.size, mode: c.project.mode, closed: c.closed });
  const views = () => [...chats.values()].map(info);
  function agentsOf(projectId) {
    const out = [];
    for (const c of chats.values()) {
      if (c.projectId !== projectId) continue;
      for (const a of c.agents.values()) out.push({ id: a.id, chatId: c.id, type: a.type, description: a.description, prompt: a.prompt, state: a.done ? 'done' : 'running', lastAction: a.lastAction, acts: a.acts, result: a.result });
    }
    return out;
  }
  function init(d) {
    deps = d;
    if (hasApi('onChatEvent')) api.onChatEvent(onEvent);
  }
  return { init, open, close, show, views, agentsOf, count: () => chats.size };
})();
