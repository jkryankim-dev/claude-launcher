'use strict';
// 런처 설정(config.json): 새 폴더 기본값, 프로젝트 목록, 앱 설정, 직접 추가한 모델
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    let id = typeof p.id === 'string' && /^[a-z0-9]{4,16}$/.test(p.id) ? p.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    projects.push({ id, name: str(p.name, path.basename(p.path) || p.path), path: p.path, ...profile(p, defaults) });
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
  const hit = c.projects.find(p => samePath(p.path, abs));
  if (hit) return hit;
  const p = { id: newId(), name: path.basename(abs) || abs, path: abs, ...clone(c.defaults) };
  c.projects.push(p);
  return p;
}
function updateProject(c, p) {
  const i = c.projects.findIndex(x => x.id === p?.id);
  if (i < 0) return null;
  const cur = c.projects[i];
  c.projects[i] = { id: cur.id, name: str(p.name, cur.name), path: str(p.path, cur.path), ...profile(p, cur) };
  return c.projects[i];
}
function removeProject(c, id) { c.projects = c.projects.filter(p => p.id !== id); }
function moveProject(c, id, delta) {
  const i = c.projects.findIndex(p => p.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= c.projects.length) return;
  const [p] = c.projects.splice(i, 1);
  c.projects.splice(j, 0, p);
}
module.exports = { MODES, OPEN_WITH, DEFAULTS, SETTINGS, normalize, load, save, addProject, updateProject, removeProject, moveProject, readJSON, writeJSON, newId };
