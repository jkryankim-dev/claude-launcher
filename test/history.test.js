'use strict';
// 대화 기록 읽기 모듈 테스트: src/core/history.js
// 임시 configDir에 픽스처 jsonl을 코드로 만들어 쓴다(실제 ~/.claude는 읽지 않는다).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../src/core/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
const IS_WIN = process.platform === 'win32';
const PROJ = IS_WIN ? 'C:\\dev\\proj' : '/dev/proj';
const sid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// jsonl 한 줄 만들기(정의되지 않은 키는 JSON.stringify가 버린다)
const base = (type, o = {}) => ({
  type, uuid: o.uuid, parentUuid: o.parentUuid, timestamp: o.ts, sessionId: o.sessionId,
  cwd: o.cwd, isSidechain: o.sidechain === true ? true : undefined, isMeta: o.meta === true ? true : undefined,
  entrypoint: o.entrypoint, gitBranch: o.branch, version: '2.0.0',
});
const user = (content, o = {}) => ({ ...base('user', { cwd: PROJ, ...o }), message: { content } });
const assistant = (content, o = {}) => {
  const { model, ...rest } = o;
  return { ...base('assistant', { cwd: PROJ, ...rest }), message: { model: model || 'claude-x', content } };
};
const text = t => ({ type: 'text', text: t });
const toolUse = (name, input) => ({ type: 'tool_use', name, input });

const write = (file, lines) => fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const mkproj = () => { const c = tmp(), dir = h.projectDir(c, PROJ); fs.mkdirSync(dir, { recursive: true }); return { c, dir }; };
const setMtime = (file, iso) => fs.utimesSync(file, new Date(iso), new Date(iso));

test('encodeProjectDir/projectDir: 영숫자 외 문자는 모두 -, 한글·공백 포함', () => {
  assert.equal(h.encodeProjectDir('C:\\dev\\claude-launcher'), 'C--dev-claude-launcher');
  assert.equal(h.encodeProjectDir('/home/u/my_app'), '-home-u-my-app');
  assert.equal(h.encodeProjectDir('C:\\dev\\프로 젝트'), 'C--dev------');
  assert.equal(h.encodeProjectDir(''), '');
  assert.equal(h.projectDir('C:\\cfg', 'C:\\dev\\x'), path.join('C:\\cfg', 'projects', 'C--dev-x'));
});

test('cleanText: 꼬리표 제거·여러 줄 꼬리표·command 복원·꼬리표뿐인 글', () => {
  assert.equal(h.cleanText('그냥 글'), '그냥 글');
  assert.equal(h.cleanText('<system-reminder>조용히</system-reminder>본문'), '본문');
  assert.equal(h.cleanText('앞<system-reminder>여\n러\n줄</system-reminder>뒤'), '앞뒤');
  assert.equal(h.cleanText('<command-name>/compact</command-name><command-args>max 10</command-args>'), '/compact max 10');
  assert.equal(h.cleanText('<command-name>/clear</command-name>'), '/clear');
  assert.equal(h.cleanText('<command-message>msg</command-message><command-args>x</command-args>'), '', 'command-name 없는 꼬리표뿐인 글');
  assert.equal(h.cleanText('<local-command-stdout>출력</local-command-stdout>'), '');
  assert.equal(h.cleanText('<local-command-caveat>주의</local-command-caveat>'), '');
  assert.equal(h.cleanText('<task-notification><x>무시</x></task-notification>남음'), '남음');
  assert.equal(h.cleanText(123), '');
  assert.equal(h.cleanText(null), '');
});

test('listSessions: 제목 우선순위 4단계·ai-title 마지막 것·정렬·limit·필드', async () => {
  const { c, dir } = mkproj();
  const f = (n, lines) => { const p = path.join(dir, sid(n) + '.jsonl'); write(p, lines); return p; };
  f(1, [
    user('첫 글입니다', { ts: '2026-01-03T00:00:00Z', branch: 'main' }),
    assistant([text('답변')], { ts: '2026-01-03T00:01:00Z', model: 'claude-a' }),
    assistant([text('답변2')], { ts: '2026-01-03T00:02:00Z', model: 'claude-b' }),
    user('둘째 글', { ts: '2026-01-03T00:03:00Z' }),
    { type: 'ai-title', aiTitle: 'ai 제목', sessionId: sid(1) },
    { type: 'summary', summary: '옛 요약 제목', sessionId: sid(1) },
    { type: 'custom-title', customTitle: '정한 제목', sessionId: sid(1) },
  ]);
  f(2, [
    user('f2 첫 글', { ts: '2026-01-02T00:00:00Z' }),
    { type: 'ai-title', aiTitle: '첫 ai 제목', sessionId: sid(2) },
    { type: 'ai-title', aiTitle: '두 번째 ai 제목', sessionId: sid(2) },
  ]);
  f(3, [user('f3 첫 글', { ts: '2026-01-05T00:00:00Z' }), { type: 'summary', summary: '옛 요약 제목', sessionId: sid(3) }]);
  f(4, [user('줄바꿈\n포함 ' + 'p'.repeat(100), { ts: '2026-01-04T00:00:00Z' })]);
  for (const [n, ts] of [[1, '2026-01-03T00:03:00Z'], [2, '2026-01-02T00:00:00Z'], [3, '2026-01-05T00:00:00Z'], [4, '2026-01-04T00:00:00Z']]) {
    setMtime(path.join(dir, sid(n) + '.jsonl'), ts); // mtime 순서를 updatedAt 순서와 맞춰 limit 결과를 결정적으로
  }
  const list = await h.listSessions(c, PROJ);
  assert.deepEqual(list.map(x => x.id), [sid(3), sid(4), sid(1), sid(2)], 'updatedAt 내림차순');
  assert.equal(list[0].title, '옛 요약 제목', 'summary 승격');
  assert.equal(list[3].title, '두 번째 ai 제목', 'ai-title 여러 개 중 마지막');
  const s1 = list.find(x => x.id === sid(1));
  assert.equal(s1.title, '정한 제목', 'custom-title이 최우선');
  assert.equal(s1.firstPrompt, '첫 글입니다');
  assert.equal(s1.messages, 4);
  assert.equal(s1.model, 'claude-b', '마지막 어시스턴트 모델');
  assert.equal(s1.branch, 'main');
  assert.equal(s1.entrypoint, null);
  assert.equal(s1.headless, false);
  assert.equal(s1.startedAt, '2026-01-03T00:00:00Z');
  assert.equal(s1.updatedAt, '2026-01-03T00:03:00Z');
  assert.equal(s1.file, path.join(dir, sid(1) + '.jsonl'));
  assert.ok(s1.size > 0);
  assert.equal(list[1].title.length, 80, '첫 글 폴백 제목은 80자로 자름');
  assert.ok(list[1].title.startsWith('줄바꿈 포함'), '공백 정리');
  assert.ok(list[1].title.endsWith('…'));
  assert.equal(list[1].firstPrompt.length, 107, 'firstPrompt는 200자 이내라 그대로');
  const two = await h.listSessions(c, PROJ, { limit: 2 });
  assert.deepEqual(two.map(x => x.id), [sid(3), sid(4)]);
});

test('listSessions: 빈 세션 제외·agent 파일·하위 폴더·uuid 아닌 파일 무시·폴더 없음', async () => {
  const { c, dir } = mkproj();
  write(path.join(dir, sid(1) + '.jsonl'), [assistant([text('사용자 글 없는 세션')])]);
  write(path.join(dir, sid(2) + '.jsonl'), [user('<system-reminder>숨김</system-reminder>')]);
  write(path.join(dir, sid(3) + '.jsonl'), [user([{ type: 'tool_result', content: 'x', tool_use_id: 't' }])]);
  write(path.join(dir, sid(4) + '.jsonl'), [user('살아남는 글')]);
  write(path.join(dir, 'agent-123.jsonl'), [user('에이전트 세션')]);
  write(path.join(dir, 'not-uuid.jsonl'), [user('uuid 형태 아님')]);
  fs.mkdirSync(path.join(dir, 'sub'));
  write(path.join(dir, 'sub', sid(5) + '.jsonl'), [user('하위 폴더 세션')]);
  assert.deepEqual((await h.listSessions(c, PROJ)).map(x => x.id), [sid(4)]);
  assert.deepEqual(await h.listSessions(tmp(), PROJ), [], '폴더가 없으면 빈 배열');
  assert.deepEqual(await h.listSessions(c, IS_WIN ? 'Z:\\없는\\폴더' : '/없는/폴더'), []);
});

test('listSessions: headless 제외/포함, 걸러진 만큼 더 읽어 limit 채우기', async () => {
  const { c, dir } = mkproj();
  const f = (n, entrypoint, ts) => {
    const p = path.join(dir, sid(n) + '.jsonl');
    write(p, [user(`${n}번 글`, { entrypoint, ts })]);
    setMtime(p, ts);
  };
  f(1, 'cli', '2026-02-10T00:00:00Z');
  f(2, 'sdk', '2026-02-09T00:00:00Z');
  f(3, 'cli', '2026-02-08T00:00:00Z');
  const only = await h.listSessions(c, PROJ);
  assert.deepEqual(only.map(x => x.id), [sid(1), sid(3)], '기본은 headless(sdk)만 제외');
  assert.equal(only[0].headless, false);
  const filled = await h.listSessions(c, PROJ, { limit: 2 }); // 2번이 걸러져도 3번을 읽어 2개를 채운다
  assert.deepEqual(filled.map(x => x.id), [sid(1), sid(3)]);
  const all = await h.listSessions(c, PROJ, { includeHeadless: true });
  assert.deepEqual(all.map(x => x.id), [sid(1), sid(2), sid(3)]);
  assert.equal(all[1].entrypoint, 'sdk');
  assert.equal(all[1].headless, true);
});

test('listSessions: cwd 확인 — 같은 인코딩 폴더의 다른 cwd 제외, 구분자·끝·대소문자 차이는 인정', async () => {
  const { c, dir } = mkproj();
  const OTHER = IS_WIN ? 'C:\\dev\\other' : '/dev/other';
  write(path.join(dir, sid(1) + '.jsonl'), [user('그대로', { cwd: PROJ, ts: '2026-03-01T00:00:00Z' })]);
  write(path.join(dir, sid(2) + '.jsonl'), [user('다른 폴더', { cwd: OTHER, ts: '2026-03-05T00:00:00Z' })]);
  write(path.join(dir, sid(3) + '.jsonl'), [user('슬래시', { cwd: IS_WIN ? 'c:/dev/proj/' : '/dev/proj/', ts: '2026-03-04T00:00:00Z' })]);
  write(path.join(dir, sid(4) + '.jsonl'), [user('대문자', { cwd: IS_WIN ? 'C:\\DEV\\PROJ' : '/dev/PROJ', ts: '2026-03-03T00:00:00Z' })]);
  write(path.join(dir, sid(5) + '.jsonl'), [user('cwd 없음', { cwd: undefined, ts: '2026-03-02T00:00:00Z' })]);
  const ids = new Set((await h.listSessions(c, PROJ)).map(x => x.id));
  assert.ok(ids.has(sid(1)));
  assert.ok(ids.has(sid(3)), "Windows식 '/' 구분자·끝 구분자 차이는 같은 폴더");
  assert.ok(ids.has(sid(5)), 'cwd 줄이 전혀 없으면 포함');
  assert.ok(!ids.has(sid(2)), '같은 인코딩 폴더명에 섞인 다른 폴더의 세션');
  assert.equal(ids.has(sid(4)), IS_WIN, '대소문자는 Windows에서만 무시');
});

test('깨진 줄·잘린 마지막 줄·모르는 type·1MB api-request 줄이 섞여도 정상', async () => {
  const { c, dir } = mkproj();
  const file = path.join(dir, sid(1) + '.jsonl');
  write(file, [
    JSON.stringify({ type: 'file-history-snapshot', cwd: PROJ, sessionId: sid(1) }),
    '이건 그냥 깨진 줄 {{{',
    JSON.stringify({ type: 'queue-operation', op: 'x' }),
    user('깨진 파일에서도 읽기', { ts: '2026-04-01T00:00:01Z' }),
    assistant([text('응답')], { ts: '2026-04-01T00:00:02Z' }),
    JSON.stringify({ type: 'api-request', requestId: 'r1', pad: 'x'.repeat(1048576), fake: { type: 'user', note: '속임' }, cwd: PROJ }),
    '{"uuid":"q9","parentUuid":null,"cwd":' + JSON.stringify(PROJ) + ',"timestamp":"2026-04-01T00:00:03Z","type":"user","message":{"content":"키 순서가 달라도 읽는다"}}',
  ]);
  fs.appendFileSync(file, '{"type":"user","message":{"content":"쓰다 만 줄"'); // 잘린 마지막 줄(줄바꿈 없음)
  const list = await h.listSessions(c, PROJ);
  assert.equal(list.length, 1);
  assert.equal(list[0].messages, 3);
  assert.equal(list[0].firstPrompt, '깨진 파일에서도 읽기');
  assert.equal(list[0].updatedAt, '2026-04-01T00:00:03Z');
  assert.ok(list[0].size > 1048576, '1MB 줄 포함 크기');
  const tr = await h.readTranscript(file);
  assert.equal(tr.total, 3);
  assert.deepEqual(tr.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(tr.messages[2].text, '키 순서가 달라도 읽는다');
});

test('캐시: 같은 파일은 다시 읽지 않고, 줄이 늘거나 mtime이 바뀌면 다시 읽는다', async () => {
  const { c, dir } = mkproj();
  const file = path.join(dir, sid(1) + '.jsonl');
  write(file, [user('캐시 글', { ts: '2026-05-01T00:00:00Z' }), assistant([text('답')], { ts: '2026-05-01T00:01:00Z' })]);
  h.clearCache();
  assert.equal(h._readCount(), 0);
  const a1 = await h.listSessions(c, PROJ);
  assert.equal(h._readCount(), 1);
  const a2 = await h.listSessions(c, PROJ);
  assert.equal(h._readCount(), 1, '두 번째는 파일을 다시 읽지 않음');
  assert.deepEqual(a2, a1);
  fs.appendFileSync(file, JSON.stringify(user('추가 글', { ts: '2026-05-02T00:00:00Z' })) + '\n');
  const a3 = await h.listSessions(c, PROJ);
  assert.equal(h._readCount(), 2, '내용이 늘면 다시 읽음');
  assert.equal(a3[0].messages, 3);
  assert.equal(a3[0].updatedAt, '2026-05-02T00:00:00Z');
  setMtime(file, '2026-06-01T00:00:00Z');
  const a4 = await h.listSessions(c, PROJ);
  assert.equal(h._readCount(), 3, '크기가 같아도 mtime이 바뀌면 다시 읽음');
  assert.deepEqual(a4.map(x => x.messages), [3]);
  h.clearCache();
  assert.equal(h._readCount(), 0);
});

test('readTranscript: 연속 assistant 병합·thinking 제외·tool_result뿐 제외·이미지·sidechain/meta 제외·긴 글 자르기', async () => {
  const { dir } = mkproj();
  const file = path.join(dir, sid(1) + '.jsonl');
  const T = s => `2026-06-01T00:0${s}:00Z`;
  write(file, [
    user('질문 1', { uuid: 'u1', ts: T(1) }),
    assistant([{ type: 'thinking', thinking: '버리는 생각' }, text('답1 앞'), toolUse('Read', { file_path: 'C:\\a\\b.js', extra: 2 })], { uuid: 'a1', parentUuid: 'u1', ts: T(2), model: 'm1' }),
    assistant([text('답1 뒤'), toolUse('Bash', { command: 'npm test' })], { uuid: 'a2', parentUuid: 'a1', ts: T(3), model: 'm1' }),
    user([{ type: 'tool_result', content: 'ok', tool_use_id: 't1' }], { uuid: 'ur', parentUuid: 'a2' }),
    user([text('사진'), { type: 'image', source: {} }], { uuid: 'u2', parentUuid: 'ur', ts: T(4) }),
    assistant([toolUse('Grep', { pattern: 'foo', description: '설명' })], { uuid: 'a3', parentUuid: 'u2', ts: T(5), model: 'm2' }),
    user('사이드체인 글', { uuid: 'us', parentUuid: 'a3', sidechain: true }),
    user('메타 글', { uuid: 'um', parentUuid: 'a3', meta: true }),
    assistant([text('긴'.repeat(25000))], { uuid: 'a4', parentUuid: 'um', ts: T(6), model: 'm2' }),
  ]);
  const r = await h.readTranscript(file);
  assert.equal(r.total, 5);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.messages[0], { role: 'user', text: '질문 1', tools: [], ts: T(1), model: null });
  assert.deepEqual(r.messages[1], {
    role: 'assistant', text: '답1 앞\n\n답1 뒤',
    tools: [{ name: 'Read', summary: 'C:\\a\\b.js' }, { name: 'Bash', summary: 'npm test' }],
    ts: T(2), model: 'm1',
  }, 'parentUuid로 이어진 어시스턴트 줄은 하나로 합침(빈 줄로 잇기)');
  assert.equal(r.messages[2].text, '사진\n[이미지]', '이미지 블록 표시');
  assert.deepEqual(r.messages[3].tools, [{ name: 'Grep', summary: 'foo' }], 'pattern이 description보다 우선');
  assert.equal(r.messages[3].text, '');
  assert.equal(r.messages[4].text.length, 20005, '20,000자 + …(생략)');
  assert.ok(r.messages[4].text.endsWith('…(생략)'));
  const tail2 = await h.readTranscript(file, { limit: 2 });
  assert.deepEqual(tail2.messages.map(m => m.role), ['assistant', 'assistant'], 'tail이면 마지막 limit개');
  assert.deepEqual(tail2.messages[0].tools, [{ name: 'Grep', summary: 'foo' }]);
  assert.equal(tail2.total, 5);
  assert.equal(tail2.truncated, true);
  const head2 = await h.readTranscript(file, { limit: 2, tail: false });
  assert.deepEqual(head2.messages.map(m => m.role), ['user', 'assistant'], 'tail=false면 처음 limit개');
  assert.equal(head2.messages[0].text, '질문 1');
  assert.deepEqual(head2.messages[1].tools[0], { name: 'Read', summary: 'C:\\a\\b.js' });
});

test('readTranscript: tool_use 요약 키 우선순위·120자 자르기·빈 input', async () => {
  const { dir } = mkproj();
  const file = path.join(dir, sid(1) + '.jsonl');
  write(file, [
    user('도구 목록'),
    assistant([toolUse('Write', { command: 'cmd-value', file_path: 'f.json' })], { uuid: 'x1', parentUuid: 'p0' }),
    assistant([toolUse('X', { description: 'd', pattern: 'pat' })], { uuid: 'x2', parentUuid: 'p1' }),
    assistant([toolUse('Y', { url: 'https://u', prompt: '프롬프트' })], { uuid: 'x3', parentUuid: 'p2' }),
    assistant([toolUse('Z', { skill: 'glm-delegate', query: 'q' })], { uuid: 'x4', parentUuid: 'p3' }),
    assistant([toolUse('W', { note: '다른 키뿐' })], { uuid: 'x5', parentUuid: 'p4' }),
    assistant([toolUse('V', { command: 'c'.repeat(200) })], { uuid: 'x6', parentUuid: 'p5' }),
    assistant([toolUse('N')], { uuid: 'x7', parentUuid: 'p6' }),
  ]);
  const { messages } = await h.readTranscript(file);
  assert.equal(messages.length, 8);
  assert.equal(messages[1].tools[0].summary, 'f.json', 'file_path가 command보다 우선');
  assert.equal(messages[2].tools[0].summary, 'pat', 'pattern이 description보다 우선');
  assert.equal(messages[3].tools[0].summary, '프롬프트', 'prompt가 url보다 우선');
  assert.equal(messages[4].tools[0].summary, 'glm-delegate', 'skill이 query보다 우선');
  assert.equal(messages[5].tools[0].summary, '', '아는 키가 없으면 빈 문자열');
  assert.equal(messages[6].tools[0].summary.length, 120);
  assert.ok(messages[6].tools[0].summary.endsWith('…'));
  assert.equal(messages[7].tools[0].summary, '', 'input 없음');
});

test('searchSessions: 본문·제목 일치, 대소문자 무시, 세션당 1건, 짧은 query, snippet 범위, limit', async () => {
  const { c, dir } = mkproj();
  const f = (n, lines, ts) => { const p = path.join(dir, sid(n) + '.jsonl'); write(p, lines); setMtime(p, ts); };
  f(1, [
    user('npm test 스크립트 고침', { ts: '2026-07-01T00:00:00Z' }),
    assistant([text('스크립트 확인 완료')], { ts: '2026-07-01T00:01:00Z' }),
    { type: 'custom-title', customTitle: '배포 자동화', sessionId: sid(1) },
  ], '2026-07-01T00:01:00Z');
  f(2, [user('점심 메뉴 추천', { ts: '2026-07-02T00:00:00Z' }), assistant([text('ESLint 규칙 이야기')], { ts: '2026-07-02T00:01:00Z' })], '2026-07-02T00:01:00Z');
  f(3, [user('a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100), { ts: '2026-07-03T00:00:00Z' })], '2026-07-03T00:00:00Z');
  f(4, [user('npm install', { ts: '2026-06-01T00:00:00Z' })], '2026-06-01T00:00:00Z');

  const npm = await h.searchSessions(c, PROJ, 'npm');
  assert.deepEqual(npm.map(x => x.id), [sid(1), sid(4)], 'updatedAt 내림차순');
  assert.equal(npm[0].role, 'user');
  assert.equal(npm[0].snippet, 'npm test 스크립트 고침', '처음 일치라 앞 … 없음');
  assert.equal(npm[0].ts, '2026-07-01T00:00:00Z');
  assert.equal(npm[0].updatedAt, '2026-07-01T00:01:00Z');
  assert.equal(npm[0].title, '배포 자동화');
  assert.deepEqual(await h.searchSessions(c, PROJ, 'npm', { limit: 1 }), [npm[0]]);

  const eslint = await h.searchSessions(c, PROJ, 'ESLINT');
  assert.equal(eslint.length, 1);
  assert.equal(eslint[0].id, sid(2));
  assert.equal(eslint[0].role, 'assistant', '대소문자 무시 본문 일치');

  const title = await h.searchSessions(c, PROJ, '배포');
  assert.equal(title.length, 1);
  assert.equal(title[0].role, 'title', '제목 일치');
  assert.ok(title[0].snippet.includes('배포'));
  assert.equal(title[0].ts, title[0].updatedAt);

  const one = await h.searchSessions(c, PROJ, '스크립트');
  assert.equal(one.length, 1, '세션당 첫 일치 1건');
  assert.equal(one[0].role, 'user');

  const needle = await h.searchSessions(c, PROJ, 'needle');
  assert.equal(needle.length, 1);
  assert.ok(needle[0].snippet.startsWith('…') && needle[0].snippet.endsWith('…'), '창이 잘리면 …');
  assert.ok(needle[0].snippet.includes('NEEDLE'));

  assert.deepEqual(await h.searchSessions(c, PROJ, 'x'), [], '2자 미만 query');
  assert.deepEqual(await h.searchSessions(c, PROJ, '배'), []);
  assert.deepEqual(await h.searchSessions(tmp(), PROJ, 'npm'), [], '폴더 없음');
});

test('readTranscript: 없는 파일·빈 파일도 던지지 않는다', async () => {
  assert.deepEqual(await h.readTranscript(path.join(tmp(), 'nope.jsonl')), { messages: [], total: 0, truncated: false });
  const { dir } = mkproj();
  const empty = path.join(dir, sid(1) + '.jsonl');
  fs.writeFileSync(empty, '');
  assert.deepEqual(await h.readTranscript(empty), { messages: [], total: 0, truncated: false });
});
