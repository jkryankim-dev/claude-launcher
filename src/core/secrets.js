'use strict';
// z.ai 키 저장: Windows는 DPAPI(현재 사용자 계정)로 암호화해 "dpapi:<base64>" 형식으로 둔다.
// - PowerShell 모듈(ConvertTo-SecureString 등)에 기대지 않고 .NET ProtectedData를 직접 부른다.
// - PowerShell 7에서 물려받은 PSModulePath는 Windows PowerShell 5.1의 모듈 로드를 깨뜨리므로 자식 환경에서 지운다.
// - 평문 키는 명령줄이 아니라 자식 프로세스 환경변수(CL_SECRET)로만 넘긴다.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const LOAD = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $u=[Security.Cryptography.DataProtectionScope]::CurrentUser;";
const PS_ENC = 'try{' + LOAD + ' $p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:CL_SECRET),$null,$u); [Console]::Out.Write([Convert]::ToBase64String($p))}catch{[Console]::Error.Write($_.Exception.Message); exit 1}';
const PS_DEC = 'try{' + LOAD + ' $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CL_SECRET),$null,$u); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))}catch{exit 1}';
// 예전 형식(ConvertFrom-SecureString 16진수)도 읽을 수 있게 남겨 둔다
const PS_DEC_LEGACY = 'try{$s=ConvertTo-SecureString -String $env:CL_SECRET; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}catch{exit 1}';

function ps(script, secret) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'PSMODULEPATH') env[k] = v;
  env.CL_SECRET = secret;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
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
  fs.writeFileSync(file, `dpapi:${enc}`);
}
function decryptText(raw) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  if (raw.startsWith('plain:')) return raw.slice(6).trim();
  if (!IS_WIN) return '';
  const r = raw.startsWith('dpapi:') ? ps(PS_DEC, raw.slice(6)) : ps(PS_DEC_LEGACY, raw);
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
function loadKey(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  return decryptText(raw);
}
function hasKey(file) { try { return fs.statSync(file).size > 0; } catch { return false; } }
function deleteKey(file) { fs.rmSync(file, { force: true }); }
module.exports = { saveKey, loadKey, decryptText, hasKey, deleteKey, PS_ENC, PS_DEC };
