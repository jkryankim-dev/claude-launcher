'use strict';
// GLM 위임 실행 기록 읽기: <저장소>/.glm/runs/<runId>/ 폴더에서 목록·상세를 만든다 (Electron 의존 없음).
// 폴더 이름·파일 형식은 skills/glm-delegate/scripts/glm-run.mjs가 실제로 쓰는 그대로다.
//
// ── 실행마다 남는 파일(glm-run.mjs cmdRun/launchWorker/runVerify) ──
//  meta.json    실행 메타. 임시 파일 쓰기+이름 바꾸기로 원자적 기록(읽을 때 깨진 것은 무시하면 된다).
//               주요 필드: id, parent(이어받은 원 실행 id|null), children[후속 실행 id], title,
//               spec(명세 경로, 저장소 상대 '/' 구분자), root/cwd('/' 구분자),
//               cfg{role('edit'|'scan'),model,effort,maxTurns,timeoutMin,scope,verify,allowBash,reportLines},
//               pid(glm-run 프로세스), childPid(작업자 claude), startedAt/endedAt(ISO),
//               status('running'→'done'|'failed'|'interrupted'|'timeout'),
//               snapshot{tree,skipped}, sessionId, initModel, warnings[명세 머리말 경고],
//               progress{turns,files,lastTool,at}(실행 중 폴링마다, 최대 10초 늦음),
//               result{subtype,isError,turns,durationMs}, turns(최종 턴 수), retries, denials,
//               usage, rate, lastText, cause(끝내지 못한 이유 문장), exitCode,
//               changed{files[{path,add,del,st,oos,note}],outside,gitMode,partial}(종료 시 1회),
//               verify{ok,results[{cmd,code,ms,timedOut,tail}],shell}(검증을 돌린 경우만),
//               after{경로:sha1}, rolledBack{at,...}(되돌린 경우)
//  spec.md      메인 세션이 쓴 명세 원문(머리말 포함)
//  prompt.md    작업자에게 실제로 보낸 전체 프롬프트
//  settings.json 작업자 권한·공개 환경(비밀값 없음)
//  stream.jsonl 작업자(claude -p --output-format stream-json) 표준 출력을 줄별로 기록.
//               system(init/api_retry) · assistant(message.content: tool_use|text|thinking 블록) ·
//               user(message.content: tool_result 블록) · result(최종). 줄에 timestamp(ISO)가 있을 수 있다.
//  stderr.log   작업자 stderr · verify.log 검증 명령 출력 · report.md 작업자 최종 보고(있을 때만) ·
//  summary.txt  사람용 요약 · STOP 중단 요청 표시(내용=ISO 시각)
//
// ── state 판정(glm-run의 --status/--list와 같은 근거) ──
//  meta.status 'done'→done, 'failed'→failed, 'timeout'→timeout, 'interrupted'→stopped.
//  'running'은 meta.pid 프로세스가 살아 있어야 running, 죽었으면 stopped(비정상 종료).
//  메타가 없거나 깨졌거나 status를 모르면 unknown.
//  실행 중(또는 비정상 종료로 최종 값이 없는) 실행의 턴 수·마지막 동작은 meta.progress가 최대 10초 느리므로
//  stream.jsonl 끝 64KB에서 보강한다. 완료된 실행은 meta 값을 그대로 쓰고 mtime+size 키로 캐시한다.
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const TAIL_CHUNK = 64 * 1024;      // stream.jsonl 끝 읽기 단위
const STREAM_BUF = 256 * 1024;     // stream.jsonl 순차 스캔 단위
const TEXT_LIMIT = 60000;          // spec/prompt/report/verifyOutput 한도
const CACHE_MAX = 400;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

const cache = new Map(); // runDir 절대경로 → { runKey, run, detailKey, detail }

const fwd = p => String(p).replace(/\\/g, '/');
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** 방어적 비밀값 가림: sk-… 토큰과 Bearer … 값을 ***로 바꾼다. */
function maskSecrets(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9][A-Za-z0-9_-]{3,}/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, '***');
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const isRunId = s => typeof s === 'string' && RUN_ID_RE.test(s);
const isoMs = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function readJSON(file) { const t = readText(file); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }
function statKey(file) { try { const s = fs.statSync(file); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return '-'; } }

/** 파일 끝에서부터 뒤로 64KB씩 읽어 줄(오래된→최신)을 모은다. 창 시작의 잘린 첫 줄은 버린다. */
function readTailLines(file, minLines) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (!size) return [];
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let end = size, nl = 0;
    while (end > 0) {
      const len = Math.min(TAIL_CHUNK, end);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, end - len);
      chunks.unshift(buf);
      for (let i = 0; i < len; i++) if (buf[i] === 0x0a) nl++;
      end -= len;
      if (nl >= minLines + 1) break; // +1: 창 첫 줄이 잘려 버려질 분
    }
    let lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 끝 개행 뒤 빈줄
    if (end > 0 && lines.length) lines.shift();                      // 파일 시작이 아니면 첫 줄은 잘린 조각
    return lines.map(l => l.replace(/\r$/, ''));
  } catch { return []; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 없음 */ } } }
}

/** 파일 끝 n바이트를 문자열로(첫 줄이 잘리면 그 줄은 버린다). 로그처럼 긴 파일용. */
function readTailText(file, n) {
  try {
    const size = fs.statSync(file).size;
    if (size <= n) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(n);
      fs.readSync(fd, buf, 0, n, size - n);
      const s = buf.toString('utf8');
      const i = s.indexOf('\n');
      return i < 0 ? '' : s.slice(i + 1);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** stream.jsonl 전체를 순차 스캔(통째로 메모리에 올리지 않고)해 줄별 JSON을 onLine에 넘긴다. */
function scanStream(file, onLine) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let rem = '';
    const buf = Buffer.allocUnsafe(STREAM_BUF);
    for (;;) {
      const r = fs.readSync(fd, buf, 0, STREAM_BUF, null);
      if (r <= 0) break;
      rem += buf.toString('utf8', 0, r);
      const parts = rem.split('\n');
      rem = parts.pop();
      for (const l of parts) {
        const s = l.replace(/\r$/, '');
        if (!s.trim()) continue;
        let ev; try { ev = JSON.parse(s); } catch { continue; }
        onLine(ev);
      }
    }
    if (rem.trim()) { let ev; try { ev = JSON.parse(rem.replace(/\r$/, '')); } catch { ev = null; } if (ev) onLine(ev); }
  } catch { /* 없거나 읽는 중 사라짐 */ } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 없음 */ } } }
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* 쓰는 중 잘렸거나 깨진 줄 */ }
  }
  return out;
}

/** 작업자 cwd 기준 짧은 경로(저장소 밖 경로는 그대로). glm-run의 shortPath와 같은 규칙. */
function shortPath(base, p) {
  if (!base || typeof base !== 'string') return fwd(p);
  let r;
  try { r = path.relative(base, String(p)); } catch { return fwd(p); }
  return !r || r.startsWith('..') || path.isAbsolute(r) ? fwd(p) : fwd(r);
}
/** 절대 경로를 저장소 상대('/')로. git-bash 스타일('/c/x')도 받아 들인다. 밖이면 그대로. */
function toRel(root, p) {
  let s = String(p || '');
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (m) s = `${m[1]}:/${m[2]}`;
  let r;
  try { r = path.relative(path.resolve(root), path.resolve(root, s)); } catch { return fwd(s); }
  return !r || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r) ? fwd(s) : fwd(r);
}
const toolText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && typeof b === 'object' && b.type === 'text').map(b => b.text).join('\n') : '');

/** 도구 사용 한 줄 요약 — glm-run의 lastTool과 같은 규칙(파일 경로>명령(60)>패턴(40)), 80자 이내. */
function toolSummary(name, input, base) {
  const i = input && typeof input === 'object' ? input : {};
  const fp = i.file_path || i.notebook_path;
  const tail = fp ? shortPath(base, fp) : i.command ? clip(i.command, 60) : i.pattern ? clip(i.pattern, 40) : '';
  return cut(maskSecrets(`${name}${tail ? ' ' + tail : ''}`), 80);
}

/** stream-json 이벤트 모음에서 활동(Act)·턴 수·마지막 도구·편집 파일을 뽑는다. */
function scanEvents(events, baseDir) {
  const toolById = new Map();
  const msgIds = new Set();
  const acts = [];
  const edited = [];
  let lastTool = '';
  const tsOf = ev => { const t = Date.parse(ev && ev.timestamp); return Number.isFinite(t) ? t : null; };
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      if (ev.message.id) msgIds.add(ev.message.id);
      for (const b of ev.message.content || []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') {
          const name = String(b.name || '');
          toolById.set(b.id, name);
          lastTool = toolSummary(name, b.input, baseDir);
          acts.push({ ts: tsOf(ev), kind: 'tool', tool: name, summary: lastTool, text: '' });
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && EDIT_TOOLS.test(name)) edited.push(fp);
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          acts.push({ ts: tsOf(ev), kind: 'text', tool: '', summary: '', text: cut(maskSecrets(b.text.trim()), 300) });
        } // thinking 블록은 활동에서 제외
      }
    } else if (ev.type === 'user' && ev.message && typeof ev.message === 'object' && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b && typeof b === 'object' && b.type === 'tool_result' && b.is_error) {
          const name = toolById.get(b.tool_use_id) || '';
          const text = maskSecrets(toolText(b.content).trim());
          acts.push({ ts: tsOf(ev), kind: 'error', tool: name, summary: cut(`${name || '도구'} 오류${text ? `: ${clip(text, 60)}` : ''}`, 80), text: cut(text, 300) });
        }
      }
    } else if (ev.type === 'result') {
      const t = typeof ev.result === 'string' ? ev.result : '';
      for (const d of Array.isArray(ev.permission_denials) ? ev.permission_denials : []) {
        const tool = String((d && d.tool_name) || '');
        const input = (d && d.tool_input && (d.tool_input.command || d.tool_input.file_path)) || '';
        acts.push({ ts: tsOf(ev), kind: 'error', tool, summary: cut(maskSecrets(`${tool || '도구'} 권한 거부${input ? `: ${clip(input, 60)}` : ''}`), 80), text: '' });
      }
      acts.push({ ts: tsOf(ev), kind: 'result', tool: '', summary: `result ${ev.subtype || ''}${ev.is_error ? ' · 오류' : ''}`.trim(), text: cut(maskSecrets(t), 300) });
    }
  }
  return { acts, turns: msgIds.size, lastTool, edited };
}

/** persona: 아직 meta에 없는 필드. 메타(persona 또는 cfg.persona) → 명세 머리말 순으로 찾는다. */
function personaOf(meta, specRaw) {
  const v = meta && typeof meta === 'object' ? (meta.persona ?? (meta.cfg && meta.cfg.persona)) : null;
  if (v != null && String(v).trim()) return cut(maskSecrets(String(v).trim()), 80);
  const text = String(specRaw ?? '').split(String.fromCharCode(0xfeff)).join(''); // 선행 BOM 제거
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv && kv[1].toLowerCase() === 'persona') {
      let s = kv[2].trim();
      if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1);
      s = s.trim();
      return s ? cut(maskSecrets(s), 80) : null;
    }
  }
  return null;
}

function stateOf(meta) {
  if (!meta || typeof meta !== 'object') return 'unknown';
  switch (meta.status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'interrupted': return 'stopped';
    case 'timeout': return 'timeout';
    case 'running': return pidAlive(meta.pid) ? 'running' : 'stopped';
    default: return 'unknown';
  }
}
const isTerminal = meta => !!meta && ['done', 'failed', 'interrupted', 'timeout'].includes(meta.status);

/**
 * 실행 한 건의 Run을 만든다. 완료된 실행은 meta 값을 우선 쓰고,
 * 최종 값이 없는(실행 중·비정상 종료·빠른 종료) 것만 stream.jsonl 끝 64KB을 읽어 보강한다.
 */
function buildRun(runDir, id, projectPath, meta, specRaw) {
  if (specRaw === undefined) specRaw = readText(path.join(runDir, 'spec.md'));
  const cfg = meta && meta.cfg && typeof meta.cfg === 'object' ? meta.cfg : {};
  const state = stateOf(meta);
  const startedAt = meta ? isoMs(meta.startedAt) : null;
  const endedAt = meta ? isoMs(meta.endedAt) : null;
  const base = typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : projectPath;
  const streamPath = path.join(runDir, 'stream.jsonl');
  let tail = null;
  const getTail = () => (tail ??= scanEvents(parseLines(readTailLines(streamPath, 40)), base));

  let turns = Number.isFinite(meta?.turns) ? meta.turns : null;
  let lastAction = '';
  if (state === 'running' || state === 'stopped') {
    const t = getTail();
    const pt = meta?.progress && meta.progress.lastTool;
    lastAction = t.lastTool || (pt ? cut(maskSecrets(String(pt)), 80) : '');
    if (turns == null) turns = Math.max(meta?.progress?.turns || 0, t.turns);
  } else if (meta) {
    const pt = meta.progress && meta.progress.lastTool;
    lastAction = pt ? cut(maskSecrets(String(pt)), 80) : '';
    if (!lastAction || turns == null) {
      const t = getTail();
      if (!lastAction) lastAction = t.lastTool;
      if (turns == null) turns = Math.max(meta.progress?.turns || 0, t.turns);
    }
  } else {
    const t = getTail(); // 메타가 없어도 stream 끝으로 최소한의 정보를 채운다
    lastAction = t.lastTool;
    turns = t.turns;
  }
  const editedFiles = meta?.changed && Array.isArray(meta.changed.files)
    ? meta.changed.files.length
    : (meta?.progress?.files ?? 0);
  return {
    id,
    title: cut(maskSecrets(meta?.title || ''), 120),
    role: cfg.role === 'edit' || cfg.role === 'scan' ? cfg.role : null,
    persona: personaOf(meta, specRaw),
    model: (meta?.initModel || cfg.model) || null,
    effort: cfg.effort || null,
    state,
    startedAt,
    endedAt,
    elapsedMs: startedAt != null ? Math.max(0, (endedAt ?? Date.now()) - startedAt) : null,
    turns: turns ?? 0,
    editedFiles,
    lastAction,
    verify: meta?.verify ? (meta.verify.ok ? 'pass' : 'fail') : null,
    resumeOf: meta?.parent || null,
    specPath: meta?.spec || null,
  };
}

function setCache(runDir, patch) {
  let c = cache.get(runDir);
  if (!c) {
    if (cache.size >= CACHE_MAX) { const k = cache.keys().next().value; if (k !== undefined) cache.delete(k); }
    c = {};
    cache.set(runDir, c);
  }
  Object.assign(c, patch);
}
function limitText(s, label, warnings) {
  s = maskSecrets(String(s ?? ''));
  if (s.length > TEXT_LIMIT) {
    warnings.push(`${label} 원문이 ${TEXT_LIMIT.toLocaleString('en-US')}자를 넘어 앞부분만 표시합니다`);
    return s.slice(0, TEXT_LIMIT);
  }
  return s;
}

/** 최신순 실행 목록. stream 전체를 읽지 않는다(메타 우선, 모자란 값만 끝 64KB). */
async function listRuns(projectPath, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 30;
  const dir = path.join(String(projectPath || ''), '.glm', 'runs');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const ids = entries.filter(e => e.isDirectory() && isRunId(e.name)).map(e => e.name).sort().reverse().slice(0, limit);
  const runs = [];
  for (const id of ids) {
    const runDir = path.join(dir, id);
    const meta = readJSON(path.join(runDir, 'meta.json'));
    if (!isTerminal(meta)) cache.delete(runDir); // 진행 중·깨진 실행은 캐시하지 않는다
    else {
      const key = `${statKey(path.join(runDir, 'meta.json'))}|${statKey(path.join(runDir, 'spec.md'))}`;
      const c = cache.get(runDir);
      if (c && c.runKey === key) { runs.push(c.run); continue; }
      const run = buildRun(runDir, id, projectPath, meta);
      setCache(runDir, { runKey: key, run });
      runs.push(run);
      continue;
    }
    runs.push(buildRun(runDir, id, projectPath, meta));
  }
  return runs;
}

/** 실행 상세. runId 형식 검증으로 경로 탈출을 막고, 없는 실행이면 null. */
async function readRun(projectPath, runId, opts = {}) {
  if (!isRunId(runId)) return null;
  const activityLimit = Number.isInteger(opts.activityLimit) && opts.activityLimit >= 0 ? opts.activityLimit : 60;
  const runDir = path.join(String(projectPath || ''), '.glm', 'runs', runId);
  try { if (!fs.statSync(runDir).isDirectory()) return null; } catch { return null; }

  const names = ['meta.json', 'spec.md', 'prompt.md', 'report.md', 'verify.log', 'stream.jsonl'];
  const detailKey = `${names.map(n => statKey(path.join(runDir, n))).join('|')}|a${activityLimit}`;
  const meta = readJSON(path.join(runDir, 'meta.json'));
  if (!isTerminal(meta)) cache.delete(runDir);
  else {
    const c = cache.get(runDir);
    if (c && c.detailKey === detailKey) return c.detail;
  }

  const warnings = Array.isArray(meta?.warnings) ? meta.warnings.map(String) : [];
  if (!meta) warnings.push('meta.json이 없거나 해석할 수 없습니다');
  const specRaw = readText(path.join(runDir, 'spec.md'));
  const run = buildRun(runDir, runId, projectPath, meta, specRaw);
  const base = typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : projectPath;
  const streamPath = path.join(runDir, 'stream.jsonl');

  let activity = [];
  try {
    fs.statSync(streamPath);
    const min = Math.max(activityLimit * 3, activityLimit + 20); // act로 안 이어지는 줄(tool_result 등)의 여유
    const scanned = scanEvents(parseLines(readTailLines(streamPath, min)), base);
    activity = scanned.acts.length > activityLimit ? scanned.acts.slice(scanned.acts.length - activityLimit) : scanned.acts;
  } catch { /* stream 없음 */ }

  let files;
  if (meta?.changed && Array.isArray(meta.changed.files)) {
    files = meta.changed.files.map(f => (f && f.path != null ? String(f.path) : '')).filter(Boolean);
  } else {
    const root = typeof meta?.root === 'string' && meta.root ? meta.root : projectPath;
    const set = new Set();
    scanStream(streamPath, ev => {
      if (!ev || ev.type !== 'assistant' || !ev.message || typeof ev.message !== 'object') return;
      for (const b of ev.message.content || []) {
        if (b && typeof b === 'object' && b.type === 'tool_use' && EDIT_TOOLS.test(String(b.name || ''))) {
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp) set.add(toRel(root, fp));
        }
      }
    });
    files = [...set].sort();
  }

  let verifyOutput = null;
  const vlog = path.join(runDir, 'verify.log');
  try {
    const st = fs.statSync(vlog);
    verifyOutput = st.size > TEXT_LIMIT
      ? (warnings.push(`검증 로그이 ${TEXT_LIMIT.toLocaleString('en-US')}자를 넘어 뒷부분만 표시합니다`), readTailText(vlog, TEXT_LIMIT))
      : readText(vlog) ?? '';
  } catch { /* 검증 없음 */ }

  const reportRaw = readText(path.join(runDir, 'report.md'));
  const detail = {
    ...run,
    spec: limitText(specRaw ?? '', '명세(spec.md)', warnings),
    prompt: limitText(readText(path.join(runDir, 'prompt.md')) ?? '', '프롬프트(prompt.md)', warnings),
    report: reportRaw == null ? null : limitText(reportRaw, '보고(report.md)', warnings),
    activity,
    files,
    verifyOutput,
    warnings: warnings.map(maskSecrets),
  };
  if (isTerminal(meta)) setCache(runDir, { detailKey, detail });
  return detail;
}

/** .glm/runs 아래 변화를 디바운스해 알린다. fs.watch(recursive)가 안 되면 2초 폴링으로 대체하고,
 *  runs 폴더가 아직 없을 때도 돌다가 생기면 감시로 올린다. close 뒤에는 onChange가 불리지 않는다. */
function watchRuns(projectPath, onChange, opts = {}) {
  const runsDir = path.join(String(projectPath || ''), '.glm', 'runs');
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const debounceMs = Math.max(0, num(opts.debounceMs ?? opts.debounce, 500));
  const pollMs = Math.max(200, num(opts.pollMs, 2000));
  let closed = false, timer = null, poller = null, watcher = null, lastSig;

  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!closed) onChange(); }, debounceMs);
    timer.unref();
  };
  const stopPoll = () => { if (poller) { clearInterval(poller); poller = null; } };
  const stopWatch = () => { if (watcher) { const w = watcher; watcher = null; try { w.close(); } catch { /* 이미 닫힘 */ } } };
  const signature = () => {
    let entries;
    try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return null; }
    const parts = [];
    for (const e of entries) {
      parts.push(e.name);
      if (!e.isDirectory()) continue;
      const d = path.join(runsDir, e.name);
      parts.push(statKey(d), statKey(path.join(d, 'meta.json')), statKey(path.join(d, 'stream.jsonl')));
    }
    return parts.join('|');
  };
  const startPoll = baseline => {
    if (poller || closed) return;
    if (baseline) lastSig = signature();
    poller = setInterval(() => {
      if (closed) return stopPoll();
      const s = signature();
      if (s === lastSig) return;
      const wasAbsent = lastSig === null;
      lastSig = s;
      fire();
      if (wasAbsent && s !== null) tryWatch(); // runs 폴더가 새로 생겼으면 감시로 올린다
    }, pollMs);
    poller.unref();
  };
  const tryWatch = () => {
    if (closed || watcher) return;
    try {
      watcher = fs.watch(runsDir, { recursive: true }, () => fire());
      watcher.on('error', () => { stopWatch(); lastSig = signature(); startPoll(false); });
      stopPoll();
    } catch { startPoll(true); }
  };
  let exists = false;
  try { exists = fs.statSync(runsDir).isDirectory(); } catch { /* 아직 없음 */ }
  if (exists) tryWatch();
  else { lastSig = null; startPoll(false); }

  return {
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      stopPoll();
      stopWatch();
    },
  };
}

module.exports = { listRuns, readRun, watchRuns, isRunId };
