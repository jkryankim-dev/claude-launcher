'use strict';
// claude 실행 파일 찾기 (네이티브 설치 .exe 우선, npm .cmd는 cli.js를 node로 직접 실행)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const MIN_CLAUDE = '2.1.255'; // Fable 5.1 지원 버전

function viaFile(p) {
  const ext = path.extname(p).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { cmd: 'node', pre: [p], shell: false, label: p };
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const cli = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    return fs.existsSync(cli) ? { cmd: 'node', pre: [cli], shell: false, label: p } : { cmd: p, pre: [], shell: true, label: p };
  }
  return { cmd: p, pre: [], shell: false, label: p };
}
function resolve(env = process.env) {
  if (env.GLM_CLAUDE_BIN) return viaFile(env.GLM_CLAUDE_BIN);
  if (!IS_WIN) {
    const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
    const p = String(r.stdout || '').trim().split('\n')[0];
    return p ? viaFile(p) : null;
  }
  const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
  const list = String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pick = list.find(p => /\.exe$/i.test(p)) || list.find(p => /\.(cmd|bat)$/i.test(p));
  if (pick) return viaFile(pick);
  const guess = [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(env.APPDATA || '', 'npm', 'claude.cmd')].find(p => fs.existsSync(p));
  return guess ? viaFile(guess) : null;
}
const q = a => (/^[\w\-.:\\/=@+,[\]]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
/** 실행할 파일·인자 (.cmd는 cmd.exe /s /c "..." 형태로 감싼다) */
function command(bin, args) {
  const all = [...bin.pre, ...args];
  if (bin.shell) return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[q(bin.cmd), ...all.map(q)].join(' ')}"`], verbatim: true };
  return { file: bin.cmd, args: all, verbatim: false };
}
function parseVersion(s) { const m = /(\d+\.\d+\.\d+)/.exec(String(s || '')); return m ? m[1] : null; }
function semverLt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}
module.exports = { MIN_CLAUDE, resolve, command, parseVersion, semverLt };
