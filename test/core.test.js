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
