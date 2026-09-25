'use strict';
// 렌더러에 노출하는 좁은 API (Node 접근 없음)
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  state: () => call('state'),
  addProjects: () => call('projects:add'),
  addPaths: paths => call('projects:addPaths', paths),
  saveProject: p => call('project:save', p),
  removeProject: id => call('project:remove', id),
  moveProject: (id, delta) => call('project:move', id, delta),
  changePath: id => call('project:changePath', id),
  open: (ids, layout) => call('projects:open', ids, layout),
  applyOpenWithAll: v => call('projects:setOpenWith', v),
  reveal: id => call('folder:reveal', id),
  saveDefaults: d => call('defaults:save', d),
  saveSettings: s => call('settings:save', s),
  saveKey: k => call('key:save', k),
  deleteKey: () => call('key:delete'),
  completeSetup: d => call('setup:complete', d),
  runChecks: () => call('checks:run'),
  glmCheck: () => call('tool:glmCheck'),
  claudeUpdate: () => call('tool:claudeUpdate'),
  reinstall: () => call('tool:reinstall'),
  checkUpdates: manual => call('update:check', manual),
  applyCatalog: () => call('update:applyCatalog'),
  installApp: () => call('update:installApp'),
  addModel: (kind, m) => call('models:add', kind, m),
  removeModel: (kind, id) => call('models:remove', kind, id),
  openExternal: url => call('link:open', url),
  pathForFile: f => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  onEvent: cb => { ipcRenderer.on('event', (_e, data) => cb(data)); },
  // 런처 안 터미널
  termOpen: (projectId, cols, rows) => call('term:open', projectId, cols, rows),
  termAttach: id => call('term:attach', id),
  termKill: id => call('term:kill', id),
  termList: () => call('term:list'),
  termInput: (id, data) => ipcRenderer.send('term:input', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  onTermData: cb => { ipcRenderer.on('term:data', (_e, d) => cb(d)); },
  onTermExit: cb => { ipcRenderer.on('term:exit', (_e, d) => cb(d)); },
});
