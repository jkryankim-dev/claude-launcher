'use strict';
// src/core/bridge.js 테스트: history·runs·studio·chat IPC 본문의 검증·조립.
// history·runs는 실제 모듈을 임시 폴더 픽스처로 돌리고, 채팅 호스트·키·claude 경로는 가짜를 주입한다.
// buildChatSession(runtime/start-session.mjs)과 스튜디오 도구(runtime/studio.mjs)는 실제 파일을 동적 import해 쓴다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const history = require('../src/core/history');
const runs = require('../src/core/runs');
const { createBridge, CHAT_ID_RE } = require('../src/core/bridge');

const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
const UUID = '1f0e8d9a-2345-4bc8-8d9a-c0ffee123456';
const KEY = 'zk-bridge-secret-1234';

let mods = null;
async function getMods() {
  if (!mods) {
    const ss = await import(pathToFileURL(path.join(ROOT, 'runtime', 'start-session.mjs')).href);
    const st = await import(pathToFileURL(path.join(ROOT, 'runtime', 'studio.mjs')).href);
    mods = { buildChat: ss.buildChatSession, studio: st };
  }
  return mods;
}

// ── 가짜 채팅 호스트: 호출 기록 + 살아 있는 세션 집합 ──
function fakeChatHost(over = {}) {
  const calls = { open: [], send: [], respond: [], interrupt: [], close: [], setModel: [], setPermissionMode: [], commands: [] };
  const live = new Set();
  return {
    calls, live,
    async open(o) { calls.open.push(o); if (over.openFail) return { ok: false, error: over.openFail }; live.add(o.id); return { ok: true }; },
    send(id, d) { calls.send.push([id, d]); return live.has(id) ? { ok: true } : { ok: false, error: '닫힌 세션입니다' }; },
    respond(id, rid, a) { calls.respond.push([id, rid, a]); return { ok: true }; },
    interrupt(id) { calls.interrupt.push(id); return live.has(id) ? { ok: true } : { ok: false, error: '닫힌 세션입니다' }; },
    async setModel(id, m) { calls.setModel.push([id, m]); return { ok: true }; },
    async setPermissionMode(id, m) { calls.setPermissionMode.push([id, m]); return { ok: true, mode: m }; },
    async commands(id) { calls.commands.push(id); return [{ name: 'review', description: '리뷰', argumentHint: '<file>' }]; },
    close(id) { calls.close.push(id); return live.delete(id); },
    closeAll() { for (const id of [...live]) this.close(id); },
    list() { return [...live].map(id => ({ id, cwd: 'C:/w', sessionId: 's-' + id, model: 'm', busy: false, pending: 0 })); },
  };
}

/** 브리지 의존 주입 꾸러미. projects는 정규화된 프로젝트 모양 그대로. */
function makeDeps(over = {}) {
  const chatHost = over.chatHost || fakeChatHost(over.hostOver || {});
  let n = 0;
  return {
    deps: {
      getConfig: () => ({ projects: over.projects || [], settings: { glmConfigDir: over.glmConfigDir || '' }, defaults: {} }),
      history,
      runs,
      chatHost,
      getStudio: over.getStudio || (async () => (await getMods()).studio),
      getBuildChat: over.getBuildChat || (async () => (await getMods()).buildChat),
      sessionExtra: over.sessionExtra || (() => ({ keyFile: 'K.dpapi', glmConfigDir: '/h/.claude-glm', zaiBaseUrl: 'https://api.z.ai/api/anthropic', fastModel: 'glm-5.3-flash', keepShell: true })),
      resolveClaudeExe: over.resolveClaudeExe || (() => (over.claudeExe === undefined ? 'C:/bin/claude.exe' : over.claudeExe)),
      loadKey: over.loadKey || (() => KEY),
      hasKey: over.hasKey || (() => (over.hasKeyResult === undefined ? true : over.hasKeyResult)),
      newChatId: () => `c${String(++n).padStart(8, '0')}`,
      envBase: over.envBase || { PATH: '/bin' },
      home: over.home || tmp(),
      notifyRuns: over.notifyRuns || (() => {}),
      warn: over.warn || (() => {}),
      existsSync: over.existsSync,
      watchOpts: over.watchOpts,
    },
    chatHost,
  };
}
const P = (over = {}) => ({
  id: 'std1', name: '프로젝트', path: tmp(), mode: 'split', openWith: 'inapp', extraArgs: '',
  main: { model: 'fable', effort: 'high' }, worker: { model: 'glm-5.3', effort: 'max' }, ext: { studio: false }, ...over,
});
const writeSession = (cfgDir, proj, id, text) => {
  const dir = history.projectDir(cfgDir, proj);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: proj, timestamp: '2026-11-01T00:00:00Z', message: { content: text } }) + '\n');
};
const writeRun = (proj, id, files) => {
  const d = path.join(proj, '.glm', 'runs', id);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) fs.writeFileSync(path.join(d, name), content);
};
const META = (p, id, over = {}) => JSON.stringify({
  id, parent: null, children: [], title: `실행 ${id}`, spec: '.glm/tasks/t.md', root: p, cwd: p,
  cfg: { role: 'edit', model: 'glm-5.3', effort: 'high' }, pid: 0, startedAt: '2026-11-01T00:00:00.000Z',
  status: 'done', endedAt: '2026-11-01T00:01:00.000Z', turns: 3, ...over,
});
const SPEC = '---\ntitle: 테스트 실행\n---\n## 목표\n본문.\n';
const PROMPT = '너는 숙련된 작업자다.\n[작업 명세]\n';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 대화 기록 ──
test('historyList: Session.file 미노출·glm/기본 configDir 구분·원격·없는 프로젝트', async () => {
  await getMods();
  const home = tmp(), proj = tmp(), glmCfg = tmp(), envCfg = tmp();
  writeSession(path.join(home, '.claude'), proj, UUID, '기본 폴더 대화');
  writeSession(glmCfg, proj, '2f0e8d9a-2345-4bc8-8d9a-c0ffee123456', 'GLM 대화');
  writeSession(envCfg, proj, '3f0e8d9a-2345-4bc8-8d9a-c0ffee123456', '환경변수 폴더 대화');
  const projects = [
    P({ id: 'std1', path: proj }),
    P({ id: 'glm1', path: proj, mode: 'glm' }),
    P({ id: 'rmt1', path: 'C:\\dev\\r', remote: { host: 'example-host', user: '', port: 0 } }),
  ];
  const b = createBridge(makeDeps({ projects, glmConfigDir: glmCfg, home }).deps);
  const r = await b.historyList('std1', { limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.remote, false);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].id, UUID);
  assert.ok(!('file' in r.sessions[0]), 'Session.file은 렌더러에 나가지 않는다');
  assert.match(r.sessions[0].firstPrompt, /기본 폴더 대화/, '기본값은 ~/.claude');
  const g = await b.historyList('glm1');
  assert.equal(g.ok, true);
  assert.match(g.sessions[0].firstPrompt, /GLM 대화/, 'glm 모드는 GLM 설정 폴더에서 읽는다');
  assert.deepEqual(await b.historyList('rmt1'), { ok: true, remote: true, sessions: [] });
  assert.deepEqual(await b.historyList('nope'), { ok: false, error: '프로젝트를 찾을 수 없습니다' });
  // CLAUDE_CONFIG_DIR 환경변수가 있으면 구독 모드도 그 폴더에서 읽는다
  const b2 = createBridge(makeDeps({ projects: [P({ id: 'env1', path: proj, mode: 'claude' })], home, envBase: { CLAUDE_CONFIG_DIR: envCfg } }).deps);
  const e = await b2.historyList('env1');
  assert.equal(e.sessions.length, 1);
  assert.match(e.sessions[0].firstPrompt, /환경변수 폴더 대화/);
});

test('historyRead·historySearch: UUID 검증·파일 재탐색·검색·원격', async () => {
  await getMods();
  const home = tmp(), proj = tmp();
  const cfg = path.join(home, '.claude');
  writeSession(cfg, proj, UUID, 'npm 이야기');
  writeSession(cfg, proj, '4f0e8d9a-2345-4bc8-8d9a-c0ffee123456', '다른 주제');
  const projects = [P({ path: proj }), P({ id: 'rmt1', path: 'C:\\dev\\r', remote: { host: 'example-host', user: '', port: 0 } })];
  const b = createBridge(makeDeps({ projects, home }).deps);
  const r = await b.historyRead('std1', UUID, { limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.messages[0].text, 'npm 이야기');
  assert.deepEqual(await b.historyRead('std1', 'not-a-uuid'), { ok: false, error: '세션 id가 UUID 형식이 아닙니다' });
  assert.equal((await b.historyRead('std1', '5f0e8d9a-2345-4bc8-8d9a-c0ffee123456')).ok, false, '없는 세션 파일');
  assert.equal((await b.historyRead('rmt1', UUID)).ok, false, '원격은 대화 기록 읽기 불가');
  const h = await b.historySearch('std1', 'npm');
  assert.equal(h.ok, true);
  assert.equal(h.hits.length, 1);
  assert.equal(h.hits[0].id, UUID);
  assert.ok(!('file' in h.hits[0]));
  assert.deepEqual((await b.historySearch('std1', 'x')).hits, [], '2자 미만 검색어');
});

// ── GLM 실행 기록 ──
test('runsList·runsRead: 목록·origin(맨 처음 실행의 명세·프롬프트)·검증·원격', async () => {
  await getMods();
  const proj = tmp();
  writeRun(proj, '20260102-010000-01ab', { 'meta.json': META(proj, '20260102-010000-01ab'), 'spec.md': SPEC, 'prompt.md': PROMPT });
  writeRun(proj, '20260102-020000-02cd', { 'meta.json': META(proj, '20260102-020000-02cd', { parent: '20260102-010000-01ab', title: '후속 1' }), 'spec.md': '# 후속1\n' });
  writeRun(proj, '20260102-030000-03ef', { 'meta.json': META(proj, '20260102-030000-03ef', { parent: '20260102-020000-02cd', title: '후속 2' }) });
  writeRun(proj, '20260102-040000-04a0', { 'meta.json': META(proj, '20260102-040000-04a0', { parent: '20260102-030000-03ef' }), 'spec.md': '# 후속3\n' });
  const projects = [P({ path: proj }), P({ id: 'rmt1', path: 'C:\\dev\\r', remote: { host: 'example-host', user: '', port: 0 } })];
  const b = createBridge(makeDeps({ projects }).deps);
  const list = await b.runsList('std1');
  assert.equal(list.ok, true);
  assert.deepEqual(list.runs.map(x => x.id).slice(0, 3), ['20260102-040000-04a0', '20260102-030000-03ef', '20260102-020000-02cd']);
  assert.equal(list.runs[2].resumeOf, '20260102-010000-01ab');
  const one = await b.runsRead('std1', '20260102-020000-02cd');
  assert.equal(one.run.origin.id, '20260102-010000-01ab');
  assert.equal(one.run.origin.title, '실행 20260102-010000-01ab');
  assert.equal(one.run.origin.spec, SPEC, '맨 처음 실행의 명세 원문');
  assert.equal(one.run.origin.prompt, PROMPT);
  const deep = await b.runsRead('std1', '20260102-040000-04a0'); // 3단 사슬도 맨 처음 실행까지 올라간다
  assert.equal(deep.run.origin.id, '20260102-010000-01ab');
  const root = await b.runsRead('std1', '20260102-010000-01ab');
  assert.equal(root.run.origin, undefined, '이어받지 않은 실행에는 origin 없음');
  assert.equal((await b.runsRead('std1', '../x')).ok, false, 'runId 형식 검증');
  assert.deepEqual(await b.runsRead('std1', '20260102-999999-99ff'), { ok: true, run: null }, '형식은 맞지만 없는 실행');
  assert.deepEqual(await b.runsRead('rmt1', '20260102-010000-01ab'), { ok: true, run: null }, '원격은 실행 기록 없음');
  assert.equal((await b.runsList('nope')).ok, false);
});

test('runsWatch·runsUnwatch: 변화 알림({projectId})·해제·없는 프로젝트', async () => {
  await getMods();
  const proj = tmp();
  const notified = [];
  const projects = [P({ path: proj })];
  const b = createBridge(makeDeps({ projects, notifyRuns: d => notified.push(d), watchOpts: { debounceMs: 40, pollMs: 120 } }).deps);
  assert.deepEqual(await b.runsWatch('nope'), { ok: false, error: '프로젝트를 찾을 수 없습니다' });
  assert.equal((await b.runsWatch('std1')).ok, true);
  writeRun(proj, '20260102-030000-01ab', { 'meta.json': META(proj, '20260102-030000-01ab') });
  const t0 = Date.now();
  while (!notified.length && Date.now() - t0 < 5000) await sleep(100);
  assert.deepEqual(notified[0], { projectId: 'std1' });
  assert.equal((await b.runsUnwatch('std1')).ok, true);
  const at = notified.length;
  writeRun(proj, '20260102-040000-02cd', { 'meta.json': META(proj, '20260102-040000-02cd') });
  await sleep(600);
  assert.equal(notified.length, at, 'unwatch 뒤에는 알림 없음');
});

// ── 스튜디오 조직도 ──
test('studioOrg: 꺼짐·org.json 없음·깨짐·검증 오류·경고·원격·없는 프로젝트', async () => {
  await getMods();
  const off = tmp(), empty = tmp(), broken = tmp(), warn = tmp(), bad = tmp();
  fs.mkdirSync(path.join(broken, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.studio', 'org.json'), '{ 깨진 json');
  const warnOrg = { schema: 1, name: 's', director: { name: '디렉터' }, departments: [{ id: 'design', name: '기획' }, { id: 'art', name: '아트' }], roles: [{ id: 'r1', dept: 'design', name: '역할', when: '언제', engine: 'claude', model: 'opus', reports_to: 'director', brief: 'b' }] };
  fs.mkdirSync(path.join(warn, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(warn, '.studio', 'org.json'), JSON.stringify(warnOrg)); // art 부서에 역할 0개 → 경고
  fs.mkdirSync(path.join(bad, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.studio', 'org.json'), JSON.stringify({ ...warnOrg, roles: [{ ...warnOrg.roles[0], id: 'Bad ID' }] }));
  const projects = [
    P({ id: 'off1', path: off }),
    P({ id: 'emp1', path: empty, ext: { studio: true } }),
    P({ id: 'brk1', path: broken, ext: { studio: true } }),
    P({ id: 'wrn1', path: warn, ext: { studio: true } }),
    P({ id: 'bad1', path: bad, ext: { studio: true } }),
    P({ id: 'rmt1', path: 'C:\\dev\\r', ext: { studio: true }, remote: { host: 'example-host', user: '', port: 0 } }),
  ];
  const b = createBridge(makeDeps({ projects }).deps);
  assert.deepEqual(await b.studioOrg('off1'), { ok: true, enabled: false, org: null, warnings: [] });
  assert.deepEqual(await b.studioOrg('emp1'), { ok: true, enabled: true, org: null, warnings: [] }, 'org.json 없으면 org:null');
  const brk = await b.studioOrg('brk1');
  assert.equal(brk.enabled, true);
  assert.equal(brk.org, null);
  assert.match(brk.error, /해석하지 못했습니다/);
  const wrn = await b.studioOrg('wrn1');
  assert.equal(wrn.error, null);
  assert.equal(wrn.org.name, 's');
  assert.ok(wrn.warnings.some(w => /art.*역할이 0개/.test(w)), JSON.stringify(wrn.warnings));
  const badr = await b.studioOrg('bad1');
  assert.match(badr.error, /조직도 오류/);
  assert.equal(badr.org.roles[0].id, 'Bad ID', '깨졌어도 org는 돌려준다');
  assert.deepEqual(await b.studioOrg('rmt1'), { ok: true, enabled: true, org: null, warnings: [] });
  assert.deepEqual(await b.studioOrg('nope'), { ok: false, error: '프로젝트를 찾을 수 없습니다' });
});

// ── 채팅 ──
test('chatOpen: 검증(없는 프로젝트·원격·폴더·키·resume UUID)과 host.open 인자', async () => {
  await getMods();
  const proj = tmp();
  const projects = [
    P({ path: proj, extraArgs: '--permission-mode plan --verbose' }),
    P({ id: 'glm1', path: proj, mode: 'glm' }),
    P({ id: 'rmt1', path: 'C:\\dev\\r', remote: { host: 'example-host', user: '', port: 0 } }),
    P({ id: 'gone1', path: path.join(tmp(), '없는폴더') }),
  ];
  const { deps, chatHost } = makeDeps({ projects, hasKeyResult: false });
  const b = createBridge(deps);
  assert.deepEqual(await b.chatOpen({ projectId: 'nope' }), { ok: false, error: '프로젝트를 찾을 수 없습니다' });
  assert.deepEqual(await b.chatOpen({ projectId: 'rmt1' }), { ok: false, error: '원격 프로젝트는 채팅을 아직 지원하지 않습니다. 터미널로 여세요' });
  assert.match((await b.chatOpen({ projectId: 'gone1' })).error, /폴더가 없습니다/);
  assert.match((await b.chatOpen({ projectId: 'glm1' })).error, /z\.ai 키가 필요합니다/);
  assert.match((await b.chatOpen({ projectId: 'std1', resume: 'junk' })).error, /UUID/);

  const r = await b.chatOpen({ projectId: 'std1' });
  assert.deepEqual(r, { ok: true, chatId: 'c00000001' });
  const o = chatHost.calls.open[0];
  assert.equal(o.id, 'c00000001');
  assert.equal(o.cwd, proj);
  assert.equal(o.model, 'fable');
  assert.equal(o.effort, 'high');
  assert.equal(o.permissionMode, 'plan', 'extraArgs의 --permission-mode');
  assert.deepEqual(o.extraArgs, { verbose: null });
  assert.equal(o.claudePath, 'C:/bin/claude.exe');
  assert.equal(o.resume, undefined);
  assert.equal(o.env.GLM_DELEGATE, 'on');
  assert.equal(o.env.GLM_MODEL, 'glm-5.3');
  assert.ok(!('CLAUDE_CONFIG_DIR' in o.env), '구독 모드는 기본 설정 폴더');

  const r2 = await b.chatOpen({ projectId: 'std1', resume: UUID });
  assert.equal(chatHost.calls.open[1].resume, UUID);

  const noExe = createBridge(makeDeps({ projects, claudeExe: null }).deps);
  assert.match((await noExe.chatOpen({ projectId: 'std1' })).error, /claude 실행 파일을 찾을 수 없습니다/);
  const failHost = createBridge(makeDeps({ projects, hostOver: { openFail: '이미 열린 세션 id입니다' } }).deps);
  assert.deepEqual(await failHost.chatOpen({ projectId: 'std1' }), { ok: false, error: '이미 열린 세션 id입니다' });
});

test('chatOpen: glm 키는 env로만 전달되고 반환값에는 없다', async () => {
  await getMods();
  const proj = tmp();
  const projects = [P({ id: 'glm1', path: proj, mode: 'glm' })];
  const { deps, chatHost } = makeDeps({ projects });
  const b = createBridge(deps);
  const r = await b.chatOpen({ projectId: 'glm1' });
  assert.equal(r.ok, true);
  const o = chatHost.calls.open[0];
  assert.equal(o.env.ANTHROPIC_AUTH_TOKEN, KEY, '키는 세션 환경으로만 흘러간다');
  assert.equal(o.model, 'glm-5.3');
  assert.equal(o.effort, 'max');
  assert.equal(o.env.CLAUDE_CONFIG_DIR, '/h/.claude-glm');
  assert.ok(!JSON.stringify(r).includes(KEY), 'chatOpen 반환값에 평문 키 없음');
});

test('chatOpen: ext.studio면 ensureStudio를 부르고 STUDIO_TOOL/STUDIO_ORG가 환경에 들어간다(실패는 경고로만)', async () => {
  await getMods();
  const mods = await getMods();
  const proj = tmp();
  const ensured = [];
  const getStudio = async () => ({
    ensureStudio: dir => { ensured.push(dir); if (dir === 'THROW') throw new Error('읽기 전용 폴더'); return { seeded: true, written: [], removed: [], kept: [], warnings: [] }; },
    validateOrg: mods.studio.validateOrg,
  });
  const projects = [P({ id: 'stud1', path: proj, ext: { studio: true } })];
  const warns = [];
  const { deps, chatHost } = makeDeps({ projects, getStudio, warn: m => warns.push(m) });
  const b = createBridge(deps);
  assert.equal((await b.chatOpen({ projectId: 'stud1' })).ok, true);
  assert.deepEqual(ensured, [proj]);
  const o = chatHost.calls.open[0];
  assert.equal(o.env.STUDIO_ORG, path.join(proj, '.studio', 'org.json'));
  assert.ok(o.env.STUDIO_TOOL.endsWith('studio.mjs'), o.env.STUDIO_TOOL);
  // ensureStudio가 던져도 채팅은 연다(경고만)
  const p2 = [P({ id: 'stud1', path: 'THROW', ext: { studio: true } })];
  const b2 = createBridge(makeDeps({ projects: p2, getStudio, warn: m => warns.push(m), existsSync: () => true }).deps);
  assert.equal((await b2.chatOpen({ projectId: 'stud1' })).ok, true);
  assert.ok(warns.some(w => /실패/.test(w)), JSON.stringify(warns));
});

test('chat 래퍼: chatId·requestId 검증, chatList의 projectId 병합·정리, closeAll', async () => {
  await getMods();
  const projA = tmp(), projB = tmp();
  const projects = [P({ id: 'pa', path: projA }), P({ id: 'pb', path: projB })];
  const { deps, chatHost } = makeDeps({ projects });
  const b = createBridge(deps);
  const a = await b.chatOpen({ projectId: 'pa' });
  const c = await b.chatOpen({ projectId: 'pb' });
  assert.ok(CHAT_ID_RE.test(a.chatId) && CHAT_ID_RE.test(c.chatId));

  assert.equal(b.chatSend('bad-id', { text: 'x' }).ok, false);
  assert.deepEqual(b.chatSend(a.chatId, { text: '안녕' }), { ok: true });
  assert.equal(b.chatRespond(a.chatId, '', { allow: true }).ok, false);
  assert.deepEqual(b.chatRespond(a.chatId, 'req1', { allow: true }), { ok: true });
  assert.equal(b.chatInterrupt('nope!!').ok, false);
  assert.deepEqual(b.chatInterrupt(a.chatId), { ok: true });
  assert.equal((await b.chatSetModel(a.chatId, ' ')).ok, false);
  assert.deepEqual(await b.chatSetModel(a.chatId, 'opus'), { ok: true });
  assert.equal((await b.chatSetPermissionMode(a.chatId, 'plan')).ok, true);
  const cmds = await b.chatCommands(a.chatId);
  assert.deepEqual(cmds, { ok: true, commands: [{ name: 'review', description: '리뷰', argumentHint: '<file>' }] });
  assert.equal((await b.chatCommands('zzz')).ok, false);

  const list = b.chatList();
  assert.equal(list.ok, true);
  assert.deepEqual(list.chats.map(x => x.projectId).sort(), ['pa', 'pb']);
  assert.ok(list.chats.every(x => CHAT_ID_RE.test(x.id) && x.cwd && 'sessionId' in x && 'busy' in x && 'pending' in x));
  assert.deepEqual(await b.chatClose(c.chatId), { ok: true });
  assert.equal(b.chatList().chats.length, 1);
  assert.deepEqual(await b.chatClose(c.chatId), { ok: false, error: '세션을 찾을 수 없습니다' }, '두 번 닫기');
  b.closeAll();
  assert.deepEqual(b.chatList().chats, [], 'closeAll이 전부 닫는다');
  assert.deepEqual(chatHost.calls.close.length >= 2, true);
});

test('bridge 결과 전반에 평문 키가 없다', async () => {
  await getMods();
  const proj = tmp();
  writeRun(proj, '20260102-010000-01ab', { 'meta.json': META(proj, '20260102-010000-01ab', { warnings: ['경고'] }), 'spec.md': SPEC, 'prompt.md': PROMPT });
  const home = tmp();
  writeSession(path.join(home, '.claude'), proj, UUID, '대화');
  const projects = [P({ path: proj, mode: 'glm' })];
  const b = createBridge(makeDeps({ projects, home }).deps);
  const results = [
    await b.historyList('std1'), await b.historyRead('std1', UUID), await b.historySearch('std1', '대화'),
    await b.runsList('std1'), await b.runsRead('std1', '20260102-010000-01ab'), await b.studioOrg('std1'),
    b.chatList(), b.chatSend('c12345678', { text: 'x' }),
  ];
  for (const r of results) assert.ok(!JSON.stringify(r).includes(KEY), `평문 키 유출: ${JSON.stringify(r).slice(0, 80)}`);
});
