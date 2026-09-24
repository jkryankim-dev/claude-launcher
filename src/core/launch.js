'use strict';
// 열기: Windows Terminal 탭·새 창·분할, 기본 콘솔 대체, VS Code
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cleanEnv } = require('./proc');

const TAB_COLOR = { split: '#534AB7', claude: '#5F5E5A', glm: '#0F6E56' }; // 런처 목록의 모드 색과 같음

function clean(s) { return String(s).replace(/[;"\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
function sessionTitle(p) {
  if (p.mode === 'glm') return `${p.name} · ${p.worker.model}/${p.worker.effort}`;
  if (p.mode === 'claude') return `${p.name} · ${p.main.model}/${p.main.effort}`;
  return `${p.name} · ${p.main.model}/${p.main.effort} + ${p.worker.model}`;
}
function paneArgs(p, ctx) {
  return ['--title', clean(sessionTitle(p)), '--suppressApplicationTitle', '--tabColor', TAB_COLOR[p.mode] || TAB_COLOR.split,
    '-d', p.path, ctx.node, ctx.script, '--project', p.id];
}
/** wt.exe 인자. 1개: 기존 창의 새 탭(또는 새 창). 여러 개: 새 창에 최대 2×2 분할, 5개째부터는 같은 창의 새 탭 */
function buildWtArgs(list, ctx, layout = 'tab') {
  if (!list.length) return [];
  if (list.length === 1 && layout !== 'split') return ['-w', layout === 'window' ? 'new' : '0', 'new-tab', ...paneArgs(list[0], ctx)];
  const [a, b, c, d, ...rest] = list;
  const args = ['-w', 'new', 'new-tab', ...paneArgs(a, ctx)];
  if (b) args.push(';', 'split-pane', '-V', ...paneArgs(b, ctx));
  if (c) args.push(';', 'split-pane', '-H', ...paneArgs(c, ctx));
  if (d) args.push(';', 'move-focus', 'left', ';', 'split-pane', '-H', ...paneArgs(d, ctx));
  for (const r of rest) args.push(';', 'new-tab', ...paneArgs(r, ctx));
  return args;
}
/** Windows Terminal이 없을 때: cmd /c start 로 콘솔 창 */
function consoleCommand(p, ctx) {
  return `/d /s /c start "${clean(p.name)}" /D "${p.path}" "${ctx.node}" "${ctx.script}" --project ${p.id}`;
}
function spawnDetached(file, args, opts = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { detached: true, stdio: 'ignore', env: cleanEnv(), ...opts }); }
    catch (e) { resolve({ ok: false, message: e.message }); return; }
    child.once('error', e => resolve({ ok: false, message: e.code === 'ENOENT' ? `${path.basename(file)}을(를) 찾을 수 없습니다` : e.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}
async function openTerminal(list, ctx, { layout = 'tab', terminal = 'wt' } = {}) {
  if (process.platform !== 'win32') return { ok: false, message: 'Windows에서만 열 수 있습니다' };
  if (terminal === 'wt' && ctx.wt) {
    const r = await spawnDetached(ctx.wt, buildWtArgs(list, ctx, layout));
    if (r.ok) return r;
  }
  for (const p of list) {
    const r = await spawnDetached(process.env.ComSpec || 'cmd.exe', [consoleCommand(p, ctx)], { windowsVerbatimArguments: true });
    if (!r.ok) return r;
  }
  return { ok: true, fallback: terminal === 'wt' };
}
function findVSCode(env = process.env) {
  const c = [path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')];
  return c.find(p => p && fs.existsSync(p)) || null;
}
async function openVSCode(p) {
  const exe = findVSCode();
  if (exe) return spawnDetached(exe, [p.path]);
  return spawnDetached(process.env.ComSpec || 'cmd.exe', [`/d /s /c code "${p.path}"`], { windowsVerbatimArguments: true, windowsHide: true });
}
/** 시작기가 읽을 세션 파일(비밀값 없음) */
function writeSessionFile(home, p, extra = {}) {
  const f = path.join(home, 'sessions', `${p.id}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...p, ...extra, writtenAt: new Date().toISOString() }, null, 2));
  return f;
}
module.exports = { TAB_COLOR, sessionTitle, buildWtArgs, consoleCommand, openTerminal, openVSCode, findVSCode, writeSessionFile };
