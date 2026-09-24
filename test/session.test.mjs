// runtime/start-session.mjs 테스트: 모드별 claude 인자·환경, --dry-run
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSession, splitArgs } from '../runtime/start-session.mjs';

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
