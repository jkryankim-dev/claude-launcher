'use strict';
// 런처 IPC 본문(대화 기록·GLM 실행 기록·스튜디오 조직도·채팅): main.js의 핸들러를 얇게 유지하는
// 검증·조립 계층. Electron 없이 도는 순수 Node 모듈이고 모든 의존(설정·history·runs·채팅 호스트·
// 스튜디오 도구·claude 실행 파일 찾기·키)은 주입받는다. 모든 메서드는 던지지 않고 { ok:false, error }를 돌려준다.
const fs = require('node:fs');
const path = require('node:path');
const { sessionData, isSessionId } = require('./launch');

const CHAT_ID_RE = /^c[0-9a-z]{8}$/;
const msg = e => String((e && e.message) || e || '').slice(0, 300);

function createBridge(deps) {
  const {
    getConfig,        // () => 설정 객체(projects·settings 포함)
    history,          // { listSessions, readTranscript, searchSessions, projectDir }
    runs,             // { listRuns, readRun, watchRuns, isRunId }
    chatHost,         // createChatHost() 결과
    getStudio,        // async () => { ensureStudio, validateOrg } (runtime/studio.mjs)
    getBuildChat,     // async () => buildChatSession (runtime/start-session.mjs)
    sessionExtra,     // (project) => 세션 부가 정보(keyFile·glmConfigDir 등)
    resolveClaudeExe, // () => SDK가 직접 띄울 수 있는 claude 경로 | null
    loadKey,          // () => 평문 z.ai 키(비밀값 — env로만 나간다)
    hasKey,           // () => boolean
    newChatId,        // () => 'c' + 랜덤 8자
    envBase,          // 채팅 환경의 바탕(정리된 process.env 사본)
    home,             // os.homedir()
    notifyRuns,       // ({ projectId }) => void — runs:changed 알림
    warn,             // (string) => void — 본 프로세스 경고 로그
    existsSync = fs.existsSync,
    watchOpts,        // watchRuns에 그대로 넘길 옵션(테스트용 디바운스 등)
  } = deps;

  const findProject = id => {
    const c = getConfig();
    return c && Array.isArray(c.projects) ? c.projects.find(p => p && p.id === id) || null : null;
  };
  /** 대화 기록 위치: glm 모드면 GLM 설정 폴더, 아니면 기본(CLAUDE_CONFIG_DIR 또는 ~/.claude) */
  const historyConfigDir = p => {
    if (p.mode === 'glm') {
      const c = getConfig();
      return (c.settings && c.settings.glmConfigDir) || path.join(home, '.claude-glm');
    }
    return envBase.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  };
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  // ── 대화 기록 ──
  async function historyList(projectId, opts = {}) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: true, remote: true, sessions: [] };
    try {
      const sessions = await history.listSessions(historyConfigDir(p), p.path, obj(opts));
      return { ok: true, remote: false, sessions: sessions.map(({ file, ...s }) => s) }; // 파일 절대 경로는 렌더러에 주지 않는다
    } catch (e) { return { ok: false, error: msg(e) }; }
  }
  async function historyRead(projectId, sessionId, opts = {}) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: false, error: '원격 프로젝트는 대화 기록을 읽을 수 없습니다' };
    if (!isSessionId(sessionId)) return { ok: false, error: '세션 id가 UUID 형식이 아닙니다' };
    try {
      const file = path.join(history.projectDir(historyConfigDir(p), p.path), `${sessionId}.jsonl`);
      if (!existsSync(file)) return { ok: false, error: '세션 기록 파일을 찾을 수 없습니다' };
      const r = await history.readTranscript(file, obj(opts));
      return { ok: true, messages: r.messages, total: r.total, truncated: r.truncated };
    } catch (e) { return { ok: false, error: msg(e) }; }
  }
  async function historySearch(projectId, query) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: true, hits: [] };
    try {
      return { ok: true, hits: await history.searchSessions(historyConfigDir(p), p.path, String(query ?? '')) };
    } catch (e) { return { ok: false, error: msg(e) }; }
  }

  // ── GLM 실행 기록 ──
  async function runsList(projectId) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: true, runs: [] }; // .glm/runs는 원격 폴더에 있다
    try { return { ok: true, runs: await runs.listRuns(p.path) }; } catch (e) { return { ok: false, error: msg(e) }; }
  }
  /** resume 사슬을 따라 올라가 맨 처음 실행을 찾는다(순환·끊긴 사슬에도 멈춘다) */
  async function rootRun(projectPath, firstParent) {
    const seen = new Set([firstParent]);
    let cur = firstParent;
    for (let depth = 0; depth < 10 && runs.isRunId(cur); depth++) {
      const r = await runs.readRun(projectPath, cur);
      if (!r) return null;
      if (!r.resumeOf || seen.has(r.resumeOf)) return r;
      seen.add(cur);
      cur = r.resumeOf;
    }
    return null;
  }
  async function runsRead(projectId, runId) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: true, run: null };
    if (!runs.isRunId(runId)) return { ok: false, error: '실행 id 형식이 올바르지 않습니다' };
    try {
      const run = await runs.readRun(p.path, runId);
      if (!run) return { ok: true, run: null };
      if (run.resumeOf) {
        const origin = await rootRun(p.path, run.resumeOf);
        if (origin) run.origin = { id: origin.id, title: origin.title, spec: origin.spec, prompt: origin.prompt };
      }
      return { ok: true, run };
    } catch (e) { return { ok: false, error: msg(e) }; }
  }
  const watchers = new Map(); // projectId → watchRuns 핸들
  function runsWatch(projectId) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (watchers.has(projectId) || p.remote) return { ok: true };
    try {
      watchers.set(projectId, runs.watchRuns(p.path, () => { if (notifyRuns) notifyRuns({ projectId }); }, watchOpts));
      return { ok: true };
    } catch (e) { return { ok: false, error: msg(e) }; }
  }
  function runsUnwatch(projectId) {
    const w = watchers.get(projectId);
    if (w) {
      watchers.delete(projectId);
      try { w.close(); } catch { /* 이미 닫힘 */ }
    }
    return { ok: true };
  }

  // ── 스튜디오 조직도 ──
  async function studioOrg(projectId) {
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    const enabled = !!(p.ext && p.ext.studio === true);
    if (!enabled || p.remote) return { ok: true, enabled, org: null, warnings: [] };
    let raw;
    try { raw = fs.readFileSync(path.join(p.path, '.studio', 'org.json'), 'utf8'); } catch { return { ok: true, enabled, org: null, warnings: [] }; }
    let org;
    try { org = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } // BOM 허용
    catch (e) { return { ok: true, enabled, org: null, error: `org.json을 해석하지 못했습니다: ${msg(e)}`, warnings: [] }; }
    let error = null;
    const warnings = [];
    try {
      const st = await getStudio();
      if (st && typeof st.validateOrg === 'function') {
        const v = st.validateOrg(org) || {};
        if (Array.isArray(v.errors) && v.errors.length) error = `조직도 오류 ${v.errors.length}건: ${v.errors.slice(0, 3).join(' · ')}`;
        if (Array.isArray(v.warnings)) warnings.push(...v.warnings);
      }
    } catch (e) { warn(`스튜디오 조직도 검증 실패: ${msg(e)}`); }
    return { ok: true, enabled, org, error, warnings };
  }

  // ── 채팅 ──
  const chatProject = new Map(); // chatId → projectId (chatList가 projectId를 채우는 데 쓴다)
  async function chatOpen(d) {
    const projectId = d && typeof d === 'object' ? d.projectId : null;
    const wantResume = d && typeof d === 'object' ? d.resume : undefined;
    const p = findProject(projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
    if (p.remote) return { ok: false, error: '원격 프로젝트는 채팅을 아직 지원하지 않습니다. 터미널로 여세요' };
    if (!existsSync(p.path)) return { ok: false, error: `폴더가 없습니다: ${p.path}` };
    let resume;
    if (wantResume !== undefined && wantResume !== null && wantResume !== '') {
      if (!isSessionId(wantResume)) return { ok: false, error: '이어하기 세션 id가 UUID 형식이 아닙니다' };
      resume = wantResume;
    }
    if (p.mode === 'glm' && !hasKey()) return { ok: false, error: 'GLM만 모드는 z.ai 키가 필요합니다. 설정에서 z.ai 키를 저장하세요' };
    if (p.ext && p.ext.studio === true) {
      try { const st = await getStudio(); await st.ensureStudio(p.path); } // 실패는 경고로만 — 채팅은 계속 연다
      catch (e) { warn(`스튜디오 조직도 심기 실패(${p.name}): ${msg(e)}`); }
    }
    let b;
    try {
      const buildChat = await getBuildChat();
      const extra = { ...sessionExtra(p) };
      if (resume) extra.resume = resume;
      // 키(비밀값)는 여기서 환경으로만 흘러 들어가고, 반환값·이벤트·로그에는 나가지 않는다.
      b = buildChat(sessionData(p, extra), { env: envBase, key: p.mode === 'glm' ? loadKey() : '', home });
    } catch (e) { return { ok: false, error: msg(e) }; }
    if (!b || b.error) return { ok: false, error: (b && b.error) || '채팅 세션을 만들지 못했습니다' };
    const claudePath = resolveClaudeExe();
    if (!claudePath) return { ok: false, error: 'claude 실행 파일을 찾을 수 없습니다. Claude Code(네이티브 설치)를 확인하세요' };
    const chatId = newChatId();
    let r;
    try {
      r = await chatHost.open({
        id: chatId, cwd: p.path, env: b.env, model: b.model, effort: b.effort, resume: b.resume || undefined,
        permissionMode: b.permissionMode || undefined, claudePath, extraArgs: b.extraArgs,
      });
    } catch (e) { return { ok: false, error: msg(e) }; }
    if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || '채팅 세션을 열지 못했습니다' };
    chatProject.set(chatId, p.id);
    return { ok: true, chatId };
  }
  const chatIdOk = id => CHAT_ID_RE.test(String(id || ''));
  function chatSend(chatId, d) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    const m = obj(d);
    return chatHost.send(chatId, { text: m.text, images: Array.isArray(m.images) ? m.images : undefined });
  }
  function chatRespond(chatId, requestId, answer) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    if (typeof requestId !== 'string' || !requestId) return { ok: false, error: '요청 id가 올바르지 않습니다' };
    return chatHost.respond(chatId, requestId, answer && typeof answer === 'object' ? answer : {});
  }
  function chatInterrupt(chatId) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    return chatHost.interrupt(chatId);
  }
  function chatClose(chatId) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    const closed = chatHost.close(chatId);
    chatProject.delete(chatId);
    return closed ? { ok: true } : { ok: false, error: '세션을 찾을 수 없습니다' };
  }
  async function chatSetModel(chatId, model) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    if (typeof model !== 'string' || !model.trim()) return { ok: false, error: '모델 이름이 올바르지 않습니다' };
    return chatHost.setModel(chatId, model.trim());
  }
  async function chatSetPermissionMode(chatId, mode) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다' };
    if (typeof mode !== 'string' || !mode.trim()) return { ok: false, error: '권한 모드가 올바르지 않습니다' };
    return chatHost.setPermissionMode(chatId, mode.trim());
  }
  async function chatCommands(chatId) {
    if (!chatIdOk(chatId)) return { ok: false, error: '채팅 id 형식이 올바르지 않습니다', commands: [] };
    try { return { ok: true, commands: await chatHost.commands(chatId) }; }
    catch (e) { return { ok: false, error: msg(e), commands: [] }; }
  }
  function chatList() {
    const live = chatHost.list();
    const ids = new Set(live.map(s => s.id));
    for (const id of [...chatProject.keys()]) if (!ids.has(id)) chatProject.delete(id); // 저절로 닫힌 세션 정리
    return { ok: true, chats: live.map(s => ({ ...s, projectId: chatProject.get(s.id) || null })) };
  }

  /** 앱 종료·창 닫힘: 모든 채팅 세션과 실행 기록 감시를 닫는다 */
  function closeAll() {
    try { chatHost.closeAll(); } catch { /* 이미 닫힘 */ }
    for (const id of [...watchers.keys()]) runsUnwatch(id);
  }

  return {
    historyList, historyRead, historySearch, runsList, runsRead, runsWatch, runsUnwatch,
    studioOrg, chatOpen, chatSend, chatRespond, chatInterrupt, chatClose, chatSetModel,
    chatSetPermissionMode, chatCommands, chatList, closeAll,
  };
}

module.exports = { createBridge, CHAT_ID_RE };
