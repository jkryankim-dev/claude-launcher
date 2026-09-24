#!/usr/bin/env node
/**
 * start-session.mjs — Claude 런처 세션 시작기
 * Windows Terminal 탭(또는 콘솔 창) 안에서 실행된다. 런처가 열기 직전에 써 둔
 * <런처 폴더>/sessions/<projectId>.json을 읽어 환경을 만들고, 그 폴더에서 claude를 띄운다.
 *   node start-session.mjs --project <id> [--home <런처 폴더>] [--dry-run]
 * 런처가 %APPDATA%\claude-launcher\runtime\ 에 설치·갱신한다.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ZAI_URL = 'https://api.z.ai/api/anthropic';
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_)/i;
const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'GLM_WORKER', 'GLM_DELEGATE', 'GLM_MODEL', 'GLM_EFFORT', 'GLM_KEY_FILE', 'GLM_BASE_URL', 'GLM_FAST_MODEL']);
const MODE_NAME = { split: '분담', claude: 'Claude만', glm: 'GLM만' };
const useEffort = e => !!e && e !== 'off';

export function launcherHome(env = process.env) {
  if (env.CLAUDE_LAUNCHER_HOME) return env.CLAUDE_LAUNCHER_HOME;
  if (IS_WIN) return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-launcher');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-launcher');
}

/** "a 'b c'" → ['a', 'b c'] (추가 인자용 간단 분리) */
export function splitArgs(s) {
  const res = [];
  let cur = '', q = null, has = false;
  for (const c of String(s || '')) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { res.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (cur || has) res.push(cur);
  return res;
}

/** 세션 설정 → claude 인자·환경. 순수 함수(테스트 대상). */
export function buildSession(s, { env = process.env, key = '', home = os.homedir() } = {}) {
  const e = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || STRIP.test(k) || STRIP_EXACT.has(k.toUpperCase())) continue;
    e[k] = v;
  }
  const args = [];
  let lines;
  if (s.mode === 'glm') {
    const m = s.worker.model;
    if (!key) return { error: 'z.ai 키가 없습니다. 런처 → 설정 → z.ai 키를 저장한 뒤 다시 여세요.' };
    Object.assign(e, {
      ANTHROPIC_BASE_URL: s.zaiBaseUrl || ZAI_URL, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: m,
      ANTHROPIC_DEFAULT_FABLE_MODEL: m, ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: s.fastModel || 'glm-5.3-flash', API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: s.glmConfigDir || path.join(home, '.claude-glm'),
      GLM_DELEGATE: 'off',
    });
    if (/\[1m\]/i.test(m)) e.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
    if (useEffort(s.worker.effort)) e.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
    args.push('--model', m);
    if (useEffort(s.worker.effort)) args.push('--effort', s.worker.effort);
    lines = [`GLM 전용 세션: ${m}, effort ${s.worker.effort || '기본'} (z.ai)`, `설정 폴더 ${e.CLAUDE_CONFIG_DIR}`];
  } else {
    args.push('--model', s.main.model);
    if (useEffort(s.main.effort)) args.push('--effort', s.main.effort);
    if (s.mode === 'split') {
      Object.assign(e, { GLM_DELEGATE: 'on', GLM_MODEL: s.worker.model, GLM_EFFORT: s.worker.effort || 'high' });
      if (s.keyFile) e.GLM_KEY_FILE = s.keyFile;
      if (s.zaiBaseUrl) e.GLM_BASE_URL = s.zaiBaseUrl;
      if (s.fastModel) e.GLM_FAST_MODEL = s.fastModel;
      lines = [`메인 ${s.main.model}, effort ${s.main.effort || '기본'} (Claude 구독)`,
        `작업자 ${s.worker.model}, effort ${s.worker.effort || 'high'} (z.ai) — 반복 작업은 GLM에 위임`];
    } else {
      e.GLM_DELEGATE = 'off';
      lines = [`Claude 전용: ${s.main.model}, effort ${s.main.effort || '기본'} (Claude 구독, 위임 안 함)`];
    }
  }
  if (s.extraArgs) args.push(...splitArgs(s.extraArgs));
  e.CLAUDE_LAUNCHER_PROJECT = s.name || '';
  return { env: e, args, lines };
}

function readKey(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  if (!raw) return '';
  if (raw.startsWith('plain:')) return raw.slice(6).trim();
  if (!IS_WIN) return '';
  const ps = 'try{$s=ConvertTo-SecureString -String $env:CL_SECRET; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}catch{exit 1}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CL_SECRET: raw }, encoding: 'utf8', windowsHide: true, timeout: 30e3 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
function whereFirst(name) {
  const r = IS_WIN ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true }) : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return String(r.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function resolveClaude() {
  const viaFile = p => {
    const ext = path.extname(p).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) return { cmd: process.execPath, pre: [p], shell: false };
    if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
      const cli = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      return fs.existsSync(cli) ? { cmd: process.execPath, pre: [cli], shell: false } : { cmd: p, pre: [], shell: true };
    }
    return { cmd: p, pre: [], shell: false };
  };
  if (process.env.GLM_CLAUDE_BIN) return viaFile(process.env.GLM_CLAUDE_BIN);
  const list = whereFirst('claude');
  const pick = IS_WIN ? list.find(p => /\.exe$/i.test(p)) || list.find(p => /\.(cmd|bat)$/i.test(p)) : list[0];
  if (pick) return viaFile(pick);
  const guess = IS_WIN && [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')].find(p => fs.existsSync(p));
  return guess ? viaFile(guess) : null;
}
const q = a => (/^[\w\-.:\\/=@+,[\]]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
function runInherit(bin, args, opts) {
  return new Promise(resolve => {
    const all = [...bin.pre, ...args];
    let child;
    try {
      child = bin.shell
        ? spawn([q(bin.cmd), ...all.map(q)].join(' '), [], { ...opts, shell: true, stdio: 'inherit' })
        : spawn(bin.cmd, all, { ...opts, stdio: 'inherit' });
    } catch (e) { resolve({ code: 1, error: e }); return; }
    child.on('error', e => resolve({ code: 1, error: e }));
    child.on('exit', code => resolve({ code: code ?? 1 }));
  });
}
function openShell(cwd, env) {
  if (IS_WIN) spawnSync(whereFirst('pwsh').length ? 'pwsh.exe' : 'powershell.exe', ['-NoLogo'], { cwd, env, stdio: 'inherit' });
  else spawnSync(process.env.SHELL || '/bin/bash', [], { cwd, env, stdio: 'inherit' });
}

const color = (m, s) => `\x1b[38;2;${m === 'glm' ? '93;202;165' : m === 'claude' ? '211;209;199' : '175;169;236'}m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const out = s => process.stdout.write(s + '\n');
function header(s, b) {
  const bar = color(s.mode, '▌');
  out('');
  out(`${bar} \x1b[1m${s.name}\x1b[0m ${dim(`(${MODE_NAME[s.mode] || s.mode})`)}`);
  for (const l of b.lines) out(`${bar} ${l}`);
  out(`${bar} ${dim(s.path)}`);
  out('');
}
function fail(msg, s) {
  out(`\n\x1b[31m✕\x1b[0m ${msg}`);
  out(dim('이 창은 셸로 남겨 둡니다. 닫으려면 exit'));
  openShell(s?.path && fs.existsSync(s.path) ? s.path : os.homedir(), process.env);
}
function visibleEnv(e) {
  const keys = Object.keys(e).filter(k => /^(ANTHROPIC_|CLAUDE_|GLM_|API_TIMEOUT)/.test(k)).sort();
  return Object.fromEntries(keys.map(k => [k, k === 'ANTHROPIC_AUTH_TOKEN' ? '***' : e[k]]));
}

async function main() {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const id = val('--project');
  const home = val('--home') || launcherHome();
  const dry = argv.includes('--dry-run');
  const ignore = () => {};
  process.on('SIGINT', ignore); // Ctrl+C는 claude가 처리한다(시작기가 먼저 죽으면 탭이 닫힘)
  if (IS_WIN) process.on('SIGBREAK', ignore);
  const file = id ? path.join(home, 'sessions', `${id}.json`) : '';
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 없음 */ }
  if (!s) return fail(`세션 설정을 찾을 수 없습니다: ${file || '(--project 없음)'}. 런처에서 다시 열어 주세요.`, null);
  if (!fs.existsSync(s.path)) return fail(`폴더가 없습니다: ${s.path}`, null);
  const b = buildSession(s, { key: s.mode === 'glm' ? readKey(s.keyFile) : '' });
  if (b.error) return fail(b.error, s);
  header(s, b);
  if (dry) { out(JSON.stringify({ args: b.args, env: visibleEnv(b.env) }, null, 2)); return; }
  const bin = resolveClaude();
  if (!bin) return fail('claude 명령을 찾을 수 없습니다. Claude Code 설치를 확인하세요.', s);
  const r = await runInherit(bin, b.args, { cwd: s.path, env: b.env });
  if (r.error) out(`\n\x1b[31m✕\x1b[0m claude 실행 실패: ${r.error.message}`);
  if (s.keepShell !== false) {
    out(`\n${dim('Claude Code가 끝났습니다. 이어서 하려면:')} claude --continue ${b.args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    openShell(s.path, b.env);
  }
  process.exitCode = r.code;
}

function sameFile(a, b) { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } }
const isMain = !!process.argv[1] && sameFile(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));
if (isMain) main().catch(e => { out(`✕ 시작기 오류: ${e?.stack || e}`); process.exitCode = 1; });
