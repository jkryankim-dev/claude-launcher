'use strict';
/**
 * Claude 런처 — Electron 메인 프로세스
 * 폴더마다 메인(Claude 구독)·작업자(GLM) 모델과 effort를 저장하고, 클릭하면 그 설정으로
 * Windows Terminal에서 Claude Code를 연다. 앱·위임 스킬·모델 목록은 GitHub에서 스스로 업데이트한다.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('./core/config');
const catalog = require('./core/catalog');
const launch = require('./core/launch');
const secrets = require('./core/secrets');
const checks = require('./core/checks');
const sync = require('./core/sync');
const claudemd = require('./core/claudemd');
const claudebin = require('./core/claudebin');
const remote = require('./core/remote');
const { runCapture, cleanEnv } = require('./core/proc');
const { zaiRate } = require('./core/rate');
const { createHost } = require('./core/ptyhost');
const pkg = require('../package.json');

// 개발 실행(npm start)에서만: CLAUDE_LAUNCHER_HOME으로 데이터 폴더를 바꿔 설치된 런처와 동시에 띄울 수 있다(중복 실행 잠금이 폴더 기준).
const DEV_HOME = !app.isPackaged && process.env.CLAUDE_LAUNCHER_HOME ? path.resolve(process.env.CLAUDE_LAUNCHER_HOME) : '';
app.setPath('userData', DEV_HOME || path.join(app.getPath('appData'), 'claude-launcher'));

const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const HOME = app.getPath('userData');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const P = {
  config: path.join(HOME, 'config.json'),
  catalogCache: path.join(HOME, 'catalog.json'),
  bundledCatalog: path.join(RES, 'catalog.json'),
  keyFile: path.join(HOME, 'zai-key.dpapi'),
  runtime: path.join(HOME, 'runtime'),
  bundledRuntime: path.join(RES, 'runtime'),
  bundledSkill: path.join(RES, 'skills', 'glm-delegate'),
  skillDir: path.join(CLAUDE_HOME, 'skills', 'glm-delegate'),
  snippet: path.join(RES, 'snippets', 'CLAUDE.md.snippet'),
  claudeMd: path.join(CLAUDE_HOME, 'CLAUDE.md'),
  lastVersion: path.join(HOME, 'last-version'),
};
P.sessionScript = path.join(P.runtime, 'start-session.mjs');
P.glmRun = path.join(P.skillDir, 'scripts', 'glm-run.mjs');
const MASK = '••••••';
const EFFORT_OK = ['low', 'medium', 'high', 'xhigh', 'max'];

let win = null;
let lastChecks = null;
let pendingCatalog = null;
let autoUpdater = null;
let ptyHost = null; // 런처 안 터미널 세션
let ptyModule; // @lydell/node-pty (처음 쓸 때 불러옴)
let ptyError = '';
let allowClose = false;
const updateState = { app: { state: 'idle' }, catalog: { state: 'idle' } };

const loadCfg = () => config.load(P.config);
const saveCfg = c => config.save(P.config, c);
function send(type, data = {}) { if (win && !win.isDestroyed()) win.webContents.send('event', { type, ...data }); }

function repoInfo() {
  const url = String((pkg.repository && (pkg.repository.url || pkg.repository)) || '');
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(url);
  if (!m || m[1] === 'OWNER') return null;
  return { owner: m[1], repo: m[2] };
}

// ───────── 관리 파일(세션 시작기·위임 스킬·CLAUDE.md 영역) ─────────
function applyClaudeMd() {
  try { claudemd.apply(P.claudeMd, fs.readFileSync(P.snippet, 'utf8')); } catch (e) { console.error('CLAUDE.md', e); }
}
function syncManaged() {
  const c = loadCfg();
  const res = { runtime: sync.syncDir(P.bundledRuntime, P.runtime), skill: [] };
  if (c.setupDone) {
    res.skill = sync.syncDir(P.bundledSkill, P.skillDir);
    if (c.settings.claudeMd) applyClaudeMd();
  }
  return res;
}
function versionNote() {
  let prev = '';
  try { prev = fs.readFileSync(P.lastVersion, 'utf8').trim(); } catch { /* 첫 실행 */ }
  const cur = app.getVersion();
  if (prev !== cur) { try { fs.writeFileSync(P.lastVersion, cur); } catch { /* 무시 */ } }
  return prev && prev !== cur ? `v${prev}에서 v${cur}로 업데이트했습니다` : '';
}

// ───────── 상태 ─────────
async function refreshChecks() {
  try { lastChecks = await checks.runAll({ hasKey: secrets.hasKey(P.keyFile) }); }
  catch (e) { lastChecks = { at: new Date().toISOString(), items: [{ id: 'claude', level: 'error', label: '점검 실패', detail: String(e.message || e) }], node: null, wt: null }; }
  send('checks', { checks: lastChecks });
  return lastChecks;
}
function getState() {
  const c = loadCfg();
  return {
    version: app.getVersion(), platform: process.platform, firstRun: !c.setupDone,
    config: {
      ...c, settings: { ...c.settings, githubToken: c.settings.githubToken ? MASK : '' },
      projects: c.projects.map(p => ({ ...p, remoteLabel: p.remote ? remote.label(p.remote, p.path) : '' })),
    },
    catalog: catalog.effective(P, c), checks: lastChecks, keySaved: secrets.hasKey(P.keyFile),
    rate: zaiRate(new Date()), update: updateState, repo: repoInfo(), paths: { home: HOME, skill: P.skillDir },
  };
}

// ───────── 열기 ─────────
function sessionExtra(c) {
  const cat = catalog.effective(P, c);
  return {
    keepShell: c.settings.keepShell, zaiBaseUrl: c.settings.zaiBaseUrl, fastModel: cat.glm.fastModel || 'glm-5.3-flash',
    glmConfigDir: c.settings.glmConfigDir || path.join(os.homedir(), '.claude-glm'), keyFile: P.keyFile,
  };
}
// ───────── 원격(SSH) 프로젝트 ─────────
const SSH_MISSING = 'ssh를 찾을 수 없습니다. Windows 설정 → 선택적 기능에서 OpenSSH 클라이언트를 설치하세요.';
const remotePreparing = new Map(); // 프로젝트 id → 진행 중 prepare 약속. 같은 원격 프로젝트를 겹쳐 열 때 준비가 두 번 돌지 않게 한다
function remoteRes() {
  let snippet = null;
  if (claudemd.has(P.claudeMd)) { try { snippet = fs.readFileSync(P.snippet, 'utf8'); } catch { snippet = null; } }
  return { runtimeDir: P.bundledRuntime, skillDir: P.bundledSkill, snippet };
}
/** 원격에 runtime·스킬·세션 JSON·CLAUDE.md 영역·z.ai 키를 심는다. 성공하면 ssh.exe 경로를 돌려준다 */
function prepareRemote(p, c) {
  let run = remotePreparing.get(p.id);
  if (run) return run;
  run = (async () => {
    const ssh = await remote.findSsh();
    if (!ssh) throw new Error(SSH_MISSING);
    const key = p.mode !== 'claude' ? (secrets.loadKey(P.keyFile) || null) : null; // 평문 키는 이 인자로만 감
    await remote.prepareOpen(p, { res: remoteRes(), sessionExtra: sessionExtra(c), key, ssh });
    return ssh;
  })().finally(() => { remotePreparing.delete(p.id); });
  remotePreparing.set(p.id, run);
  return run;
}

async function openProjects(ids, layout) {
  const c = loadCfg();
  const list = ids.map(id => c.projects.find(p => p.id === id)).filter(Boolean);
  if (!list.length) return { ok: false, message: '열 폴더가 없습니다' };
  const missing = list.filter(p => !p.remote && !fs.existsSync(p.path));
  if (missing.length) return { ok: false, message: `폴더가 없습니다: ${missing.map(p => p.path).join(', ')}` };
  const hasKey = secrets.hasKey(P.keyFile);
  if (!hasKey && list.some(p => p.mode === 'glm' && (layout === 'split' || p.openWith !== 'vscode'))) {
    return { ok: false, message: 'GLM만 모드는 z.ai 키가 필요합니다. 설정에서 키를 저장하세요' };
  }
  if (!lastChecks) await refreshChecks();
  const needNode = list.some(p => !p.remote && (layout === 'split' || p.openWith !== 'vscode')); // 원격은 로컬 node 없이 ssh만으로 열린다
  if (needNode && !lastChecks.node) return { ok: false, message: 'Node.js를 찾을 수 없습니다. 설치한 뒤 설정에서 다시 점검하세요' };
  const failed = [];
  const ready = new Set();
  let ssh = null;
  await Promise.all(list.filter(p => p.remote).map(async p => {
    try { ssh = await prepareRemote(p, c); ready.add(p.id); }
    catch (e) { failed.push(`${p.name}: ${String((e && e.message) || e)}`); }
  }));
  const openList = list.filter(p => !p.remote || ready.has(p.id)); // 준비에 실패한 원격만 빼고 나머지는 연다
  if (!openList.length) return { ok: false, message: failed.join('\n') || '열 수 있는 폴더가 없습니다' };
  if (!fs.existsSync(P.sessionScript)) sync.syncDir(P.bundledRuntime, P.runtime);
  const extra = sessionExtra(c);
  for (const p of openList) if (!p.remote) launch.writeSessionFile(HOME, p, extra);
  const ctx = { node: lastChecks.node || 'node', script: P.sessionScript, wt: lastChecks.wt };
  if (openList.some(p => p.remote)) { ctx.ssh = ssh || await remote.findSsh(); ctx.homeDir = os.homedir(); }
  let r = { ok: true };
  if (layout === 'split' && openList.length > 1) {
    r = await launch.openTerminal(openList, ctx, { layout: 'split', terminal: c.settings.terminal });
  } else {
    for (const p of openList) {
      const ow = p.remote && p.openWith === 'vscode' ? 'inapp' : p.openWith; // 원격은 VS Code 대신 터미널로
      const how = layout === 'wt' || ow === 'inapp' ? 'tab' : ow; // 'wt' = 런처 안이 안 될 때 터미널 탭으로 대신 열기
      r = how === 'vscode'
        ? await launch.openVSCode(p)
        : await launch.openTerminal([p], ctx, { layout: how === 'window' ? 'window' : 'tab', terminal: c.settings.terminal });
      if (!r.ok) break;
    }
  }
  const warn = [
    r.ok && !hasKey && list.some(p => p.mode === 'split') ? 'z.ai 키가 없어 GLM 위임은 동작하지 않습니다' : '',
    ...failed,
  ].filter(Boolean).join('\n');
  return { ...r, warn };
}

// ───────── 런처 안 터미널 ─────────
function getPty() {
  if (ptyModule !== undefined) return ptyModule;
  try { ptyModule = require('@lydell/node-pty'); } catch (e) { ptyModule = null; ptyError = String((e && e.message) || e); }
  return ptyModule;
}
function host() {
  if (!ptyHost) ptyHost = createHost({ spawnPty: (f, a, o) => getPty().spawn(f, a, o), send: (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); } });
  return ptyHost;
}
async function termOpen(projectId, cols, rows) {
  const c = loadCfg();
  const p = c.projects.find(x => x.id === projectId);
  if (!p) return { ok: false, message: '프로젝트를 찾을 수 없습니다' };
  if (!p.remote && !fs.existsSync(p.path)) return { ok: false, message: `폴더가 없습니다: ${p.path}` };
  if (p.mode === 'glm' && !secrets.hasKey(P.keyFile)) return { ok: false, message: 'GLM만 모드는 z.ai 키가 필요합니다. 설정에서 키를 저장하세요' };
  let ssh = null;
  if (p.remote) {
    try { ssh = await prepareRemote(p, c); }
    catch (e) { return { ok: false, message: String((e && e.message) || e) }; } // 원격 준비 실패는 wt로 폴백해도 같으니 오류만 보낸다
  } else {
    if (!lastChecks) await refreshChecks();
    if (!lastChecks.node) return { ok: false, message: 'Node.js를 찾을 수 없습니다. 설치한 뒤 설정에서 다시 점검하세요' };
  }
  if (!getPty()) return { ok: false, fallback: true, message: `런처 안 터미널을 쓸 수 없어 터미널 탭으로 엽니다 (${ptyError.slice(0, 120)})` };
  const colsN = Number(cols) || 120, rowsN = Number(rows) || 32;
  const env = cleanEnv(process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_LAUNCHER_INAPP: '1' });
  const meta = { projectId: p.id, name: p.name, mode: p.mode, title: launch.sessionTitle(p) };
  if (p.remote) {
    try {
      const s = host().open({ file: ssh, args: remote.sessionSshArgs(p.remote, p.id), cwd: os.homedir(), env, cols: colsN, rows: rowsN, meta });
      return { ok: true, ...s };
    } catch (e) {
      return { ok: false, fallback: true, message: `런처 안 터미널을 열지 못해 터미널 탭으로 엽니다 (${String((e && e.message) || e).slice(0, 120)})` };
    }
  }
  if (!fs.existsSync(P.sessionScript)) sync.syncDir(P.bundledRuntime, P.runtime);
  launch.writeSessionFile(HOME, p, sessionExtra(c));
  try {
    const s = host().open({ file: lastChecks.node, args: [P.sessionScript, '--project', p.id], cwd: p.path, env, cols: colsN, rows: rowsN, meta });
    return { ok: true, ...s };
  } catch (e) {
    return { ok: false, fallback: true, message: `런처 안 터미널을 열지 못해 터미널 탭으로 엽니다 (${String((e && e.message) || e).slice(0, 120)})` };
  }
}
function confirmEndSessions(what) {
  const n = ptyHost ? ptyHost.running() : 0;
  if (!n) return true;
  const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: [what, '취소'], defaultId: 1, cancelId: 1, title: 'Claude 런처', message: `런처 안에서 실행 중인 세션 ${n}개가 함께 끝납니다.`, detail: `${what}할까요?` });
  return r === 0;
}

// ───────── 도구 ─────────
async function toolGlmCheck() {
  const c = loadCfg();
  if (!fs.existsSync(P.glmRun)) sync.syncDir(P.bundledSkill, P.skillDir);
  if (!lastChecks) await refreshChecks();
  if (!lastChecks.node) return { code: -1, output: 'Node.js를 찾을 수 없습니다.' };
  const d = c.defaults;
  const env = cleanEnv(process.env, {
    GLM_KEY_FILE: P.keyFile, GLM_MODEL: d.worker.model, GLM_EFFORT: d.worker.effort, GLM_BASE_URL: c.settings.zaiBaseUrl,
    GLM_FAST_MODEL: catalog.effective(P, c).glm.fastModel || 'glm-5.3-flash', CLAUDE_LAUNCHER_HOME: HOME,
  });
  const cwd = (c.projects.find(p => !p.remote && fs.existsSync(p.path)) || {}).path || os.homedir();
  return runCapture(lastChecks.node, [P.glmRun, '--check'], { cwd, env, timeout: 240000 });
}
async function toolClaudeUpdate() {
  const bin = claudebin.resolve();
  if (!bin) return { code: -1, output: 'Claude Code를 찾을 수 없습니다.' };
  const cmd = claudebin.command(bin, ['update']);
  const file = cmd.file === 'node' ? (lastChecks && lastChecks.node) || 'node' : cmd.file;
  const r = await runCapture(file, cmd.args, { verbatim: cmd.verbatim, timeout: 300000 });
  refreshChecks();
  return r;
}

// ───────── 업데이트 (앱: electron-updater, 모델 목록: catalog.json) ─────────
function setUpdate(part, s) { updateState[part] = s; send('update', { update: updateState }); }
function notesText(n) {
  const s = Array.isArray(n) ? n.map(x => x.note || '').join('\n') : String(n || '');
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}
function configureFeed() {
  const r = repoInfo();
  const token = loadCfg().settings.githubToken;
  if (autoUpdater && r && token) autoUpdater.setFeedURL({ provider: 'github', owner: r.owner, repo: r.repo, private: true, token });
}
function setupUpdater() {
  if (!app.isPackaged) { updateState.app = { state: 'dev', message: '개발 모드에서는 앱 자동 업데이트를 건너뜁니다' }; return; }
  if (!repoInfo()) { updateState.app = { state: 'error', message: '업데이트 저장소가 정해지지 않은 빌드입니다' }; return; }
  try { ({ autoUpdater } = require('electron-updater')); } catch { updateState.app = { state: 'error', message: 'electron-updater를 불러오지 못했습니다' }; return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  configureFeed();
  autoUpdater.on('checking-for-update', () => setUpdate('app', { state: 'checking' }));
  autoUpdater.on('update-available', i => setUpdate('app', { state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', p => setUpdate('app', { ...updateState.app, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-not-available', () => setUpdate('app', { state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-downloaded', i => setUpdate('app', { state: 'ready', version: i.version, notes: notesText(i.releaseNotes) }));
  autoUpdater.on('error', e => setUpdate('app', { state: 'error', message: String((e && e.message) || e).slice(0, 300) }));
}
async function checkUpdates(manual) {
  const c = loadCfg();
  if (autoUpdater && (manual || c.settings.autoUpdate) && !['downloading', 'ready'].includes(updateState.app.state)) {
    autoUpdater.checkForUpdates().catch(e => setUpdate('app', { state: 'error', message: String((e && e.message) || e).slice(0, 300) }));
  }
  if (!manual && !c.settings.autoUpdate) return getState();
  const url = catalog.catalogUrl(repoInfo(), c.settings.githubToken, c.settings.catalogUrl);
  if (!url) { setUpdate('catalog', { state: 'error', message: '모델 목록 주소를 알 수 없습니다 (저장소 미설정)' }); return getState(); }
  setUpdate('catalog', { state: 'checking' });
  try {
    const remote = await catalog.fetchRemote(url, c.settings.githubToken);
    const cur = catalog.base(P);
    if (remote.version > cur.version) { pendingCatalog = remote; setUpdate('catalog', { state: 'available', version: remote.version, diff: catalog.diff(cur, remote) }); }
    else { pendingCatalog = null; setUpdate('catalog', { state: 'latest', version: cur.version }); }
  } catch (e) { setUpdate('catalog', { state: 'error', message: String(e.message || e).slice(0, 200) }); }
  return getState();
}

// ───────── 설정 저장 ─────────
function completeSetup(d = {}) {
  const c = loadCfg();
  if (d.key) secrets.saveKey(P.keyFile, d.key);
  if (d.defaults) c.defaults = config.normalize({ defaults: d.defaults }).defaults;
  c.settings.claudeMd = d.claudeMd !== false;
  c.setupDone = true;
  saveCfg(c);
  syncManaged();
  refreshChecks();
  return getState();
}
function saveSettings(s = {}) {
  const c = loadCfg();
  const n = c.settings, prevMd = n.claudeMd;
  for (const k of ['autoUpdate', 'keepShell', 'claudeMd']) if (typeof s[k] === 'boolean') n[k] = s[k];
  if (['wt', 'console'].includes(s.terminal)) n.terminal = s.terminal;
  if (typeof s.githubToken === 'string' && s.githubToken !== MASK) n.githubToken = s.githubToken.trim();
  saveCfg(c);
  if (n.claudeMd !== prevMd) { if (n.claudeMd) applyClaudeMd(); else claudemd.remove(P.claudeMd); }
  configureFeed();
  return getState();
}
function addModel(kind, m = {}) {
  if (!['claude', 'glm'].includes(kind)) throw new Error('모델 종류가 올바르지 않습니다');
  const id = String(m.id || '').trim();
  if (!/^[\w.\-[\]:/@]{2,80}$/.test(id)) throw new Error('모델 이름 형식을 확인하세요 (예: glm-5.4)');
  const efforts = String(m.efforts || '').split(/[\s,/]+/).map(s => s.trim().toLowerCase()).filter(s => EFFORT_OK.includes(s));
  const c = loadCfg();
  c.userModels[kind] = c.userModels[kind].filter(x => x.id !== id)
    .concat({ id, label: `${id} (직접 추가)`, efforts: efforts.length ? [...new Set(efforts)] : catalog.DEFAULT_EFFORTS[kind] });
  saveCfg(c);
  return getState();
}
function addDirs(dirs) {
  const c = loadCfg();
  for (const d of dirs) config.addProject(c, d);
  saveCfg(c);
}

// ───────── 원격 점검 결과 → 화면 항목 ─────────
function remoteVal(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.version || v.path || v.label || '');
  return String(v);
}
function remoteCheckItems(info, r, rp) {
  const items = [{ label: 'SSH 연결', ok: true, detail: `${r.user ? `${r.user}@` : ''}${r.host}${r.port && r.port !== 22 ? `:${r.port}` : ''}` }];
  const nv = remoteVal(info.node);
  const major = Number((/v?(\d+)(?:\.|$)/.exec(nv) || [])[1] || 0);
  items.push({ label: 'Node.js', ok: !!info.node && (!major || major >= 18), detail: nv ? (major && major < 18 ? `${nv} — 18 이상이 필요합니다` : nv) : '설치되어 있지 않습니다' });
  const cv = remoteVal(info.claude);
  items.push({ label: 'Claude Code', ok: !!info.claude, detail: cv || '설치되어 있지 않습니다' });
  const gv = info.git === true ? "설치됨" : remoteVal(info.git);
  items.push({ label: 'git', ok: !!info.git, detail: gv || '설치되어 있지 않습니다' });
  if (rp) items.push({ label: '폴더', ok: !!info.pathExists, detail: info.pathExists ? rp : '폴더를 찾을 수 없습니다' });
  return items;
}

// ───────── IPC ─────────
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));
  h('state', () => getState());
  h('projects:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: '프로젝트 폴더 선택', properties: ['openDirectory', 'multiSelections'] });
    if (!r.canceled && r.filePaths.length) addDirs(r.filePaths);
    return getState();
  });
  h('projects:addPaths', paths => {
    addDirs((Array.isArray(paths) ? paths : []).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }));
    return getState();
  });
  h('projects:addRemote', d => {
    try {
      d = d && typeof d === 'object' ? d : {};
      const r = remote.normalizeRemote({ host: d.host, user: d.user, port: d.port });
      if (!r) return { error: 'SSH 연결 정보를 확인하세요 (호스트 필수, 포트는 1–65535 숫자).' };
      const rp = String(d.path || '').trim();
      if (!rp) return { error: '원격 폴더 경로를 입력하세요.' };
      const c = loadCfg();
      const added = config.addRemoteProject(c, {
        host: r.host, user: r.user, port: r.port, path: rp,
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : undefined,
      });
      if (!added) return { error: '원격 폴더를 추가하지 못했습니다. 호스트와 경로를 확인하세요.' };
      saveCfg(c);
      return getState();
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  h('remote:check', async d => {
    try {
      d = d && typeof d === 'object' ? d : {};
      const r = remote.normalizeRemote({ host: d.host, user: d.user, port: d.port });
      if (!r) return { ok: false, error: 'SSH 연결 정보를 확인하세요 (호스트 필수, 포트는 1–65535 숫자).' };
      const ssh = await remote.findSsh();
      if (!ssh) return { ok: false, error: SSH_MISSING };
      const rp = String(d.path || '').trim();
      const info = await remote.checkRemote(r, rp, { res: remoteRes(), ssh });
      return { ok: true, items: remoteCheckItems(info, r, rp) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  h('remote:list', async d => {
    try {
      d = d && typeof d === 'object' ? d : {};
      const r = remote.normalizeRemote({ host: d.host, user: d.user, port: d.port });
      if (!r) return { ok: false, error: 'SSH 연결 정보를 확인하세요 (호스트 필수, 포트는 1–65535 숫자).' };
      const ssh = await remote.findSsh();
      if (!ssh) return { ok: false, error: SSH_MISSING };
      const res = await remote.listRemote(r, String(d.path || '').trim(), { res: remoteRes(), ssh });
      return { ok: true, path: res.path || '', parent: res.parent == null ? null : res.parent, dirs: Array.isArray(res.dirs) ? res.dirs : [] };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  h('project:save', p => { const c = loadCfg(); if (!config.updateProject(c, p)) throw new Error('프로젝트를 찾을 수 없습니다'); saveCfg(c); return getState(); });
  h('project:remove', id => { const c = loadCfg(); config.removeProject(c, id); saveCfg(c); return getState(); });
  h('project:move', (id, delta) => { const c = loadCfg(); config.moveProject(c, id, delta); saveCfg(c); return getState(); });
  h('project:changePath', async id => {
    const c = loadCfg();
    const p = c.projects.find(x => x.id === id);
    if (!p || p.remote) return getState(); // 원격 프로젝트는 로컬 폴더 선택 대화상자를 쓰지 않는다
    const r = await dialog.showOpenDialog(win, { title: '폴더 변경', defaultPath: p.path, properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths[0]) { p.path = r.filePaths[0]; saveCfg(c); }
    return getState();
  });
  h('projects:open', (ids, layout) => openProjects(Array.isArray(ids) ? ids : [], layout));
  h('folder:reveal', async id => {
    const p = loadCfg().projects.find(x => x.id === id);
    if (!p) return;
    if (p.remote) throw new Error('원격 프로젝트는 탐색기에서 열 수 없습니다.');
    const err = await shell.openPath(p.path); if (err) throw new Error(err);
  });
  h('defaults:save', d => { const c = loadCfg(); c.defaults = config.normalize({ defaults: d }).defaults; saveCfg(c); return getState(); });
  h('settings:save', s => saveSettings(s));
  h('key:save', async k => { secrets.saveKey(P.keyFile, k); await refreshChecks(); return getState(); });
  h('key:delete', async () => { secrets.deleteKey(P.keyFile); await refreshChecks(); return getState(); });
  h('setup:complete', d => completeSetup(d));
  h('checks:run', async () => { await refreshChecks(); return getState(); });
  h('tool:glmCheck', () => toolGlmCheck());
  h('tool:claudeUpdate', () => toolClaudeUpdate());
  h('tool:reinstall', () => {
    const r = syncManaged();
    return { code: 0, output: `세션 시작기: ${P.runtime} (바뀐 파일 ${r.runtime.length}개)\n위임 스킬: ${P.skillDir} (바뀐 파일 ${r.skill.length}개)${loadCfg().setupDone ? '' : '\n처음 설정을 마치면 위임 스킬을 설치합니다.'}` };
  });
  h('update:check', manual => checkUpdates(!!manual));
  h('update:applyCatalog', () => {
    if (pendingCatalog) { catalog.saveCache(P, pendingCatalog); pendingCatalog = null; setUpdate('catalog', { state: 'latest', version: catalog.base(P).version }); }
    return getState();
  });
  h('update:installApp', () => {
    if (!autoUpdater || updateState.app.state !== 'ready') return { ok: false };
    if (!confirmEndSessions('업데이트')) return { ok: false };
    allowClose = true;
    if (ptyHost) ptyHost.killAll();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });
  h('models:add', (kind, m) => addModel(kind, m));
  h('models:remove', (kind, id) => {
    const c = loadCfg();
    if (c.userModels[kind]) c.userModels[kind] = c.userModels[kind].filter(x => x.id !== id);
    saveCfg(c);
    return getState();
  });
  h('link:open', url => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });
  h('projects:setOpenWith', v => {
    if (!config.OPEN_WITH.includes(v)) throw new Error('열기 방식이 올바르지 않습니다');
    const c = loadCfg();
    for (const p of c.projects) p.openWith = v;
    c.defaults.openWith = v;
    saveCfg(c);
    return getState();
  });
  h('term:open', (pid, cols, rows) => termOpen(pid, cols, rows));
  h('term:attach', id => (ptyHost ? ptyHost.attach(id) : null));
  h('term:kill', id => (ptyHost ? ptyHost.kill(id) : false));
  h('term:list', () => (ptyHost ? ptyHost.list() : []));
  ipcMain.on('term:input', (_e, id, data) => { if (ptyHost) ptyHost.input(id, data); });
  ipcMain.on('term:resize', (_e, id, cols, rows) => { if (ptyHost) ptyHost.resize(id, cols, rows); });
}

// ───────── 창·수명 ─────────
function createWindow(note) {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 880, minHeight: 540, show: false, title: 'Claude 런처', autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#f4f5f7',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (note) win.webContents.once('did-finish-load', () => setTimeout(() => send('toast', { text: note, level: 'ok' }), 800));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => {
    if (allowClose) return;
    if (!confirmEndSessions('닫기')) { e.preventDefault(); return; }
    allowClose = true;
    if (ptyHost) ptyHost.killAll();
  });
  win.on('closed', () => { win = null; });
}
function start() {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (ptyHost) ptyHost.killAll(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    fs.mkdirSync(HOME, { recursive: true });
    try { syncManaged(); } catch (e) { console.error('sync', e); }
    registerIpc();
    createWindow(versionNote());
    setupUpdater();
    refreshChecks();
    setTimeout(() => { checkUpdates(false).catch(() => {}); }, 4000);
    setInterval(() => { checkUpdates(false).catch(() => {}); }, 6 * 3600e3);
  });
}
if (app.requestSingleInstanceLock()) start(); else app.quit();
