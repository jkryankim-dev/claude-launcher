'use strict';
// 런처 설정(config.json): 새 폴더 기본값, 프로젝트 목록, 앱 설정, 직접 추가한 모델
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const remote = require('./remote');

const MODES = ['split', 'claude', 'glm'];
const OPEN_WITH = ['inapp', 'tab', 'window', 'vscode'];
const DEFAULTS = { mode: 'split', main: { model: 'fable', effort: 'medium' }, worker: { model: 'glm-5.3', effort: 'max' }, openWith: 'inapp', extraArgs: '' };
const SETTINGS = { autoUpdate: true, terminal: 'wt', keepShell: true, claudeMd: true, githubToken: '', catalogUrl: '', zaiBaseUrl: 'https://api.z.ai/api/anthropic', glmConfigDir: '' };

const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const clone = o => JSON.parse(JSON.stringify(o));
const newId = () => crypto.randomBytes(4).toString('hex');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJSON(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = JSON.stringify(o, null, 2);
  try { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); } catch { fs.writeFileSync(f, s); }
}
function profile(x, base) {
  x = x && typeof x === 'object' ? x : {};
  return {
    mode: MODES.includes(x.mode) ? x.mode : base.mode,
    main: { model: str(x.main?.model, base.main.model), effort: str(x.main?.effort, base.main.effort) },
    worker: { model: str(x.worker?.model, base.worker.model), effort: str(x.worker?.effort, base.worker.effort) },
    openWith: OPEN_WITH.includes(x.openWith) ? x.openWith : base.openWith,
    extraArgs: typeof x.extraArgs === 'string' ? x.extraArgs.trim() : base.extraArgs,
  };
}
function models(list) {
  return (Array.isArray(list) ? list : [])
    .filter(m => m && typeof m.id === 'string' && m.id.trim())
    .map(m => ({ id: m.id.trim(), label: str(m.label, m.id.trim()), efforts: Array.isArray(m.efforts) ? m.efforts.filter(e => typeof e === 'string') : [] }));
}
function normalize(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const defaults = profile(raw.defaults, DEFAULTS);
  const settings = { ...SETTINGS };
  for (const k of Object.keys(SETTINGS)) if (raw.settings && typeof raw.settings[k] === typeof SETTINGS[k]) settings[k] = raw.settings[k];
  const seen = new Set(), projects = [];
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (!p || typeof p.path !== 'string' || !p.path.trim()) continue;
    // 원격 프로젝트: remote가 있으면 정규화하고, 유효하지 않으면 버린다(로컬 경로로 오해하면 안 된다).
    const r = p.remote ? remote.normalizeRemote(p.remote) : null;
    if (p.remote && !r) continue;
    const rp = r ? remote.cleanPath(p.path) : p.path;
    if (r && !rp) continue;
    let id = typeof p.id === 'string' && /^[a-z0-9]{4,16}$/.test(p.id) ? p.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    const proj = { id, name: str(p.name, r ? remote.baseName(rp) : path.basename(p.path) || p.path), path: rp, ...profile(p, defaults) };
    if (r) proj.remote = r; // remote 없는 옛 형식 프로젝트에는 이 키를 만들지 않는다
    projects.push(proj);
  }
  return { version: 1, setupDone: raw.setupDone === true, defaults, settings, projects, userModels: { claude: models(raw.userModels?.claude), glm: models(raw.userModels?.glm) } };
}
const load = f => normalize(readJSON(f));
const save = (f, c) => writeJSON(f, normalize(c));
function samePath(a, b) {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function addProject(c, dir) {
  const abs = path.resolve(dir);
  const hit = c.projects.find(p => !p.remote && samePath(p.path, abs)); // 원격 프로젝트와는 비교하지 않는다(같은 경로 문자열이어도 다른 프로젝트)
  if (hit) return hit;
  const p = { id: newId(), name: path.basename(abs) || abs, path: abs, ...clone(c.defaults) };
  c.projects.push(p);
  return p;
}
/** 원격 프로젝트 추가. 중복은 같은 대상 + 같은 원격 경로(대소문자·구분자 무시). 잘못된 host/path면 null */
function addRemoteProject(c, { host, user, port, path: remotePath, name } = {}) {
  const r = remote.normalizeRemote({ host, user, port });
  if (!r) return null;
  const rp = remote.cleanPath(remotePath);
  if (!rp) return null;
  const norm = s => String(s).replace(/\\/g, '/').toLowerCase();
  const hit = c.projects.find(p => p.remote && remote.sameTarget(p.remote, r) && norm(p.path) === norm(rp));
  if (hit) return hit;
  const p = { id: newId(), name: str(name, remote.baseName(rp)), path: rp, ...clone(c.defaults), remote: r };
  c.projects.push(p);
  return p;
}
function updateProject(c, p) {
  const i = c.projects.findIndex(x => x.id === p?.id);
  if (i < 0) return null;
  const cur = c.projects[i];
  let r = cur.remote || null;
  let nextPath = r ? cur.path : str(p.path, cur.path); // 로컬은 기존처럼 path 수정 허용
  if (r) {
    // 원격 프로젝트: path·remote(host/user/port) 수정을 받는다(정규화·검증 후, 잘못된 값은 무시).
    if (p.remote && typeof p.remote === 'object') {
      const n = remote.normalizeRemote({
        host: p.remote.host !== undefined ? p.remote.host : r.host,
        user: p.remote.user !== undefined ? p.remote.user : r.user,
        port: p.remote.port !== undefined ? p.remote.port : r.port,
      });
      if (n) r = n;
    }
    if (typeof p.path === 'string' && p.path.trim()) {
      const cp = remote.cleanPath(p.path);
      if (cp) nextPath = cp;
    }
  } // 로컬 프로젝트에 remote를 붙이거나 원격에서 떼는 변경은 무시한다.
  const next = { id: cur.id, name: str(p.name, cur.name), path: nextPath, ...profile(p, cur) };
  if (r) next.remote = r;
  c.projects[i] = next;
  return next;
}
function removeProject(c, id) { c.projects = c.projects.filter(p => p.id !== id); }
function moveProject(c, id, delta) {
  const i = c.projects.findIndex(p => p.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= c.projects.length) return;
  const [p] = c.projects.splice(i, 1);
  c.projects.splice(j, 0, p);
}
module.exports = { MODES, OPEN_WITH, DEFAULTS, SETTINGS, normalize, load, save, addProject, addRemoteProject, updateProject, removeProject, moveProject, readJSON, writeJSON, newId };
