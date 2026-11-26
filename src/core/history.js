'use strict';
// Claude Code 대화 기록 읽기: <configDir>/projects/<인코딩된 폴더명>/<sessionId>.jsonl에서
// 폴더별 세션 목록·대화 내용·검색을 뽑는다(Electron 없이 도는 순수 Node 모듈).
// - 줄 단위 스트리밍(readline + createReadStream)으로 읽고 전체를 메모리에 올리지 않는다.
// - 큰 줄(api-request 등)은 값싼 문자열 검사로 걸러 JSON.parse를 피한다("type"이 줄 앞에 없어도 찾는다).
// - 파일별 요약은 file+mtime+size 키로 캐시해 바뀐 파일만 다시 읽는다.
// - 모르는 type·깨진 줄(쓰다 만 마지막 줄 포함)은 조용히 무시한다(앞으로 늘어날 type에 대비).
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
// 파싱할 가치가 있는 줄만 통과시키는 값싼 필터. 키 순서·콜론 앞뒤 공백과 무관하게 찾는다.
const LINE_RE = /"type"\s*:\s*"(?:user|assistant|ai-title|custom-title|summary)"/;
const CWD_RE = /"cwd"\s*:/;
// 사용자 글에 하네스가 심어 넣는 꼬리표(여러 줄 가능). 여는·닫는 태그 이름이 같은 것만 짝지어 뗀다.
const BLOCK_RE = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification)>[\s\S]*?<\/\1>/g;
const CMD_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const CMD_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
// tool_use input에서 대표 값으로 쓸 키의 우선순위
const SUMMARY_KEYS = ['file_path', 'command', 'pattern', 'description', 'prompt', 'url', 'skill', 'query'];
const CACHE_MAX = 500;

const cache = new Map(); // file → { mtimeMs, size, s }
let reads = 0; // 파일을 실제로 연 횟수(캐시 검증용)

/** 프로젝트 경로 → Claude Code의 projects 폴더명. 영숫자가 아닌 문자(한글·공백 등)는 글자마다 '-' */
const encodeProjectDir = p => String(p || '').replace(/[^A-Za-z0-9]/g, '-');

/** configDir 안에서 이 프로젝트의 기록 폴더 경로 */
const projectDir = (configDir, projectPath) => path.join(String(configDir || ''), 'projects', encodeProjectDir(projectPath));

/** 표시용 글 다듬기: 꼬리표를 떼고, 꼬리표만 남은 command 글은 '/foo args'로 복원한다. */
function cleanText(s) {
  if (typeof s !== 'string') return '';
  const name = CMD_NAME_RE.exec(s);
  const args = CMD_ARGS_RE.exec(s);
  const out = s.replace(BLOCK_RE, '').trim();
  if (out || !name) return out;
  const n = name[1].trim();
  const a = args ? args[1].replace(/\s+/g, ' ').trim() : '';
  return (n.startsWith('/') ? n : `/${n}`) + (a ? ` ${a}` : '');
}

const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();

/** 제목·요약용 자르기: 코드포인트 기준으로 n자 이내로 잘라 '…'를 붙인다. */
function clip(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  const cps = Array.from(t);
  if (cps.length <= n) return t;
  return cps.slice(0, n - 1).join('') + '…';
}

/** 대화 한 통의 text 자르기: 20,000자를 넘으면 자르고 '…(생략)'을 붙인다. */
function clipMsg(s) {
  const t = String(s || '');
  if (t.length <= 20000) return t;
  const cps = Array.from(t);
  if (cps.length <= 20000) return t;
  return cps.slice(0, 20000).join('') + '…(생략)';
}

function parseLine(l) {
  if (!l) return null;
  try { const o = JSON.parse(l); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** 줄을 스트리밍으로 읽어 onLine에 넘긴다. onLine이 false를 돌려주면 읽기를 끊는다.
 *  파일이 사라지거나 잠겨도 reject하지 않고 그대로 끝난다(부분 결과 사용). */
function readLines(file, onLine) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let stream = null;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { finish(); return; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    rl.on('line', l => {
      if (done) return;
      if (first) { first = false; if (l.charCodeAt(0) === 0xfeff) l = l.slice(1); } // UTF-8 BOM
      let stop = false;
      try { stop = onLine(l) === false; } catch { /* 한 줄이 실패해도 나머지는 계속 */ }
      if (stop) {
        try { stream.destroy(); } catch { /* 이미 닫힘 */ }
        rl.close();
        finish();
      }
    });
    rl.on('close', finish);
    rl.on('error', () => finish()); // 입력 스트림 오류가 인터페이스로 넘어온다(리스너가 없으면 처리되지 않은 예외가 된다)
    stream.on('error', () => { try { stream.destroy(); } catch { /* 이미 닫힘 */ } finish(); });
  });
}

/** 사용자 글 본문: 문자열 그대로, 배열은 text·image 블록만(tool_result는 무시). 꼬리표를 뗀 결과. */
function userText(content) {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text);
    else if (b.type === 'image') parts.push('[이미지]');
  }
  return cleanText(parts.join('\n'));
}

/** tool_use input에서 대표 값 하나: 정해진 키 순서로 첫 문자열 값을 120자 이내로. */
function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(tidy(v), 120);
  }
  return '';
}

/** 어시스턴트 줄에서 text 블록과 tool_use 목록. thinking 등 다른 블록은 버린다. */
function assistantParts(content) {
  const texts = [], tools = [];
  if (typeof content === 'string') { if (content.trim()) texts.push(content); return { texts, tools }; }
  if (!Array.isArray(content)) return { texts, tools };
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string' && b.name) tools.push({ name: b.name, summary: toolSummary(b.input) });
  }
  return { texts, tools };
}

/** 대화 줄을 Msg로 만든다. 같은 응답(다음 줄의 parentUuid가 앞 줄 uuid이고 사이에 사용자 글이 없음)은 하나로 합친다.
 *  parentUuid 사슬이 끊기면(사용자 글·건너뛴 줄 지남) 이전 응답을 확정하고 새 Msg를 시작한다. */
function createBuilder(onMsg) {
  let cur = null; // 합칠 수 있어 잠시 모아 두는 어시스턴트 Msg
  let lastUuid = null; // 마지막으로 본 어시스턴트 줄의 uuid(합침 판정)
  const flush = () => {
    if (!cur) return;
    onMsg({ role: 'assistant', text: clipMsg(cur.parts.join('\n\n')), tools: cur.tools, ts: cur.ts, model: cur.model });
    cur = null;
  };
  return {
    push(o) {
      const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
      if (o.type === 'user') {
        const t = clipMsg(userText(o.message && o.message.content));
        if (!t) return; // tool_result뿐이거나 꼬리표만 있는 글
        flush();
        onMsg({ role: 'user', text: t, tools: [], ts, model: null });
        return;
      }
      const m = o.message && typeof o.message === 'object' ? o.message : {};
      const { texts, tools } = assistantParts(m.content);
      if (cur && o.parentUuid && o.parentUuid === lastUuid) {
        for (const t of texts) cur.parts.push(t);
        for (const t of tools) cur.tools.push(t);
      } else {
        flush(); // 내용 없는 줄로 시작하는 새 응답도 이전 응답을 확정짓는다
        if (texts.length || tools.length) cur = { parts: texts.slice(), tools, ts, model: typeof m.model === 'string' ? m.model : null };
      }
      lastUuid = typeof o.uuid === 'string' && o.uuid ? o.uuid : null;
    },
    end() { flush(); },
  };
}

/** 폴더 안의 세션 파일(`<uuid>.jsonl`만)을 mtime 내림차순으로. 하위 폴더·agent-*.jsonl은 무시. */
function listFiles(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !SESSION_FILE_RE.test(e.name)) continue;
    const file = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({ id: e.name.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs, size: st.size });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 세션 하나를 훑어 목록용 요약을 만든다(제목·첫 글·줄 수·시간·모델만 남긴다). */
async function scanSession(file) {
  const s = {
    cwd: undefined, customTitle: '', aiTitle: '', summary: '', firstUser: '',
    messages: 0, model: null, branch: '', entrypoint: undefined, startedAt: null, updatedAt: null,
  };
  let needCwd = true; // cwd는 어떤 줄에 있어도 좋다: 처음 만나는 값으로 폴더를 확인한다
  const builder = createBuilder(m => { s.messages++; if (!s.firstUser && m.role === 'user') s.firstUser = m.text; });
  await readLines(file, line => {
    if (!LINE_RE.test(line) && !(needCwd && CWD_RE.test(line))) return;
    const o = parseLine(line);
    if (!o) return;
    if (needCwd && typeof o.cwd === 'string') { s.cwd = o.cwd; needCwd = false; }
    const t = o.type;
    if (t === 'ai-title') { if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) s.aiTitle = o.aiTitle; return; }
    if (t === 'custom-title') { if (typeof o.customTitle === 'string' && o.customTitle.trim()) s.customTitle = o.customTitle; return; }
    if (t === 'summary') { if (typeof o.summary === 'string' && o.summary.trim()) s.summary = o.summary; return; }
    if (t !== 'user' && t !== 'assistant') return;
    if (o.isSidechain || o.isMeta) return;
    if (s.entrypoint === undefined && typeof o.entrypoint === 'string' && o.entrypoint) s.entrypoint = o.entrypoint;
    if (typeof o.timestamp === 'string' && o.timestamp) {
      if (!s.startedAt) s.startedAt = o.timestamp;
      s.updatedAt = o.timestamp;
    }
    if (typeof o.gitBranch === 'string' && o.gitBranch) s.branch = o.gitBranch;
    if (t === 'assistant' && o.message && typeof o.message.model === 'string' && o.message.model) s.model = o.message.model;
    builder.push(o);
  });
  builder.end();
  return s;
}

/** 요약 캐시: file+mtime+size가 같으면 다시 읽지 않는다. */
async function summaryOf(f) {
  const c = cache.get(f.file);
  if (c && c.mtimeMs === f.mtimeMs && c.size === f.size) return c.s;
  reads++;
  const s = await scanSession(f.file);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // 오래된 것부터 비운다
  cache.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, s });
  return s;
}

// 'cli'는 터미널, 'sdk-ts'는 런처 채팅(Agent SDK)으로 한 대화다. 그 밖(claude -p 등)만 화면 없는 실행으로 본다.
const INTERACTIVE_ENTRY = new Set(['cli', 'sdk-ts']);
const isHeadless = s => !!s.entrypoint && !INTERACTIVE_ENTRY.has(s.entrypoint);

/** Windows에서는 대소문자·'/' '\'·끝 구분자 차이를 무시하고 폴더를 비교. */
function sameCwd(a, b) {
  const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a), y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function makeSession(f, s) {
  const mtimeISO = new Date(f.mtimeMs).toISOString();
  const first = tidy(s.firstUser);
  const base = s.customTitle || s.aiTitle || s.summary || first; // custom-title > ai-title > summary > 첫 사용자 글
  return {
    id: f.id,
    file: f.file,
    title: clip(tidy(base), 80),
    firstPrompt: clip(first, 200),
    startedAt: s.startedAt || mtimeISO,
    updatedAt: s.updatedAt || mtimeISO,
    messages: s.messages,
    model: s.model || null,
    branch: s.branch || null,
    entrypoint: s.entrypoint || null,
    headless: isHeadless(s),
    size: f.size,
  };
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

/** 폴더의 세션 목록. updatedAt 내림차순. mtime 내림차순으로 읽다가 limit을 채우면 멈춘다(걸러진 세션이 있으면 다음 파일을 더 읽는다). */
async function listSessions(configDir, projectPath, opts = {}) {
  const limit = num(opts.limit, 50);
  const includeHeadless = opts.includeHeadless === true;
  const files = listFiles(projectDir(configDir, projectPath));
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const s = await summaryOf(f);
    if (!s.firstUser) continue; // 사용자 글이 하나도 없는 세션(빈 세션·꼬리표뿐)
    if (s.cwd !== undefined && !sameCwd(s.cwd, projectPath)) continue; // 같은 인코딩 폴더에 섞인 다른 폴더의 세션
    if (!includeHeadless && isHeadless(s)) continue; // claude -p 작업자 등
    out.push(makeSession(f, s));
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

/** 세션 하나의 대화. tail이면 마지막 limit개, 아니면 처음 limit개. total은 전체 Msg 수. */
async function readTranscript(file, opts = {}) {
  const limit = num(opts.limit, 400);
  const tail = opts.tail !== false;
  const messages = [];
  let total = 0;
  const builder = createBuilder(m => {
    total++;
    if (tail) { messages.push(m); if (messages.length > limit) messages.shift(); }
    else if (messages.length < limit) messages.push(m);
  });
  await readLines(file, line => {
    if (!LINE_RE.test(line)) return;
    const o = parseLine(line);
    if (!o || (o.type !== 'user' && o.type !== 'assistant')) return;
    if (o.isSidechain || o.isMeta) return;
    builder.push(o);
  });
  builder.end();
  return { messages, total, truncated: total > messages.length };
}

/** 줄 하나에서 검색 대상 글(꼬리표를 뗀 사용자 글 / 어시스턴트 text 블록). */
function lineText(o) {
  const c = o.message && typeof o.message === 'object' ? o.message.content : null;
  if (o.type === 'user') return userText(c);
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text' && typeof b.text === 'string' && b.text).map(b => b.text).join('\n\n');
}

/** 일치 위치 앞뒤 60자. 잘린 쪽에만 '…'. */
function snippet(text, qLow) {
  const t = tidy(text);
  const i = t.toLowerCase().indexOf(qLow);
  if (i < 0) return clip(t, 120);
  const start = Math.max(0, i - 60), end = Math.min(t.length, i + qLow.length + 60);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

/** 파일에서 query와 처음으로 일치하는 Msg를 찾는다(찾는 순간 읽기를 끊는다). */
async function findInFile(file, q) {
  let hit = null;
  await readLines(file, line => {
    if (hit || !LINE_RE.test(line)) return;
    const o = parseLine(line);
    if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) return;
    const text = lineText(o);
    if (!text || !text.toLowerCase().includes(q)) return;
    hit = { role: o.type, snippet: snippet(text, q), ts: typeof o.timestamp === 'string' ? o.timestamp : null };
    return false;
  });
  return hit;
}

/** 제목·본문에서 찾기(대소문자 무시 부분 일치). 세션당 첫 일치 1건, updatedAt 내림차순. */
async function searchSessions(configDir, projectPath, query, opts = {}) {
  const q = String(query ?? '').toLowerCase();
  if (q.length < 2) return [];
  const limit = num(opts.limit, 30);
  const includeHeadless = opts.includeHeadless === true;
  const files = listFiles(projectDir(configDir, projectPath));
  const hits = [];
  for (const f of files) {
    if (hits.length >= limit) break;
    const s = await summaryOf(f);
    if (!s.firstUser) continue;
    if (s.cwd !== undefined && !sameCwd(s.cwd, projectPath)) continue;
    if (!includeHeadless && isHeadless(s)) continue;
    const ses = makeSession(f, s);
    if (ses.title.toLowerCase().includes(q)) {
      hits.push({ id: ses.id, title: ses.title, updatedAt: ses.updatedAt, role: 'title', snippet: snippet(ses.title, q), ts: ses.updatedAt });
      continue;
    }
    const hit = await findInFile(f.file, q);
    if (hit) hits.push({ id: ses.id, title: ses.title, updatedAt: ses.updatedAt, role: hit.role, snippet: hit.snippet, ts: hit.ts });
  }
  hits.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return hits;
}

function clearCache() { cache.clear(); reads = 0; }

module.exports = { encodeProjectDir, projectDir, listSessions, readTranscript, searchSessions, cleanText, clearCache, _readCount: () => reads };
