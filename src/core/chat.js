'use strict';
// 채팅 세션 호스트: @anthropic-ai/claude-agent-sdk의 query()를 스트리밍 입력 모드로 구동해
// 여러 채팅 세션을 관리하고, SDK 메시지를 렌더러가 그리기 쉬운 직렬화 가능한 이벤트로 바꿔 내보낸다.
// Electron 의존 없음. loadSdk를 주입받는다(앱에서는 ESM 동적 import, 테스트에서는 가짜).

const INPUT_JSON_MAX = 4000;
const TEXT_MAX = 4000;
const SUMMARY_MAX = 120;
const SUMMARY_KEYS = ['file_path', 'command', 'pattern', 'description', 'prompt', 'url', 'skill', 'query'];
const STDERR_LINES = 20;
const AUTH_RE = /login|auth|401|credential/i;
const FATAL_STDERR_RE = /fatal|panic|crash|\berror\b/i;

/** 긴 문자열을 n자로 자르고 잘린 길이를 표시한다. */
function cut(text, n) {
  const s = String(text);
  if (s.length <= n) return s;
  return s.slice(0, n) + `…(+${s.length - n})`;
}

/** json 길이가 한도를 넘는 입력의 문자열 값들을 점점 짧게 잘라 줄인다. */
function shrinkInput(input) {
  let json;
  try { json = JSON.stringify(input); } catch { return {}; }
  if (json === undefined || json.length <= INPUT_JSON_MAX) return input;
  let limit = 256;
  for (;;) {
    const reduced = truncStrings(input, limit);
    let len;
    try { len = JSON.stringify(reduced).length; } catch { return {}; }
    if (len <= INPUT_JSON_MAX || limit <= 16) return reduced;
    limit = Math.floor(limit / 2);
  }
}

function truncStrings(value, limit) {
  if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) + `…(+${value.length - limit})` : value;
  if (Array.isArray(value)) return value.map(v => truncStrings(v, limit));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncStrings(v, limit);
    return out;
  }
  return value;
}

/** input에서 요약으로 쓸 첫 문자열 값(summary 키 순서)을 찾는다. */
function summarize(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of SUMMARY_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v) return cut(v, SUMMARY_MAX);
  }
  return null;
}

/** stderr·오류 문구에서 키·토큰처럼 보이는 값을 가린다. */
function redact(line) {
  return String(line)
    .replace(/sk-[A-Za-z0-9_.-]{4,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9+/=]{32,}/g, '***');
}

function redactTail(lines) {
  return lines.map(redact).join('\n');
}

/** 이벤트를 직렬화 가능한 모양으로: undefined 값과 항목을 제거한다(null은 유지). */
function clean(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(v => clean(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

function toolResultText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return cut(content, TEXT_MAX);
  if (Array.isArray(content)) {
    const parts = content.map(b => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return cut(String(b.text ?? ''), TEXT_MAX);
      if (b.type === 'image') return '[이미지]';
      if (b.type === 'document') return '[문서]';
      return '';
    }).filter(Boolean);
    return cut(parts.join('\n'), TEXT_MAX);
  }
  return '';
}

function createChatHost({ loadSdk, onEvent, permissionTimeoutMs } = {}) {
  if (typeof onEvent !== 'function') throw new Error('createChatHost: onEvent 콜백이 필요합니다');
  const sessions = new Map();
  let reqN = 0;
  let sdkPromise = null;

  function getSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve()
        .then(() => (typeof loadSdk === 'function' ? loadSdk() : import('@anthropic-ai/claude-agent-sdk')))
        .then(mod => {
          const query = mod && (mod.query || (mod.default && mod.default.query));
          if (typeof query !== 'function') throw new Error('SDK에 query가 없습니다');
          return { query };
        })
        .catch(err => {
          sdkPromise = null; // 다음 open에서 재시도
          throw err;
        });
    }
    return sdkPromise;
  }

  // onEvent가 던져도 세션은 죽지 않는다. 닫힌 세션으로는 아무 이벤트도 내보내지 않는다.
  function emit(s, ev) {
    if (s.closed) return;
    try {
      const out = clean({ chat: s.id, ...ev });
      if (out) onEvent(out);
    } catch { /* 이벤트 소비자의 실패가 세션을 죽이지 않는다 */ }
  }

  function emitError(s, message, extra) {
    const m = String((message && message.message) || message || '알 수 없는 오류');
    const ev = { type: 'error', message: cut(m, 2000) };
    if (s.stderrTail.length) ev.stderr = redactTail(s.stderrTail);
    if (extra) Object.assign(ev, extra);
    if (AUTH_RE.test(m)) ev.auth = true;
    emit(s, ev);
  }

  /** 스트림이 끝났을 때의 공통 정리. close()가 이미 닫았으면 아무것도 하지 않는다. */
  function finish(s, reason) {
    if (s.closed) return;
    // 순서: 대기 요청 정리(request-done) → closed 이벤트 → 새 이벤트 차단.
    // closed 이벤트는 s.closed를 set하기 전에 내보내야 emit 가드를 통과한다.
    for (const req of s.pending.values()) settle(s, req, { behavior: 'deny', message: '세션이 끝났습니다' }, 'cancelled');
    emit(s, { type: 'closed', reason });
    s.closed = true;
    s.inputClosed = true;
    wakeInput(s);
    sessions.delete(s.id);
  }

  // ── 입력 스트림: 닫힐 때까지 끝나지 않는 async iterable. send가 push, close가 return한다. ──
  function wakeInput(s) {
    if (s.pullRes) {
      const resolve = s.pullRes;
      // next()가 기다리던 약속은 반드시 반복자 결과 객체로 풀어야 한다(빈 값이면 SDK가 세션을 끊는다)
      if (s.queue.length) { s.pullRes = null; resolve({ done: false, value: s.queue.shift() }); }
      else if (s.inputClosed) { s.pullRes = null; resolve({ done: true, value: undefined }); }
    }
  }

  function makeInputStream(s) {
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (s.queue.length) return Promise.resolve({ done: false, value: s.queue.shift() });
        if (s.inputClosed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => { s.pullRes = resolve; });
      },
      return() {
        s.inputClosed = true;
        wakeInput(s);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  // ── 권한·질문·계획 요청 ──
  function settle(s, req, result, outcome) {
    if (s.pending.get(req.requestId) !== req) return;
    s.pending.delete(req.requestId);
    if (req.timer) clearTimeout(req.timer);
    if (req.onAbort && req.signal) req.signal.removeEventListener('abort', req.onAbort);
    emit(s, { type: 'request-done', requestId: req.requestId, outcome });
    req.resolve(result);
  }

  function expire(s, req) {
    settle(s, req, { behavior: 'deny', message: '요청 시간이 초과되었습니다' }, 'timeout');
  }

  async function canUseTool(toolName, input, opts) {
    const s = this;
    if (s.closed) return { behavior: 'deny', message: '세션이 닫혀 있습니다' };
    const requestId = `req${(reqN++).toString(36)}`;
    const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission';
    const req = {
      requestId,
      kind,
      suggestions: Array.isArray(opts.suggestions) && opts.suggestions.length ? opts.suggestions : null,
      signal: opts.signal,
      resolve: null,
      timer: null,
      onAbort: null,
    };
    const promise = new Promise(resolve => { req.resolve = resolve; });
    s.pending.set(requestId, req);
    const base = { requestId, parent: opts.agentID || null };
    if (kind === 'question') {
      const questions = Array.isArray(input && input.questions) ? input.questions : [];
      req.rawQuestions = questions;
      req.inputQuestions = questions.map(q => ({ text: String(q.question ?? '') }));
      emit(s, {
        type: 'question',
        ...base,
        questions: questions.map(q => ({
          question: String(q.question ?? ''),
          header: String(q.header ?? ''),
          multiSelect: !!q.multiSelect,
          options: (Array.isArray(q.options) ? q.options : []).map(o => ({
            label: String(o.label ?? ''),
            description: String(o.description ?? ''),
          })),
        })),
      });
    } else if (kind === 'plan') {
      emit(s, { type: 'plan', ...base, plan: String((input && input.plan) ?? '') });
    } else {
      emit(s, {
        type: 'permission',
        ...base,
        tool: toolName,
        input: shrinkInput(input),
        summary: summarize(input),
        reason: typeof opts.decisionReason === 'string' && opts.decisionReason ? cut(opts.decisionReason, SUMMARY_MAX) : null,
        blockedPath: typeof opts.blockedPath === 'string' && opts.blockedPath ? opts.blockedPath : null,
        canAlways: !!req.suggestions,
      });
    }
    if (permissionTimeoutMs > 0) req.timer = setTimeout(() => expire(s, req), permissionTimeoutMs);
    if (opts.signal) {
      req.onAbort = () => settle(s, req, { behavior: 'deny', message: '요청이 중단되었습니다' }, 'cancelled');
      if (opts.signal.aborted) req.onAbort();
      else opts.signal.addEventListener('abort', req.onAbort, { once: true });
    }
    return promise;
  }

  function denyResult(message, interrupt) {
    const out = { behavior: 'deny', message: message || '사용자가 거부했습니다' };
    if (interrupt) out.interrupt = true;
    return out;
  }

  // ── SDK 메시지 → 이벤트 ──
  function handleMessage(s, msg) {
    if (s.closed) return;
    const type = msg && msg.type;
    const parent = msg.parent_tool_use_id || null;
    if (type === 'system') {
      if (msg.subtype === 'init') {
        s.sessionId = msg.session_id || s.sessionId;
        if (msg.model) s.model = msg.model;
        if (msg.permissionMode) s.permissionMode = msg.permissionMode;
        const ev = {
          type: 'init',
          sessionId: msg.session_id,
          model: msg.model,
          permissionMode: msg.permissionMode,
          tools: Array.isArray(msg.tools) ? msg.tools : [],
          cwd: msg.cwd,
        };
        if (Array.isArray(msg.agents) && msg.agents.length) ev.agents = msg.agents;
        emit(s, ev);
        return;
      }
      if (msg.subtype === 'compact_boundary') { emit(s, { type: 'compact' }); return; }
      if (msg.subtype === 'status') {
        if (msg.permissionMode) s.permissionMode = msg.permissionMode;
        const ev = { type: 'status', busy: s.busy };
        if (typeof msg.status === 'string' && msg.status) ev.text = msg.status;
        emit(s, ev);
        return;
      }
      emit(s, { type: 'raw', sdkType: type, subtype: msg.subtype });
      return;
    }
    if (type === 'stream_event') {
      if (parent) return; // 부분 출력은 메인 스레드 것만 delta로
      const ev = msg.event;
      if (!ev || ev.type !== 'content_block_delta' || !ev.delta) return;
      const d = ev.delta;
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        emit(s, { type: 'delta', text: d.text, parent: null });
      } else if (d.type === 'thinking_delta' && !s.thinkingSeen) {
        s.thinkingSeen = true;
        emit(s, { type: 'thinking', active: true });
      }
      return;
    }
    if (type === 'assistant') {
      if (msg.error) emitError(s, String(msg.error));
      const blocks = [];
      const content = (msg.message && Array.isArray(msg.message.content)) ? msg.message.content : [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text) blocks.push({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') blocks.push({
          kind: 'tool',
          id: b.id,
          name: b.name,
          summary: summarize(b.input),
          input: shrinkInput(b.input),
        });
        // thinking 블록은 뺀다
      }
      if (blocks.length) emit(s, { type: 'assistant', blocks, model: msg.message && msg.message.model, parent });
      return;
    }
    if (type === 'user') {
      const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const b of content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
        emit(s, {
          type: 'tool-result',
          toolUseId: b.tool_use_id,
          isError: !!b.is_error,
          text: toolResultText(b.content),
          parent,
        });
      }
      return;
    }
    if (type === 'result') {
      s.thinkingSeen = false;
      const usage = msg.usage || {};
      const ev = {
        type: 'result',
        subtype: msg.subtype,
        isError: !!msg.is_error,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0,
        usage: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreate: usage.cache_creation_input_tokens ?? 0,
        },
        turns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
      };
      if (typeof msg.result === 'string' && msg.result) ev.text = cut(msg.result, TEXT_MAX);
      else if (Array.isArray(msg.errors) && msg.errors.length) ev.text = cut(msg.errors.map(redact).join('\n'), TEXT_MAX);
      emit(s, ev);
      if (!s.queue.length && s.busy) {
        s.busy = false;
        emit(s, { type: 'status', busy: false });
      }
      return;
    }
    emit(s, { type: 'raw', sdkType: type, subtype: msg.subtype });
  }

  async function consume(s, query) {
    try {
      for await (const msg of query) handleMessage(s, msg);
      // 입력 없이 스트림이 저절로 끝났는데 마지막 stderr가 치명적으로 보이면 오류로 본다
      const last = s.stderrTail[s.stderrTail.length - 1];
      if (last && FATAL_STDERR_RE.test(last)) {
        emitError(s, last);
        finish(s, 'error');
        return;
      }
      finish(s, 'ended');
    } catch (err) {
      if (s.closed) return; // close()가 이미 정리했다
      emitError(s, err);
      finish(s, 'error');
    }
  }

  // ── 공개 API ──
  async function open(opts) {
    const { id, cwd, env, model, effort, resume, permissionMode, claudePath, appendSystemPrompt, extraArgs } = opts || {};
    if (!id || typeof id !== 'string' || sessions.has(id)) {
      return { ok: false, error: sessions.has(id) ? '이미 열린 세션 id입니다' : '세션 id가 필요합니다' };
    }
    let sdk;
    try {
      sdk = await getSdk();
    } catch (err) {
      return { ok: false, error: cut((err && err.message) || String(err), 500) };
    }
    const s = {
      id,
      cwd: cwd || '',
      closed: false,
      busy: false,
      thinkingSeen: false,
      sessionId: null,
      model: model || null,
      permissionMode: permissionMode || null,
      queue: [],
      inputClosed: false,
      pullRes: null,
      pending: new Map(),
      stderrTail: [],
      query: null,
      abort: new AbortController(),
    };
    sessions.set(id, s);
    const canUse = canUseTool.bind(s);
    const options = { settingSources: ['user', 'project', 'local'], includePartialMessages: true, canUseTool: canUse, abortController: s.abort };
    if (cwd !== undefined) options.cwd = cwd;
    if (env !== undefined) options.env = env; // 받은 그대로(호출자가 완성한 환경)
    if (model) options.model = model;
    if (effort) options.effort = effort;
    if (resume) options.resume = resume;
    if (permissionMode) options.permissionMode = permissionMode;
    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
    options.systemPrompt = appendSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: appendSystemPrompt }
      : { type: 'preset', preset: 'claude_code' };
    if (extraArgs && typeof extraArgs === 'object') options.extraArgs = extraArgs;
    options.stderr = data => {
      for (const line of String(data).split('\n')) {
        if (line === '') continue;
        s.stderrTail.push(line);
        if (s.stderrTail.length > STDERR_LINES) s.stderrTail.shift();
      }
    };
    try {
      s.query = sdk.query({ prompt: makeInputStream(s), options });
    } catch (err) {
      sessions.delete(id);
      return { ok: false, error: cut((err && err.message) || String(err), 500) };
    }
    consume(s, s.query); // 순서 보장을 위해 한 루프에서 순서대로 소비한다
    return { ok: true };
  }

  function send(id, { text, images } = {}) {
    const s = sessions.get(id);
    if (!s || s.closed) return { ok: false, error: '닫힌 세션입니다' };
    const t = typeof text === 'string' ? text : '';
    const imgs = Array.isArray(images) ? images.filter(i => i && typeof i.data === 'string' && i.data) : [];
    if (!t && !imgs.length) return { ok: false, error: '보낼 내용이 없습니다' };
    const message = imgs.length
      ? {
          role: 'user',
          content: [
            ...(t ? [{ type: 'text', text: t }] : []),
            ...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType || 'image/png', data: i.data } })),
          ],
        }
      : { role: 'user', content: t };
    const queued = s.busy;
    s.queue.push({ type: 'user', message, parent_tool_use_id: null });
    wakeInput(s);
    emit(s, { type: 'user', text: t, images: imgs.length, queued });
    if (!s.busy) {
      s.busy = true;
      emit(s, { type: 'status', busy: true });
    }
    return { ok: true };
  }

  function respond(id, requestId, answer) {
    const s = sessions.get(id);
    if (!s) return { ok: false, error: '세션이 없습니다' };
    const req = s.pending.get(requestId);
    if (!req) return { ok: false, error: '정리된 요청입니다' };
    const a = answer && typeof answer === 'object' ? answer : {};
    if (req.kind === 'question') {
      if (a.cancel) { settle(s, req, denyResult(), 'deny'); return { ok: true }; }
      const answers = a.answers && typeof a.answers === 'object' ? a.answers : {};
      const other = a.other && typeof a.other === 'object' ? a.other : {};
      const out = {};
      for (const q of req.inputQuestions) {
        const chosen = answers[q.text];
        if (chosen !== undefined) out[q.text] = chosen;
        else if (typeof other[q.text] === 'string' && other[q.text]) out[q.text] = other[q.text];
      }
      settle(s, req, { behavior: 'allow', updatedInput: { questions: req.rawQuestions, answers: out } }, 'answered');
      return { ok: true };
    }
    if (req.kind === 'plan') {
      if (a.allow) settle(s, req, { behavior: 'allow' }, 'allow');
      else settle(s, req, denyResult(a.message), 'deny');
      return { ok: true };
    }
    if (a.allow) {
      const outcome = a.always && req.suggestions ? 'always' : 'allow';
      const result = { behavior: 'allow' };
      if (a.always && req.suggestions) result.updatedPermissions = req.suggestions;
      settle(s, req, result, outcome);
      return { ok: true };
    }
    settle(s, req, denyResult(a.message), 'deny');
    return { ok: true };
  }

  function interrupt(id) {
    const s = sessions.get(id);
    if (!s || s.closed) return { ok: false, error: '닫힌 세션입니다' };
    for (const req of [...s.pending.values()]) {
      settle(s, req, denyResult('사용자가 중단했습니다', true), 'cancelled');
    }
    if (s.query && typeof s.query.interrupt === 'function') {
      s.query.interrupt().catch(() => {}); // 인터럽트 실패가 호스트를 죽이지 않는다
    }
    return { ok: true };
  }

  async function setModel(id, model) {
    const s = sessions.get(id);
    if (!s || s.closed) return { ok: false, error: '닫힌 세션입니다' };
    try {
      await s.query.setModel(model);
      s.model = model || null;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: cut((err && err.message) || String(err), 300) };
    }
  }

  async function setPermissionMode(id, mode) {
    const s = sessions.get(id);
    if (!s || s.closed) return { ok: false, error: '닫힌 세션입니다' };
    try {
      const res = await s.query.setPermissionMode(mode);
      s.permissionMode = (res && res.mode) || mode; // 실제 적용된 모드를 기록한다
      return { ok: true, mode: s.permissionMode };
    } catch (err) {
      return { ok: false, error: cut((err && err.message) || String(err), 300) };
    }
  }

  async function commands(id) {
    const s = sessions.get(id);
    if (!s || s.closed || !s.query || typeof s.query.supportedCommands !== 'function') return [];
    try {
      const list = await s.query.supportedCommands();
      if (!Array.isArray(list)) return [];
      return list.map(c => ({
        name: String(c.name ?? ''),
        description: String(c.description ?? ''),
        argumentHint: String(c.argumentHint ?? ''),
      }));
    } catch {
      return [];
    }
  }

  function close(id) {
    const s = sessions.get(id);
    if (!s) return false;
    if (!s.closed) {
      // 순서: 대기 요청 정리(request-done) → closed 이벤트 → 새 이벤트 차단
      for (const req of [...s.pending.values()]) settle(s, req, denyResult('세션이 닫혔습니다'), 'cancelled');
      emit(s, { type: 'closed', reason: 'closed' });
      s.closed = true;
      s.inputClosed = true;
      wakeInput(s);
      sessions.delete(s.id);
    }
    try { if (s.query && typeof s.query.close === 'function') s.query.close(); } catch { /* 이미 끝남 */ }
    try { s.abort.abort(); } catch { /* 이미 끝남 */ }
    return true;
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id);
  }

  function list() {
    return [...sessions.values()].map(s => ({
      id: s.id,
      cwd: s.cwd,
      sessionId: s.sessionId,
      model: s.model,
      busy: s.busy,
      pending: s.pending.size,
    }));
  }

  return { open, send, respond, interrupt, setModel, setPermissionMode, commands, close, closeAll, list };
}

module.exports = { createChatHost, INPUT_JSON_MAX, TEXT_MAX };
