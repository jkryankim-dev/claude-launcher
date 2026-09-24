// glm-run.mjs 통합 테스트 — 가짜 claude(test/fixtures/mock-claude.mjs)로 실제 git 저장소에서 실행한다.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUN = path.join(ROOT, 'skills/glm-delegate/scripts/glm-run.mjs');
const MOCK = path.join(HERE, 'fixtures/mock-claude.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'glmtest-'));
const LHOME = path.join(TMP, 'launcher-home');
const CONF = path.join(TMP, 'worker-config');

function baseEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GLM_|ZAI_|ANTHROPIC_|CLAUDE|MOCK_)/i.test(k)) e[k] = v;
  return {
    ...e, GLM_CLAUDE_BIN: MOCK, ZAI_API_KEY: 'zai-test-key-1234', GLM_CONFIG_DIR: CONF, CLAUDE_LAUNCHER_HOME: LHOME,
    GLM_HEARTBEAT_SEC: '1', ANTHROPIC_API_KEY: 'sk-ant-SHOULD-NOT-LEAK', ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDECODE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'max', GLM_WORKER_ENV_FOO_BAR: 'baz', ...extra,
  };
}
function run(args, cwd, extra = {}) {
  const r = spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: 'utf8', env: baseEnv(extra), timeout: 180e3 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function write(dir, rel, s) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  const init = {
    'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/app/api/[id]/route.ts': 'export async function GET() {}\n',
    'src/한글.ts': 'export const 한 = 1;\n', 'src/c.ts': 'export const c = 1;\n', 'README.md': '# t\n',
  };
  for (const [f, c] of Object.entries(init)) write(dir, f, c);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  write(dir, 'src/b.ts', 'export const b = 2; // 실행 전 미커밋 변경\n');
  write(dir, 'src/untracked.ts', 'export const u = 1;\n');
  return dir;
}
function files(dir) {
  const res = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.glm') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else res[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return res;
}
const SPEC = `---
title: 테스트 편집
role: edit
scope:
  - src/**
  - "!src/c.ts"
verify:
  - node -e "process.exit(0)"
---
## 목표
각 파일 끝에 주석을 추가한다.
`;
function spec(dir, name = 't1.md', text = SPEC) { write(dir, `.glm/tasks/${name}`, text); return `.glm/tasks/${name}`; }
const readLog = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('편집 실행: 요약·환경 격리·권한 설정·정확한 되돌리기', () => {
  const dir = makeRepo();
  const before = files(dir);
  const log = path.join(TMP, 'log1.json');
  const r = run([spec(dir)], dir, {
    MOCK_FILES: 'src/a.ts,src/b.ts,src/app/api/[id]/route.ts,src/한글.ts,+src/new/d.ts,src/untracked.ts,src/c.ts',
    MOCK_BASH_FILE: 'README.md', MOCK_LOG: log, MOCK_SID: 'sid-1111',
  });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /✅ 완료/);
  assert.match(r.out, /변경 8파일/);
  assert.match(r.out, /A src\/new\/d\.ts/);
  assert.match(r.out, /M src\/app\/api\/\[id\]\/route\.ts/);
  assert.match(r.out, /M src\/한글\.ts/);
  assert.match(r.out, /M src\/untracked\.ts/);
  assert.match(r.out, /범위 밖 변경 2개: README\.md, src\/c\.ts/);
  assert.match(r.out, /검증 ✅ PASS/);
  assert.match(r.out, /크레딧/);
  assert.match(r.out, /권한 거부 1건: Bash\(npm run build\)/);
  assert.match(r.out, /API 재시도 1회/);
  assert.match(r.out, /── 작업자 보고 ──\n## 결과/);

  const L = readLog(log);
  assert.equal(L.env.ANTHROPIC_API_KEY, undefined, 'Anthropic 키가 작업자로 새면 안 됨');
  assert.equal(L.env.ANTHROPIC_AUTH_TOKEN, 'zai-test-key-1234');
  assert.equal(L.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(L.env.CLAUDECODE, undefined);
  assert.equal(L.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(L.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, '1');
  assert.equal(L.env.GLM_WORKER, '1');
  assert.equal(L.env.CLAUDE_CONFIG_DIR, CONF);
  assert.equal(L.env.FOO_BAR, 'baz');
  assert.equal(L.env.ZAI_API_KEY, undefined);
  assert.ok(L.args.includes('dontAsk') && L.args.includes('stream-json'));
  assert.equal(L.args[L.args.indexOf('--max-turns') + 1], '80');
  assert.match(L.stdin, /\[작업 명세\] 테스트 편집/);
  assert.match(L.stdin, /\[작업 규칙\]/);
  assert.match(L.stdin, /수정 허용 범위\(이 밖은 수정 금지\): src\/\*\*, !src\/c\.ts/);

  const S = readLog(L.args[L.args.indexOf('--settings') + 1]);
  assert.equal(S.permissions.defaultMode, 'dontAsk');
  assert.ok(S.permissions.allow.includes('Bash(node -e "process.exit(0)")'));
  assert.ok(S.permissions.deny.includes('Skill'));
  assert.equal(S.env.ANTHROPIC_AUTH_TOKEN, undefined, '키는 설정 파일에 쓰지 않음');
  assert.match(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8'), /^\/\.glm\/$/m);

  assert.match(run(['--status', 'latest'], dir).out, /✅ 완료/);
  assert.match(run(['--list'], dir).out, /최근 GLM 실행[\s\S]*테스트 편집/);

  const rb = run(['--rollback', 'latest'], dir);
  assert.equal(rb.code, 0, rb.out + rb.err);
  assert.match(rb.out, /삭제 1/);
  assert.deepEqual(files(dir), before, '미커밋 변경·미추적 파일까지 실행 전 그대로');
  assert.ok(!fs.existsSync(path.join(dir, 'src/new')), '빈 폴더 정리');
  assert.equal(run(['--rollback', 'latest'], dir).code, 2, '두 번 되돌리기 방지');
});

test('되돌리기: 실행 뒤 직접 고친 파일은 건너뛰고 --force면 복원', () => {
  const dir = makeRepo();
  const before = files(dir);
  const r = run([spec(dir)], dir, { MOCK_FILES: 'src/a.ts,src/b.ts' });
  assert.equal(r.code, 0, r.out + r.err);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), '// 사용자가 직접 수정\n');
  const rb = run(['--rollback', 'latest'], dir);
  assert.equal(rb.code, 1);
  assert.match(rb.out, /건너뜀: src\/a\.ts \(실행 후 다시 수정됨/);
  assert.equal(files(dir)['src/b.ts'], before['src/b.ts']);
  const rb2 = run(['--rollback', 'latest', '--force'], dir);
  assert.equal(rb2.code, 0, rb2.out + rb2.err);
  assert.deepEqual(files(dir), before);
});

test('이어서(--resume): 같은 세션으로 후속 지시, 부모·자식 연결', () => {
  const dir = makeRepo();
  const r = run([spec(dir)], dir, { MOCK_FILES: 'src/a.ts', MOCK_SID: 'sid-parent' });
  assert.equal(r.code, 0, r.out + r.err);
  write(dir, '.glm/tasks/fix.md', '# 후속\nsrc/a.ts 주석을 한 줄 더 추가한다.\n');
  const log = path.join(TMP, 'log-resume.json');
  const r2 = run(['--resume', 'latest', '.glm/tasks/fix.md'], dir, { MOCK_FILES: 'src/a.ts', MOCK_LOG: log });
  assert.equal(r2.code, 0, r2.out + r2.err);
  const L = readLog(log);
  assert.equal(L.args[L.args.indexOf('--resume') + 1], 'sid-parent');
  assert.match(L.stdin, /\[후속 지시\]/);
  const ids = fs.readdirSync(path.join(dir, '.glm/runs')).sort();
  const [p, c] = ids.map(id => readLog(path.join(dir, '.glm/runs', id, 'meta.json')));
  assert.equal(c.parent, p.id);
  assert.deepEqual(p.children, [c.id]);
  assert.match(r2.out, /이어서: /);
  assert.equal(run(['--rollback', p.id], dir).code, 2, '후속 실행이 있으면 부모 먼저 되돌리기 거부');
});

test('안전장치: 재귀 위임·키 없음·위임 꺼짐', () => {
  const dir = makeRepo();
  const s = spec(dir);
  let r = run([s], dir, { GLM_WORKER: '1' });
  assert.equal(r.code, 2); assert.match(r.err, /다시 위임할 수 없습니다/);
  r = run([s], dir, { ZAI_API_KEY: '', CLAUDE_LAUNCHER_HOME: path.join(TMP, 'no-key-home') });
  assert.equal(r.code, 2); assert.match(r.err, /z\.ai API 키가 없습니다/);
  r = run([s], dir, { GLM_DELEGATE: 'off' });
  assert.equal(r.code, 2); assert.match(r.err, /위임이 꺼져/);
});

test('런처에 저장한 키 사용 (plain: 형식은 비Windows 개발용)', () => {
  const dir = makeRepo();
  const home = path.join(TMP, 'home-key');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'zai-key.dpapi'), 'plain:filekey-9999');
  const log = path.join(TMP, 'log-key.json');
  const r = run([spec(dir)], dir, { ZAI_API_KEY: '', CLAUDE_LAUNCHER_HOME: home, MOCK_LOG: log });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(readLog(log).env.ANTHROPIC_AUTH_TOKEN, 'filekey-9999');
  assert.match(r.out, /변경 없음/);
});

test('시간 제한: 작업자를 끝내고 시간 초과로 보고', () => {
  const dir = makeRepo();
  const t0 = Date.now();
  const r = run([spec(dir), '--timeout', '0.05'], dir, { MOCK_MODE: 'sleep' });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /⏱ 시간 초과/);
  assert.ok(Date.now() - t0 < 60e3);
});

test('--check: 설치·연결 점검', () => {
  const dir = makeRepo();
  const r = run(['--check'], dir, { MOCK_MODE: 'check' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Claude Code 2\.1\.260/);
  assert.match(r.out, /응답 "GLM_OK"/);
  assert.match(r.out, /준비 완료/);
});

test('git 저장소가 아닌 폴더에서도 동작', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'plain-'));
  write(dir, 'x.txt', 'x\n');
  write(dir, 'spec.md', '# 단순 작업\nx.txt 끝에 한 줄 추가\n');
  const r = run(['spec.md'], dir, { MOCK_FILES: 'x.txt' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /git 저장소가 아니라/);
  assert.match(r.out, /git 비교 없이 도구 기록 기준/);
  assert.match(r.out, /\? x\.txt/);
});

test('오류 설명: 최대 턴·인증 실패', () => {
  const dir = makeRepo();
  let r = run([spec(dir)], dir, { MOCK_MODE: 'maxturns' });
  assert.equal(r.code, 1); assert.match(r.out, /최대 턴\(80\) 도달/);
  r = run([spec(dir)], dir, { MOCK_MODE: 'autherr' });
  assert.equal(r.code, 1); assert.match(r.out, /인증 실패\(401\)/);
});

test('조사(scan) 역할: 편집 도구 차단과 조사 규칙', () => {
  const dir = makeRepo();
  const log = path.join(TMP, 'log-scan.json');
  const r = run([spec(dir, 'scan.md', '---\nrole: scan\nscope: [src]\n---\n# 조사\n한글 문자열 위치 목록\n')], dir, { MOCK_LOG: log });
  assert.equal(r.code, 0, r.out + r.err);
  const L = readLog(log);
  const S = readLog(L.args[L.args.indexOf('--settings') + 1]);
  assert.ok(S.permissions.deny.includes('Edit') && !S.permissions.allow.includes('Edit'));
  assert.match(L.stdin, /조사\(읽기 전용/);
});

test('SKILL.md의 명세 템플릿이 경고 없이 해석됨', () => {
  const md = fs.readFileSync(path.join(ROOT, 'skills/glm-delegate/SKILL.md'), 'utf8');
  const tpl = /~~~markdown\r?\n([\s\S]*?)\r?\n~~~/.exec(md)[1].replace('npx tsc --noEmit', 'node -e "process.exit(0)"');
  const dir = makeRepo();
  const r = run([spec(dir, 'tpl.md', tpl)], dir, { MOCK_FILES: 'src/a.ts' });
  assert.match(r.out, /\[GLM\] 시작 · \S+ · API 라우트 에러 응답을 apiError\(\)로 통일/);
  assert.doesNotMatch(r.out, /머리말/);
  assert.match(r.out, /범위 밖 변경 1개: src\/a\.ts/);
});

test('--stop: 실행 중인 작업 중단', async () => {
  const dir = makeRepo();
  const child = spawn(process.execPath, [RUN, spec(dir)], { cwd: dir, env: baseEnv({ MOCK_MODE: 'sleep' }), stdio: 'ignore' });
  const exited = once(child, 'exit');
  const runs = path.join(dir, '.glm/runs');
  let meta = null;
  for (let i = 0; i < 300 && !meta?.sessionId; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const id = fs.readdirSync(runs)[0]; meta = readLog(path.join(runs, id, 'meta.json')); } catch { /* 아직 없음 */ }
  }
  assert.ok(meta?.sessionId, '작업자가 시작되어야 함');
  const r = run(['--stop', 'latest'], dir);
  assert.match(r.out, /⏹ 중단/, r.out + r.err);
  await exited;
});

test('병렬 실행: 서로의 변경을 가져가지 않음', async () => {
  const dir = makeRepo();
  const s1 = spec(dir, 'p1.md'), s2 = spec(dir, 'p2.md');
  const go = (s, env) => new Promise(res => {
    const c = spawn(process.execPath, [RUN, s], { cwd: dir, env: baseEnv(env) });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', code => res({ code, out }));
  });
  const [a, b] = await Promise.all([
    go(s1, { MOCK_FILES: 'src/a.ts', MOCK_SLOW: '6000' }),
    go(s2, { MOCK_FILES: 'src/b.ts', MOCK_SLOW: '6000' }),
  ]);
  assert.match(a.out, /변경 1파일.*병렬 실행 중/, a.out);
  assert.match(a.out, /M src\/a\.ts/); assert.doesNotMatch(a.out, /src\/b\.ts/);
  assert.match(b.out, /M src\/b\.ts/); assert.doesNotMatch(b.out, /src\/a\.ts/);
});

test('링크·정션·짧은 이름 경로로 들어와도 저장소 안의 변경으로 인식', () => {
  const dir = makeRepo();
  const link = path.join(TMP, `link-${Date.now()}`);
  fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const s = spec(link);
  const r = run([path.join(link, s), '--cwd', link], TMP, { MOCK_FILES: 'src/a.ts' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /M src\/a\.ts/);
  assert.doesNotMatch(r.out, /⚠ ?(범위 밖|저장소 밖)/, r.out);
});

test('Windows: 런처가 DPAPI로 저장한 키로 작업자 실행 (PowerShell 7 환경 흉내)', { skip: process.platform !== 'win32' }, () => {
  const secrets = createRequire(import.meta.url)('../src/core/secrets.js');
  const home = path.join(TMP, 'home-dpapi');
  fs.mkdirSync(home, { recursive: true });
  secrets.saveKey(path.join(home, 'zai-key.dpapi'), 'dpapi-key-5678');
  const dir = makeRepo();
  const log = path.join(TMP, 'log-dpapi.json');
  const r = run([spec(dir)], dir, { ZAI_API_KEY: '', CLAUDE_LAUNCHER_HOME: home, MOCK_LOG: log, PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\nope\\Modules' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(readLog(log).env.ANTHROPIC_AUTH_TOKEN, 'dpapi-key-5678');
});

test('병렬 실행: 마무리 중에 끼어든 늦은 실행의 변경도 가져가지 않음', async () => {
  const dir = makeRepo();
  const s1 = spec(dir, 'q1.md'), s2 = spec(dir, 'q2.md');
  const go = (s, env) => new Promise(res => {
    const c = spawn(process.execPath, [RUN, s], { cwd: dir, env: baseEnv(env) });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', code => res({ code, out }));
  });
  const pa = go(s1, { MOCK_FILES: 'src/a.ts', GLM_TEST_HOLD_MS: '5000' }); // A: 작업자는 바로 끝나고 마무리 직전 5초 대기
  const runs = path.join(dir, '.glm/runs');
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const m = readLog(path.join(runs, fs.readdirSync(runs)[0], 'meta.json')); if (m.sessionId) break; } catch { /* 아직 */ }
  }
  await new Promise(r => setTimeout(r, 800));
  const b = await go(s2, { MOCK_FILES: 'src/b.ts' }); // B: A의 마무리 대기 중에 시작해 b.ts를 고침
  const a = await pa;
  assert.match(a.out, /M src\/a\.ts/, a.out);
  assert.doesNotMatch(a.out, /src\/b\.ts/, a.out);
  assert.match(b.out, /M src\/b\.ts/, b.out);
  assert.doesNotMatch(b.out, /src\/a\.ts/, b.out);
});
