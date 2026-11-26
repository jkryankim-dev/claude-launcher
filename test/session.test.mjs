// runtime/start-session.mjs 테스트: 모드별 claude 인자·환경, --dry-run
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSession, buildChatSession, chatExtraArgs, runStudioEnsure, splitArgs } from '../runtime/start-session.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime/start-session.mjs');
const base = {
  id: 'p1', name: 'cuboerp', path: '/dev/cuboerp',
  main: { model: 'fable', effort: 'high' }, worker: { model: 'glm-5.3', effort: 'max' },
  keyFile: '/k/zai-key.dpapi', zaiBaseUrl: 'https://api.z.ai/api/anthropic', fastModel: 'glm-5.3-flash', glmConfigDir: '/h/.claude-glm',
};
const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CONFIG_DIR: '/other', CLAUDECODE: '1', GLM_MODEL: 'old', GLM_DELEGATE: 'off' };

test('분담: 구독 세션(ANTHROPIC_* 제거) + 작업자 설정 전달', () => {
  const b = buildSession({ ...base, mode: 'split' }, { env });
  assert.deepEqual(b.args, ['--model', 'fable', '--effort', 'high']);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE']) assert.equal(b.env[k], undefined, k);
  assert.equal(b.env.GLM_MODEL, 'glm-5.3');
  assert.equal(b.env.GLM_EFFORT, 'max');
  assert.equal(b.env.GLM_DELEGATE, 'on');
  assert.equal(b.env.GLM_KEY_FILE, '/k/zai-key.dpapi');
  assert.equal(b.env.GLM_FAST_MODEL, 'glm-5.3-flash');
  assert.equal(b.env.PATH, '/bin');
  assert.equal(b.env.CLAUDE_LAUNCHER_PROJECT, 'cuboerp');
});

test('Claude만: 위임 끔, effort 기본이면 --effort 생략', () => {
  const b = buildSession({ ...base, mode: 'claude', main: { model: 'opus', effort: 'off' } }, { env });
  assert.deepEqual(b.args, ['--model', 'opus']);
  assert.equal(b.env.GLM_DELEGATE, 'off');
  assert.equal(b.env.GLM_MODEL, undefined);
});

test('GLM만: z.ai 환경과 별도 설정 폴더, 키 없으면 오류', () => {
  assert.match(buildSession({ ...base, mode: 'glm' }, { env }).error, /z\.ai 키/);
  const b = buildSession({ ...base, mode: 'glm', extraArgs: '--permission-mode plan "--append x y"' }, { env, key: 'zk' });
  assert.equal(b.env.ANTHROPIC_AUTH_TOKEN, 'zk');
  assert.equal(b.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(b.env.ANTHROPIC_MODEL, 'glm-5.3');
  assert.equal(b.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  assert.equal(b.env.CLAUDE_CONFIG_DIR, '/h/.claude-glm');
  assert.equal(b.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, '1');
  assert.equal(b.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(b.env.GLM_DELEGATE, 'off');
  assert.deepEqual(b.args, ['--model', 'glm-5.3', '--effort', 'max', '--permission-mode', 'plan', '--append x y']);
});

test('splitArgs: 따옴표·빈 인자', () => {
  assert.deepEqual(splitArgs(`a "b c" 'd' ""`), ['a', 'b c', 'd', '']);
  assert.deepEqual(splitArgs('  '), []);
});

test('시작기 --dry-run: 세션 파일을 읽어 실행할 내용을 보여 줌(키는 가림)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'p1.json'), JSON.stringify({ ...base, mode: 'glm', path: home, keyFile: path.join(home, 'key') }));
  fs.writeFileSync(path.join(home, 'key'), 'plain:secret-zk');
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'p1', '--home', home, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cuboerp/);
  assert.match(r.stdout, /GLM 전용 세션/);
  assert.match(r.stdout, /"ANTHROPIC_AUTH_TOKEN": "\*\*\*"/);
  assert.doesNotMatch(r.stdout, /secret-zk/);
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual(j.args, ['--model', 'glm-5.3', '--effort', 'max']);
});

test('Windows: 런처가 DPAPI로 저장한 키를 시작기가 읽음 (PowerShell 7 환경 흉내)', { skip: process.platform !== 'win32' }, () => {
  const secrets = createRequire(import.meta.url)('../src/core/secrets.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-dpapi-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  const keyFile = path.join(home, 'zai-key.dpapi');
  secrets.saveKey(keyFile, 'real-key-5678');
  fs.writeFileSync(path.join(home, 'sessions', 'p2.json'), JSON.stringify({ ...base, id: 'p2', mode: 'glm', path: home, keyFile }));
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'p2', '--home', home, '--dry-run'], { encoding: 'utf8', env: { ...process.env, PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\nope\\Modules' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"ANTHROPIC_AUTH_TOKEN": "\*\*\*"/);
});

test('시작기 --dry-run: 실패하면 셸을 열지 않고 종료 코드 1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fail-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'nope', '--home', home, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /세션 설정을 찾을 수 없습니다/);
});

// ── 이어하기(resume) ──
const UUID = '1f0e8d9a-2345-4bc8-8d9a-c0ffee123456';

test('resume: UUID면 --resume 인자, 아니면 무시하고 경고', () => {
  const b = buildSession({ ...base, mode: 'claude', resume: UUID }, { env });
  assert.deepEqual(b.args, ['--model', 'fable', '--effort', 'high', '--resume', UUID]);
  for (const bad of ['not-uuid', '../../../etc/passwd', '1f0e8d9a-2345-4bc8-8d9a-c0ffee12345', 123]) {
    const w = buildSession({ ...base, mode: 'claude', resume: bad }, { env });
    assert.ok(!w.args.includes('--resume'), `${JSON.stringify(bad)} → --resume 없음`);
    assert.ok(w.warnings.some(x => /resume.*UUID/i.test(x)), `${JSON.stringify(bad)} → 경고`);
  }
  const none = buildSession({ ...base, mode: 'claude' }, { env });
  assert.deepEqual(none.warnings, [], 'resume 없으면 경고 없음');
});

test('시작기 --dry-run 출력에도 --resume이 반영된다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-res-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'p3.json'), JSON.stringify({ ...base, id: 'p3', mode: 'claude', path: home, resume: UUID }));
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'p3', '--home', home, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '' } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual(j.args, ['--model', 'fable', '--effort', 'high', '--resume', UUID]);
});

// ── 스튜디오 조직도 심기 ──
test('ext.studio: STUDIO_TOOL/STUDIO_ORG 환경 — 안 켜면 없음', () => {
  const b = buildSession({ ...base, mode: 'split', ext: { studio: true } }, { env });
  assert.ok(b.env.STUDIO_TOOL.endsWith('studio.mjs'), b.env.STUDIO_TOOL);
  assert.ok(path.isAbsolute(b.env.STUDIO_TOOL));
  assert.equal(b.env.STUDIO_ORG, path.join('/dev/cuboerp', '.studio', 'org.json'));
  const none = buildSession({ ...base, mode: 'split' }, { env });
  assert.equal(none.env.STUDIO_TOOL, undefined);
  assert.equal(none.env.STUDIO_ORG, undefined);
});

test('runStudioEnsure: 실제 폴더에 심기, 두 번째는 조용히, 실패해도 문구만 돌려준다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-run-'));
  const s = { ...base, mode: 'split', path: dir, ext: { studio: true } };
  const lines1 = await runStudioEnsure(s);
  assert.ok(fs.existsSync(path.join(dir, '.studio', 'org.json')), 'org.json 심김');
  assert.ok(fs.existsSync(path.join(dir, '.studio', 'ORG.md')));
  assert.ok(lines1.some(l => l.includes('게임 스튜디오 조직도를 만들었습니다') && l.includes('.studio/ORG.md')), JSON.stringify(lines1));
  const lines2 = await runStudioEnsure(s);
  assert.ok(!lines2.some(l => l.includes('만들었습니다')), '이미 있으면 안내 없음: ' + JSON.stringify(lines2));

  const notDir = path.join(dir, 'afile.txt');
  fs.writeFileSync(notDir, 'x');
  const bad = await runStudioEnsure({ ...s, path: notDir }); // 폴더가 아닌 경로 → 심기 실패
  assert.ok(bad.some(l => /실패|계속/.test(l)), JSON.stringify(bad));
  const still = buildSession({ ...s, path: notDir, mode: 'claude' }, { env }); // 세션 구성은 계속된다
  assert.ok(still.env.STUDIO_ORG.includes('afile.txt'));
  assert.deepEqual(await runStudioEnsure({ ...base, mode: 'claude' }), [], 'ext.studio가 아니면 아무 일 없음');
});

// ── 채팅 세션 구성(buildChatSession) ──
test('buildChatSession: 모드별 환경이 buildSession과 정확히 같고 모델·effort·configDir·resume을 돌려준다', () => {
  for (const mode of ['split', 'claude', 'glm']) {
    const s = { ...base, mode, extraArgs: '--verbose' };
    const term = buildSession(s, { env, key: mode === 'glm' ? 'zk' : '' });
    const chat = buildChatSession(s, { env, key: mode === 'glm' ? 'zk' : '' });
    assert.deepEqual(chat.env, term.env, `${mode} 환경이 같은 코드 경로`);
  }
  assert.match(buildChatSession({ ...base, mode: 'glm' }, { env }).error, /z\.ai 키/);
  const glm = buildChatSession({ ...base, mode: 'glm' }, { env, key: 'zk' });
  assert.equal(glm.model, 'glm-5.3');
  assert.equal(glm.effort, 'max');
  assert.equal(glm.configDir, '/h/.claude-glm');
  const main = buildChatSession({ ...base, mode: 'claude', main: { model: 'opus', effort: 'off' } }, { env });
  assert.equal(main.model, 'opus');
  assert.equal(main.effort, null, "effort 'off'는 null");
  assert.equal(main.configDir, null);
  assert.equal(buildChatSession({ ...base, mode: 'claude', resume: UUID }, { env }).resume, UUID);
  assert.equal(buildChatSession({ ...base, mode: 'claude', resume: 'junk' }, { env }).resume, null);
  assert.equal(buildChatSession({ ...base, mode: 'claude', extraArgs: '--permission-mode plan' }, { env }).permissionMode, 'plan');
});

test('chatExtraArgs 변환 표: skip-permissions·permission-mode·무시할 model/effort·flag=value·값 붙은 flag·순서', () => {
  assert.deepEqual(chatExtraArgs(''), { extraArgs: undefined, permissionMode: null });
  assert.deepEqual(chatExtraArgs(undefined), { extraArgs: undefined, permissionMode: null });
  assert.deepEqual(chatExtraArgs('--dangerously-skip-permissions'), { extraArgs: undefined, permissionMode: 'bypassPermissions' });
  assert.deepEqual(chatExtraArgs('--permission-mode plan'), { extraArgs: undefined, permissionMode: 'plan' });
  assert.deepEqual(chatExtraArgs('--permission-mode=acceptEdits'), { extraArgs: undefined, permissionMode: 'acceptEdits' });
  assert.deepEqual(chatExtraArgs('--model opus --effort max'), { extraArgs: undefined, permissionMode: null }, '프로필 값을 쓰므로 무시');
  assert.deepEqual(chatExtraArgs('--model'), { extraArgs: undefined, permissionMode: null }, '값 없는 --model');
  assert.deepEqual(chatExtraArgs('--verbose --append "x y"'), { extraArgs: { verbose: null, append: 'x y' }, permissionMode: null });
  assert.deepEqual(chatExtraArgs('--foo=bar pos --flag -5'), { extraArgs: { foo: 'bar', flag: '-5' }, permissionMode: null }, '위치 인자는 버림, '-' 값은 받음');
  assert.deepEqual(chatExtraArgs('--dangerously-skip-permissions --permission-mode plan'), { extraArgs: undefined, permissionMode: 'plan' }, '뒤에 오는 쪽이 이긴다');
  assert.deepEqual(chatExtraArgs('pos -- --flag'), { extraArgs: { flag: null }, permissionMode: null }, '빈 이름(-- alone)·앞 위치 인자 무시');
});
