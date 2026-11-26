'use strict';
// 원격(SSH) 프로젝트 테스트: src/core/remote.js + runtime/remote-apply.cjs (가짜 spawn 주입 + node - 통합)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const remote = require('../src/core/remote');
const claudemd = require('../src/core/claudemd');
const secrets = require('../src/core/secrets');
const agent = require('../runtime/remote-apply.cjs');

const ROOT = path.resolve(__dirname, '..');
const AGENT_SRC = fs.readFileSync(path.join(ROOT, 'runtime', 'remote-apply.cjs'), 'utf8');
const IS_WIN = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'remote-'));
const KEY = 'sk-test-zai-4242';
const REMOTE = { host: 'example-host', user: 'me', port: 2222 };
const withEnv = (lh, home) => ({ ...process.env, CLAUDE_LAUNCHER_HOME: lh, USERPROFILE: home, HOME: home });
const rejectsCode = async (fn, code) => {
  try { await fn(); assert.fail(`${code}로 reject되어야 함`); } catch (e) { assert.equal(e.code, code); return e; }
};

test('normalizeRemote: 정상·trim·옵션 주입 host 거부·user 규칙·port 범위', () => {
  assert.deepEqual(remote.normalizeRemote({ host: ' example-host ', user: ' me ', port: '2222' }), { host: 'example-host', user: 'me', port: 2222 });
  assert.deepEqual(remote.normalizeRemote({ host: 'mini.tail-scale.ts.net.' }), { host: 'mini.tail-scale.ts.net.', user: '', port: 0 });
  assert.deepEqual(remote.normalizeRemote({ host: 'h', user: 'DOMAIN\\사용자' }), { host: 'h', user: 'DOMAIN\\사용자', port: 0 });
  assert.deepEqual(remote.normalizeRemote({ host: 'h', port: 22 }), { host: 'h', user: '', port: 0 });
  assert.deepEqual(remote.normalizeRemote({ host: 'h', port: 65535 }), { host: 'h', user: '', port: 65535 });
  assert.equal(remote.normalizeRemote(null), null);
  assert.equal(remote.normalizeRemote('x'), null);
  assert.equal(remote.normalizeRemote({}), null);
  assert.equal(remote.normalizeRemote({ host: '-oProxyCommand=evil' }), null, 'ssh 옵션으로 쓸 수 있는 형태 거부');
  assert.equal(remote.normalizeRemote({ host: 'bad host' }), null);
  assert.equal(remote.normalizeRemote({ host: 'a'.repeat(254) }), null, '최대 253자');
  assert.deepEqual(remote.normalizeRemote({ host: 'a'.repeat(253) }), { host: 'a'.repeat(253), user: '', port: 0 });
  for (const user of ['a b', 'a@b', "a'b", 'a"b', 'a:b', '-x', 'a\nb']) assert.equal(remote.normalizeRemote({ host: 'h', user }), null, `user 거부: ${JSON.stringify(user)}`);
  assert.deepEqual(remote.normalizeRemote({ host: 'h', user: '' }), { host: 'h', user: '', port: 0 });
  assert.deepEqual(remote.normalizeRemote(remote.normalizeRemote({ host: 'h', user: 'me' })), { host: 'h', user: 'me', port: 0 }, '정규화 결과(port 0)를 다시 넣어도 통과');
  for (const port of ['0', -1, 65536, 'abc', '22x', 1.5, true]) assert.equal(remote.normalizeRemote({ host: 'h', port }), null, `port 거부: ${JSON.stringify(port)}`);
  assert.deepEqual(remote.normalizeRemote({ host: 'h', port: '022' }), { host: 'h', user: '', port: 0 }, "문자열 '022' → 22 → 기본 포트 0");
});

test('baseName/cleanPath: 구분자·끝 처리·드라이브 루트', () => {
  assert.equal(remote.baseName('C:\\dev\\foo\\'), 'foo');
  assert.equal(remote.baseName('C:/dev/foo'), 'foo');
  assert.equal(remote.baseName('C:\\'), 'C:');
  assert.equal(remote.baseName('foo'), 'foo');
  assert.equal(remote.baseName('C:\\\\srv\\\\share\\\\'), 'share');
  assert.equal(remote.cleanPath('  C:\\dev\\foo\\\\ '), 'C:\\dev\\foo');
  assert.equal(remote.cleanPath('C:/dev/foo/'), 'C:/dev/foo');
  assert.equal(remote.cleanPath('C:\\'), 'C:\\', '드라이브 루트는 유지');
  assert.equal(remote.cleanPath('c:/'), 'c:\\');
  assert.equal(remote.cleanPath('  '), '');
  assert.equal(remote.label(REMOTE, 'C:\\dev\\foo'), 'me@example-host:C:\\dev\\foo');
  assert.equal(remote.target(REMOTE), 'me@example-host');
  assert.equal(remote.target({ host: 'h', user: '', port: 0 }), 'h');
  assert.equal(remote.sameTarget({ host: 'Example-Host', user: 'ME', port: 2222 }, REMOTE), true);
  assert.equal(remote.sameTarget({ host: 'example-host', user: 'me', port: 0 }, REMOTE), false);
  assert.equal(remote.sameTarget({ host: 'other', user: 'me', port: 2222 }, REMOTE), false);
});

test('sshArgs: 대화형/자동, 포트 있음/없음', () => {
  assert.deepEqual(remote.sshArgs(REMOTE, { interactive: true }),
    ['-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', 'me@example-host']);
  assert.deepEqual(remote.sshArgs({ host: 'example-host', user: '', port: 0 }, { interactive: false }),
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', 'example-host']);
});

test('startCommand: UTF-16LE 인코딩·id 검증·특수문자 없음', () => {
  const cmd = remote.startCommand('abcd1234');
  const want = `& node (Join-Path $env:APPDATA 'claude-launcher\\runtime\\start-session.mjs') --project 'abcd1234'; exit $LASTEXITCODE`;
  assert.equal(Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf16le'), want);
  assert.match(cmd, /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=\-]+$/);
  assert.ok(!/[;"'\\]|%|&/.test(cmd.replace(/-/g, '')), '따옴표·cmd 특수문자 없음');
  assert.deepEqual(remote.sessionSshArgs({ host: 'h', user: '', port: 0 }, 'abcd1234').slice(-1), [cmd]);
  for (const id of ['ab', 'ABCD', 'abcd1234!', 'abcd12345678901234', '', null, undefined]) assert.throws(() => remote.startCommand(id), /id/);
});

test('findSsh: PATH 우선 → Windows 번들 위치 → null', async () => {
  assert.equal(await remote.findSsh({ where: async () => ['C:\\tools\\ssh.exe'], exists: () => true }), 'C:\\tools\\ssh.exe');
  const bundled = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  assert.equal(await remote.findSsh({ where: async () => [], exists: p => p === bundled }), bundled);
  assert.equal(await remote.findSsh({ where: async () => [], exists: () => false }), null);
});

test('collectFiles: 중첩 폴더·/ 구분·정렬·없는 폴더', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'A');
  fs.writeFileSync(path.join(d, 'b', 'x.txt'), 'X');
  fs.writeFileSync(path.join(d, 'b', 'c', 'y.txt'), 'Y');
  const list = remote.collectFiles(d, 'runtime');
  assert.deepEqual(list.map(x => x.rel), ['runtime/a.txt', 'runtime/b/c/y.txt', 'runtime/b/x.txt']);
  assert.equal(Buffer.from(list[0].b64, 'base64').toString('utf8'), 'A');
  assert.deepEqual(remote.collectFiles(path.join(d, '없는폴더'), 'runtime'), []);
});

test('원격 payload: 런처 runtime 폴더 전체에 studio.mjs·studio-org.default.json이 포함된다', () => {
  const rels = remote.collectFiles(path.join(ROOT, 'runtime'), 'runtime').map(x => x.rel);
  assert.ok(rels.includes('runtime/studio.mjs'), 'studio.mjs가 원격 복사 목록에 있음');
  assert.ok(rels.includes('runtime/studio-org.default.json'), '기본 조직도 JSON도 함께 감');
  assert.ok(rels.includes('runtime/start-session.mjs'));
  assert.ok(rels.includes('runtime/remote-apply.cjs'));
});

test('buildPayload/buildAgentScript: 기본값·listPath 빈 문자열·스크립트 조립', () => {
  assert.deepEqual(remote.buildPayload(), { v: 1, files: [], session: null, claudeMd: null, key: null, checkPath: null, listPath: null });
  const p = remote.buildPayload({ key: '', listPath: '', claudeMd: { text: 'x' } });
  assert.equal(p.key, null);
  assert.equal(p.listPath, '', '빈 문자열(드라이브 목록)은 null이 아니어야 함');
  assert.deepEqual(p.claudeMd, { text: 'x' });
  const full = remote.buildPayload({
    session: { id: 'abcd1234' },
    launcherFiles: [{ rel: 'runtime/a', b64: 'YQ==' }],
    claudeFiles: [{ rel: 'skills/glm-delegate/b', b64: 'Yg==' }],
    key: KEY, checkPath: 'C:\\dev\\foo',
  });
  assert.deepEqual(full.files, [{ root: 'launcher', rel: 'runtime/a', b64: 'YQ==' }, { root: 'claude', rel: 'skills/glm-delegate/b', b64: 'Yg==' }]);
  assert.equal(remote.buildAgentScript('SRC', { a: 1 }), 'globalThis.__CL_PAYLOAD__ = {"a":1};\nSRC');
});

test('parseAgentOutput: 배너 섞임·마지막 줄·없음·깨진 JSON', () => {
  assert.deepEqual(remote.parseAgentOutput('Warning: Permanently added example-host\n@@CLR@@{"ok":true,"v":1}\n'), { ok: true, v: 1 });
  assert.deepEqual(remote.parseAgentOutput('@@CLR@@{"ok":true,"first":1}\r\n@@CLR@@{"ok":true,"second":2}\r\n'), { ok: true, second: 2 });
  assert.deepEqual(remote.parseAgentOutput('@@CLR@@{"ok":true,"한글":"경로"}'), { ok: true, 한글: '경로' });
  assert.throws(() => remote.parseAgentOutput('그냥 출력만 있음'), e => e.code === 'bad-output');
  assert.throws(() => remote.parseAgentOutput('@@CLR@@{"ok":,'), e => e.code === 'bad-output');
});

// ───────── runAgent: 가짜 spawn(EventEmitter + stdin/stdout/stderr) ─────────
function fakeSpawn(behavior) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const rec = { file, args, opts, stdin: '', child: new EventEmitter() };
    rec.child.stdout = new EventEmitter();
    rec.child.stderr = new EventEmitter();
    rec.child.stdin = { write: d => { rec.stdin += d; }, end: d => { if (d) rec.stdin += d; }, on: () => {} };
    rec.child.kill = () => { rec.child.killed = true; };
    calls.push(rec);
    if (behavior) setImmediate(() => behavior(rec));
    return rec.child;
  };
  return { spawn, calls };
}
const okLine = over => `@@CLR@@${JSON.stringify({ ok: true, platform: 'win32', launcherHome: 'L', userHome: 'H', node: 'v22.3.0', claude: 'C:\\claude.exe', git: true, pathExists: true, written: 0, sessionFile: null, keyWritten: false, claudeMd: null, list: null, ...over })}\n`;

test('runAgent: 성공 — stdin=스크립트, 인자 뒤는 node -, 인자에 키 없음, stdout이 나뉘어 와도 해석', async () => {
  const f = fakeSpawn(r => {
    r.child.stderr.emit('data', Buffer.from('Warning: Permanently added\n'));
    const line = okLine();
    r.child.stdout.emit('data', Buffer.from(line.slice(0, 25)));
    r.child.stdout.emit('data', Buffer.from(line.slice(25)));
    r.child.emit('close', 0);
  });
  const payload = remote.buildPayload({ key: KEY, checkPath: 'C:\\dev\\foo' });
  const r = await remote.runAgent(REMOTE, payload, { agentSource: AGENT_SRC, ssh: 'C:\\OpenSSH\\ssh.exe', spawn: f.spawn });
  assert.equal(r.ok, true);
  const [rec] = f.calls;
  assert.equal(rec.file, 'C:\\OpenSSH\\ssh.exe');
  assert.deepEqual(rec.args.slice(-2), ['node', '-']);
  assert.ok(rec.args.includes('-T') && rec.args.includes('me@example-host'));
  assert.equal(rec.stdin, remote.buildAgentScript(AGENT_SRC, payload), 'stdin에는 payload+에이전트 원문');
  assert.ok(rec.args.every(a => !String(a).includes(KEY)), '키는 명령줄에 없음');
  assert.equal(rec.opts.windowsHide, true);
});

test('runAgent: 종료 255/거부 문구 → connect·auth·no-node 구분', async () => {
  const mk = stderr => fakeSpawn(r => { r.child.stderr.emit('data', Buffer.from(stderr)); r.child.emit('close', 255); });
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: mk('ssh: connect to host example-host port 2222: Connection refused').spawn }), 'connect');
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: mk('ssh: Could not resolve hostname example-host').spawn }), 'connect');
  const e = await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: mk('me@example-host: Permission denied (publickey).').spawn }), 'auth');
  assert.match(e.message, /공개 키/);
  assert.ok(e.message.length < 600, 'stderr 꼬리는 300자로 제한');
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: fakeSpawn(r => { r.child.stderr.emit('data', Buffer.from("'node' is not recognized as an internal or external command")); r.child.emit('close', 1); }).spawn }), 'no-node');
});

test('runAgent: 타임아웃 kill·ENOENT ssh-missing·출력 없음 bad-output·ok:false agent', async () => {
  const slow = fakeSpawn(() => { /* 응답 없음 */ });
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: slow.spawn, timeoutMs: 60 }), 'timeout');
  assert.equal(slow.calls[0].child.killed, true, '자식 프로세스 kill');
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: fakeSpawn(r => r.child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))).spawn }), 'ssh-missing');
  await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: fakeSpawn(r => r.child.emit('close', 0)).spawn }), 'bad-output');
  const e = await rejectsCode(() => remote.runAgent(REMOTE, remote.buildPayload(), { agentSource: 'x', ssh: 'ssh', spawn: fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(`@@CLR@@${JSON.stringify({ ok: false, error: '원격 폴더에 쓸 수 없습니다' })}\n`)); r.child.emit('close', 0); }).spawn }), 'agent');
  assert.match(e.message, /원격 폴더에 쓸 수 없습니다/);
});

// ───────── remote-apply.cjs: apply 직접 호출 ─────────
const ctx2 = (lh, home) => ({ env: withEnv(lh, home), home });

test('apply: 파일 rel 검증(..·절대 경로·역슬래시·드라이브·빈 값) — 하나라도 틀리면 아무것도 쓰지 않음', () => {
  const base = tmp(), lh = path.join(base, 'lh'), home = path.join(base, 'home');
  const good = { root: 'launcher', rel: 'ok.txt', b64: Buffer.from('x').toString('base64') };
  for (const bad of ['../evil.txt', '/abs.txt', 'C:/x.txt', 'a\\b.txt', '', '.', 'a//b']) {
    const r = agent.apply({ files: [good, { root: 'launcher', rel: bad, b64: 'eA==' }] }, ctx2(lh, home));
    assert.equal(r.ok, false, `거부: ${JSON.stringify(bad)}`);
    assert.ok(!fs.existsSync(path.join(lh, 'ok.txt')), `검증 전이라 좋은 파일도 쓰면 안 됨: ${JSON.stringify(bad)}`);
  }
  assert.equal(agent.apply({ files: [{ root: 'other', rel: 'a', b64: 'eA==' }] }, ctx2(lh, home)).ok, false);
  assert.equal(agent.apply({ files: [{ root: 'launcher', rel: 'a', b64: 5 }] }, ctx2(lh, home)).ok, false);
  assert.equal(agent.apply(null, ctx2(lh, home)).ok, false);
});

test('apply: 세션 id 검증·keyFile 재작성·glmConfigDir 삭제·키 파일 plain:·재실행 keyWritten false', () => {
  const base = tmp(), lh = path.join(base, 'lh'), home = path.join(base, 'home');
  for (const id of ['BAD!', 'ab', 'abcd12345678901234', 5]) {
    assert.equal(agent.apply({ session: { id } }, ctx2(lh, home)).ok, false, `id 거부: ${JSON.stringify(id)}`);
  }
  const r = agent.apply({ session: { id: 'abcd1234', mode: 'split', keyFile: 'C:\\local\\zai-key.dpapi', glmConfigDir: 'C:\\local\\.claude-glm', name: 'foo' }, key: KEY }, ctx2(lh, home));
  assert.equal(r.ok, true);
  assert.equal(r.keyWritten, true);
  assert.equal(r.sessionFile, path.join(lh, 'sessions', 'abcd1234.json'));
  const s = JSON.parse(fs.readFileSync(r.sessionFile, 'utf8'));
  assert.equal(s.keyFile, path.join(lh, 'zai-key.txt'), '원격 키 경로로 재작성');
  assert.ok(!('glmConfigDir' in s), 'glmConfigDir는 삭제(원격 기본값 사용)');
  assert.equal(typeof s.writtenAt, 'number');
  assert.equal(s.name, 'foo');
  const kf = path.join(lh, 'zai-key.txt');
  assert.equal(fs.readFileSync(kf, 'utf8'), `plain:${KEY}`);
  const r2 = agent.apply({ key: KEY }, ctx2(lh, home));
  assert.equal(r2.ok, true);
  assert.equal(r2.keyWritten, false, '같은 내용이면 다시 쓰지 않음');
  assert.equal(r2.sessionFile, null);
  if (!IS_WIN) assert.equal(fs.statSync(kf).mode & 0o777, 0o600, '비Windows는 chmod 600');
  assert.equal(agent.launcherHome({ CLAUDE_LAUNCHER_HOME: 'X' }), 'X');
});

test('apply: claudeMd 결과가 claudemd.apply와 바이트 단위로 같음(빈 파일·기존 내용·이미 영역 있음)', () => {
  const content = '## 분담 규칙 $& $1\n- 반복은 GLM에 위임';
  const cases = ['', '# 내 규칙\n- 한국어로 답한다\n', '# 머리\n'];
  for (const initial of cases) {
    const d = tmp(), lh = path.join(d, 'lh');
    const mine = path.join(d, '.claude', 'CLAUDE.md'), ref = path.join(d, '.claude', 'ref.md');
    if (initial) { fs.mkdirSync(path.dirname(mine)); fs.writeFileSync(mine, initial); fs.writeFileSync(ref, initial); }
    const changed = claudemd.apply(ref, content);
    const r = agent.apply({ claudeMd: { text: content } }, { env: withEnv(lh, d), home: d });
    assert.equal(r.ok, true);
    assert.equal(r.claudeMd, changed ? 'applied' : 'unchanged');
    assert.equal(fs.readFileSync(mine, 'utf8'), fs.readFileSync(ref, 'utf8'), `같은 결과: 초기값 ${JSON.stringify(initial)}`);
  }
  // 이미 영역이 있고 내용이 같으면 둘 다 바꾸지 않음
  const d = tmp(), lh = path.join(d, 'lh');
  const mine = path.join(d, '.claude', 'CLAUDE.md'), ref = path.join(d, '.claude', 'ref.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  claudemd.apply(mine, content); claudemd.apply(ref, content);
  assert.equal(claudemd.apply(ref, content), false);
  const r = agent.apply({ claudeMd: { text: content } }, { env: withEnv(lh, d), home: d });
  assert.equal(r.claudeMd, 'unchanged');
  assert.equal(fs.readFileSync(mine, 'utf8'), fs.readFileSync(ref, 'utf8'));
});

test('apply: checkPath 폴더/파일/없음·listPath 하위 폴더만·정렬·제외·실패', () => {
  const d = tmp(), lh = path.join(d, 'lh');
  const o = { env: withEnv(lh, d), home: d };
  fs.writeFileSync(path.join(d, 'f.txt'), 'x');
  assert.equal(agent.apply({ checkPath: d }, o).pathExists, true);
  assert.equal(agent.apply({ checkPath: path.join(d, 'f.txt') }, o).pathExists, false, '폴더일 때만 true');
  assert.equal(agent.apply({ checkPath: path.join(d, '없음') }, o).pathExists, false);
  assert.equal(agent.apply({}, o).pathExists, null);
  assert.equal(agent.apply({}, o).list, null);

  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  for (const name of ['Beta', 'alpha', 'Zeta', '.hidden', '$Recycle Bin', 'System Volume Information']) fs.mkdirSync(path.join(sub, name));
  fs.writeFileSync(path.join(sub, 'notdir.txt'), 'x');
  const r = agent.apply({ listPath: sub }, o);
  assert.equal(r.ok, true);
  assert.deepEqual(r.list.dirs, ['alpha', 'Beta', 'Zeta']);
  assert.equal(r.list.parent, d);
  assert.equal(r.list.error, null);
  const bad = agent.apply({ listPath: path.join(sub, '없는폴더') }, o);
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.list.dirs, []);
  assert.ok(bad.list.error, '읽기 실패는 한국어 오류');
  assert.equal(agent.apply({ listPath: IS_WIN ? 'C:\\' : '/' }, o).list.parent, '', '드라이브(루트)의 parent는 빈 문자열');
});

test('apply: listPath 빈 문자열 → 드라이브 목록(Windows 전용)', { skip: !IS_WIN && 'Windows 전용' }, () => {
  const d = tmp();
  const r = agent.apply({ listPath: '' }, { env: withEnv(path.join(d, 'lh'), d), home: d });
  assert.equal(r.ok, true);
  assert.equal(r.list.path, '');
  assert.equal(r.list.parent, null);
  assert.ok(r.list.dirs.includes('C:\\'));
  assert.ok(r.list.dirs.every(x => /^[A-Z]:\\$/.test(x)), 'C:\\ … Z:\\ 형태');
  assert.deepEqual([...r.list.dirs].sort(), r.list.dirs);
});

test('apply: 결과에 키·민감값이 없고 node/platform/git 채움', () => {
  const d = tmp(), lh = path.join(d, 'lh');
  const r = agent.apply({ key: KEY, checkPath: d }, { env: withEnv(lh, d), home: d });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes(KEY), '결과 JSON에 키 없음');
  assert.ok(r.node.startsWith('v'));
  assert.equal(r.platform, process.platform);
  assert.equal(typeof r.git, 'boolean');
});

test('secrets.loadKey: plain: 파일은 평문 키 반환(원격 zai-key.txt 형식)', () => {
  const f = path.join(tmp(), 'zai-key.txt');
  fs.writeFileSync(f, `plain:${KEY}`);
  assert.equal(secrets.loadKey(f), KEY);
});

// ───────── 통합: process.execPath에 ['-']로 스크립트를 주입(원격에서 일어날 일을 로컬에서 재현) ─────────
test('통합: node - 실행 — 파일 기록·세션 재작성·키·두 번째 실행 written 0·출력에 키 없음', () => {
  const base = tmp(), lh = path.join(base, 'launcher'), home = path.join(base, 'home');
  const rt = path.join(base, 'rt');
  fs.mkdirSync(path.join(rt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'remote-apply.cjs'), AGENT_SRC);
  fs.writeFileSync(path.join(rt, 'start-session.mjs'), '// 시작기\n');
  fs.writeFileSync(path.join(rt, 'sub', 'deep.txt'), '깊은 파일');
  const skill = path.join(base, 'skill');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# 스킬\n');
  fs.writeFileSync(path.join(skill, 'scripts', 'glm-run.mjs'), '// 작업자\n');
  const payload = remote.buildPayload({
    session: { id: 'abcd1234', name: 'foo', mode: 'split', path: 'C:\\dev\\foo', keyFile: 'C:\\local\\zai-key.dpapi', glmConfigDir: 'C:\\local\\.claude-glm', zaiBaseUrl: 'https://api.z.ai/api/anthropic' },
    launcherFiles: remote.collectFiles(rt, 'runtime'),
    claudeFiles: remote.collectFiles(skill, 'skills/glm-delegate'),
    claudeMd: { text: '## 분담\n- 테스트 영역' },
    key: KEY,
    checkPath: base,
  });
  const run = () => spawnSync(process.execPath, ['-'], { input: remote.buildAgentScript(AGENT_SRC, payload), encoding: 'utf8', env: withEnv(lh, home), timeout: 120000 });

  const r1 = run();
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(!r1.stdout.includes(KEY) && !r1.stderr.includes(KEY), '출력에 키 없음');
  const o1 = remote.parseAgentOutput(r1.stdout);
  assert.equal(o1.ok, true);
  assert.equal(o1.written, 5, '런처 3 + 스킬 2');
  assert.equal(o1.keyWritten, true);
  assert.equal(o1.claudeMd, 'applied');
  assert.equal(o1.pathExists, true);
  assert.equal(o1.launcherHome, lh);
  assert.equal(o1.userHome, home);
  assert.equal(fs.readFileSync(path.join(lh, 'runtime', 'sub', 'deep.txt'), 'utf8'), '깊은 파일');
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'glm-delegate', 'SKILL.md'), 'utf8'), '# 스킬\n');
  const s = JSON.parse(fs.readFileSync(path.join(lh, 'sessions', 'abcd1234.json'), 'utf8'));
  assert.equal(s.keyFile, path.join(lh, 'zai-key.txt'));
  assert.ok(!('glmConfigDir' in s));
  assert.equal(fs.readFileSync(path.join(lh, 'zai-key.txt'), 'utf8'), `plain:${KEY}`);
  assert.ok(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8').includes('## 분담'));

  const o2 = remote.parseAgentOutput(run().stdout);
  assert.equal(o2.ok, true);
  assert.equal(o2.written, 0, '모두 같으므로 다시 쓰지 않음');
  assert.equal(o2.keyWritten, false);
  assert.equal(o2.claudeMd, 'unchanged');
  assert.equal(o2.sessionFile, path.join(lh, 'sessions', 'abcd1234.json'));
});

// ───────── prepareOpen ─────────
function resFixture(snippet) {
  const base = tmp();
  const runtimeDir = path.join(base, 'runtime');
  fs.mkdirSync(path.join(runtimeDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'remote-apply.cjs'), AGENT_SRC);
  fs.writeFileSync(path.join(runtimeDir, 'sub', 'x.txt'), 'x');
  const skillDir = path.join(base, 'skills', 'glm-delegate');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# 스킬\n');
  return { runtimeDir, skillDir, snippet };
}
const payloadOf = rec => JSON.parse(rec.stdin.slice('globalThis.__CL_PAYLOAD__ = '.length, rec.stdin.indexOf(';\n')));
const RPROJ = {
  id: 'abcd1234', name: 'foo', path: 'C:\\dev\\foo', mode: 'split', remote: { host: 'example-host', user: 'me', port: 0 },
  main: { model: 'fable', effort: 'high' }, worker: { model: 'glm-5.3', effort: 'max' }, keepShell: true,
};

test('prepareOpen: payload 구성 — keyFile·glmConfigDir 제거·파일·checkPath·claudeMd·키 전달', async () => {
  const f = fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(okLine())); r.child.emit('close', 0); });
  const r = await remote.prepareOpen(RPROJ, {
    res: resFixture('## 영역'), sessionExtra: { keyFile: 'C:\\local\\zai-key.dpapi', glmConfigDir: 'C:\\local\\.claude-glm', zaiBaseUrl: 'https://api.z.ai/api/anthropic' },
    key: KEY, ssh: 'ssh', spawn: f.spawn,
  });
  assert.equal(r.ok, true);
  const p = payloadOf(f.calls[0]);
  assert.equal(p.v, 1);
  assert.equal(p.session.id, 'abcd1234');
  assert.ok(!('keyFile' in p.session));
  assert.ok(!('glmConfigDir' in p.session));
  assert.equal(p.session.zaiBaseUrl, 'https://api.z.ai/api/anthropic');
  assert.equal(p.key, KEY);
  assert.equal(p.checkPath, 'C:\\dev\\foo');
  assert.equal(p.listPath, null);
  assert.deepEqual(p.claudeMd, { text: '## 영역' });
  assert.ok(p.files.some(x => x.root === 'launcher' && x.rel.startsWith('runtime/')));
  assert.ok(p.files.some(x => x.root === 'claude' && x.rel.startsWith('skills/glm-delegate/')));
});

test('prepareOpen: mode claude면 key null(보내지 않음), split에 키 없으면 no-key', async () => {
  const f = fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(okLine())); r.child.emit('close', 0); });
  await remote.prepareOpen({ ...RPROJ, mode: 'claude' }, { res: resFixture(null), key: KEY, ssh: 'ssh', spawn: f.spawn });
  assert.equal(payloadOf(f.calls[0]).key, null);
  const f2 = fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(okLine())); r.child.emit('close', 0); });
  await remote.prepareOpen({ ...RPROJ, mode: 'claude' }, { res: resFixture(null), ssh: 'ssh', spawn: f2.spawn });
  assert.equal(payloadOf(f2.calls[0]).key, null, 'claude 모드는 키 없어도 실행');
  const none = fakeSpawn(null);
  await rejectsCode(() => remote.prepareOpen(RPROJ, { res: resFixture(null), ssh: 'ssh', spawn: none.spawn }), 'no-key');
  assert.equal(none.calls.length, 0, '실행 전에 거부');
  await rejectsCode(() => remote.prepareOpen(RPROJ, { res: resFixture(null), key: '', ssh: 'ssh', spawn: none.spawn }), 'no-key');
});

test('prepareOpen: 원격 상태 검증 — no-path·no-claude·old-node', async () => {
  const res = resFixture(null);
  const go = over => fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(okLine(over))); r.child.emit('close', 0); });
  await rejectsCode(() => remote.prepareOpen(RPROJ, { res, key: KEY, ssh: 'ssh', spawn: go({ pathExists: false }).spawn }), 'no-path');
  await rejectsCode(() => remote.prepareOpen(RPROJ, { res, key: KEY, ssh: 'ssh', spawn: go({ claude: null }).spawn }), 'no-claude');
  await rejectsCode(() => remote.prepareOpen(RPROJ, { res, key: KEY, ssh: 'ssh', spawn: go({ node: 'v16.20.2' }).spawn }), 'old-node');
  const r = await remote.prepareOpen(RPROJ, { res, key: KEY, ssh: 'ssh', spawn: go({ node: 'v18.20.4' }).spawn });
  assert.equal(r.ok, true);
});

test('checkRemote/listRemote: 파일 없이 checkPath·listPath만, 결과 그대로', async () => {
  const res = resFixture(null);
  const f = fakeSpawn(r => { r.child.stdout.emit('data', Buffer.from(okLine({ list: { path: 'C:\\dev', parent: 'C:\\', dirs: ['foo'], error: null } }))); r.child.emit('close', 0); });
  await remote.checkRemote(REMOTE, 'C:\\dev\\foo', { res, ssh: 'ssh', spawn: f.spawn });
  const p1 = payloadOf(f.calls[0]);
  assert.deepEqual(p1.files, []);
  assert.equal(p1.checkPath, 'C:\\dev\\foo');
  assert.equal(p1.listPath, null);
  const l = await remote.listRemote(REMOTE, 'C:\\dev', { res, ssh: 'ssh', spawn: f.spawn });
  assert.deepEqual(l, { path: 'C:\\dev', parent: 'C:\\', dirs: ['foo'], error: null });
  const p2 = payloadOf(f.calls[1]);
  assert.equal(p2.checkPath, null);
  assert.equal(p2.listPath, 'C:\\dev');
});
