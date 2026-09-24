'use strict';
// z.ai 키 저장: Windows는 DPAPI(현재 사용자 계정)로 암호화. 평문 키는 명령줄이 아니라 자식 프로세스 환경변수(CL_SECRET)로만 넘긴다.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const PS_ENC = '$k=$env:CL_SECRET; if(-not $k){exit 2}; $s=ConvertTo-SecureString -String $k -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))';
const PS_DEC = 'try{$s=ConvertTo-SecureString -String $env:CL_SECRET; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}catch{exit 1}';
function ps(script, secret) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CL_SECRET: secret }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
function saveKey(file, key) {
  key = String(key || '').trim();
  if (!key) throw new Error('키가 비어 있습니다');
  if (/\s/.test(key)) throw new Error('키에 공백이 들어 있습니다');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!IS_WIN) { fs.writeFileSync(file, `plain:${key}`, { mode: 0o600 }); return; } // 개발용(비Windows)
  const r = ps(PS_ENC, key);
  const enc = String(r.stdout || '').trim();
  if (r.status !== 0 || !enc) throw new Error(`키 암호화에 실패했습니다 ${String(r.stderr || (r.error && r.error.message) || '').trim()}`.trim());
  fs.writeFileSync(file, enc);
}
function loadKey(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  if (!raw) return '';
  if (raw.startsWith('plain:')) return raw.slice(6).trim();
  if (!IS_WIN) return '';
  const r = ps(PS_DEC, raw);
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
function hasKey(file) { try { return fs.statSync(file).size > 0; } catch { return false; } }
function deleteKey(file) { fs.rmSync(file, { force: true }); }
module.exports = { saveKey, loadKey, hasKey, deleteKey };
