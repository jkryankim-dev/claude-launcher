'use strict';
// src/core 모듈 테스트 (Electron 없이 실행)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/core/config');
const catalog = require('../src/core/catalog');
const launch = require('../src/core/launch');
const claudemd = require('../src/core/claudemd');
const sync = require('../src/core/sync');
const secrets = require('../src/core/secrets');
const remote = require('../src/core/remote');
const { zaiRate } = require('../src/core/rate');

const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));

test('config: 기본값 채우기, 잘못된 값 교정, 폴더 추가(중복 방지)·이동·삭제, 저장·읽기', () => {
  const c = config.normalize({ projects: [{ path: '/x/a', mode: 'weird', main: { model: 'opus' } }, { nope: 1 }], settings: { terminal: 'console', autoUpdate: 'yes' } });
  assert.equal(c.projects.length, 1);
  assert.equal(c.projects[0].mode, 'split');
  assert.equal(c.projects[0].main.model, 'opus');
  assert.equal(c.projects[0].main.effort, 'medium');
  assert.equal(c.projects[0].worker.effort, 'max');
  assert.equal(c.projects[0].worker.model, 'glm-5.3');
  assert.equal(c.settings.terminal, 'console');
  assert.equal(c.settings.autoUpdate, true, '형식이 틀린 값은 기본값');
  const p = config.addProject(c, '/x/b');
  assert.equal(config.addProject(c, '/x/b').id, p.id);
  assert.equal(c.projects.length, 2);
  config.moveProject(c, p.id, -1);
  assert.equal(c.projects[0].id, p.id);
  const u = config.updateProject(c, { id: p.id, mode: 'glm', worker: { model: 'glm-5.3-flash' } });
  assert.equal(u.mode, 'glm');
  assert.equal(u.worker.model, 'glm-5.3-flash');
  assert.equal(u.worker.effort, 'max', '빠진 값은 기존 값 유지');
  assert.equal(config.updateProject(c, { id: 'nope' }), null);
  const f = path.join(tmp(), 'c.json');
  config.save(f, c);
  assert.deepEqual(config.load(f), c);
  config.removeProject(c, p.id);
  assert.equal(c.projects.length, 1);
});

test('catalog: 번들·캐시 중 높은 버전, 직접 추가 모델 병합, 차이 계산, 주소', () => {
  const d = tmp();
  const P = { bundledCatalog: path.join(ROOT, 'catalog.json'), catalogCache: path.join(d, 'cache.json') };
  const b = catalog.base(P);
  assert.ok(b.version >= 1 && b.glm.models.some(m => m.id === 'glm-5.3'));
  const next = JSON.parse(JSON.stringify(b));
  next.version = b.version + 1;
  next.glm.models.push({ id: 'glm-5.4', label: 'GLM-5.4', efforts: ['low', 'high', 'max'] });
  next.claude.models.find(m => m.id === 'sonnet').efforts.push('xhigh');
  assert.deepEqual(catalog.diff(b, next), [
    { kind: 'claude', type: 'effort', id: 'sonnet', efforts: ['xhigh'] },
    { kind: 'glm', type: 'model', id: 'glm-5.4', label: 'GLM-5.4' },
  ]);
  catalog.saveCache(P, next);
  assert.equal(catalog.base(P).version, next.version);
  const eff = catalog.effective(P, { userModels: { claude: [], glm: [{ id: 'glm-x', label: 'glm-x', efforts: ['low'] }] } });
  assert.ok(eff.glm.models.some(m => m.id === 'glm-x' && m.user));
  assert.deepEqual(catalog.effortsFor(eff, 'glm', 'glm-x'), ['low']);
  assert.deepEqual(catalog.effortsFor(eff, 'claude', 'haiku'), []);
  assert.equal(catalog.catalogUrl({ owner: 'o', repo: 'r' }, ''), 'https://raw.githubusercontent.com/o/r/main/catalog.json');
  assert.match(catalog.catalogUrl({ owner: 'o', repo: 'r' }, 'tok'), /api\.github\.com\/repos\/o\/r\/contents\/catalog\.json/);
  assert.equal(catalog.catalogUrl(null, ''), '');
  assert.throws(() => catalog.saveCache(P, { version: 9 }), /형식/);
});

test('catalog: 원격 받기(가짜 fetch)와 오류', async () => {
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  let seen = null;
  const fake = async (url, opts) => { seen = opts.headers; return { ok: true, status: 200, text: async () => JSON.stringify(good) }; };
  assert.equal((await catalog.fetchRemote('https://x', 'tok', fake)).version, good.version);
  assert.equal(seen.Authorization, 'Bearer tok');
  await assert.rejects(catalog.fetchRemote('https://x', '', async () => ({ ok: false, status: 404, text: async () => '' })), /404/);
  await assert.rejects(catalog.fetchRemote('https://x', '', async () => ({ ok: true, status: 200, text: async () => '{"version":1}' })), /형식/);
  await assert.rejects(catalog.fetchRemote('', ''), /주소/);
});

test('launch: Windows Terminal 인자 (탭, 새 창, 2×2 분할, 5개 이상)', () => {
  const ctx = { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\a b\\AppData\\Roaming\\claude-launcher\\runtime\\start-session.mjs' };
  const mk = (id, mode = 'split') => ({ id, name: `p${id};x`, path: `C:\\dev\\p${id}`, mode, main: { model: 'fable', effort: 'high' }, worker: { model: 'glm-5.3', effort: 'max' } });
  const one = launch.buildWtArgs([mk('a1')], ctx, 'tab');
  assert.deepEqual(one.slice(0, 3), ['-w', '0', 'new-tab']);
  assert.ok(!one.includes(';'));
  assert.equal(one[one.indexOf('--title') + 1], 'pa1 x · fable/high + glm-5.3', '제목의 ;는 wt 구분자라 제거');
  assert.equal(one[one.indexOf('-d') + 1], 'C:\\dev\\pa1');
  assert.deepEqual(one.slice(-4), [ctx.node, ctx.script, '--project', 'a1']);
  assert.equal(launch.buildWtArgs([mk('a1')], ctx, 'window')[1], 'new');
  const four = launch.buildWtArgs(['1', '2', '3', '4'].map(i => mk(i)), ctx, 'split');
  assert.deepEqual(four.filter(a => ['new-tab', 'split-pane', 'move-focus'].includes(a)), ['new-tab', 'split-pane', 'split-pane', 'move-focus', 'split-pane']);
  assert.equal(four.filter(a => a === ';').length, 4);
  const five = launch.buildWtArgs(['1', '2', '3', '4', '5'].map(i => mk(i)), ctx, 'split');
  assert.equal(five.filter(a => a === 'new-tab').length, 2);
  const glm = launch.buildWtArgs([mk('g', 'glm')], ctx, 'tab');
  assert.equal(glm[glm.indexOf('--tabColor') + 1], launch.TAB_COLOR.glm);
  assert.equal(glm[glm.indexOf('--title') + 1], 'pg x · glm-5.3/max');
  assert.equal(launch.consoleCommand(mk('c'), ctx),
    '/d /s /c start "pc x" /D "C:\\dev\\pc" "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\AppData\\Roaming\\claude-launcher\\runtime\\start-session.mjs" --project c');
  const home = tmp();
  const f = launch.writeSessionFile(home, mk('s'), { keyFile: 'k' });
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.id, 's');
  assert.equal(s.keyFile, 'k');
});

test('claudemd: 관리 영역만 추가·갱신·제거, 기존 내용과 백업 보존', () => {
  const f = path.join(tmp(), 'CLAUDE.md');
  fs.writeFileSync(f, '# 내 규칙\n- 한국어로 답한다\n');
  assert.equal(claudemd.apply(f, '## 분담\n- A'), true);
  assert.equal(claudemd.apply(f, '## 분담\n- A'), false, '같은 내용이면 쓰지 않음');
  claudemd.apply(f, '## 분담\n- B $& $1');
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /^# 내 규칙\n- 한국어로 답한다\n\n<!-- claude-launcher:start/);
  assert.equal((s.match(/claude-launcher:start/g) || []).length, 1);
  assert.ok(s.includes('- B $& $1\n<!-- claude-launcher:end -->'), '치환 패턴 문자도 그대로');
  assert.ok(claudemd.has(f));
  assert.equal(claudemd.remove(f), true);
  assert.equal(fs.readFileSync(f, 'utf8'), '# 내 규칙\n- 한국어로 답한다\n');
  assert.equal(fs.readFileSync(f + '.launcher-backup', 'utf8'), '# 내 규칙\n- 한국어로 답한다\n');
  const empty = path.join(tmp(), 'CLAUDE.md');
  claudemd.apply(empty, 'x');
  assert.match(fs.readFileSync(empty, 'utf8'), /^<!-- claude-launcher:start/);
});

test('sync: 바뀐 파일만 복사', () => {
  const a = tmp(), b = path.join(tmp(), 'dst');
  fs.mkdirSync(path.join(a, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(a, 'SKILL.md'), 'x');
  fs.writeFileSync(path.join(a, 'scripts', 'r.mjs'), 'y');
  assert.equal(sync.syncDir(a, b).length, 2);
  assert.equal(sync.syncDir(a, b).length, 0);
  fs.writeFileSync(path.join(a, 'SKILL.md'), 'x2');
  assert.deepEqual(sync.syncDir(a, b), ['SKILL.md']);
  assert.throws(() => sync.syncDir(path.join(a, 'none'), b), /원본/);
});

test('secrets: 저장·읽기·삭제 (Windows는 DPAPI, 그 밖은 개발용 평문)', t => {
  const prev = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\nope\\Modules'; // PowerShell 7에서 물려받은 경우 흉내
  t.after(() => { if (prev === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = prev; });
  const f = path.join(tmp(), 'zai-key.dpapi');
  assert.equal(secrets.hasKey(f), false);
  secrets.saveKey(f, '  test.key-1234  ');
  assert.equal(secrets.hasKey(f), true);
  const saved = fs.readFileSync(f, 'utf8');
  assert.ok(saved.startsWith(process.platform === 'win32' ? 'dpapi:' : 'plain:'), saved.slice(0, 12));
  if (process.platform === 'win32') assert.ok(!saved.includes('test.key-1234'), '평문으로 저장하면 안 됨');
  assert.equal(secrets.loadKey(f), 'test.key-1234');
  assert.throws(() => secrets.saveKey(f, ''), /비어/);
  assert.throws(() => secrets.saveKey(f, 'a b'), /공백/);
  secrets.deleteKey(f);
  assert.equal(secrets.hasKey(f), false);
  assert.equal(secrets.loadKey(f), '');
});

test('rate: z.ai 피크·비피크·종일 비피크 기간', () => {
  assert.equal(zaiRate(new Date('2026-09-30T07:00:00Z')).factor, 0.5); // 특별 기간
  assert.equal(zaiRate(new Date('2026-10-14T07:00:00Z')).peak, true); // 수요일 16시 KST
  assert.equal(zaiRate(new Date('2026-10-14T11:00:00Z')).peak, false); // 수요일 20시 KST
  assert.equal(zaiRate(new Date('2026-10-17T07:00:00Z')).peak, false); // 토요일
});

test('config: 원격 프로젝트 정규화 왕복, 잘못된 remote는 버림, 옛 형식은 remote 키 없음', () => {
  const c = config.normalize({
    projects: [
      { path: 'C:\\dev\\foo\\', remote: { host: ' example-host ', user: ' me ', port: '2222' }, mode: 'weird' },
      { path: 'C:\\dev\\bar', remote: { host: '-oProxyCommand=evil' } },
      { path: 'C:\\dev\\baz', remote: { host: '' } },
      { path: 'C:\\dev\\local' },
    ],
  });
  assert.equal(c.projects.length, 2, '잘못된 remote 프로젝트는 버림');
  const rp = c.projects[0];
  assert.deepEqual(rp.remote, { host: 'example-host', user: 'me', port: 2222 });
  assert.equal(rp.path, 'C:\\dev\\foo', '원격 경로는 cleanPath');
  assert.equal(rp.name, 'foo', '이름 기본값은 baseName');
  assert.equal(rp.mode, 'split');
  const local = c.projects[1];
  assert.ok(!('remote' in local), 'remote 없는 프로젝트에는 remote 키를 만들지 않음');
  const f = path.join(tmp(), 'c.json');
  config.save(f, c);
  assert.deepEqual(config.load(f), c, '저장 → 다시 normalize해도 동일');
});

test('config: addRemoteProject 중복 판정(대소문자·슬래시)·로컬과 같은 경로 공존', () => {
  const c = config.normalize({});
  const a = config.addRemoteProject(c, { host: 'Example-Host', user: 'me', port: 2222, path: 'C:\\dev\\foo\\' });
  assert.ok(a && /^[a-z0-9]{4,16}$/.test(a.id));
  assert.equal(a.name, 'foo');
  assert.equal(config.addRemoteProject(c, { host: 'example-host', user: 'ME', port: 2222, path: 'c:/dev/foo' }).id, a.id, '대소문자·슬래시 차이는 같은 프로젝트');
  assert.equal(c.projects.length, 1);
  assert.equal(config.addRemoteProject(c, { host: 'bad host', path: 'C:\\x' }), null, '잘못된 host면 추가 안 함');
  assert.equal(config.addRemoteProject(config.normalize({}), { host: 'port-default', user: 'me', port: 0, path: 'C:\\x' }).remote.port, 0, '기본 포트(0)로 정규화된 값도 추가됨');
  assert.equal(config.addRemoteProject(c, { host: 'ok-host', path: '   ' }), null, '빈 path면 추가 안 함');
  assert.equal(config.addRemoteProject(c), null);
  const local = config.addProject(c, 'C:\\dev\\foo'); // 원격과 같은 경로 문자열이어도 별개 프로젝트
  assert.notEqual(local.id, a.id);
  assert.ok(!('remote' in local));
  assert.equal(c.projects.length, 2);
  assert.equal(config.addProject(c, 'C:\\dev\\foo').id, local.id, '로컬끼리는 기존처럼 중복 판정');
  config.addRemoteProject(c, { host: 'example-host', user: 'me', port: 2222, path: 'C:\\dev\\other' });
  assert.equal(c.projects.length, 3, '같은 대상이라도 경로가 다르면 추가');
});

test('config: updateProject — 원격 path·host/port 수정, 잘못된 값 무시, 로컬에 remote 붙이기 무시', () => {
  const c = config.normalize({ projects: [{ path: 'C:\\dev\\foo', remote: { host: 'example-host', user: 'me', port: 2222 } }] });
  const id = c.projects[0].id;
  const u = config.updateProject(c, { id, path: 'C:\\dev\\bar\\', remote: { host: 'new-host', port: 22 } });
  assert.equal(u.path, 'C:\\dev\\bar');
  assert.deepEqual(u.remote, { host: 'new-host', user: 'me', port: 0 }, '빠진 user는 유지, 22는 기본 포트 0');
  const bad = config.updateProject(c, { id, remote: { host: 'bad host' } });
  assert.equal(bad.remote.host, 'new-host', '잘못된 host는 무시');
  assert.equal(config.updateProject(c, { id, path: '   ' }).path, 'C:\\dev\\bar', '빈 path는 무시');
  const c2 = config.normalize({ projects: [{ path: 'C:\\dev\\local' }] });
  const u2 = config.updateProject(c2, { id: c2.projects[0].id, remote: { host: 'example-host' } });
  assert.ok(!('remote' in u2), '로컬 프로젝트에 remote를 붙이는 변경은 무시');
  assert.equal(config.updateProject(c2, { id: c2.projects[0].id, path: 'C:\\dev\\moved' }).path, 'C:\\dev\\moved', '로컬 path 수정은 기존처럼 동작');
});

test('launch: 원격 프로젝트 — wt 인자(탭·분할·로컬 혼합)·consoleCommand·sessionTitle·sessionData', () => {
  const ctx = { node: 'node.exe', script: 's.mjs', wt: 'wt.exe', ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', homeDir: 'C:\\Users\\main' };
  const mk = (id, r = null) => ({ id, name: `p${id}`, path: r ? 'C:\\dev\\foo' : `C:\\dev\\p${id}`, mode: 'split', remote: r, main: { model: 'fable', effort: 'high' }, worker: { model: 'glm-5.3', effort: 'max' } });
  const rp = mk('rmt1', { host: 'example-host', user: 'me', port: 2222 });
  const one = launch.buildWtArgs([rp], ctx, 'tab');
  assert.equal(one[one.indexOf('-d') + 1], 'C:\\Users\\main', '시작 폴더는 로컬 홈');
  const cmdIdx = one.indexOf(ctx.ssh);
  assert.ok(cmdIdx > 0, 'node·script 자리에 ssh');
  assert.deepEqual(one.slice(cmdIdx + 1, -1), remote.sshArgs(rp.remote, { interactive: true }));
  assert.ok(one[one.length - 1].startsWith('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand '));
  assert.ok(!one.includes('--project'), '--project는 startCommand 안에 있음');
  assert.equal(one[one.indexOf('--title') + 1], 'example-host · prmt1 · fable/high + glm-5.3', '제목 앞에 host');
  const mix = launch.buildWtArgs([mk('loc1'), rp], ctx, 'split');
  assert.equal(mix.filter(a => a === '--project').length, 1, '로컬 탭에만 --project');
  assert.equal(mix[mix.indexOf('--project') + 1], 'loc1');
  assert.ok(mix.includes(ctx.ssh) && mix.includes('node.exe'), '로컬·원격 혼합 분할');
  const cc = launch.consoleCommand(rp, ctx);
  assert.ok(cc.startsWith(`/d /s /c start "prmt1" /D "C:\\Users\\main" "${ctx.ssh}" `));
  assert.match(cc, /-EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(!cc.includes('--project'));
  assert.equal(launch.sessionTitle(rp), 'example-host · prmt1 · fable/high + glm-5.3');
  const home = tmp();
  const sd = launch.sessionData(rp, { keyFile: 'k' });
  assert.equal(typeof sd.writtenAt, 'string');
  const f = launch.writeSessionFile(home, rp, { keyFile: 'k' });
  const inFile = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(typeof inFile.writtenAt, 'string');
  delete sd.writtenAt;
  delete inFile.writtenAt;
  assert.deepEqual(inFile, sd, 'sessionData는 writeSessionFile이 쓰는 내용과 같음');
});
