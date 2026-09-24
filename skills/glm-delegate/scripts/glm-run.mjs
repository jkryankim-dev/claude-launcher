#!/usr/bin/env node
/**
 * glm-run.mjs — 메인 세션(설계·리뷰) → GLM 작업자(반복 작업) 위임 런처
 * Claude 런처가 ~/.claude/skills/glm-delegate/scripts/ 에 설치·갱신한다.
 *
 * 메인 세션이 쓴 작업 명세(.md)로 헤드리스 Claude Code(`claude -p`)를 z.ai Anthropic 호환
 * 엔드포인트와 별도 설정 폴더로 실행하고, 결과 요약만 출력한다.
 *  - 구독(OAuth)·Anthropic 키와 섞이지 않도록 ANTHROPIC_* 변수를 비우고 z.ai 키만 넣는다.
 *  - 실행 전후 작업 트리를 git 트리 객체로 기록해, 그 실행이 바꾼 파일만 되돌릴 수 있다.
 *  - 기록: <저장소>/.glm/runs/<runId>/ (.git/info/exclude에 자동 등록되어 커밋되지 않음)
 * Node 18+, 외부 의존성 없음. 사용법: node glm-run.mjs --help
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 18) {
  process.stderr.write(`❌ Node 18 이상이 필요합니다 (현재 ${process.version}).\n`);
  process.exit(2);
}

const IS_WIN = process.platform === 'win32';
const E = process.env;
const SELF = fileURLToPath(import.meta.url);
const SELF_CMD = `node "${SELF.replace(/\\/g, '/')}"`;
const MIN_CLAUDE = '2.1.255';

const posInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const posNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function launcherHome() {
  if (E.CLAUDE_LAUNCHER_HOME) return E.CLAUDE_LAUNCHER_HOME;
  if (IS_WIN) return path.join(E.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-launcher');
  return path.join(E.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-launcher');
}

const CFG = {
  baseUrl: E.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
  model: E.GLM_MODEL || 'glm-5.3',
  fastModel: E.GLM_FAST_MODEL || 'glm-5.3-flash',
  effort: (E.GLM_EFFORT || 'high').toLowerCase(),
  maxTurns: posInt(E.GLM_MAX_TURNS, 80),
  timeoutMin: posNum(E.GLM_TIMEOUT_MIN, 30),
  heartbeatSec: posInt(E.GLM_HEARTBEAT_SEC, 120),
  reportLines: posInt(E.GLM_REPORT_LINES, 40),
  configDir: E.GLM_CONFIG_DIR || path.join(os.homedir(), '.claude-glm-worker'),
  claudeBin: E.GLM_CLAUDE_BIN || '',
  verifyShell: E.GLM_VERIFY_SHELL || '',
  plan: (E.GLM_PLAN || '').toLowerCase(),
  keyFile: E.GLM_KEY_FILE || path.join(launcherHome(), 'zai-key.dpapi'),
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'off'];
const VERIFY_TIMEOUT_MS = 15 * 60e3;
const BIG_FILE = 5 * 1024 * 1024; // 이보다 큰 미추적 파일은 스냅샷에서 제외
// z.ai GLM Coding Plan 크레딧 배수(1만 토큰당, 피크 기준). 비피크는 50%.
const RATES = { std: { input: 6.9, cached: 1.7, output: 24 }, flash: { input: 2.3, cached: 0.56, output: 8 } };
const PLAN_5H = { lite: 2000, pro: 12000, max: 28000 };
const STATUS_LABEL = { running: '⏳ 진행 중', done: '✅ 완료', failed: '❌ 실패', timeout: '⏱ 시간 초과', interrupted: '⏹ 중단' };

const HELP = `GLM 작업자 런처 — 메인 세션(설계·리뷰) → GLM(반복 작업) 위임

  node glm-run.mjs <명세.md> [--model M] [--effort E] [--max-turns N] [--timeout 분] [--cwd 폴더]
  node glm-run.mjs --resume <runId|latest> <후속지시.md>   같은 작업자 세션에 후속 지시
  node glm-run.mjs --status [runId|latest]                진행 상황 또는 결과 요약
  node glm-run.mjs --list                                 최근 실행 목록
  node glm-run.mjs --stop [runId|latest]                  실행 중단
  node glm-run.mjs --rollback [runId|latest] [--force]    그 실행이 바꾼 파일만 되돌리기
  node glm-run.mjs --check                                설치·연결 점검

명세 머리말(선택): title, role(edit|scan), model(glm-5.3|flash|…), effort(low|high|max|off),
  max_turns, timeout(분), scope(수정 허용 글롭, !제외), verify(검증 명령), allow_bash, report_lines
환경변수: GLM_MODEL, GLM_FAST_MODEL, GLM_EFFORT, GLM_MAX_TURNS, GLM_TIMEOUT_MIN, GLM_BASE_URL,
  GLM_CONFIG_DIR, GLM_CLAUDE_BIN, GLM_VERIFY_SHELL, GLM_PLAN(lite|pro|max), GLM_WORKER_ENV_<이름>
z.ai 키: ZAI_API_KEY 환경변수, 없으면 Claude 런처 설정에 저장한 키를 자동으로 사용`;

// ───────── 공통 유틸 ─────────
const out = (s = '') => process.stdout.write(s + '\n');
const fwd = p => String(p).replace(/\\/g, '/');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function die(msg, code = 2) {
  try { fs.writeSync(2, String(msg).trimEnd() + '\n'); } catch { process.stderr.write(String(msg) + '\n'); }
  process.exit(code);
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJSON(p, obj) {
  const s = JSON.stringify(obj, null, 2);
  try { fs.writeFileSync(p + '.tmp', s); fs.renameSync(p + '.tmp', p); } catch { try { fs.writeFileSync(p, s); } catch { /* 무시 */ } }
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
function fmtNum(n) {
  n = Math.round(n || 0);
  if (n < 10000) return n.toLocaleString('en-US');
  const v = n / 10000;
  return `${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1).replace(/\.0$/, '')}만`;
}
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const newRunId = () => { const d = new Date(); return `${localStamp(d)}-${String(d.getMilliseconds()).padStart(3, '0')}${crypto.randomBytes(1).toString('hex')[0]}`; };
function semverLt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}
function hashFile(abs) { try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch { return 'deleted'; } }
function finish(code) { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); }

/** 피크: 평일 14–18시 SGT(=15–19시 KST). 2026-09-25~10-07은 종일 비피크 요금. */
function zaiRate(date) {
  const sgt = new Date(date.getTime() + 8 * 3600e3);
  const ymd = sgt.toISOString().slice(0, 10);
  if (ymd >= '2026-09-25' && ymd <= '2026-10-07') return { factor: 0.5, label: '종일 비피크 기간 50%' };
  const day = sgt.getUTCDay(), h = sgt.getUTCHours();
  return day >= 1 && day <= 5 && h >= 14 && h < 18
    ? { factor: 1, label: '피크 시간대(평일 15–19시 KST) 100%' }
    : { factor: 0.5, label: '비피크 50%' };
}

// ───────── z.ai 키 ─────────
function decryptKeyFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  if (!raw) return '';
  if (raw.startsWith('plain:')) return raw.slice(6).trim();
  if (!IS_WIN) return '';
  // DPAPI(현재 사용자). "dpapi:<base64>"는 .NET ProtectedData로 직접 푼다(PowerShell 모듈 불필요). 그 밖은 예전 형식.
  // PowerShell 7에서 물려받은 PSModulePath는 Windows PowerShell 5.1의 모듈 로드를 깨뜨리므로 지운다.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'PSMODULEPATH') env[k] = v;
  const dp = raw.startsWith('dpapi:');
  env.CL_SECRET = dp ? raw.slice(6) : raw;
  const ps = dp
    ? "try{[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CL_SECRET),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))}catch{exit 1}"
    : 'try{$s=ConvertTo-SecureString -String $env:CL_SECRET; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}catch{exit 1}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env, encoding: 'utf8', windowsHide: true, timeout: 30e3 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
function findKey() {
  if ((E.ZAI_API_KEY || '').trim()) return { key: E.ZAI_API_KEY.trim(), src: 'ZAI_API_KEY' };
  if ((E.GLM_API_KEY || '').trim()) return { key: E.GLM_API_KEY.trim(), src: 'GLM_API_KEY' };
  const k = decryptKeyFile(CFG.keyFile);
  return k ? { key: k, src: '런처에 저장한 키' } : { key: '', src: '' };
}
function apiKey() {
  const { key } = findKey();
  if (!key) die([
    '❌ z.ai API 키가 없습니다.',
    'Claude 런처 → 설정 → z.ai 키에 저장하거나, 환경변수 ZAI_API_KEY를 설정한 뒤 터미널을 다시 여세요.',
    '  PowerShell: [Environment]::SetEnvironmentVariable("ZAI_API_KEY", "키", "User")',
  ].join('\n'));
  return key;
}

// ───────── 인자 ─────────
function parseArgs(argv) {
  const o = { _: [], force: false, cmd: 'run' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) die(`❌ ${a} 뒤에 값이 필요합니다.`); i++; return v; };
    const opt = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) return 'latest'; i++; return v; };
    switch (a) {
      case '-h': case '--help': o.cmd = 'help'; break;
      case '--check': o.cmd = 'check'; break;
      case '--list': o.cmd = 'list'; break;
      case '--status': o.cmd = 'status'; o.sel = opt(); break;
      case '--stop': o.cmd = 'stop'; o.sel = opt(); break;
      case '--rollback': o.cmd = 'rollback'; o.sel = opt(); break;
      case '--resume': o.cmd = 'resume'; o.sel = val(); break;
      case '--force': o.force = true; break;
      case '--model': o.model = val(); break;
      case '--effort': o.effort = val(); break;
      case '--max-turns': o.maxTurns = val(); break;
      case '--timeout': o.timeout = val(); break;
      case '--cwd': o.cwd = val(); break;
      default:
        if (a.startsWith('--')) die(`❌ 알 수 없는 옵션: ${a}\n${SELF_CMD} --help`);
        o._.push(a);
    }
  }
  return o;
}

// ───────── git·저장소 ─────────
function git(args, { cwd, env, input } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'core.safecrlf=false', ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
// 짧은 이름(RUNNER~1)·정션·링크로 들어와도 git이 돌려주는 경로와 같은 형태가 되도록 실제 경로로 맞춘다
function realDir(p) { try { return fs.realpathSync.native(p); } catch { return p; } }
function repoCtx(cwdArg) {
  const given = path.resolve(cwdArg || process.cwd());
  if (!fs.existsSync(given)) die(`❌ 폴더가 없습니다: ${given}`);
  const cwd = realDir(given);
  const top = git(['rev-parse', '--show-toplevel'], { cwd });
  if (!top.ok) return { cwd, root: cwd, isGit: false };
  return { cwd, root: realDir(path.resolve(top.out.trim())), isGit: true };
}
function ensureExclude(ctx) {
  if (!ctx.isGit) return;
  const r = git(['rev-parse', '--git-path', 'info/exclude'], { cwd: ctx.root });
  if (!r.ok) return;
  const p = path.resolve(ctx.root, r.out.trim());
  let cur = '';
  try { cur = fs.readFileSync(p, 'utf8'); } catch { /* 없음 */ }
  if (/^\/?\.glm\/?\s*$/m.test(cur)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${cur && !cur.endsWith('\n') ? '\n' : ''}# glm-delegate 실행 기록\n/.glm/\n`);
}
const runsDir = ctx => path.join(ctx.root, '.glm', 'runs');
const runDirOf = (ctx, id) => path.join(runsDir(ctx), id);
const readMeta = (ctx, id) => readJSON(path.join(runDirOf(ctx, id), 'meta.json'));
const writeMeta = (ctx, id, m) => writeJSON(path.join(runDirOf(ctx, id), 'meta.json'), m);
function listRuns(ctx) {
  try { return fs.readdirSync(runsDir(ctx)).filter(n => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(n)).sort(); } catch { return []; }
}
function resolveRun(ctx, sel, pred) {
  const all = listRuns(ctx);
  if (!all.length) die(`❌ 실행 기록이 없습니다 (${fwd(runsDir(ctx))}).`);
  if (!sel || sel === 'latest') {
    for (let i = all.length - 1; i >= 0; i--) if (!pred || pred(readMeta(ctx, all[i]) || {})) return all[i];
    die('❌ 조건에 맞는 실행이 없습니다.');
  }
  if (all.includes(sel)) return sel;
  const hits = all.filter(id => id.startsWith(sel) || id.endsWith(sel));
  if (hits.length === 1) return hits[0];
  die(hits.length ? `❌ 여러 실행과 일치합니다: ${hits.join(', ')}` : `❌ 실행을 찾을 수 없습니다: ${sel}`);
}

// ───────── 명세 파서 (간이 YAML 머리말) ─────────
const SPEC_KEYS = new Set(['title', 'role', 'model', 'effort', 'max_turns', 'timeout', 'scope', 'allow_bash', 'verify', 'report_lines']);
const KEY_ALIAS = { maxturns: 'max_turns', allowbash: 'allow_bash', reportlines: 'report_lines' };
function unquote(s) {
  s = String(s).trim();
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s;
}
function splitInline(s) {
  const res = []; let cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { res.push(cur); cur = ''; continue; }
    cur += c;
  }
  res.push(cur);
  return res.map(unquote).filter(Boolean);
}
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], prev = i ? line[i - 1] : ' ';
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && /[\s[,:-]/.test(prev)) { q = c; continue; }
    if (c === '#' && /\s/.test(prev)) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}
function parseSpec(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { die(`❌ 명세 파일을 읽을 수 없습니다: ${file}`); }
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fm = {}, warnings = [];
  let body = text;
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    let listKey = null;
    for (const rawLine of m[1].split('\n')) {
      const line = stripComment(rawLine);
      if (!line.trim()) continue;
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (item && listKey) { const v = unquote(item[1]); if (v) fm[listKey].push(v); continue; }
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) { warnings.push(`머리말 해석 불가: ${clip(rawLine, 60)}`); continue; }
      let key = kv[1].toLowerCase().replace(/-/g, '_');
      key = KEY_ALIAS[key] || key;
      if (!SPEC_KEYS.has(key)) warnings.push(`알 수 없는 머리말 키: ${kv[1]}`);
      const v = kv[2].trim();
      if (v === '') { fm[key] = []; listKey = key; continue; }
      listKey = null;
      fm[key] = v.startsWith('[') && v.endsWith(']') ? splitInline(v.slice(1, -1)) : unquote(v);
    }
  }
  for (const k of ['scope', 'allow_bash', 'verify']) if (fm[k] != null && !Array.isArray(fm[k])) fm[k] = [fm[k]];
  for (const k of ['title', 'role', 'model', 'effort', 'max_turns', 'timeout', 'report_lines']) if (Array.isArray(fm[k])) fm[k] = fm[k][0] ?? '';
  body = body.trim();
  if (!body) die(`❌ 명세 본문이 비었습니다: ${file}`);
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = String(fm.title || (h1 && h1[1]) || path.basename(file, path.extname(file))).trim();
  return { raw, fm, body, title, warnings };
}

// ───────── 범위(scope) 글롭 — 대괄호는 글자 그대로(Next.js [id] 경로) ─────────
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length;) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; } else { re += '.*'; i += 2; } continue; }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') {
      const j = g.indexOf('}', i);
      if (j > i) { re += `(?:${g.slice(i + 1, j).split(',').map(escRe).join('|')})`; i = j + 1; continue; }
    }
    re += escRe(c); i++;
  }
  return new RegExp(`^${re}$`, IS_WIN ? 'i' : '');
}
function compileScope(list, ctx) {
  const pre = fwd(path.relative(ctx.root, ctx.cwd));
  const inc = [], exc = [];
  for (let s of list || []) {
    s = fwd(String(s).trim());
    if (!s) continue;
    const neg = s.startsWith('!');
    if (neg) s = s.slice(1).trim();
    s = s.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (s === '' || s === '.') s = '**';
    else if (!/[*?{]/.test(s)) {
      if (s.endsWith('/')) s += '**';
      else { try { if (fs.statSync(path.join(ctx.cwd, s)).isDirectory()) s += '/**'; } catch { /* 파일 또는 없음 */ } }
    }
    if (pre) s = `${pre}/${s}`;
    (neg ? exc : inc).push(globToRe(s));
  }
  if (!inc.length && !exc.length) return null;
  return p => (!inc.length || inc.some(r => r.test(p))) && !exc.some(r => r.test(p));
}

// ───────── 작업자 환경·권한·프롬프트 ─────────
const STRIP_PREFIX = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|GLM_|ZAI_|CLAUDE_LAUNCHER_)/i;
const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_MAX_TURNS', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE']);

/** settings.json에도 기록하는 공개 환경(비밀값 없음) */
function publicWorkerEnv(model, effort) {
  const e = {
    ANTHROPIC_BASE_URL: CFG.baseUrl, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CFG.fastModel, ANTHROPIC_SMALL_FAST_MODEL: CFG.fastModel,
    API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    GLM_WORKER: '1',
  };
  if (effort !== 'off') { e.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'; e.CLAUDE_CODE_EFFORT_LEVEL = effort; }
  if (/\[1m\]/i.test(model)) e.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
  return e;
}
function workerEnv(model, effort, key) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIP_PREFIX.test(k) || STRIP_EXACT.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  Object.assign(env, publicWorkerEnv(model, effort));
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^GLM_WORKER_ENV_(.+)$/i.exec(k);
    if (m && v !== undefined) env[m[1]] = v;
  }
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.CLAUDE_CONFIG_DIR = CFG.configDir;
  env.GLM_WORKER = '1';
  return env;
}
function bashRules(cmd) {
  const c = String(cmd).trim();
  if (!c) return [];
  if (/^Bash\(/.test(c)) return [c];
  if (c.includes('*')) return [`Bash(${c})`];
  return [`Bash(${c})`, `Bash(${c} *)`];
}
function allowRules(cmds) {
  const res = [];
  for (const c of cmds) {
    res.push(...bashRules(c));
    const parts = String(c).split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
    if (parts.length > 1) for (const p of parts) res.push(...bashRules(p));
  }
  return res;
}
function buildSettings(role, allowBash, publicEnv) {
  const allow = role === 'edit' ? ['Edit', 'Write'] : [];
  allow.push(...allowRules(['git diff', 'git status', 'git log', 'git show', ...allowBash]));
  const deny = ['Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch',
    'Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)', 'Edit(**/.env.*)',
    'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/.glm/**)', 'Edit(**/.glm/**)'];
  for (const g of ['add', 'commit', 'push', 'reset', 'checkout', 'switch', 'restore', 'clean', 'stash', 'rebase', 'merge']) deny.push(...bashRules(`git ${g}`));
  deny.push('Bash(rm -rf *)', ...bashRules('npm install'), ...bashRules('npm i'), 'Bash(pnpm add *)', ...bashRules('pnpm install'), 'Bash(yarn add *)');
  if (role === 'scan') deny.push('Edit', 'Write', 'NotebookEdit');
  return { permissions: { defaultMode: 'dontAsk', allow: [...new Set(allow)], deny: [...new Set(deny)] }, env: publicEnv };
}

const RULES_EDIT = n => `1. [작업 명세]에 적힌 일만 한다. 요청받지 않은 리팩터링·이름 변경·포맷팅·주석 정리는 하지 않는다.
2. 수정 허용 범위 안의 파일만 고친다. 범위 밖 수정이 꼭 필요하면 고치지 말고 보고서의 "범위 밖 필요 변경"에 적는다.
3. 명세의 규칙과 예시를 모든 대상에 똑같이 적용한다. 대상 목록이 있으면 빠짐없이 처리하고, 처리하지 못한 항목은 이유와 함께 적는다.
4. 애매하면 기존 동작을 유지하는 보수적인 쪽을 고르고 "판단한 부분"에 적는다. 질문하지 말고 끝까지 진행한다.
5. 파일은 필요한 부분만 Edit 도구로 고친다. Write(전체 쓰기)는 새 파일을 만들 때만 쓴다.
6. 비밀값(.env, 키, 토큰)은 읽거나 출력하지 않는다. git 커밋·브랜치 조작, 패키지 설치, 대량 삭제를 하지 않는다. 다른 에이전트에 다시 위임하지 않는다.
7. 셸 명령은 Bash 도구로 실행한다. 권한이 거부된 명령은 다시 시도하지 말고 보고서에 적는다.
8. 검증 명령이 있으면 끝내기 전에 실행한다. 실패하면 원인을 고쳐 최대 3번 다시 돌리고, 그래도 실패하면 멈추고 보고한다.
9. 마지막 응답은 아래 형식의 보고서만 쓴다(${n}줄 이내, 해당 없으면 "없음"):
## 결과
완료 | 부분 완료 | 실패 — 한두 줄 요약
## 변경 파일
- 경로 — 바꾼 내용 한 줄 (파일이 많으면 같은 변경끼리 묶어서)
## 판단한 부분
## 범위 밖 필요 변경
## 검증
- 명령 → 통과/실패 (실패면 핵심 오류 한 줄)`;

const RULES_SCAN = n => `1. 파일을 수정하지 않는다(읽기 전용 조사). 명세에 없는 조사는 하지 않는다.
2. 결론부터 쓴다. 근거는 \`경로:줄\` 형식으로 달고, 인용은 한 줄 이내로 짧게 한다.
3. 대상 목록을 요청받으면 빠짐없이 한 줄에 하나씩 쓴다. 너무 많으면 묶음 기준을 밝히고 개수를 적는다.
4. 비밀값은 출력하지 않는다. 다른 에이전트에 위임하지 않는다. 셸 명령은 Bash 도구로 실행하고, 거부된 명령은 다시 시도하지 않는다.
5. 마지막 응답은 아래 형식의 보고서만 쓴다(${n}줄 이내):
## 요약
## 발견 사항
- \`경로:줄\` — 내용
## 추가 확인 필요`;

function infoBlock(cfg, ctx) {
  const rel = fwd(path.relative(ctx.root, ctx.cwd));
  const q = v => '`' + v + '`';
  return [
    `- 저장소: ${fwd(ctx.root)}${rel ? ` (작업 폴더: ${rel})` : ''}`,
    `- 역할: ${cfg.role === 'scan' ? '조사(읽기 전용, 파일 수정 금지)' : '편집'}`,
    cfg.scope.length ? `- ${cfg.role === 'scan' ? '조사 범위' : '수정 허용 범위(이 밖은 수정 금지)'}: ${cfg.scope.join(', ')}` : null,
    cfg.verify.length ? `- 검증 명령(끝내기 전에 실행): ${cfg.verify.map(q).join(', ')}` : null,
    cfg.allowBash.length
      ? `- 실행 허용된 셸 명령: ${cfg.allowBash.map(q).join(', ')} (그 밖의 변경성 명령은 거부됨)`
      : '- 셸은 읽기 전용 명령과 git diff/status/log/show만 허용됨',
  ].filter(Boolean).join('\n');
}
function buildPrompt(spec, cfg, ctx) {
  return [
    '너는 반복 작업을 맡은 코딩 작업자다. 설계자가 쓴 [작업 명세]를 그대로 수행한다. 대화 상대가 없으니 질문하지 말고 끝까지 진행한 뒤, 마지막 응답으로 보고서만 쓴다.',
    '', '[작업 정보]', infoBlock(cfg, ctx),
    '', `[작업 명세] ${spec.title}`, spec.body,
    '', '[작업 규칙]', cfg.role === 'scan' ? RULES_SCAN(cfg.reportLines) : RULES_EDIT(cfg.reportLines),
  ].join('\n');
}
function resumePrompt(spec, cfg, ctx) {
  return [
    '[후속 지시] 앞 작업에 이어지는 지시다. 앞과 같은 [작업 규칙]과 보고 형식을 그대로 따른다.',
    '', '[작업 정보]', infoBlock(cfg, ctx),
    '', `[후속 지시] ${spec.title}`, spec.body,
    '', `마지막 응답은 앞과 같은 형식의 보고서(${cfg.reportLines}줄 이내)로 쓴다.`,
  ].join('\n');
}

// ───────── claude 실행 파일 ─────────
function resolveClaude() {
  const viaFile = p => {
    const ext = path.extname(p).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) return { cmd: process.execPath, pre: [p], shell: false, label: p };
    if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
      const cli = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], shell: false, label: p };
      return { cmd: p, pre: [], shell: true, label: p };
    }
    return { cmd: p, pre: [], shell: false, label: p };
  };
  if (CFG.claudeBin) return viaFile(CFG.claudeBin);
  if (!IS_WIN) {
    const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
    const p = String(r.stdout || '').trim().split('\n')[0];
    return p ? viaFile(p) : null;
  }
  const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
  const list = String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pick = list.find(p => /\.exe$/i.test(p)) || list.find(p => /\.(cmd|bat)$/i.test(p));
  if (pick) return viaFile(pick);
  const guess = [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(E.APPDATA || '', 'npm', 'claude.cmd')].find(p => fs.existsSync(p));
  return guess ? viaFile(guess) : null;
}
function winQuote(a) { return /^[\w\-.:\\/=@+,[\]]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`; }
function spawnClaude(bin, args, opts) {
  const all = [...bin.pre, ...args];
  if (bin.shell) return spawn([winQuote(bin.cmd), ...all.map(winQuote)].join(' '), [], { ...opts, shell: true, windowsHide: true });
  return spawn(bin.cmd, all, { ...opts, windowsHide: true });
}
function runClaudeSync(bin, args, timeout = 30e3) {
  const all = [...bin.pre, ...args];
  if (bin.shell) return spawnSync([winQuote(bin.cmd), ...all.map(winQuote)].join(' '), [], { shell: true, encoding: 'utf8', timeout, windowsHide: true });
  return spawnSync(bin.cmd, all, { encoding: 'utf8', timeout, windowsHide: true });
}
function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode) return;
  if (IS_WIN) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 이미 종료 */ } }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } }, 5000).unref();
}
function killPid(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (IS_WIN) { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료 */ } }
}
const shortPath = (base, p) => { const r = path.relative(base, String(p)); return fwd(!r || r.startsWith('..') || path.isAbsolute(r) ? p : r); };

// ───────── 작업자 실행 ─────────
function launchWorker(o) {
  return new Promise(resolve => {
    const st = {
      sessionId: null, initModel: null, msgIds: new Set(), touched: new Set(), lastTool: '', lastText: '',
      retries: 0, retryErrors: [], result: null, errTail: '', exitCode: null, spawnError: null,
      timedOut: false, interrupted: false, t0: Date.now(), ms: 0, childPid: null,
    };
    const bin = resolveClaude();
    if (!bin) { st.spawnError = { code: 'ENOENT', message: 'claude 실행 파일 없음' }; return resolve(st); }
    const settingsPath = path.join(o.runDir, 'settings.json');
    writeJSON(settingsPath, o.settings);
    const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose',
      '--max-turns', String(o.maxTurns), '--permission-mode', 'dontAsk', '--settings', settingsPath];
    if (o.resumeSession) args.push('--resume', o.resumeSession);
    let child;
    try { child = spawnClaude(bin, args, { cwd: o.cwd, env: workerEnv(o.model, o.effort, o.key), stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN }); }
    catch (e) { st.spawnError = e; return resolve(st); }
    st.childPid = child.pid;
    const streamLog = fs.createWriteStream(path.join(o.runDir, 'stream.jsonl'));
    const errLog = fs.createWriteStream(path.join(o.runDir, 'stderr.log'));
    let buf = '', settled = false, afterResult = null;
    const handleLine = line => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        st.sessionId = ev.session_id || st.sessionId; st.initModel = ev.model || null; o.onInit?.(st);
      } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        st.retries++;
        st.retryErrors.push(clip(`${ev.error_status ?? ''} ${typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error ?? '')}`, 160));
      } else if (ev.type === 'assistant' && ev.message) {
        if (ev.message.id) st.msgIds.add(ev.message.id);
        for (const b of ev.message.content || []) {
          if (b.type === 'tool_use') {
            const i = b.input || {};
            const fp = i.file_path || i.notebook_path;
            st.lastTool = `${b.name}${fp ? ' ' + shortPath(o.cwd, fp) : i.command ? ' ' + clip(i.command, 60) : i.pattern ? ' ' + clip(i.pattern, 40) : ''}`;
            if (fp && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(b.name)) st.touched.add(fp);
          } else if (b.type === 'text' && b.text && b.text.trim()) st.lastText = b.text.trim();
        }
      } else if (ev.type === 'result') {
        st.result = ev;
        if (!afterResult) afterResult = setTimeout(() => killTree(child), 60e3);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      streamLog.write(d); buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { errLog.write(d); st.errTail = (st.errTail + d).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);

    const stopFile = path.join(o.runDir, 'STOP');
    const timer = setTimeout(() => { st.timedOut = true; killTree(child); }, o.timeoutMs);
    const poll = setInterval(() => {
      if (!st.interrupted && fs.existsSync(stopFile)) { st.interrupted = true; killTree(child); }
      o.onPoll?.(st);
    }, 2000);
    const onSig = () => { if (st.interrupted) process.exit(130); st.interrupted = true; killTree(child); };
    const onExit = () => { if (!settled) killTree(child); };
    process.on('SIGINT', onSig); process.on('SIGTERM', onSig); process.on('exit', onExit);
    const settle = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(poll); if (afterResult) clearTimeout(afterResult);
      process.off('SIGINT', onSig); process.off('SIGTERM', onSig); process.off('exit', onExit);
      if (buf.trim()) handleLine(buf);
      buf = '';
      st.exitCode = code; st.ms = Date.now() - st.t0;
      let n = 2;
      const fin = () => { if (--n === 0) resolve(st); };
      streamLog.end(fin); errLog.end(fin);
    };
    child.on('error', e => { st.spawnError = e; settle(null); });
    child.on('close', code => settle(code));
  });
}

// ───────── 스냅샷·변경 수집 ─────────
/** 작업 트리(추적 파일 + 무시되지 않은 미추적 파일)를 임시 인덱스로 트리 객체에 기록. 실제 인덱스·작업 트리는 건드리지 않는다. */
function snapshotTree(ctx, runDir, tag) {
  if (!ctx.isGit) return null;
  const idx = path.join(runDir, `snap-${tag}.index`);
  const env = { GIT_INDEX_FILE: idx };
  const rp = git(['rev-parse', '--git-path', 'index'], { cwd: ctx.root });
  const realIdx = rp.ok ? path.resolve(ctx.root, rp.out.trim()) : '';
  const build = seed => {
    fs.rmSync(idx, { force: true });
    if (seed) {
      if (!realIdx || !fs.existsSync(realIdx)) return null;
      fs.copyFileSync(realIdx, idx);
      if (!git(['add', '-u'], { cwd: ctx.root, env }).ok) return null;
    }
    const lo = git(['ls-files', '-z', '-o', '--exclude-standard'], { cwd: ctx.root, env });
    if (!lo.ok) return null;
    const add = [], skipped = [];
    for (const f of lo.out.split('\0')) {
      if (!f || f === '.glm' || f.startsWith('.glm/')) continue;
      let s;
      try { s = fs.lstatSync(path.join(ctx.root, f)); } catch { continue; }
      if ((s.isFile() || s.isSymbolicLink()) && s.size <= BIG_FILE) add.push(f); else skipped.push(f);
    }
    for (let i = 0; i < add.length; i += 300) {
      const r = git(['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: ctx.root, env, input: add.slice(i, i + 300).join('\0') });
      if (!r.ok) return null;
    }
    const wt = git(['write-tree'], { cwd: ctx.root, env });
    return wt.ok ? { tree: wt.out.trim(), skipped } : null;
  };
  try { return build(true) || build(false); } catch { return null; } finally {
    for (const p of [idx, idx + '.lock']) { try { fs.rmSync(p, { force: true }); } catch { /* 무시 */ } }
  }
}
function diffNumstat(ctx, t1, t2) {
  const r = git(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', t1, t2], { cwd: ctx.root });
  if (!r.ok) return null;
  const res = [];
  for (const rec of r.out.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (m) res.push({ path: m[3], add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2] });
  }
  return res;
}
function inTree(ctx, tree, rels) {
  const res = new Set();
  const ok = rels.filter(p => !p.includes('\n'));
  if (!tree || !ok.length) return res;
  const r = git(['cat-file', '--batch-check'], { cwd: ctx.root, input: ok.map(p => `${tree}:${p}`).join('\n') + '\n' });
  const lines = r.out.split('\n');
  ok.forEach((p, i) => { if (/^[0-9a-f]{40,64} (blob|commit) /.test(lines[i] || '')) res.add(p); });
  return res;
}
function checkIgnored(ctx, rels) {
  if (!rels.length) return new Set();
  const r = git(['check-ignore', '-z', '--stdin', '--no-index'], { cwd: ctx.root, input: rels.join('\0') + '\0' });
  return new Set(r.out.split('\0').filter(Boolean));
}
function toRel(root, p) {
  let s = String(p);
  const m = IS_WIN && /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (m) s = `${m[1]}:/${m[2]}`;
  const rel = path.relative(root, path.resolve(root, s));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return fwd(rel);
}
function overlappingRuns(ctx, myId, t0, t1) {
  const res = [];
  for (const id of listRuns(ctx).slice(-50)) {
    if (id === myId) continue;
    const m = readMeta(ctx, id);
    if (!m?.startedAt) {
      try { if (fs.statSync(runDirOf(ctx, id)).mtimeMs >= t0) res.push(id); } catch { /* 없음 */ }
      continue;
    }
    const s = Date.parse(m.startedAt);
    const e = m.endedAt ? Date.parse(m.endedAt) : pidAlive(m.pid) ? Infinity : s;
    if (s < t1 && e > t0) res.push(id);
  }
  return res;
}
function collectChanges(ctx, snap, tree2, touched, overlap, scopeFn) {
  const touchedRel = new Set(), outside = [];
  for (const p of touched) {
    const r = toRel(ctx.root, p);
    if (r === null) outside.push(fwd(p));
    else if (r !== '.glm' && !r.startsWith('.glm/')) touchedRel.add(r);
  }
  const bigBefore = new Set(snap?.skipped || []), bigAfter = new Set(tree2?.skipped || []);
  const map = new Map();
  let gitMode = false;
  if (snap?.tree && tree2?.tree) {
    const d = diffNumstat(ctx, snap.tree, tree2.tree);
    if (d) {
      gitMode = true;
      for (const x of d) {
        if (x.path.startsWith('.glm/')) continue;
        if (overlap.length && !touchedRel.has(x.path)) continue;
        map.set(x.path, x);
      }
    }
  }
  const rest = [...touchedRel].filter(p => !map.has(p));
  const ign = gitMode && rest.length ? checkIgnored(ctx, rest) : new Set();
  for (const p of rest) {
    const note = ign.has(p) ? 'gitignore 대상' : bigBefore.has(p) || bigAfter.has(p) ? '대용량' : null;
    if (gitMode && !note) continue; // 추적 가능한데 차이가 없음 = 순변경 없음
    map.set(p, { path: p, add: null, del: null, note });
  }
  const paths = [...map.keys()].sort();
  const before = snap?.tree ? inTree(ctx, snap.tree, paths) : new Set();
  const files = paths.map(p => {
    const f = map.get(p);
    const now = fs.existsSync(path.join(ctx.root, p));
    const was = before.has(p) || bigBefore.has(p) ? true : snap?.tree && !f.note ? false : null;
    f.st = was === null ? (now ? '?' : 'D') : was ? (now ? 'M' : 'D') : (now ? 'A' : '?');
    f.oos = scopeFn ? !scopeFn(p) : false;
    return f;
  });
  return { files, outside: [...new Set(outside)], gitMode, partial: overlap.length > 0 };
}

// ───────── 검증 ─────────
function findGitBash() {
  const c = [E.CLAUDE_CODE_GIT_BASH_PATH];
  const w = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const g of String(w.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    let d = path.dirname(g);
    for (let k = 0; k < 3; k++) { c.push(path.join(d, 'bin', 'bash.exe')); d = path.dirname(d); }
  }
  c.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', path.join(E.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'));
  return c.find(p => p && !/system32/i.test(p) && fs.existsSync(p)) || null;
}
let _vshell;
function verifyShell() {
  if (_vshell) return _vshell;
  const v = CFG.verifyShell;
  const base = v ? path.basename(v).toLowerCase() : '';
  if (v && /^(powershell|pwsh)(\.exe)?$/.test(base)) _vshell = { exe: v, args: c => ['-NoProfile', '-NonInteractive', '-Command', c], label: base };
  else if (v && /^cmd(\.exe)?$/.test(base)) _vshell = { exe: null, label: 'cmd' };
  else if (v) _vshell = { exe: v, args: c => ['-c', c], label: base };
  else if (IS_WIN) { const b = findGitBash(); _vshell = b ? { exe: b, args: c => ['-c', c], label: 'Git Bash' } : { exe: null, label: 'cmd' }; }
  else _vshell = fs.existsSync('/bin/bash') ? { exe: '/bin/bash', args: c => ['-c', c], label: 'bash' } : { exe: null, label: 'sh' };
  return _vshell;
}
function execShell(cmd, cwd, timeoutMs, log) {
  return new Promise(resolve => {
    const sh = verifyShell();
    const env = { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' };
    const opts = { cwd, env, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] };
    let child;
    try { child = sh.exe ? spawn(sh.exe, sh.args(cmd), opts) : spawn(cmd, { ...opts, shell: true }); }
    catch (e) { return resolve({ code: -1, tail: String(e.message), timedOut: false }); }
    let tail = '', timedOut = false;
    const onData = d => { log.write(d); tail = (tail + d.toString('utf8')).slice(-8000); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const t = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, tail: String(e.message), timedOut }); });
    child.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, tail, timedOut }); });
  });
}
async function runVerify(cmds, cwd, logPath) {
  const log = fs.createWriteStream(logPath);
  const results = [];
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let ok = true;
  for (const cmd of cmds) {
    const t0 = Date.now();
    log.write(`$ ${cmd}\n`);
    const r = await execShell(cmd, cwd, Math.max(5e3, deadline - Date.now()), log);
    const tail = r.code === 0 ? [] : r.tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean).slice(-25).map(s => cut(s, 200));
    results.push({ cmd, code: r.code, ms: Date.now() - t0, timedOut: r.timedOut, tail });
    log.write(`\n[exit ${r.code}${r.timedOut ? ' timeout' : ''}]\n\n`);
    if (r.code !== 0) { ok = false; break; }
  }
  await new Promise(res => log.end(res));
  return { ok, results, shell: verifyShell().label };
}

// ───────── 요약 ─────────
function usageTotals(result, fallbackModel) {
  const rows = [];
  const mu = result?.modelUsage;
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    for (const [m, u] of Object.entries(mu)) rows.push({ model: m, input: (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0), cached: u.cacheReadInputTokens || 0, output: u.outputTokens || 0 });
  } else if (result?.usage) {
    const u = result.usage;
    rows.push({ model: fallbackModel, input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
  }
  const t = { input: 0, cached: 0, output: 0, credits: 0, known: rows.length > 0 };
  for (const r of rows) {
    t.input += r.input; t.cached += r.cached; t.output += r.output;
    const k = /flash/i.test(r.model) ? RATES.flash : RATES.std;
    t.credits += (r.input * k.input + r.cached * k.cached + r.output * k.output) / 1e4;
  }
  return t;
}
function explainError(st, cfg) {
  if (st.spawnError) return st.spawnError.code === 'ENOENT'
    ? 'claude 실행 파일을 찾지 못했습니다 → Claude Code 설치 확인, 또는 GLM_CLAUDE_BIN에 전체 경로 지정'
    : `작업자 실행 실패: ${clip(st.spawnError.message, 150)}`;
  if (st.interrupted) return '중단 요청(--stop 또는 상위 세션 종료)';
  if (st.timedOut) return `시간 제한 ${cfg.timeoutMin}분 초과 → 작업을 더 쪼개거나 timeout을 늘리세요. 이어서 하려면 --resume`;
  const r = st.result;
  const resText = typeof r?.result === 'string' ? r.result : '';
  const txt = [resText, ...(Array.isArray(r?.errors) ? r.errors.map(String) : []), ...st.retryErrors, st.errTail].join('\n');
  const raw = clip(resText || st.retryErrors.at(-1) || st.errTail.split('\n').filter(Boolean).at(-1) || '', 160);
  let why;
  if (r?.subtype === 'error_max_turns') why = `최대 턴(${cfg.maxTurns}) 도달 → 작업을 쪼개거나 --resume으로 이어서(필요하면 max_turns 상향)`;
  else if (/\b401\b|unauthori[sz]ed|authentication|invalid[^\n]{0,20}(api.?key|token)/i.test(txt)) why = 'z.ai 인증 실패(401) → 런처 설정의 z.ai 키 확인 후 --check';
  else if (/\b429\b|rate.?limit|quota|insufficient|too many requests|usage limit|额度|余额/i.test(txt)) why = 'z.ai 사용 한도·속도 제한(429) → 5시간/주간 한도 확인, 잠시 후 --resume';
  else if (/effort/i.test(txt) && /\b400\b|invalid|unsupported|unknown/i.test(txt)) why = 'effort 값 거부 → effort: off (또는 GLM_EFFORT=off)로 다시 실행';
  else if (/beta/i.test(txt) && /\b400\b|invalid|unsupported|unknown/i.test(txt)) why = '베타 헤더 거부 → GLM_WORKER_ENV_CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 설정 후 다시 실행';
  else if (/model/i.test(txt) && /not.?found|invalid|unknown|does not exist|not supported/i.test(txt)) why = `모델 이름 오류(${cfg.model}) → 런처의 작업자 모델 확인`;
  else if (/permission-mode|dontAsk/i.test(txt)) why = 'Claude Code 버전이 낮음 → claude update';
  else if (!r) why = `작업자가 결과 없이 종료(exit ${st.exitCode}) → stderr.log 확인`;
  else if (r.subtype && r.subtype !== 'success') why = `작업자 오류(${r.subtype})`;
  else why = '작업자가 오류로 끝남';
  return raw && !why.includes(raw) ? `${why} · 원문: ${raw}` : why;
}
function buildSummary(m, report) {
  const L = [];
  const ch = m.changed || { files: [], outside: [] };
  const files = ch.files || [];
  const verFail = m.verify && !m.verify.ok;
  const head = m.status === 'done' ? (verFail ? '⚠ 완료 · 검증 실패' : '✅ 완료') : STATUS_LABEL[m.status] || m.status;
  const dur = Date.parse(m.endedAt) - Date.parse(m.startedAt);
  L.push(`[GLM] ${head} · ${m.id} · ${m.initModel || m.cfg.model} · ${m.turns ?? 0}턴 · ${fmtDur(dur)}`);
  L.push(`작업: ${m.title}${m.parent ? ` (이어서: ${m.parent})` : ''}`);
  if (m.cause) L.push(`원인: ${m.cause}`);
  if (m.cfg.role === 'scan' && files.length) L.push(`⚠ 조사 작업인데 파일 ${files.length}개가 바뀌었습니다 → 되돌리기 권장`);
  if (files.length) {
    const add = files.reduce((a, f) => a + (f.add || 0), 0), del = files.reduce((a, f) => a + (f.del || 0), 0);
    const how = ch.partial ? ' · 병렬 실행 중이라 도구 기록 기준' : !ch.gitMode ? ' · git 비교 없이 도구 기록 기준' : '';
    L.push(`변경 ${files.length}파일 (+${add} −${del})${how}`);
    for (const f of files.slice(0, 30)) L.push(`  ${f.st} ${f.path}${f.add != null ? `  +${f.add} −${f.del}` : ''}${f.note ? ` (${f.note})` : ''}${f.oos ? '  ⚠범위 밖' : ''}`);
    if (files.length > 30) L.push(`  … 외 ${files.length - 30}개 (git status로 확인)`);
  } else if (m.cfg.role === 'edit') L.push('변경 없음');
  const oos = files.filter(f => f.oos);
  if (oos.length && m.cfg.role === 'edit') L.push(`⚠ 범위 밖 변경 ${oos.length}개: ${oos.slice(0, 5).map(f => f.path).join(', ')}${oos.length > 5 ? ' …' : ''}`);
  if (ch.outside?.length) L.push(`⚠ 저장소 밖 변경 ${ch.outside.length}개(자동 되돌리기 대상 아님): ${ch.outside.slice(0, 3).join(', ')}`);
  if (m.verify) {
    if (m.verify.ok) L.push(`검증 ✅ PASS · ${m.verify.results.map(r => `${r.cmd} (${fmtDur(r.ms)})`).join(' · ')}`);
    else {
      const f = m.verify.results.at(-1);
      L.push(`검증 ❌ FAIL · ${f.cmd} (exit ${f.code}${f.timedOut ? ', 시간 초과' : ''}) · 전체 로그 .glm/runs/${m.id}/verify.log`);
      for (const t of f.tail) L.push(`  │ ${t}`);
    }
  } else if (m.cfg.role === 'edit' && m.status === 'done') L.push('검증 없음 (명세에 verify 없음)');
  const u = m.usage;
  if (u?.known) {
    const cr = u.credits * m.rate.factor;
    let s = `토큰 입력 ${fmtNum(u.input)} · 캐시 ${fmtNum(u.cached)} · 출력 ${fmtNum(u.output)} → 약 ${Math.round(cr).toLocaleString('en-US')} 크레딧 (${m.rate.label})`;
    const cap = PLAN_5H[CFG.plan];
    if (cap) s += ` · ${CFG.plan} 5시간 한도의 ${(cr / cap * 100).toFixed(1)}%`;
    L.push(s);
  }
  if (m.denials?.length) {
    const cnt = new Map();
    for (const d of m.denials) { const k = `${d.tool}(${d.input})`; cnt.set(k, (cnt.get(k) || 0) + 1); }
    L.push(`권한 거부 ${m.denials.length}건: ${[...cnt].slice(0, 4).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')} → 필요하면 allow_bash에 추가`);
  }
  if (m.retries) L.push(`API 재시도 ${m.retries}회`);
  const text = report || (m.status !== 'done' ? m.lastText : '');
  if (text) {
    const lines = text.split('\n');
    const lim = m.cfg.reportLines + 20;
    L.push(/^##\s/m.test(text) ? '── 작업자 보고 ──' : '── 마지막 응답 ──');
    L.push(...lines.slice(0, lim));
    if (lines.length > lim) L.push(`… (${lines.length}줄 중 ${lim}줄 · 전체 .glm/runs/${m.id}/report.md)`);
    L.push('──');
  }
  L.push(`기록: .glm/runs/${m.id}/`);
  if (m.snapshot?.tree && files.length) L.push(`되돌리기: ${SELF_CMD} --rollback ${m.id}`);
  if (m.sessionId) L.push(`후속 지시: ${SELF_CMD} --resume ${m.id} <후속명세.md>`);
  return L.join('\n');
}

// ───────── 명령: 실행 / 이어서 ─────────
function resolveModel(v) {
  const s = String(v || '').trim();
  if (!s || /^(glm|default|std)$/i.test(s)) return CFG.model;
  if (/^(flash|fast)$/i.test(s)) return CFG.fastModel;
  return s;
}
async function cmdRun(specPath, o, parent = null) {
  const key = apiKey();
  const ctx = repoCtx(parent ? parent.cwd : o.cwd);
  const spec = parseSpec(specPath);
  const fm = spec.fm, base = parent?.cfg || {};
  const role = String(fm.role || base.role || 'edit').toLowerCase();
  if (!['edit', 'scan'].includes(role)) die(`❌ role은 edit 또는 scan 이어야 합니다: ${role}`);
  const model = resolveModel(o.model || fm.model || base.model);
  const effort = String(o.effort || fm.effort || base.effort || CFG.effort).toLowerCase();
  if (!EFFORTS.includes(effort)) die(`❌ effort 값 오류: ${effort} (${EFFORTS.join('|')})`);
  const maxTurns = posInt(o.maxTurns ?? fm.max_turns ?? base.maxTurns, CFG.maxTurns);
  const timeoutMin = posNum(o.timeout ?? fm.timeout ?? base.timeoutMin, CFG.timeoutMin);
  const scope = fm.scope ?? base.scope ?? [];
  const verify = fm.verify ?? base.verify ?? [];
  const allowBash = [...new Set([...(fm.allow_bash ?? base.allowBash ?? []), ...verify])];
  const reportLines = posInt(fm.report_lines ?? base.reportLines, role === 'scan' ? Math.round(CFG.reportLines * 1.5) : CFG.reportLines);
  const title = parent ? (fm.title || `${parent.title} · 후속`) : spec.title;
  const cfg = { role, model, effort, maxTurns, timeoutMin, scope, verify, allowBash, reportLines };

  ensureExclude(ctx);
  const id = newRunId(), runDir = runDirOf(ctx, id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'spec.md'), spec.raw);
  const prompt = parent ? resumePrompt(spec, cfg, ctx) : buildPrompt(spec, cfg, ctx);
  fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
  const snap = snapshotTree(ctx, runDir, 'before');
  const specAbs = path.resolve(specPath);
  const meta = {
    id, parent: parent?.id || null, children: [], title,
    spec: toRel(ctx.root, specAbs) || fwd(specAbs), root: fwd(ctx.root), cwd: fwd(ctx.cwd), cfg,
    pid: process.pid, childPid: null, startedAt: new Date().toISOString(), status: 'running',
    snapshot: snap, sessionId: null, warnings: spec.warnings,
  };
  writeMeta(ctx, id, meta);
  if (parent) {
    const pm = readMeta(ctx, parent.id);
    if (pm) { pm.children = [...new Set([...(pm.children || []), id])]; writeMeta(ctx, parent.id, pm); }
  }
  out(`[GLM] 시작 · ${id} · ${title}`);
  out(`  ${role === 'scan' ? '조사' : '편집'} · ${model} · effort ${effort} · 최대 ${maxTurns}턴 · 제한 ${timeoutMin}분${parent ? ` · 이어서(${parent.id})` : ''}`);
  if (!ctx.isGit) out('  ⚠ git 저장소가 아니라 변경 추적·되돌리기가 제한됩니다.');
  else if (!snap) out('  ⚠ 스냅샷 실패 — 이번 실행은 되돌릴 수 없습니다.');
  for (const w of spec.warnings) out(`  ⚠ ${w}`);
  if (role === 'edit' && !scope.length) out('  ⚠ scope 없음 — 범위 밖 변경을 검사하지 않습니다.');
  const rate0 = zaiRate(new Date());
  if (rate0.factor === 1) out(`  ⚠ z.ai ${rate0.label} — 비피크보다 크레딧이 2배 듭니다.`);

  let lastWrite = 0, nextBeat = CFG.heartbeatSec * 1000;
  const st = await launchWorker({
    cwd: ctx.cwd, runDir, model, effort, maxTurns, timeoutMs: timeoutMin * 60e3,
    settings: buildSettings(role, allowBash, publicWorkerEnv(model, effort)), prompt,
    resumeSession: parent?.sessionId || null, key,
    onInit: s => { meta.sessionId = s.sessionId; meta.initModel = s.initModel; meta.childPid = s.childPid; writeMeta(ctx, id, meta); },
    onPoll: s => {
      const el = Date.now() - s.t0;
      if (Date.now() - lastWrite > 10e3) {
        lastWrite = Date.now();
        meta.childPid = s.childPid;
        meta.progress = { turns: s.msgIds.size, files: s.touched.size, lastTool: s.lastTool, at: new Date().toISOString() };
        writeMeta(ctx, id, meta);
      }
      if (el >= nextBeat) {
        nextBeat += CFG.heartbeatSec * 1000;
        out(`[GLM] 진행 ${fmtDur(el)} · 턴 ${s.msgIds.size} · 편집 ${s.touched.size}파일${s.lastTool ? ' · ' + s.lastTool : ''}`);
      }
    },
  });

  const t1 = Date.now();
  const r = st.result;
  Object.assign(meta, {
    endedAt: new Date(t1).toISOString(),
    sessionId: st.sessionId || meta.sessionId,
    initModel: st.initModel || meta.initModel,
    status: st.spawnError ? 'failed' : st.interrupted ? 'interrupted' : st.timedOut ? 'timeout' : r && r.subtype === 'success' && !r.is_error ? 'done' : 'failed',
    result: r ? { subtype: r.subtype, isError: !!r.is_error, turns: r.num_turns, durationMs: r.duration_ms } : null,
    turns: r?.num_turns ?? st.msgIds.size,
    retries: st.retries,
    denials: (r?.permission_denials || []).map(d => ({ tool: d.tool_name, input: clip(d.tool_input?.command || d.tool_input?.file_path || JSON.stringify(d.tool_input || {}), 100) })),
    usage: usageTotals(r, model),
    rate: zaiRate(new Date(meta.startedAt)),
    lastText: cut(st.lastText || '', 1500),
  });
  meta.cause = meta.status === 'done' ? null : explainError(st, cfg);

  const tree2 = snap ? snapshotTree(ctx, runDir, 'after') : null;
  const overlap = ctx.isGit ? overlappingRuns(ctx, id, Date.parse(meta.startedAt), t1) : [];
  meta.changed = collectChanges(ctx, snap, tree2, st.touched, overlap, compileScope(scope, ctx));
  if (verify.length && role === 'edit' && !st.interrupted && (meta.status === 'done' || meta.changed.files.length)) {
    out(`[GLM] 검증 실행: ${verify.join(' && ')}`);
    meta.verify = await runVerify(verify, ctx.cwd, path.join(runDir, 'verify.log'));
  }
  meta.after = {};
  for (const f of meta.changed.files) meta.after[f.path] = hashFile(path.join(ctx.root, f.path));
  const report = typeof r?.result === 'string' ? r.result.trim() : '';
  if (report) fs.writeFileSync(path.join(runDir, 'report.md'), report + '\n');
  meta.exitCode = meta.status === 'done' && (!meta.verify || meta.verify.ok) ? 0 : 1;
  writeMeta(ctx, id, meta);
  const summary = buildSummary(meta, report);
  fs.writeFileSync(path.join(runDir, 'summary.txt'), summary + '\n');
  out(summary);
  return meta.exitCode;
}
async function cmdResume(o) {
  const fix = o._[0];
  if (!fix) die(`❌ 후속 지시 파일이 필요합니다: ${SELF_CMD} --resume <runId|latest> <후속명세.md>`);
  const ctx0 = repoCtx(o.cwd);
  const pid = resolveRun(ctx0, o.sel, m => !!m.sessionId);
  const parent = readMeta(ctx0, pid);
  if (!parent?.sessionId) die(`❌ ${pid} 실행에는 세션 ID가 없어 이어갈 수 없습니다. 새 명세로 실행하세요.`);
  if (parent.status === 'running' && pidAlive(parent.pid)) die(`❌ ${pid} 가 아직 실행 중입니다.`);
  if (parent.rolledBack && !o.force) die(`❌ ${pid} 는 되돌린 실행입니다. 작업자는 편집이 남아 있다고 기억하므로 새 명세로 실행하세요 (강행: --force).`);
  return cmdRun(fix, o, parent);
}

// ───────── 명령: 상태·목록·중단 ─────────
function cmdStatus(o) {
  const ctx = repoCtx(o.cwd);
  const id = resolveRun(ctx, o.sel);
  const m = readMeta(ctx, id);
  if (!m) die(`❌ 기록을 읽을 수 없습니다(쓰는 중일 수 있음): ${id}`);
  if (m.status === 'running') {
    if (pidAlive(m.pid)) {
      const p = m.progress || {};
      out(`[GLM] ⏳ 진행 중 · ${id} · ${m.title} · ${fmtDur(Date.now() - Date.parse(m.startedAt))} 경과 · 턴 ${p.turns ?? 0} · 편집 ${p.files ?? 0}파일${p.lastTool ? ` · 최근: ${p.lastTool}` : ''}`);
      return 0;
    }
    out(`[GLM] ⚠ 비정상 종료 · ${id} · ${m.title} — 런처 프로세스가 없습니다.`);
    out(`되돌리기: ${SELF_CMD} --rollback ${id} --force`);
    return 1;
  }
  let s = '';
  try { s = fs.readFileSync(path.join(runDirOf(ctx, id), 'summary.txt'), 'utf8').trimEnd(); } catch { /* 없음 */ }
  out(s || `[GLM] ${STATUS_LABEL[m.status] || m.status} · ${id} · ${m.title}${m.cause ? `\n원인: ${m.cause}` : ''}`);
  if (m.rolledBack) out(`(되돌림: ${m.rolledBack.at})`);
  return 0;
}
function cmdList(o) {
  const ctx = repoCtx(o.cwd);
  const ids = listRuns(ctx).slice(-15).reverse();
  if (!ids.length) { out('실행 기록이 없습니다.'); return 0; }
  out('최근 GLM 실행 (최신순)');
  for (const id of ids) {
    const m = readMeta(ctx, id) || {};
    const st = m.status === 'running' && !pidAlive(m.pid) ? '⚠ 비정상 종료' : STATUS_LABEL[m.status] || m.status || '?';
    const n = m.changed?.files?.length;
    out(`${id}  ${st}${m.verify ? (m.verify.ok ? ' · 검증 ✓' : ' · 검증 ✗') : ''}${n != null ? ` · ${n}파일` : ''}${m.rolledBack ? ' · 되돌림' : ''}${m.parent ? ` · ↳${m.parent.slice(-4)}` : ''}  ${clip(m.title, 50)}`);
  }
  return 0;
}
async function cmdStop(o) {
  const ctx = repoCtx(o.cwd);
  const id = resolveRun(ctx, o.sel, m => m.status === 'running');
  let m = readMeta(ctx, id);
  if (m.status !== 'running') die(`실행 중이 아닙니다: ${id} (${m.status})`);
  fs.writeFileSync(path.join(runDirOf(ctx, id), 'STOP'), new Date().toISOString());
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    m = readMeta(ctx, id) || m;
    if (m.status !== 'running') break;
  }
  if (m.status === 'running') {
    killPid(m.childPid); killPid(m.pid);
    Object.assign(m, { status: 'interrupted', endedAt: new Date().toISOString(), cause: '강제 종료(--stop)' });
    writeMeta(ctx, id, m);
    out(`[GLM] ⏹ 강제 종료 · ${id} — 변경 목록이 없으니 되돌리려면: ${SELF_CMD} --rollback ${id} --force`);
    return 0;
  }
  return cmdStatus({ ...o, sel: id });
}

// ───────── 명령: 되돌리기 ─────────
function pruneDirs(root, dir) {
  const r = path.resolve(root);
  let d = path.resolve(dir);
  while (d.startsWith(r) && d !== r) {
    try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    d = path.dirname(d);
  }
}
function cmdRollback(o) {
  const ctx = repoCtx(o.cwd);
  const id = resolveRun(ctx, o.sel);
  const m = readMeta(ctx, id);
  if (!m) die(`❌ 기록을 읽을 수 없습니다: ${id}`);
  if (m.status === 'running' && pidAlive(m.pid)) die(`❌ 아직 실행 중입니다. 먼저 ${SELF_CMD} --stop ${id}`);
  if (m.rolledBack && !o.force) die(`❌ 이미 되돌린 실행입니다 (${m.rolledBack.at}). 다시 하려면 --force`);
  const kids = listRuns(ctx).map(k => readMeta(ctx, k)).filter(k => k && k.parent === id && !k.rolledBack);
  if (kids.length && !o.force) die(`❌ 이 실행을 이어받은 후속 실행이 있습니다: ${kids.map(k => k.id).join(', ')}\n   최신 것부터 되돌리세요 (강행: --force).`);
  const tree = m.snapshot?.tree;
  if (!tree) die('❌ 스냅샷이 없어 되돌릴 수 없습니다 (git 저장소가 아니었거나 스냅샷 실패).');
  if (!git(['cat-file', '-e', `${tree}^{tree}`], { cwd: ctx.root }).ok) die('❌ 스냅샷 객체가 없습니다 (git gc로 정리되었을 수 있음).');
  let files = m.changed?.files;
  if (!files) {
    if (!o.force) die('❌ 이 실행은 비정상 종료되어 변경 목록이 없습니다.\n   스냅샷과 지금 작업 트리를 비교해 되돌리려면 --force (그 사이 직접 고친 내용도 함께 되돌아갑니다).');
    const now = snapshotTree(ctx, runDirOf(ctx, id), 'now');
    files = (now ? diffNumstat(ctx, tree, now.tree) || [] : []).filter(x => !x.path.startsWith('.glm/')).map(x => ({ path: x.path }));
  }
  const bigBefore = new Set(m.snapshot?.skipped || []);
  const inSnap = inTree(ctx, tree, files.map(f => f.path));
  const res = { restored: [], deleted: [], skipped: [] };
  for (const f of files) {
    const p = f.path, abs = path.join(ctx.root, p);
    const after = m.after?.[p];
    if (!o.force && after && hashFile(abs) !== after) { res.skipped.push(`${p} (실행 후 다시 수정됨 → --force)`); continue; }
    if (inSnap.has(p)) {
      const r = git(['--literal-pathspecs', 'restore', `--source=${tree}`, '--worktree', '--', p], { cwd: ctx.root });
      if (r.ok) res.restored.push(p); else res.skipped.push(`${p} (복원 실패: ${clip(r.err, 80)})`);
    } else if (bigBefore.has(p) || f.note) {
      res.skipped.push(`${p} (${f.note === 'gitignore 대상' ? 'gitignore 대상' : '대용량 미추적 파일'} — 직접 확인)`);
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true }); pruneDirs(ctx.root, path.dirname(abs)); res.deleted.push(p);
    } else res.restored.push(p);
  }
  m.rolledBack = { at: new Date().toISOString(), ...res };
  writeMeta(ctx, id, m);
  out(`[GLM] 되돌리기 · ${id} · ${m.title}`);
  out(`  복원 ${res.restored.length} · 삭제 ${res.deleted.length} · 건너뜀 ${res.skipped.length}`);
  for (const s of res.skipped.slice(0, 20)) out(`  건너뜀: ${s}`);
  const outside = m.changed?.outside || [];
  if (outside.length) out(`  ⚠ 저장소 밖 변경은 직접 확인: ${outside.slice(0, 3).join(', ')}`);
  return res.skipped.length ? 1 : 0;
}

// ───────── 명령: 점검 ─────────
async function cmdCheck(o) {
  let bad = 0;
  const ok = s => out(`✅ ${s}`), warn = s => out(`⚠ ${s}`), fail = s => { bad++; out(`❌ ${s}`); };
  out('[GLM 점검]');
  ok(`Node ${process.version}`);
  const gv = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (gv.status === 0) ok(gv.stdout.trim()); else warn('git 없음 — 변경 추적·되돌리기 불가');
  const bin = resolveClaude();
  if (!bin) fail('claude 실행 파일을 찾지 못했습니다 → Claude Code 설치 확인 (또는 GLM_CLAUDE_BIN)');
  else {
    const r = runClaudeSync(bin, ['--version']);
    const ver = /(\d+\.\d+\.\d+)/.exec(String(r.stdout || ''))?.[1];
    if (!ver) fail(`claude --version 실패 (${fwd(bin.label)})`);
    else if (semverLt(ver, MIN_CLAUDE)) warn(`Claude Code ${ver} — Fable 5.1은 ${MIN_CLAUDE} 이상 필요 → claude update`);
    else ok(`Claude Code ${ver} (${fwd(bin.label)})`);
  }
  const { key, src } = findKey();
  if (key) ok(`z.ai 키: ${src} (…${key.slice(-4)})`); else fail('z.ai 키 없음 → 런처 설정에서 저장하거나 ZAI_API_KEY 설정');
  try { fs.mkdirSync(CFG.configDir, { recursive: true }); ok(`작업자 설정 폴더 ${fwd(CFG.configDir)}`); } catch (e) { fail(`작업자 설정 폴더 생성 실패: ${e.message}`); }
  const ctx = repoCtx(o.cwd);
  if (ctx.isGit) ok(`git 저장소 ${fwd(ctx.root)}`); else warn(`git 저장소 아님 (${fwd(ctx.cwd)}) — 저장소 폴더에서 실행해야 되돌리기 가능`);
  ok(`검증 셸: ${verifyShell().label}`);
  out(`   작업자 모델 ${CFG.model} · 보조 ${CFG.fastModel} · effort ${CFG.effort} · ${CFG.baseUrl}`);
  if (bad || !bin || !key) { out('\n❌ 위 항목을 먼저 해결하세요.'); return 1; }
  out(`… 연결 테스트 (${CFG.model}, 최대 2턴, 3분 제한)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-check-'));
  const effort = CFG.effort === 'off' ? 'off' : 'low';
  const st = await launchWorker({
    cwd: tmp, runDir: tmp, model: CFG.model, effort, maxTurns: 2, timeoutMs: 180e3, key,
    settings: buildSettings('scan', [], publicWorkerEnv(CFG.model, effort)),
    prompt: '연결 테스트다. 도구를 쓰지 말고 정확히 GLM_OK 한 단어로만 답하라.',
  });
  const text = typeof st.result?.result === 'string' ? st.result.result.trim() : '';
  const u = usageTotals(st.result, CFG.model);
  if (st.result && !st.result.is_error && /GLM_OK/.test(text)) {
    ok(`응답 "${clip(text, 40)}" · 모델 ${st.initModel || CFG.model} · 입력 ${fmtNum(u.input + u.cached)} · 출력 ${fmtNum(u.output)} · ${fmtDur(st.ms)}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무시 */ }
  } else {
    fail(`연결 실패: ${explainError(st, { maxTurns: 2, timeoutMin: 3, model: CFG.model })}`);
    out(`   로그: ${fwd(tmp)}`);
  }
  out(bad ? '❌ 점검 실패' : '✅ 준비 완료');
  return bad ? 1 : 0;
}

// ───────── main ─────────
const o = parseArgs(process.argv.slice(2));
if (o.cmd === 'help') { out(HELP); process.exit(0); }
if (o.cmd === 'run' && !o._.length) { out(HELP); process.exit(2); }
if (E.GLM_WORKER === '1' && ['run', 'resume', 'check'].includes(o.cmd)) die('❌ GLM 작업자 세션 안에서는 다시 위임할 수 없습니다 (GLM_WORKER=1). 받은 명세를 직접 수행하세요.');
if (['run', 'resume'].includes(o.cmd) && /^(off|0|false|no)$/i.test(E.GLM_DELEGATE || '')) die('❌ 이 세션은 GLM 위임이 꺼져 있습니다(런처의 Claude만/GLM만 모드). 직접 처리하세요.');
const handlers = { run: () => cmdRun(o._[0], o), resume: () => cmdResume(o), status: () => cmdStatus(o), list: () => cmdList(o), stop: () => cmdStop(o), rollback: () => cmdRollback(o), check: () => cmdCheck(o) };
try {
  finish((await handlers[o.cmd]()) ?? 0);
} catch (e) {
  process.stderr.write(`❌ 내부 오류: ${e?.stack || e}\n`);
  finish(3);
}
