'use strict';
// 채팅 세션 호스트 테스트. 실제 SDK·네트워크는 부르지 않는다: 가짜 query를 주입하고
// 테스트가 SDK 메시지를 밀어 넣고 canUseTool을 직접 호출한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChatHost } = require('../src/core/chat');

// ── 가짜 SDK: query가 기록한 옵션과, 테스트가 메시지를 밀어 넣을 수 있는 질의 객체 ──
function makeFakeQuery(params) {
  const q = {
    params,
    queue: [], wake: null, done: false, err: null,
    interrupted: 0, models: [], modes: [], commands: [],
    inputReads: [], inputLoop: null,
    push(msg) { q.queue.push(msg); wakeQ(); },
    finish() { q.done = true; wakeQ(); },
    breakWith(err) { q.err = err; q.done = true; wakeQ(); },
    interrupt: async () => { q.interrupted++; return undefined; },
    setModel: async m => { q.models.push(m); },
    setPermissionMode: async m => { q.modes.push(m); return { mode: m }; },
    supportedCommands: async () => q.commands,
    // 실제 SDK처럼 입력 스트림(params.prompt)을 next() 반복으로 소비하며 반복자 결과의 형태를 엄격히 검사한다.
    // 결과가 { done, value } 객체가 아니거나 done이 아닌데 SDKUserMessage가 아니면 오류로 끝낸다
    // (예전에 next()가 빈 값으로 풀려 실제 SDK가 세션을 끊던 버그를 가짜가 잡지 못했었다).
    consumeInput() {
      if (q.inputLoop) return q.inputLoop;
      q.inputLoop = (async () => {
        const it = params.prompt;
        for (;;) {
          const r = await it.next();
          if (!r || typeof r !== 'object') throw new Error(`입력 반복자 결과가 객체가 아님: ${JSON.stringify(r)}`);
          if (r.done) { if (r.value !== undefined) throw new Error('done인데 value가 있음'); return 'done'; }
          if (!r.value || typeof r.value !== 'object' || r.value.type !== 'user') throw new Error(`done이 아닌데 SDKUserMessage가 아님: ${JSON.stringify(r.value)}`);
          q.inputReads.push(r.value);
        }
      })();
      return q.inputLoop;
    },
  };
  function wakeQ() { if (q.wake) { const r = q.wake; q.wake = null; r(); } }
  async function* iterate() {
    for (;;) {
      while (q.queue.length) yield q.queue.shift();
      if (q.err) throw q.err;
      if (q.done) return;
      await new Promise(r => { q.wake = r; });
    }
  }
  const gen = iterate();
  q[Symbol.asyncIterator] = () => gen;
  return q;
}

function fakeSdk() {
  const queries = [];
  const sdk = { query: params => { const q = makeFakeQuery(params); queries.push(q); return q; } };
  return { sdk, queries };
}

// ── 이벤트 수집기: 기록 + 조건 대기 ──
function collector() {
  const c = { list: [], waiters: [] };
  c.push = ev => {
    c.list.push(ev);
    c.waiters = c.waiters.filter(w => {
      if (w.pred(ev)) { w.resolve(ev); return false; }
      return true;
    });
  };
  c.wait = (pred, timeout = 3000) => {
    const found = c.list.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`이벤트 대기 시간 초과 (지금까지: ${c.list.map(e => e.type).join(',')})`)), timeout);
      c.waiters.push({ pred, resolve: ev => { clearTimeout(timer); resolve(ev); } });
    });
  };
  return c;
}

function makeHost(sdk, opt = {}) {
  const events = collector();
  const host = createChatHost({
    loadSdk: opt.loadSdk || (async () => sdk),
    onEvent: opt.onEvent || events.push,
    permissionTimeoutMs: opt.permissionTimeoutMs,
  });
  return { host, events };
}

async function opened(host, id, opts = {}) {
  const r = await host.open({ id, cwd: 'C:/proj', env: { PATH: 'x' }, ...opts });
  assert.deepEqual(r, { ok: true }, `open 실패: ${JSON.stringify(r)}`);
}

// ── SDK 메시지 조립 도우미 ──
const sysInit = over => ({
  type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-fable-5', permissionMode: 'default',
  tools: ['Bash', 'Read'], cwd: 'C:/proj', agents: ['reviewer'], apiKeySource: 'none', claude_code_version: '2',
  slash_commands: [], output_style: 'default', skills: [], plugins: [], mcp_servers: [], uuid: 'u1', ...over,
});
const deltaMsg = (text, over) => ({
  type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  parent_tool_use_id: null, uuid: 'u2', session_id: 's-1', ...over,
});
const thinkMsg = over => ({
  type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '음' } },
  parent_tool_use_id: null, uuid: 'u3', session_id: 's-1', ...over,
});
const assistantMsg = (blocks, over) => ({
  type: 'assistant', parent_tool_use_id: null, uuid: 'u4', session_id: 's-1',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5', content: blocks, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  ...over,
});
const resultMsg = over => ({
  type: 'result', subtype: 'success', duration_ms: 1234, duration_api_ms: 1000, is_error: false, num_turns: 2,
  result: '완료', stop_reason: 'end_turn', total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
  permission_denials: [], modelUsage: {}, uuid: 'u5', session_id: 's-1', ...over,
});
const toolResultMsg = (content, over) => ({
  type: 'user', parent_tool_use_id: null, uuid: 'u6', session_id: 's-1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] }, ...over,
});
const textBlock = t => ({ type: 'text', text: t });
const thinkBlock = t => ({ type: 'thinking', thinking: t, signature: 'sig' });
const toolBlock = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('chat: open이 넘기는 옵션(전부 지정)', async () => {
  const { sdk, queries } = fakeSdk();
  const { host } = makeHost(sdk);
  const env = { PATH: 'C:/bin', ANTHROPIC_MODEL: 'x' };
  await opened(host, 'c1', {
    cwd: 'C:/work', env, model: 'claude-opus-4-8', effort: 'high', resume: 's-0',
    permissionMode: 'acceptEdits', claudePath: 'C:/cli/claude.exe', appendSystemPrompt: '추가 지시',
    extraArgs: { 'verbose': null },
  });
  const { prompt, options } = queries[0].params;
  assert.equal(typeof prompt[Symbol.asyncIterator], 'function', 'prompt는 async iterable');
  assert.equal(options.cwd, 'C:/work');
  assert.equal(options.env, env, 'env는 받은 객체를 그대로');
  assert.equal(options.model, 'claude-opus-4-8');
  assert.equal(options.effort, 'high');
  assert.equal(options.resume, 's-0');
  assert.equal(options.permissionMode, 'acceptEdits');
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: '추가 지시' });
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.pathToClaudeCodeExecutable, 'C:/cli/claude.exe');
  assert.deepEqual(options.extraArgs, { 'verbose': null });
  assert.equal(typeof options.canUseTool, 'function');
  assert.ok(options.abortController, 'abortController가 주입됨');
  assert.equal(typeof options.stderr, 'function');
});

test('chat: open 옵션 생략 — 없는 키는 아예 없음', async () => {
  const { sdk, queries } = fakeSdk();
  const { host } = makeHost(sdk);
  await opened(host, 'c1', { cwd: 'C:/w', env: { PATH: 'x' } });
  const { options } = queries[0].params;
  for (const key of ['model', 'effort', 'resume', 'permissionMode', 'pathToClaudeCodeExecutable', 'extraArgs']) {
    assert.equal(key in options, false, `${key}는 생략`);
  }
  assert.equal('env' in options, true);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.equal('append' in options.systemPrompt, false);
});

test('chat: 같은 id 중복 open은 거절', async () => {
  const { sdk } = fakeSdk();
  const { host } = makeHost(sdk);
  await opened(host, 'c1');
  const r = await host.open({ id: 'c1', cwd: 'C:/proj', env: {} });
  assert.equal(r.ok, false);
});

test('chat: send 텍스트만 — SDKUserMessage, user 이벤트, busy 전환', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  const r = host.send('c1', { text: '안녕' });
  assert.deepEqual(r, { ok: true });
  const { value } = await it.next();
  assert.deepEqual(value, { type: 'user', message: { role: 'user', content: '안녕' }, parent_tool_use_id: null });
  const uev = await events.wait(e => e.type === 'user');
  assert.deepEqual(uev, { chat: 'c1', type: 'user', text: '안녕', images: 0, queued: false });
  const sev = await events.wait(e => e.type === 'status');
  assert.deepEqual(sev, { chat: 'c1', type: 'status', busy: true });
  assert.equal(host.list()[0].busy, true);
  host.close('c1');
});

test('chat: send 텍스트+이미지 2장 — base64 소스 블록', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  host.send('c1', { text: '사진', images: [{ mediaType: 'image/png', data: 'AAA=' }, { mediaType: 'image/jpeg', data: 'BBB=' }] });
  const { value } = await it.next();
  assert.deepEqual(value.message, {
    role: 'user',
    content: [
      { type: 'text', text: '사진' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB=' } },
    ],
  });
  const uev = await events.wait(e => e.type === 'user');
  assert.equal(uev.images, 2);
  host.close('c1');
});

test('chat: 빈 send와 닫힌 세션 send는 {ok:false}', async () => {
  const { sdk } = fakeSdk();
  const { host } = makeHost(sdk);
  await opened(host, 'c1');
  assert.equal(host.send('c1', { text: '' }).ok, false);
  assert.equal(host.send('없는id', { text: 'x' }).ok, false);
  host.close('c1');
  assert.equal(host.send('c1', { text: 'x' }).ok, false);
});

test('chat: 응답 중 send는 큐에 쌓이고 result 뒤에도 busy 유지', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  host.send('c1', { text: '첫' });
  host.send('c1', { text: '둘' });
  host.send('c1', { text: '셋' });
  const queuedEvs = events.list.filter(e => e.type === 'user');
  assert.deepEqual(queuedEvs.map(e => e.queued), [false, true, true]);
  assert.deepEqual((await it.next()).value.message.content, '첫');
  assert.deepEqual((await it.next()).value.message.content, '둘');
  queries[0].push(resultMsg());
  await events.wait(e => e.type === 'result');
  assert.equal(host.list()[0].busy, true, '큐에 셋이 남아 busy 유지');
  assert.deepEqual((await it.next()).value.message.content, '셋');
  queries[0].push(resultMsg({ uuid: 'u9' }));
  await events.wait(e => e.type === 'status' && e.busy === false);
  assert.equal(host.list()[0].busy, false);
  host.close('c1');
});

test('chat: init / delta / thinking(한 번) / status(system) / compact / raw', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  q.push(sysInit());
  const iev = await events.wait(e => e.type === 'init');
  assert.deepEqual(iev, {
    chat: 'c1', type: 'init', sessionId: 's-1', model: 'claude-fable-5', permissionMode: 'default',
    tools: ['Bash', 'Read'], cwd: 'C:/proj', agents: ['reviewer'],
  });
  assert.deepEqual(host.list()[0], { id: 'c1', cwd: 'C:/proj', sessionId: 's-1', model: 'claude-fable-5', busy: false, pending: 0 });

  q.push(deltaMsg('안녕'));
  assert.deepEqual(await events.wait(e => e.type === 'delta'), { chat: 'c1', type: 'delta', text: '안녕', parent: null });

  q.push(thinkMsg());
  assert.deepEqual(await events.wait(e => e.type === 'thinking'), { chat: 'c1', type: 'thinking', active: true });
  q.push(thinkMsg());
  q.push(thinkMsg());
  await new Promise(r => setTimeout(r, 10));
  assert.equal(events.list.filter(e => e.type === 'thinking').length, 1, 'thinking은 한 번만');

  q.push({ type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'acceptEdits', uuid: 'u7', session_id: 's-1' });
  const st = await events.wait(e => e.type === 'status' && e.text === 'compacting');
  assert.deepEqual(st, { chat: 'c1', type: 'status', busy: false, text: 'compacting' });

  q.push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 10 }, uuid: 'u8', session_id: 's-1' });
  assert.deepEqual(await events.wait(e => e.type === 'compact'), { chat: 'c1', type: 'compact' });

  q.push({ type: 'task_notification', subtype: 'started', task_id: 't' });
  assert.deepEqual(await events.wait(e => e.type === 'raw'), { chat: 'c1', type: 'raw', sdkType: 'task_notification', subtype: 'started' });

  q.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'u10', session_id: 's-1' });
  assert.deepEqual(await events.wait(e => e.type === 'raw' && e.sdkType === 'system'), { chat: 'c1', type: 'raw', sdkType: 'system', subtype: 'background_tasks_changed' });
  host.close('c1');
});

test('chat: result 이벤트 매핑과 busy 해제', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  host.send('c1', { text: '가' });
  await it.next(); // SDK가 입력을 소비해 큐를 비운다
  queries[0].push(resultMsg());
  const rev = await events.wait(e => e.type === 'result');
  assert.deepEqual(rev, {
    chat: 'c1', type: 'result', subtype: 'success', isError: false, text: '완료', costUsd: 0.01,
    usage: { input: 10, output: 5, cacheRead: 7, cacheCreate: 3 }, turns: 2, durationMs: 1234,
  });
  assert.equal(host.list()[0].busy, false);
  host.close('c1');
});

test('chat: 오류 result — errors 배열이 text로', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  queries[0].push(resultMsg({ subtype: 'error_max_turns', is_error: true, result: undefined, errors: ['턴 한도 초과'] }));
  const rev = await events.wait(e => e.type === 'result');
  assert.equal(rev.subtype, 'error_max_turns');
  assert.equal(rev.isError, true);
  assert.equal(rev.text, '턴 한도 초과');
  host.close('c1');
});

test('chat: assistant 혼합 블록 — thinking 제외, summary, 큰 input 축소', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  const big = '가'.repeat(20000);
  q.push(assistantMsg([
    thinkBlock('생각'),
    textBlock('설명'),
    toolBlock('tu1', 'Read', { file_path: 'C:/a.js', command: '무시' }),
    toolBlock('tu2', 'Write', { file_path: 'C:/big.txt', content: big }),
  ]));
  const aev = await events.wait(e => e.type === 'assistant');
  assert.equal(aev.model, 'claude-fable-5');
  assert.equal(aev.parent, null);
  assert.equal(aev.blocks.length, 3, 'thinking 블록은 빠진다');
  assert.deepEqual(aev.blocks[0], { kind: 'text', text: '설명' });
  assert.deepEqual(aev.blocks[1], { kind: 'tool', id: 'tu1', name: 'Read', summary: 'C:/a.js', input: { file_path: 'C:/a.js', command: '무시' } });
  assert.equal(aev.blocks[2].summary, 'C:/big.txt');
  assert.ok(JSON.stringify(aev.blocks[2].input).length <= 4000, '큰 input은 4000자 이하로 축소');
  assert.match(JSON.stringify(aev.blocks[2].input.content), /\(\+\d+\)/);

  // thinking만 있는 assistant 메시지는 이벤트 없음
  const before = events.list.length;
  q.push(assistantMsg([thinkBlock('only')], { uuid: 'u7' }));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(events.list.length, before, '빈 블록 assistant는 이벤트 없음');

  // assistant 에러 필드 → error 이벤트(auth 문구)
  q.push(assistantMsg([textBlock('x')], { uuid: 'u8', error: 'authentication_failed' }));
  const eev = await events.wait(e => e.type === 'error');
  assert.equal(eev.auth, true);
  host.close('c1');
});

test('chat: summary 우선순위 file_path → command → pattern', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  q.push(assistantMsg([toolBlock('t1', 'Bash', { command: 'cmd', file_path: 'C:/f.js' })]));
  const a1 = await events.wait(e => e.type === 'assistant');
  assert.equal(a1.blocks[0].summary, 'C:/f.js', 'file_path가 먼저');
  q.push(assistantMsg([toolBlock('t2', 'Grep', { pattern: '검색어' })], { uuid: 'u7' }));
  const a2 = await events.wait(e => e.type === 'assistant' && e.blocks[0].id === 't2');
  assert.equal(a2.blocks[0].summary, '검색어');
  q.push(assistantMsg([toolBlock('t3', 'TodoWrite', { todos: [] })], { uuid: 'u8' }));
  const a3 = await events.wait(e => e.type === 'assistant' && e.blocks[0].id === 't3');
  assert.equal(a3.blocks[0].summary, null, '요약 키가 없으면 null');
  host.close('c1');
});

test('chat: tool-result — 문자열·블록·오류·자르기·이미지', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  q.push(toolResultMsg('그냥 결과'));
  assert.deepEqual(await events.wait(e => e.type === 'tool-result'), {
    chat: 'c1', type: 'tool-result', toolUseId: 'tu1', isError: false, text: '그냥 결과', parent: null,
  });

  q.push(toolResultMsg([
    { type: 'text', text: '첫 줄' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    { type: 'text', text: '둘째 줄' },
  ], { uuid: 'u7' }));
  const t2 = await events.wait(e => e.type === 'tool-result' && e.text.includes('첫 줄'));
  assert.equal(t2.text, '첫 줄\n[이미지]\n둘째 줄');
  assert.equal(t2.isError, false);

  q.push(toolResultMsg('실패함', { uuid: 'u8', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: '실패함' }] } }));
  const t3 = await events.wait(e => e.type === 'tool-result' && e.isError);
  assert.equal(t3.isError, true);

  const long = '하'.repeat(5000);
  q.push(toolResultMsg(long, { uuid: 'u9' }));
  const t4 = await events.wait(e => e.type === 'tool-result' && e.text.length > 100);
  assert.ok(t4.text.length <= 4100, '4000자로 잘림');
  assert.match(t4.text, /\(\+\d+\)$/);

  q.push(toolResultMsg(long, { uuid: 'u10', parent_tool_use_id: 'p9' }));
  const t5 = await events.wait(e => e.type === 'tool-result' && e.parent);
  assert.equal(t5.parent, 'p9', '서브에이전트 tool-result에 parent');
  host.close('c1');
});

test('chat: 서브에이전트 — parent 전달, stream_event는 delta 없음', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  q.push(assistantMsg([textBlock('서브 응답')], { parent_tool_use_id: 'p1' }));
  const aev = await events.wait(e => e.type === 'assistant');
  assert.equal(aev.parent, 'p1');
  q.push(deltaMsg('서브 조각', { parent_tool_use_id: 'p1' }));
  q.push(thinkMsg({ parent_tool_use_id: 'p1' }));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(events.list.filter(e => e.type === 'delta' || e.type === 'thinking').length, 0, '서브 stream_event는 이벤트 없음');
  host.close('c1');
});

test('chat: 이벤트 순서 보장', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  q.push(sysInit());
  q.push(deltaMsg('가'));
  q.push(assistantMsg([textBlock('나')]));
  q.push(resultMsg());
  await events.wait(e => e.type === 'result');
  const types = events.list.map(e => e.type);
  assert.deepEqual(types, ['init', 'delta', 'assistant', 'result']);
  host.close('c1');
});

// ── 권한·질문·계획 ──
test('chat: 권한 allow / always / deny / suggestions 없음', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const canUse = queries[0].params.options.canUseTool;
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }];

  const p1 = canUse('Bash', { command: 'npm test' }, { signal: new AbortController().signal, suggestions, toolUseID: 't1', agentID: undefined });
  const pev = await events.wait(e => e.type === 'permission');
  assert.equal(pev.tool, 'Bash');
  assert.deepEqual(pev.input, { command: 'npm test' });
  assert.equal(pev.summary, 'npm test');
  assert.equal(pev.canAlways, true);
  assert.equal(pev.parent, null);
  assert.equal(host.list()[0].pending, 1);
  assert.deepEqual(host.respond('c1', pev.requestId, { allow: true }), { ok: true });
  assert.deepEqual(await p1, { behavior: 'allow' });
  assert.deepEqual(await events.wait(e => e.type === 'request-done'), { chat: 'c1', type: 'request-done', requestId: pev.requestId, outcome: 'allow' });

  const p2 = canUse('Edit', { file_path: 'C:/a.js' }, { signal: new AbortController().signal, suggestions, toolUseID: 't2' });
  const pe2 = await events.wait(e => e.type === 'permission' && e.input.file_path);
  host.respond('c1', pe2.requestId, { allow: true, always: true });
  assert.deepEqual(await p2, { behavior: 'allow', updatedPermissions: suggestions }, 'always는 suggestions를 되돌려준다');
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pe2.requestId)).outcome, 'always');

  const p3 = canUse('Bash', { command: 'rm -rf' }, { signal: new AbortController().signal, suggestions, toolUseID: 't3' });
  const pe3 = await events.wait(e => e.type === 'permission' && e.input.command === 'rm -rf');
  host.respond('c1', pe3.requestId, { allow: false, message: '위험한 명령' });
  assert.deepEqual(await p3, { behavior: 'deny', message: '위험한 명령' });
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pe3.requestId)).outcome, 'deny');

  const p4 = canUse('WebFetch', { url: 'https://x' }, { signal: new AbortController().signal, toolUseID: 't4' });
  const pe4 = await events.wait(e => e.type === 'permission' && e.tool === 'WebFetch');
  assert.equal(pe4.canAlways, false, 'suggestions 없으면 canAlways false');
  host.respond('c1', pe4.requestId, { allow: true, always: true });
  assert.deepEqual(await p4, { behavior: 'allow' }, 'suggestions 없으면 always도 그냥 allow');
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pe4.requestId)).outcome, 'allow');

  const p5 = canUse('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 't5' });
  const pe5 = await events.wait(e => e.type === 'permission' && e.input.command === 'x');
  host.respond('c1', pe5.requestId, { allow: false });
  assert.deepEqual(await p5, { behavior: 'deny', message: '사용자가 거부했습니다' }, 'message 기본값');
  host.close('c1');
});

test('chat: 권한 요청의 blockedPath·reason·큰 input 축소', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const p = queries[0].params.options.canUseTool('Write', { file_path: 'C:/o.js', content: '비'.repeat(9000) }, {
    signal: new AbortController().signal, toolUseID: 't1',
    blockedPath: 'C:/block', decisionReason: '허용 디렉터리 밖의 경로',
  });
  const pev = await events.wait(e => e.type === 'permission');
  assert.equal(pev.blockedPath, 'C:/block');
  assert.equal(pev.reason, '허용 디렉터리 밖의 경로');
  assert.ok(JSON.stringify(pev.input).length <= 4000);
  host.respond('c1', pev.requestId, { allow: false });
  await p;
  host.close('c1');
});

test('chat: 질문 — 단일·다중·자유 입력·cancel', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const canUse = queries[0].params.options.canUseTool;
  const questions = [
    { question: '어느 라이브러리?', header: '라이브러리', multiSelect: false, options: [{ label: 'A', description: 'a 설명' }, { label: 'B', description: 'b 설명' }] },
    { question: '무엇을 켤까?', header: '기능', multiSelect: true, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }, { label: 'z', description: '' }] },
  ];
  const p = canUse('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 't1' });
  const qev = await events.wait(e => e.type === 'question');
  assert.deepEqual(qev.questions, [
    { question: '어느 라이브러리?', header: '라이브러리', multiSelect: false, options: [{ label: 'A', description: 'a 설명' }, { label: 'B', description: 'b 설명' }] },
    { question: '무엇을 켤까?', header: '기능', multiSelect: true, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }, { label: 'z', description: '' }] },
  ]);

  host.respond('c1', qev.requestId, { answers: { '어느 라이브러리?': 'B' }, other: { '무엇을 켤까?': '직접 쓴 답' } });
  assert.deepEqual(await p, {
    behavior: 'allow',
    updatedInput: { questions, answers: { '어느 라이브러리?': 'B', '무엇을 켤까?': '직접 쓴 답' } },
  });
  assert.equal((await events.wait(e => e.type === 'request-done')).outcome, 'answered');

  const p2 = canUse('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 't2' });
  const q2 = await events.wait(e => e.type === 'question' && e !== qev);
  host.respond('c1', q2.requestId, { answers: { '어느 라이브러리?': 'A', '무엇을 켤까?': ['x', 'z'] } });
  assert.deepEqual((await p2).updatedInput.answers, { '어느 라이브러리?': 'A', '무엇을 켤까?': ['x', 'z'] }, '다중 선택은 배열');

  const p3 = canUse('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 't3' });
  const q3 = await events.wait(e => e.type === 'question' && e !== qev && e !== q2);
  host.respond('c1', q3.requestId, { cancel: true });
  assert.deepEqual(await p3, { behavior: 'deny', message: '사용자가 거부했습니다' });
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === q3.requestId)).outcome, 'deny');
  host.close('c1');
});

test('chat: ExitPlanMode — allow / deny', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const canUse = queries[0].params.options.canUseTool;
  const p = canUse('ExitPlanMode', { plan: '1단계: 테스트' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const pev = await events.wait(e => e.type === 'plan');
  assert.deepEqual(pev, { chat: 'c1', type: 'plan', requestId: pev.requestId, plan: '1단계: 테스트', parent: null });
  host.respond('c1', pev.requestId, { allow: true });
  assert.deepEqual(await p, { behavior: 'allow' });
  assert.equal((await events.wait(e => e.type === 'request-done')).outcome, 'allow');

  const p2 = canUse('ExitPlanMode', { plan: '수정' }, { signal: new AbortController().signal, toolUseID: 't2' });
  const pe2 = await events.wait(e => e.type === 'plan' && e !== pev);
  host.respond('c1', pe2.requestId, { allow: false, message: '계획을 다시 짜라' });
  assert.deepEqual(await p2, { behavior: 'deny', message: '계획을 다시 짜라' });
  host.close('c1');
});

test('chat: signal abort → cancelled, 이미 abort된 signal도 처리', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const canUse = queries[0].params.options.canUseTool;
  const ac = new AbortController();
  const p = canUse('Bash', { command: 'x' }, { signal: ac.signal, toolUseID: 't1' });
  const pev = await events.wait(e => e.type === 'permission');
  ac.abort();
  assert.deepEqual(await p, { behavior: 'deny', message: '요청이 중단되었습니다' });
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pev.requestId)).outcome, 'cancelled');

  const done = new AbortController();
  done.abort();
  const p2 = canUse('Bash', { command: 'y' }, { signal: done.signal, toolUseID: 't2' });
  const pe2 = await events.wait(e => e.type === 'permission' && e.input.command === 'y');
  assert.deepEqual(await p2, { behavior: 'deny', message: '요청이 중단되었습니다' }, '이미 abort된 signal은 즉시 정리');
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pe2.requestId)).outcome, 'cancelled');
  host.close('c1');
});

test('chat: permissionTimeoutMs → timeout', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk, { permissionTimeoutMs: 20 });
  await opened(host, 'c1');
  const p = queries[0].params.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const done = await events.wait(e => e.type === 'request-done');
  assert.equal(done.outcome, 'timeout');
  assert.deepEqual(await p, { behavior: 'deny', message: '요청 시간이 초과되었습니다' });
  host.close('c1');
});

test('chat: interrupt — 대기 요청 deny(interrupt) 정리 + query.interrupt 호출', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const p = queries[0].params.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const pev = await events.wait(e => e.type === 'permission');
  host.send('c1', { text: '가는 중' });
  assert.deepEqual(host.interrupt('c1'), { ok: true });
  assert.equal(queries[0].interrupted, 1);
  assert.deepEqual(await p, { behavior: 'deny', message: '사용자가 중단했습니다', interrupt: true });
  assert.equal((await events.wait(e => e.type === 'request-done' && e.requestId === pev.requestId)).outcome, 'cancelled');
  host.close('c1');
});

test('chat: 잘못된 requestId·정리된 요청 respond는 {ok:false}', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  assert.deepEqual(host.respond('c1', '없는요청', { allow: true }).ok, false);
  assert.deepEqual(host.respond('없는세션', 'req', { allow: true }).ok, false);
  const p = queries[0].params.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const pev = await events.wait(e => e.type === 'permission');
  host.respond('c1', pev.requestId, { allow: true });
  await p;
  assert.deepEqual(host.respond('c1', pev.requestId, { allow: true }).ok, false, '이미 정리된 요청');
  host.close('c1');
});

test('chat: close 두 번, close 뒤 이벤트 없음, 입력 스트림 종료', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  assert.equal(host.close('c1'), true);
  assert.doesNotThrow(() => host.close('c1'), '여러 번 불러도 안전');
  assert.equal(host.close('c1'), false, '이미 닫힌 세션은 없음');
  assert.equal(events.list.filter(e => e.type === 'closed').length, 1);
  assert.deepEqual(events.list.at(-1), { chat: 'c1', type: 'closed', reason: 'closed' });
  assert.deepEqual(await it.next(), { done: true, value: undefined }, '입력 스트림이 닫힌다');
  assert.deepEqual(host.list(), []);
  queries[0].push(sysInit());
  queries[0].push(deltaMsg('늦게 온 메시지'));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(events.list.length, 1, 'closed 뒤로는 이벤트가 없다');
});

test('chat: 세션 종료 시 대기 요청이 request-done 후 closed로 정리', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const p = queries[0].params.options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const pev = await events.wait(e => e.type === 'permission');
  host.close('c1');
  assert.deepEqual(await p, { behavior: 'deny', message: '세션이 닫혔습니다' });
  const i1 = events.list.findIndex(e => e.type === 'request-done');
  const i2 = events.list.findIndex(e => e.type === 'closed');
  assert.ok(i1 !== -1 && i2 > i1, 'request-done이 closed보다 먼저');
  assert.equal(events.list[i1].outcome, 'cancelled');
});

test('chat: closeAll이 전부 닫는다', async () => {
  const { sdk } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'a');
  await opened(host, 'b');
  host.closeAll();
  assert.deepEqual(host.list(), []);
  assert.equal(events.list.filter(e => e.type === 'closed').length, 2);
});

test('chat: 스트림 예외 → error + closed{error}, 세션 제거', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  queries[0].breakWith(new Error('스트림이 끊겼다'));
  const eev = await events.wait(e => e.type === 'error');
  assert.match(eev.message, /스트림이 끊겼다/);
  assert.equal(eev.auth, undefined);
  const cev = await events.wait(e => e.type === 'closed');
  assert.equal(cev.reason, 'error');
  assert.deepEqual(host.list(), []);
});

test('chat: 인증 오류 문구 → auth:true', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  queries[0].breakWith(new Error('Please login: 401 invalid credentials'));
  const eev = await events.wait(e => e.type === 'error');
  assert.equal(eev.auth, true);
  host.close('c1');
});

test('chat: stderr 꼬리 20줄 보관, 오류 이벤트에 덧붙이고 비밀값 가림', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const stderr = queries[0].params.options.stderr;
  for (let i = 0; i < 25; i++) stderr(`일반 로그 ${i}`);
  stderr('sk-proj-SUPERSECRETKEYVALUE123456');
  stderr('Authorization: Bearer abc.def.ghi');
  stderr(`hex: ${'a'.repeat(40)}`);
  queries[0].breakWith(new Error('죽었다'));
  const eev = await events.wait(e => e.type === 'error');
  assert.ok(eev.stderr, 'stderr 꼬리가 붙는다');
  assert.ok(!eev.stderr.includes('SUPERSECRETKEYVALUE'), 'sk- 키는 가린다');
  assert.ok(eev.stderr.includes('***'));
  assert.ok(!eev.stderr.includes('abc.def.ghi'), 'Bearer 토큰은 가린다');
  assert.ok(!/a{32,}/.test(eev.stderr), '32자 이상 16진 덩어리는 가린다');
  const lines = eev.stderr.split('\n');
  assert.equal(lines.length, 20, '마지막 20줄만');
  assert.ok(lines.some(l => l.includes('일반 로그 24')), '가장 마지막 줄이 포함');
  assert.ok(!lines.some(l => l.includes('일반 로그 5')), '20줄 이전은 버려진다');
});

test('chat: 자연 종료 — 치명적 stderr면 error, 아니면 ended', async () => {
  const { sdk, queries } = fakeSdk();
  const h1 = makeHost(sdk);
  await opened(h1.host, 'c1');
  queries[0].params.options.stderr('Error: cannot start CLI');
  queries[0].finish();
  assert.equal((await h1.events.wait(e => e.type === 'closed')).reason, 'error');
  assert.ok(h1.events.list.some(e => e.type === 'error' && /cannot start/.test(e.message)));

  const qs = [];
  const sdk2 = { query: p => { const q = makeFakeQuery(p); qs.push(q); return q; } };
  const hh = makeHost(sdk2);
  await opened(hh.host, 'c2');
  qs[0].params.options.stderr('준비 완료');
  qs[0].finish();
  assert.equal((await hh.events.wait(e => e.type === 'closed')).reason, 'ended');
  assert.ok(!hh.events.list.some(e => e.type === 'error'));
});

test('chat: loadSdk 실패 → open {ok:false}, 다음 open에서 재시도', async () => {
  const { sdk } = fakeSdk();
  let calls = 0;
  const loadSdk = async () => {
    calls++;
    if (calls === 1) throw new Error('네트워크 단절');
    return sdk;
  };
  const { host, events } = makeHost(null, { loadSdk });
  const r1 = await host.open({ id: 'c1', cwd: 'C:/p', env: {} });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /네트워크 단절/);
  assert.deepEqual(events.list, []);
  await opened(host, 'c1');
  assert.equal(calls, 2, '실패 후 재시도');
  host.close('c1');
});

test('chat: 두 세션 동시 — chat id가 섞이지 않고 하나가 죽어도 다른 하나 정상', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  const env = { PATH: 'x', SECRET_TOKEN: 'ENV-비밀값-보내지-않는다' };
  await opened(host, 'a', { env });
  await opened(host, 'b', { env });
  assert.equal(queries.length, 2);
  queries[0].push(sysInit({ session_id: 'sa' }));
  queries[1].push(sysInit({ session_id: 'sb' }));
  const ia = await events.wait(e => e.chat === 'a' && e.type === 'init');
  const ib = await events.wait(e => e.chat === 'b' && e.type === 'init');
  assert.equal(ia.sessionId, 'sa');
  assert.equal(ib.sessionId, 'sb');
  assert.deepEqual(events.list.filter(e => e.type === 'init').map(e => e.chat), ['a', 'b']);

  queries[0].breakWith(new Error('a 세션 죽음'));
  assert.equal((await events.wait(e => e.chat === 'a' && e.type === 'closed')).reason, 'error');
  host.send('b', { text: 'b는 살아 있다' });
  const uev = await events.wait(e => e.chat === 'b' && e.type === 'user');
  assert.equal(uev.text, 'b는 살아 있다');
  assert.equal(host.list().length, 1);
  assert.equal(host.list()[0].id, 'b');

  // 모든 이벤트는 JSON 직렬화 가능하고 env 값은 어디에도 없다
  for (const ev of events.list) {
    assert.deepEqual(JSON.parse(JSON.stringify(ev)), ev, `이벤트 직렬화 불가: ${ev.type}`);
  }
  assert.ok(!JSON.stringify(events.list).includes('ENV-비밀값-보내지-않는다'), 'env 값은 어떤 이벤트에도 없다');
  host.closeAll();
});

test('chat: onEvent가 던져도 계속 동작한다', async () => {
  const { sdk, queries } = fakeSdk();
  const throwing = () => { throw new Error('렌더러 죽음'); };
  const { host } = makeHost(sdk, { onEvent: throwing });
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  host.send('c1', { text: '살아 있다' });
  assert.deepEqual((await it.next()).value.message.content, '살아 있다');
  queries[0].push(sysInit());
  queries[0].push(resultMsg());
  await new Promise(r => setTimeout(r, 10));
  assert.doesNotThrow(() => host.close('c1'));
});

test('chat: setModel / setPermissionMode / commands', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const q = queries[0];
  assert.deepEqual(await host.setModel('c1', 'claude-opus-4-8'), { ok: true });
  assert.deepEqual(q.models, ['claude-opus-4-8']);
  assert.equal(host.list()[0].model, 'claude-opus-4-8');
  assert.deepEqual(await host.setPermissionMode('c1', 'acceptEdits'), { ok: true, mode: 'acceptEdits' });
  assert.deepEqual(q.modes, ['acceptEdits']);

  q.commands = [{ name: 'review', description: '코드 리뷰', argumentHint: '<file>', builtin: true }];
  assert.deepEqual(await host.commands('c1'), [{ name: 'review', description: '코드 리뷰', argumentHint: '<file>' }]);
  q.supportedCommands = async () => { throw new Error('아직 준비 안 됨'); };
  assert.deepEqual(await host.commands('c1'), [], '실패하면 빈 배열');
  assert.deepEqual(await host.commands('없는id'), []);

  host.close('c1');
  assert.equal((await host.setModel('c1', 'x')).ok, false);
  assert.equal((await host.setPermissionMode('c1', 'plan')).ok, false);
});

test('chat: close 뒤 같은 id로 다시 열 수 있다', async () => {
  const { sdk, queries } = fakeSdk();
  const { host } = makeHost(sdk);
  await opened(host, 'c1');
  host.close('c1');
  await opened(host, 'c1', { model: 'claude-fable-5' });
  assert.equal(queries.length, 2);
  assert.equal(host.list()[0].model, 'claude-fable-5');
  host.close('c1');
});

// ── 회귀: SDK가 send보다 먼저 next()를 호출해 기다리는 상황 ──
test('chat: 회귀 — 대기 중 next() 약속은 send 뒤 {done:false,value:SDKUserMessage}, close 뒤 {done:true}로 풀린다', async () => {
  const { sdk, queries } = fakeSdk();
  const { host } = makeHost(sdk);
  await opened(host, 'c1');
  const it = queries[0].params.prompt;
  const p1 = it.next(); // SDK가 입력을 먼저 기다린다(풀릴 때까지 남는 약속)
  host.send('c1', { text: '먼저 기다리던 메시지' });
  assert.deepEqual(await p1, {
    done: false,
    value: { type: 'user', message: { role: 'user', content: '먼저 기다리던 메시지' }, parent_tool_use_id: null },
  }, '빈 값이 아니라 온전한 반복자 결과 객체로 풀려야 한다');
  const p2 = it.next(); // 다시 기다리던 상태에서 닫는다
  host.close('c1');
  assert.deepEqual(await p2, { done: true, value: undefined });
  assert.deepEqual(await it.next(), { done: true, value: undefined }, '닫힌 뒤 next는 즉시 done');
});

test('chat: 회귀 — 엄격한 가짜 SDK 입력 소비로 형태 위반을 잡는다(실제 SDK처럼 next 먼저 걸기)', async () => {
  const { sdk, queries } = fakeSdk();
  const { host, events } = makeHost(sdk);
  await opened(host, 'c1');
  const loop = queries[0].consumeInput(); // 가짜가 실제 SDK처럼 next()를 먼저 걸고 결과 형태를 검사한다
  host.send('c1', { text: '첫 메시지' });
  await events.wait(e => e.type === 'user' && e.text === '첫 메시지');
  host.send('c1', { text: '둘째' });
  await events.wait(e => e.type === 'user' && e.text === '둘째');
  host.close('c1');
  assert.equal(await loop, 'done', 'close 뒤 입력 스트림이 {done:true}으로 끝난다');
  assert.deepEqual(queries[0].inputReads.map(m => m.message.content), ['첫 메시지', '둘째'], '두 메시지 모두 온전한 형태로 전달');
});
