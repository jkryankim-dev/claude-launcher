'use strict';
// src/core/runs.js 테스트: 임시 폴더에 .glm/runs/<id>/ 픽스처를 코드로 만들어 목록·상세·감시를 확인하고,
// 마지막에 mock-claude(test/fixtures/mock-claude.mjs)로 glm-run.mjs를 실제로 돌려 만든 실행 폴더도 읽어
// 파일 이름·형식이 실제와 어긋나지 않는지 검증한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runs = require('../src/core/runs');

const ROOT = path.resolve(__dirname, '..');
const GLM_RUN = path.join(ROOT, 'skills', 'glm-delegate', 'scripts', 'glm-run.mjs');
const MOCK = path.join(__dirname, 'fixtures', 'mock-claude.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runsmod-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const newProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runsproj-'));
const runDirOf = (p, id) => path.join(p, '.glm', 'runs', id);
function writeRun(p, id, files) {
  const d = runDirOf(p, id);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    if (content == null) continue;
    fs.writeFileSync(path.join(d, name), content);
  }
  return d;
}
const J = o => JSON.stringify(o, null, 2);
const ev = o => JSON.stringify(o);

/** glm-run.mjs가 쓰는 meta.json의 필드를 그대로 갖춘 기본값(완료·검증 통과). */
function baseMeta(p, id, over = {}) {
  const fwd = String(p).replace(/\\/g, '/');
  return J({
    id, parent: null, children: [], title: '테스트 실행',
    spec: '.glm/tasks/t1.md', root: fwd, cwd: fwd,
    cfg: { role: 'edit', model: 'glm-5.3', effort: 'high', maxTurns: 200, timeoutMin: 60, scope: ['src/**'], verify: ['npm test'], allowBash: [], reportLines: 80 },
    pid: 0, childPid: null, startedAt: '2026-01-02T03:00:00.000Z', status: 'done',
    snapshot: null, sessionId: 'sess-1', warnings: [],
    endedAt: '2026-01-02T03:01:40.000Z',
    result: { subtype: 'success', isError: false, turns: 6, durationMs: 100000 },
    turns: 6, retries: 0, denials: [], usage: null, rate: null, lastText: '',
    changed: { files: [{ path: 'src/a.js', add: 3, del: 1, st: 'M', oos: false }], outside: [], gitMode: true, partial: false },
    verify: { ok: true, results: [{ cmd: 'npm test', code: 0, ms: 1200, timedOut: false, tail: [] }], shell: 'Git Bash' },
    after: {}, exitCode: 0,
    ...over,
  });
}
const SPEC = '---\ntitle: 테스트 실행\nrole: edit\n---\n## 목표\n본문이다.\n';
const PROMPT = '너는 숙련된 코딩 작업자다.\n\n[작업 명세] 테스트 실행\n## 목표\n본문이다.\n';
const REPORT = '## 결과\n완료 — 테스트\n';

/** stream-json 표준 픽스처: init·글·thinking·Read/Edit/Bash/Grep 도구·오류 tool_result·result. */
function stdStream(p) {
  const A = path.join(p, 'src', 'a.js');
  return [
    ev({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'glm-5.3' }),
    ev({ type: 'assistant', timestamp: '2026-01-02T03:00:05.000Z', message: { id: 'm1', content: [{ type: 'thinking', thinking: '속마음은 활동에 안 나온다' }, { type: 'text', text: '시작한다' }] } }),
    ev({ type: 'assistant', timestamp: '2026-01-02T03:00:10.000Z', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: A } }] } }),
    ev({ type: 'user', timestamp: '2026-01-02T03:00:11.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '30줄' }] }] } }),
    ev({ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: A } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Permission denied: Edit' }] } }),
    ev({ type: 'assistant', message: { id: 'm4', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'node --test test/runs.test.js' } }] } }),
    ev({ type: 'assistant', message: { id: 'm5', content: [{ type: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'TODO' } }] } }),
    ev({ type: 'assistant', message: { id: 'm6', content: [{ type: 'text', text: '결과를 정리한다. '.repeat(60) }] } }),
    ev({ type: 'result', subtype: 'success', is_error: false, result: '## 결과\n완료', num_turns: 6, duration_ms: 1000 }),
  ].join('\n') + '\n';
}

test('listRuns: 최신순·limit·runId 아닌 항목 무시·폴더 없으면 []', async () => {
  const p = newProject();
  assert.deepEqual(await runs.listRuns(p), []);
  fs.mkdirSync(path.join(p, '.glm', 'runs', 'not-a-run'), { recursive: true });
  fs.mkdirSync(path.join(p, '.glm', 'runs', '20260102-030000-zz9g'), { recursive: true }); // runId 형식 아님(zz)
  fs.writeFileSync(path.join(p, '.glm', 'runs', 'zzz.txt'), 'x');
  assert.deepEqual(await runs.listRuns(p), []);
  for (const id of ['20260102-030000-01ab', '20260102-040000-02cd', '20260102-050000-03ef'])
    writeRun(p, id, { 'meta.json': baseMeta(p, id), 'spec.md': SPEC, 'prompt.md': PROMPT });
  assert.deepEqual((await runs.listRuns(p)).map(r => r.id), ['20260102-050000-03ef', '20260102-040000-02cd', '20260102-030000-01ab']);
  assert.deepEqual((await runs.listRuns(p, { limit: 2 })).map(r => r.id), ['20260102-050000-03ef', '20260102-040000-02cd']);
  assert.deepEqual((await runs.listRuns(p, { limit: 1 })).map(r => r.id), ['20260102-050000-03ef']);
});

test('Run 필드·state 판정: 실행 중·비정상 종료·완료·검증 실패·중단·타임아웃·메타 없음·resume', async () => {
  const p = newProject();
  const dead = spawnSync(process.execPath, ['-e', '0']); // 이미 종료한 pid
  const noFinal = { endedAt: undefined, result: undefined, turns: undefined, changed: undefined, verify: undefined, after: undefined, exitCode: undefined };
  writeRun(p, '20260102-010000-01ab', { 'meta.json': baseMeta(p, '20260102-010000-01ab', { status: 'running', pid: process.pid, progress: { turns: 9, files: 2, lastTool: 'Edit src/a.js', at: '2026-01-02T03:00:20.000Z' }, ...noFinal }), 'spec.md': SPEC, 'prompt.md': PROMPT, 'stream.jsonl': stdStream(p) });
  writeRun(p, '20260102-020000-02cd', { 'meta.json': baseMeta(p, '20260102-020000-02cd', { status: 'running', pid: dead.pid, progress: { turns: 3, files: 1, lastTool: 'Edit src/a.js', at: '2026-01-02T03:00:20.000Z' }, ...noFinal }), 'spec.md': SPEC, 'stream.jsonl': stdStream(p) });
  writeRun(p, '20260102-030000-03ef', { 'meta.json': baseMeta(p, '20260102-030000-03ef', { verify: { ok: false, results: [{ cmd: 'npm test', code: 1, ms: 900, timedOut: false, tail: ['fail'] }], shell: 'Git Bash' } }), 'spec.md': SPEC, 'prompt.md': PROMPT, 'stream.jsonl': stdStream(p) });
  writeRun(p, '20260102-033000-03f0', { 'meta.json': baseMeta(p, '20260102-033000-03f0', { status: 'failed', cause: '작업자 오류(error_max_turns)', verify: { ok: false, results: [{ cmd: 'npm test', code: 1, ms: 900, timedOut: false, tail: ['fail'] }], shell: 'Git Bash' } }), 'spec.md': SPEC });
  writeRun(p, '20260102-040000-04a0', { 'meta.json': baseMeta(p, '20260102-040000-04a0', { ...noFinal, status: 'interrupted', pid: process.pid, cause: '강제 종료(--stop)', endedAt: '2026-01-02T03:02:00.000Z' }), 'stream.jsonl': stdStream(p) });
  writeRun(p, '20260102-050000-05b1', { 'meta.json': baseMeta(p, '20260102-050000-05b1', { status: 'timeout', cause: '시간 제한 초과' }), 'spec.md': SPEC });
  writeRun(p, '20260102-060000-06c2', { 'stream.jsonl': stdStream(p) }); // 메타 없음 → unknown
  writeRun(p, '20260102-070000-06c3', { 'meta.json': '{ 깨진 json' }); // 메타 깨짐 → unknown
  writeRun(p, '20260102-080000-07d4', { 'meta.json': baseMeta(p, '20260102-080000-07d4', { parent: '20260102-030000-03ef', title: '테스트 실행 · 후속' }), 'spec.md': SPEC });
  const list = await runs.listRuns(p);
  assert.deepEqual(list.map(r => r.state), ['done', 'unknown', 'unknown', 'timeout', 'stopped', 'failed', 'done', 'stopped', 'running']);
  const [resume, broken, unknown, timeoutRun, interrupted, failed, verifyFail, stopped, running] = list;

  assert.equal(verifyFail.state, 'done'); // 검증 실패는 status 'done' + verify 'fail'(glm-run과 동일)
  assert.equal(verifyFail.verify, 'fail');
  assert.equal(verifyFail.title, '테스트 실행');
  assert.equal(verifyFail.role, 'edit');
  assert.equal(verifyFail.persona, null);
  assert.equal(verifyFail.model, 'glm-5.3');
  assert.equal(verifyFail.effort, 'high');
  assert.equal(verifyFail.startedAt, Date.parse('2026-01-02T03:00:00.000Z'));
  assert.equal(verifyFail.endedAt, Date.parse('2026-01-02T03:01:40.000Z'));
  assert.equal(verifyFail.elapsedMs, 100000);
  assert.equal(verifyFail.turns, 6);
  assert.equal(verifyFail.editedFiles, 1);
  assert.equal(verifyFail.lastAction, 'Grep TODO'); // progress 없음 → stream 끝에서
  assert.equal(verifyFail.resumeOf, null);
  assert.equal(verifyFail.specPath, '.glm/tasks/t1.md');
  assert.equal(resume.resumeOf, '20260102-030000-03ef');

  assert.equal(running.state, 'running');
  assert.equal(running.turns, 9); // meta.progress 값 우선
  assert.equal(running.lastAction, 'Grep TODO'); // stream 끝이 더 최신
  assert.equal(running.editedFiles, 2);
  assert.ok(running.endedAt === null && running.elapsedMs > 0);

  assert.equal(stopped.state, 'stopped'); // meta.pid가 죽은 프로세스
  assert.equal(stopped.turns, 6); // progress(3)보다 stream 창의 실제 보조 수가 큼
  assert.equal(interrupted.state, 'stopped');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.verify, 'fail');
  assert.equal(timeoutRun.state, 'timeout');
  for (const u of [unknown, broken]) {
    assert.equal(u.state, 'unknown');
    assert.equal(u.title, '');
    assert.equal(u.role, null);
    assert.equal(u.startedAt, null);
    assert.equal(u.elapsedMs, null);
    assert.equal(u.verify, null);
  }
  assert.equal(unknown.lastAction, 'Grep TODO'); // 메타가 없어도 stream 끝으로 최소한의 정보
  assert.equal(unknown.turns, 6);
  assert.equal(broken.lastAction, ''); // stream도 없으면 빈 값
  assert.equal(broken.turns, 0);
});

test('readRun: spec·prompt·report 원문·persona·verifyOutput, activity 변환, files 중복 제거', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  const A = path.join(p, 'src', 'a.js'), B = path.join(p, 'src', 'b.js');
  const spec = '---\ntitle: 테스트 실행\npersona: 백엔드 담당\n---\n## 목표\n본문이다.\n';
  const stream = [
    ev({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'glm-5.3' }),
    ev({ type: 'assistant', timestamp: '2026-01-02T03:00:05.000Z', message: { id: 'm1', content: [{ type: 'thinking', thinking: '속마음' }, { type: 'text', text: '시작한다' }] } }),
    ev({ type: 'assistant', timestamp: '2026-01-02T03:00:10.000Z', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: A } }] } }),
    ev({ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: A } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Permission denied: Edit' }] } }),
    ev({ type: 'assistant', message: { id: 'm4', content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: B } }] } }),
    ev({ type: 'assistant', message: { id: 'm5', content: [{ type: 'text', text: '긴글이다. '.repeat(80) }] } }),
    ev({ type: 'result', subtype: 'success', is_error: false, result: '## 결과\n완료', num_turns: 5, duration_ms: 900 }),
  ].join('\n') + '\n';
  writeRun(p, id, {
    'meta.json': baseMeta(p, id, { changed: undefined, verify: undefined }),
    'spec.md': spec, 'prompt.md': PROMPT, 'report.md': REPORT, 'stream.jsonl': stream,
    'verify.log': '$ npm test\nok\n\n[exit 0]\n\n',
  });
  const d = await runs.readRun(p, id);
  assert.equal(d.spec, spec);
  assert.equal(d.prompt, PROMPT);
  assert.equal(d.report, REPORT);
  assert.equal(d.persona, '백엔드 담당');
  assert.equal(d.verifyOutput, '$ npm test\nok\n\n[exit 0]\n\n');
  assert.equal(d.verify, null); // meta.verify 없음

  const a = d.activity;
  assert.deepEqual(a.map(x => x.kind), ['text', 'tool', 'tool', 'error', 'tool', 'text', 'result']);
  assert.equal(a[0].text, '시작한다');
  assert.equal(a[0].ts, Date.parse('2026-01-02T03:00:05.000Z'));
  assert.ok(!a.some(x => (x.text || '').includes('속마음')), 'thinking은 활동에서 제외');
  assert.deepEqual([a[1].tool, a[1].summary], ['Read', 'Read src/a.js']);
  assert.deepEqual([a[2].tool, a[2].summary], ['Edit', 'Edit src/a.js']);
  assert.equal(a[2].ts, null, 'timestamp 없는 줄은 null');
  assert.deepEqual([a[3].kind, a[3].tool], ['error', 'Edit']);
  assert.match(a[3].summary, /Permission denied/);
  assert.deepEqual([a[4].tool, a[4].summary], ['Write', 'Write src/b.js']);
  assert.equal(a[5].text.length, 300, '글은 300자로 자름');
  assert.equal(a[6].kind, 'result');
  assert.match(a[6].text, /## 결과/);

  assert.deepEqual(d.files, ['src/a.js', 'src/b.js'], 'stream 편집 도구에서 추리고 중복 제거');
});

test('큰 stream.jsonl(≈5MB): 전체를 읽지 않고 끝부분만으로 activity·lastAction', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  const marker = n => ev({ type: 'assistant', message: { id: `mm-${n}`, content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(p, `${n}-MARKER.js`) } }] } });
  const filler = ev({ type: 'assistant', message: { id: 'mf', content: [{ type: 'text', text: 'x'.repeat(190) }] } });
  const lines = [marker('FIRST')];
  for (let i = 0; i < 26000; i++) lines.push(filler);
  lines.push(marker('LAST'), ev({ type: 'result', subtype: 'success', is_error: false, result: '끝', num_turns: 26002 }));
  const stream = lines.join('\n') + '\n';
  assert.ok(Buffer.byteLength(stream) > 5 * 1024 * 1024, `픽스처가 5MB 이상이어야 함 (${Buffer.byteLength(stream)})`);
  writeRun(p, id, { 'meta.json': baseMeta(p, id, { turns: 26002, progress: undefined }), 'spec.md': SPEC, 'stream.jsonl': stream });

  const list = await runs.listRuns(p);
  assert.equal(list[0].turns, 26002); // 메타 값 우선(전체 줄 세지 않음)
  assert.equal(list[0].lastAction, 'Read LAST-MARKER.js');
  const d = await runs.readRun(p, id, { activityLimit: 10 });
  assert.equal(d.activity.length, 10);
  assert.ok(d.activity.some(x => x.summary === 'Read LAST-MARKER.js'));
  assert.ok(!d.activity.some(x => x.summary === 'Read FIRST-MARKER.js'), '처음 줄은 끝읽기 대상이 아님');
  assert.equal(d.activity.at(-1).kind, 'result');
  assert.ok(d.files.length >= 1); // meta.changed 우선 → 전체 스캔하지 않음
});

test('잘린·깨진 stream 줄 무시, 끝 개행 없는 온전한 마지막 줄은 읽힘', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  const stream = [
    ev({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '첫 줄' }] } }),
    '깨진 json {{{',
    ev({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'TODO' } }] } }),
    '{"type":"result","subtype":"success","is_error":false,"result":"완료","num_turns":2}',
  ].join('\n') + '\n' + '{"type":"assi'; // 쓰는 중에 끊긴 마지막 줄
  writeRun(p, id, { 'meta.json': baseMeta(p, id, { status: 'running', pid: process.pid, ...({ endedAt: undefined, turns: undefined, changed: undefined, verify: undefined }) }), 'stream.jsonl': stream });
  const d = await runs.readRun(p, id);
  assert.deepEqual(d.activity.map(x => x.kind), ['text', 'tool', 'result']);
  assert.equal(d.lastAction, 'Grep TODO');
});

test('자르기 한도(60,000자)와 warnings', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  const big = '가'.repeat(70000);
  writeRun(p, id, { 'meta.json': baseMeta(p, id), 'spec.md': big, 'prompt.md': big, 'report.md': big, 'stream.jsonl': stdStream(p) });
  const d = await runs.readRun(p, id);
  assert.equal(d.spec.length, 60000);
  assert.equal(d.prompt.length, 60000);
  assert.equal(d.report.length, 60000);
  assert.ok(d.warnings.some(w => w.includes('명세(spec.md)')));
  assert.ok(d.warnings.some(w => w.includes('프롬프트(prompt.md)')));
  assert.ok(d.warnings.some(w => w.includes('보고(report.md)')));
  const d2 = await runs.readRun(p, id, { activityLimit: 3 });
  assert.ok(d2.activity.length <= 3);
});

test('비밀값 가림: sk-…·Bearer …는 ***로', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  writeRun(p, id, {
    'meta.json': baseMeta(p, id, { title: '키 sk-abcdef123456 노출', warnings: ['Bearer abc.def.ghi-token 경고'] }),
    'spec.md': '명세에 sk-zzzz9999eeee 가 있음\n', 'prompt.md': '프롬프트에 Bearer qqq.rrr.sss 가 있음\n',
    'report.md': '보고에 sk-qqq1234wwww 가 있음\n', 'stream.jsonl': stdStream(p),
  });
  const d = await runs.readRun(p, id);
  const all = [d.title, d.spec, d.prompt, d.report, ...d.warnings].join('\n');
  assert.ok(!/sk-[a-z0-9]{8}/.test(all), 'sk- 토큰이 그대로 나오면 안 됨');
  assert.ok(!/Bearer [a-z.]/i.test(all), 'Bearer 값이 그대로 나오면 안 됨');
  assert.ok(all.includes('***'));
  assert.ok(d.title.includes('***'));
});

test('readRun·isRunId: 잘못된 runId는 null(경로 탈출 차단)', async () => {
  const p = newProject();
  writeRun(p, '20260102-030000-01ab', { 'meta.json': baseMeta(p, '20260102-030000-01ab') });
  assert.ok(runs.isRunId('20260102-030000-01ab'));
  for (const bad of ['../x', '..\\x', 'foo', '', '20260102-030000-zzzz', '20260102-030000-01AB', '2026-01-02-030000-01ab', null, undefined, '20260102-030000-01ab/../../x'])
    assert.equal(runs.isRunId(bad), false, `isRunId(${JSON.stringify(bad)})`);
  for (const bad of ['../x', '20260102-030000-zzzz', '20260102-030000-01ab/../../x', '20260102-999999-99gg'])
    assert.equal(await runs.readRun(p, bad), null, `readRun(${bad})`);
  assert.equal(await runs.readRun(p, '20260102-030000-01ab').then(r => !!r), true);
  assert.equal(await runs.readRun(newProject(), '20260102-030000-01ab'), null, '없는 실행');
});

test('캐시: 완료 실행은 mtime+size가 같으면 다시 읽지 않고, 실행 중 실행은 갱신 반영', async () => {
  const p = newProject();
  const doneId = '20260102-030000-01ab';
  const metaPath = path.join(runDirOf(p, doneId), 'meta.json');
  writeRun(p, doneId, { 'meta.json': baseMeta(p, doneId, { title: 'AAA' }), 'spec.md': SPEC, 'prompt.md': PROMPT });
  const st0 = fs.statSync(metaPath);
  assert.equal((await runs.listRuns(p))[0].title, 'AAA');
  fs.writeFileSync(metaPath, baseMeta(p, doneId, { title: 'BBB' })); // 같은 길이로 내용만 교체
  const t = new Date(Math.round(st0.mtimeMs));
  fs.utimesSync(metaPath, t, t);
  assert.equal(fs.statSync(metaPath).size, st0.size);
  assert.equal((await runs.listRuns(p))[0].title, 'AAA', 'mtime+size 불변이면 캐시 값');
  fs.utimesSync(metaPath, new Date(), new Date());
  assert.equal((await runs.listRuns(p))[0].title, 'BBB', 'mtime이 바뀌면 다시 읽음');

  const runId = '20260102-040000-02cd';
  const streamPath = path.join(runDirOf(p, runId), 'stream.jsonl');
  const noFinal = { endedAt: undefined, turns: undefined, changed: undefined, verify: undefined };
  writeRun(p, runId, { 'meta.json': baseMeta(p, runId, { status: 'running', pid: process.pid, ...noFinal }), 'stream.jsonl': stdStream(p) });
  let list = await runs.listRuns(p);
  assert.equal(list[0].lastAction, 'Grep TODO');
  fs.appendFileSync(streamPath, ev({ type: 'assistant', message: { id: 'm7', content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: path.join(p, 'z.js') } }] } }) + '\n');
  list = await runs.listRuns(p);
  assert.equal(list[0].lastAction, 'Read z.js', '실행 중 실행은 캐시하지 않음');
  assert.equal(list[0].turns, 7);
});

test('watchRuns: 변화를 디바운스해 한 번 알리고 close 뒤에는 조용히', async () => {
  const p = newProject();
  const id = '20260102-030000-01ab';
  const d = runDirOf(p, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), baseMeta(p, id));
  fs.writeFileSync(path.join(d, 'stream.jsonl'), stdStream(p));
  let n = 0;
  const w = runs.watchRuns(p, () => n++, { debounceMs: 120 });
  await sleep(400);
  assert.equal(n, 0, '시작 시점의 상태로는 알리지 않음');
  fs.writeFileSync(path.join(d, 'STOP'), new Date().toISOString());
  fs.appendFileSync(path.join(d, 'stream.jsonl'), ev({ type: 'assistant', message: { id: 'm9', content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(p, 'x.js') } }] } }) + '\n');
  fs.writeFileSync(path.join(d, 'report.md'), REPORT);
  await sleep(700);
  assert.equal(n, 1, '거의 동시의 여러 변화가 디바운스로 한 번');
  w.close();
  fs.appendFileSync(path.join(d, 'stream.jsonl'), ev({ type: 'result' }) + '\n');
  fs.mkdirSync(runDirOf(p, '20260102-090000-09ff'), { recursive: true });
  await sleep(500);
  assert.equal(n, 1, 'close 뒤에는 onChange 없음');
});

test('watchRuns: .glm/runs가 나중에 생기면 감지(폴링 대체 경로)', async () => {
  const p = newProject();
  let n = 0;
  const w = runs.watchRuns(p, () => n++, { debounceMs: 50, pollMs: 250 });
  await sleep(200);
  assert.equal(n, 0);
  writeRun(p, '20260102-030000-01ab', { 'meta.json': baseMeta(p, '20260102-030000-01ab') });
  const t0 = Date.now();
  while (n === 0 && Date.now() - t0 < 5000) await sleep(100);
  assert.ok(n >= 1, 'runs 폴더 생성 감지');
  w.close();
  await sleep(400);
  const at = n;
  fs.appendFileSync(path.join(runDirOf(p, '20260102-030000-01ab'), 'meta.json'), ' ');
  await sleep(400);
  assert.equal(n, at, 'close 뒤에는 onChange 없음');
});

test('glm-run.mjs 실제 실행 결과 읽기: 파일 형식이 실제와 어긋나면 실패한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runsint-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  for (const [f, c] of [['src/a.ts', 'export const a = 1;\n'], ['src/b.ts', 'export const b = 1;\n'], ['README.md', '# t\n']]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git('add', '-A'); git('commit', '-qm', 'init');
  fs.mkdirSync(path.join(dir, '.glm', 'tasks'), { recursive: true });
  const specRel = '.glm/tasks/t1.md';
  fs.writeFileSync(path.join(dir, specRel), '---\ntitle: 테스트 편집\nrole: edit\nverify:\n  - node -e "process.exit(0)"\n---\n## 목표\n각 파일 끝에 주석을 추가한다.\n');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GLM_|ZAI_|ANTHROPIC_|CLAUDE|MOCK_)/i.test(k)) env[k] = v;
  Object.assign(env, {
    GLM_CLAUDE_BIN: MOCK, ZAI_API_KEY: 'zai-test-key-1234', GLM_CONFIG_DIR: path.join(TMP, 'conf'),
    CLAUDE_LAUNCHER_HOME: path.join(TMP, 'home'), GLM_HEARTBEAT_SEC: '1',
    MOCK_FILES: 'src/a.ts,src/b.ts', MOCK_BASH_FILE: 'README.md',
  });
  const r = spawnSync(process.execPath, [GLM_RUN, specRel], { cwd: dir, encoding: 'utf8', env, timeout: 180e3 });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const metaOnDisk = JSON.parse(fs.readFileSync(path.join(dir, '.glm', 'runs', fs.readdirSync(path.join(dir, '.glm', 'runs'))[0], 'meta.json'), 'utf8'));
  const list = await runs.listRuns(dir);
  assert.equal(list.length, 1);
  const run = list[0];
  assert.equal(run.id, metaOnDisk.id);
  assert.equal(run.state, 'done');
  assert.equal(run.verify, 'pass');
  assert.equal(run.role, 'edit');
  assert.equal(run.title, '테스트 편집');
  assert.equal(run.model, metaOnDisk.initModel);
  assert.equal(run.turns, metaOnDisk.turns);
  assert.equal(run.editedFiles, metaOnDisk.changed.files.length);
  assert.equal(run.specPath, metaOnDisk.spec);
  assert.ok(run.lastAction.length > 0);

  const d = await runs.readRun(dir, run.id);
  assert.equal(d.spec, fs.readFileSync(path.join(runDirOf(dir, run.id), 'spec.md'), 'utf8'));
  assert.equal(d.prompt, fs.readFileSync(path.join(runDirOf(dir, run.id), 'prompt.md'), 'utf8'));
  assert.equal(d.report, fs.readFileSync(path.join(runDirOf(dir, run.id), 'report.md'), 'utf8'));
  assert.match(d.prompt, /\[작업 명세\] 테스트 편집/);
  assert.match(d.report, /## 결과/);
  assert.deepEqual(d.files, metaOnDisk.changed.files.map(f => f.path));
  assert.ok(d.files.includes('src/a.ts') && d.files.includes('src/b.ts') && d.files.includes('README.md'));
  assert.ok(d.activity.some(x => x.kind === 'tool' && x.summary === 'Edit src/a.ts'));
  assert.ok(d.activity.some(x => x.kind === 'result'));
  assert.ok(d.activity.some(x => x.kind === 'error')); // mock의 권한 거부(npm run build)
  assert.match(d.verifyOutput, /exit 0/);
  assert.equal(d.verify, 'pass');

  fs.writeFileSync(path.join(dir, '.glm/tasks/fix.md'), '# 후속\nsrc/a.ts에 한 줄 추가한다.\n');
  const r2 = spawnSync(process.execPath, [GLM_RUN, '--resume', 'latest', '.glm/tasks/fix.md'], { cwd: dir, encoding: 'utf8', env: { ...env, MOCK_FILES: 'src/a.ts' }, timeout: 180e3 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const list2 = await runs.listRuns(dir);
  assert.equal(list2.length, 2);
  assert.equal(list2[0].resumeOf, list2[1].id, 'resume 후속 실행이 원 실행과 연결됨');
  assert.match(list2[0].title, /후속/);
});
