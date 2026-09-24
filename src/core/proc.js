'use strict';
// 자식 프로세스 도우미: Electron 전용 환경변수를 빼고 실행, 출력 수집
const { spawn, execFile } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
function cleanEnv(env = process.env, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^ELECTRON_/i.test(k) && k.toUpperCase() !== 'NODE_OPTIONS') e[k] = v;
  return Object.assign(e, extra);
}
function execText(file, args, { timeout = 15000, env, cwd, verbatim = false } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', env: env || cleanEnv(), cwd, windowsVerbatimArguments: verbatim, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}
async function where(name) {
  const r = IS_WIN ? await execText('where', [name]) : await execText('sh', ['-c', `command -v ${name}`]);
  return r.ok ? r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}
function killTree(child) {
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* 이미 종료 */ }
}
/** 출력(최대 40KB)을 모아 돌려준다. 파일 확인·업데이트 같은 도구 실행용 */
function runCapture(file, args, { cwd, env, timeout = 300000, verbatim = false } = {}) {
  return new Promise(resolve => {
    let out = '', timedOut = false, child;
    try { child = spawn(file, args, { cwd, env: env || cleanEnv(), windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, output: e.message }); return; }
    const add = d => { out = (out + d.toString('utf8')).slice(-40000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const t = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, output: `${out}\n${e.message}`.trim() }); });
    child.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, timedOut, output: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') }); });
  });
}
module.exports = { IS_WIN, cleanEnv, execText, where, runCapture };
