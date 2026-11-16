'use strict';
/**
 * remote-apply.cjs — 원격 준비 에이전트 (의존성 없는 단일 파일)
 * 런처가 `ssh -T <target> node -`의 표준 입력으로 이 파일 원문을 보낸다. 앞에 붙은
 * `globalThis.__CL_PAYLOAD__ = {...};`를 읽어 원격 미니PC에 파일(런처 런타임·위임 스킬·세션 JSON·
 * z.ai 키·CLAUDE.md 영역)을 쓰고 점검 결과를 `@@CLR@@<JSON>` 한 줄로 stdout에 출력한다.
 * 예외가 나도 `@@CLR@@{"ok":false,...}`를 쓰고 종료 코드 0으로 끝난다(오류 구분은 JSON으로).
 * 내장 모듈(node:)만 쓴다. 결과·오류 문자열에 z.ai 키를 절대 넣지 않는다.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const MARK = '@@CLR@@';
// 아래 상수·규칙은 src/core/claudemd.js와 같아야 한다(원격에서는 그 파일을 require할 수 없다).
const MD_START = '<!-- claude-launcher:start — 이 영역은 Claude 런처가 관리합니다 -->';
const MD_END = '<!-- claude-launcher:end -->';
const MD_BLOCK = /<!-- claude-launcher:start[^>]*-->[\s\S]*?<!-- claude-launcher:end -->\n?/;

/** runtime/start-session.mjs의 launcherHome과 같은 규칙 */
function launcherHome(env = process.env) {
  if (env.CLAUDE_LAUNCHER_HOME) return env.CLAUDE_LAUNCHER_HOME;
  if (IS_WIN) return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-launcher');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-launcher');
}

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

/** CLAUDE.md의 런처 표시 주석 영역만 교체(src/core/claudemd.js의 apply와 바이트 단위로 같은 결과) */
function applyClaudeMd(file, content) {
  const cur = readText(file);
  const block = `${MD_START}\n${String(content).trim()}\n${MD_END}\n`;
  const next = MD_BLOCK.test(cur) ? cur.replace(MD_BLOCK, () => block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur.trim() ? '\n' : ''}${block}`;
  if (next === cur) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (cur && !fs.existsSync(file + '.launcher-backup')) fs.writeFileSync(file + '.launcher-backup', cur);
  fs.writeFileSync(file, next);
  return true;
}

function whereList(name) {
  const r = IS_WIN
    ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', windowsHide: true });
  return String((r && r.stdout) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** claude 실행 파일 경로(Windows: .exe → .cmd/.bat → 홈의 .local/bin → %APPDATA%/npm, 그 밖: command -v) */
function findClaude(env, home) {
  if (IS_WIN) {
    const list = whereList('claude');
    const pick = list.find(p => /\.exe$/i.test(p)) || list.find(p => /\.(cmd|bat)$/i.test(p));
    if (pick) return pick;
    const guesses = [path.join(home, '.local', 'bin', 'claude.exe'), path.join(env.APPDATA || '', 'npm', 'claude.cmd')];
    return guesses.find(p => p && fs.existsSync(p)) || null;
  }
  return whereList('claude')[0] || null;
}

/** 폴더 하나의 하위 폴더 이름만(숨김·$·시스템 볼륨 제외, 대소문자 무시 정렬, 최대 500개). ''이면 드라이브 목록 */
function listDir(p) {
  const out = { path: p, parent: null, dirs: [], error: null };
  try {
    if (p === '') {
      if (!IS_WIN) throw new Error('not windows');
      const drives = [];
      for (let c = 67; c <= 90; c++) { // C:\ … Z:\
        const d = `${String.fromCharCode(c)}:\\`;
        try { fs.statSync(d); drives.push(d); } catch { /* 없는 드라이브 */ }
      }
      out.dirs = drives;
      return out;
    }
    const parent = path.dirname(p);
    out.parent = parent === p ? '' : parent;
    out.dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name.toLowerCase() !== 'system volume information')
      .map(e => e.name)
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
      .slice(0, 500);
  } catch {
    out.dirs = [];
    out.error = '폴더를 읽을 수 없습니다';
  }
  return out;
}

const badRel = rel => rel.split('/').some(s => !s || s === '.' || s === '..' || /^[A-Za-z]:/.test(s));

/** payload 적용(동기). 결과 객체를 반환한다. */
function apply(payload, { env = process.env, home = os.homedir() } = {}) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload가 올바르지 않습니다' };
  const lh = launcherHome(env);
  const res = {
    ok: true, platform: process.platform, launcherHome: lh, userHome: home, node: process.version,
    claude: null, git: false, pathExists: null, written: 0, sessionFile: null, keyWritten: false, claudeMd: null, list: null,
  };
  const fail = msg => ({ ok: false, error: msg });

  // 1) 파일: 전부 먼저 검사(하나라도 잘못되면 아무것도 쓰지 않음). rel은 '/' 구분, 역슬래시·..·절대 경로 금지.
  const roots = { launcher: lh, claude: path.join(home, '.claude') };
  const files = Array.isArray(payload.files) ? payload.files : [];
  for (const f of files) {
    if (!f || typeof f !== 'object' || !roots[f.root] || typeof f.rel !== 'string' || !f.rel
      || f.rel.includes('\\') || badRel(f.rel) || typeof f.b64 !== 'string') {
      return fail(`보낼 파일 경로가 올바르지 않습니다: ${(f && f.rel) || '(없음)'}`);
    }
  }
  for (const f of files) {
    const dst = path.join(roots[f.root], ...f.rel.split('/'));
    const data = Buffer.from(f.b64, 'base64');
    let cur = null;
    try { cur = fs.readFileSync(dst); } catch { /* 새 파일 */ }
    if (cur && cur.equals(data)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    res.written++;
  }

  // 2) 세션 JSON: keyFile은 원격 경로로 채우고 glmConfigDir는 뺀다(시작기가 원격 기본값을 쓰게).
  if (payload.session != null) {
    const s = payload.session;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[a-z0-9]{4,16}$/.test(s.id)) {
      return fail('세션 id가 올바르지 않습니다');
    }
    const copy = { ...s, keyFile: path.join(lh, 'zai-key.txt'), writtenAt: Date.now() };
    delete copy.glmConfigDir;
    const dir = path.join(lh, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${s.id}.json`);
    fs.writeFileSync(file, JSON.stringify(copy, null, 2));
    res.sessionFile = file;
  }

  // 3) z.ai 키: <런처 홈>\zai-key.txt에 plain: 형식. 키 값은 어디에도 출력하지 않는다.
  const keyFile = path.join(lh, 'zai-key.txt');
  if (typeof payload.key === 'string' && payload.key) {
    const want = `plain:${payload.key}`;
    if (readText(keyFile) !== want) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, want);
      res.keyWritten = true;
      if (IS_WIN) {
        try { spawnSync('icacls', [keyFile, '/inheritance:r', '/grant:r', `${env.USERNAME || os.userInfo().username}:F`], { windowsHide: true }); } catch { /* 무시 */ }
      } else {
        try { fs.chmodSync(keyFile, 0o600); } catch { /* 무시 */ }
      }
    }
  }

  // 4) CLAUDE.md 런처 영역
  if (payload.claudeMd && typeof payload.claudeMd.text === 'string') {
    res.claudeMd = applyClaudeMd(path.join(home, '.claude', 'CLAUDE.md'), payload.claudeMd.text) ? 'applied' : 'unchanged';
  }

  // 5) 폴더 점검·도구 탐색·목록
  if (typeof payload.checkPath === 'string' && payload.checkPath) {
    try { res.pathExists = fs.statSync(payload.checkPath).isDirectory(); } catch { res.pathExists = false; }
  }
  res.claude = findClaude(env, home);
  res.git = whereList('git').length > 0;
  if (typeof payload.listPath === 'string') res.list = listDir(payload.listPath);
  return res;
}

// ───────── 실행부: node - 로 실행될 때만 동작 ─────────
if (globalThis.__CL_PAYLOAD__ !== undefined) {
  process.stdout.on('error', () => {}); // 연결이 먼저 끊겨도 처리되지 않은 오류로 터지지 않게
  try {
    process.stdout.write(`${MARK}${JSON.stringify(apply(globalThis.__CL_PAYLOAD__))}\n`);
  } catch (e) {
    process.stdout.write(`${MARK}${JSON.stringify({ ok: false, error: String((e && e.message) || e) })}\n`);
  }
}
if (typeof module !== 'undefined') module.exports = { apply, launcherHome };
