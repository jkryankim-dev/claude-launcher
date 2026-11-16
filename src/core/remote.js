'use strict';
// 원격(SSH) 프로젝트: 대상 정규화·ssh 인자 조립, 원격 준비 에이전트(remote-apply.cjs) 실행
// - 원격 미니PC(Windows + OpenSSH Server)의 폴더를 프로젝트로 연다.
// - 파일 전송은 scp 대신 `ssh -T <target> node -` + 표준 입력(스크립트 = payload + 에이전트 원문).
//   명령줄에 따옴표가 필요한 글자가 하나도 들어가지 않는다(원격 기본 셸이 무엇이든 동작).
// - z.ai 키는 로컬 DPAPI를 원격에서 못 푸니까 평문으로 표준 입력으로만 보낸다(명령줄·로그·오류에 절대 안 넣는다).
const { spawn: cpSpawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cleanEnv, where } = require('./proc');

const PS_START = id => `& node (Join-Path $env:APPDATA 'claude-launcher\\runtime\\start-session.mjs') --project '${id}'; exit $LASTEXITCODE`;
const MARK = '@@CLR@@';
const NO_NODE_RE = /is not recognized|not recognized as|command not found/i;
const AUTH_RE = /permission denied/i;
const OUT_MAX = 1024 * 1024;

function fail(code, msg, tail) {
  const e = new Error(tail ? `${msg}\n${String(tail).slice(-300)}` : msg);
  e.code = code;
  return e;
}

/** 설정의 remote 필드 정리. host는 필수(ssh 옵션 주입 방지), user는 공백·@·:·따옴표 불가, port는 1–65535(22→0=기본). */
function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (!host || host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) return null;
  let user = '';
  if (raw.user !== undefined && raw.user !== null) {
    if (typeof raw.user !== 'string') return null;
    user = raw.user.trim();
    if (user && (user.startsWith('-') || /[\s@:'"]/.test(user) || /[\x00-\x1f\x7f]/.test(user))) return null;
  }
  let port = 0;
  // 숫자 0은 "기본 포트"로 이미 정규화된 값이다(정규화 결과를 다시 넣어도 통과해야 한다).
  if (raw.port !== undefined && raw.port !== null && raw.port !== '' && raw.port !== 0) {
    const n = typeof raw.port === 'number' ? raw.port : String(raw.port).trim();
    if (typeof n !== 'number' && !/^\d+$/.test(n)) return null;
    const p = Number(n);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
    port = p === 22 ? 0 : p;
  }
  return { host, user, port };
}

const target = r => (r.user ? `${r.user}@${r.host}` : r.host);
const label = (r, remotePath) => `${target(r)}:${remotePath}`;

/** 마지막 세그먼트('/'와 '\\' 모두 구분자, 끝 구분자 무시). 'C:\\' → 'C:' */
function baseName(remotePath) {
  const p = String(remotePath || '').trim().replace(/[\\/]+$/, '');
  if (!p) return String(remotePath || '').trim();
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/** 원격 경로 정리: trim, 끝 구분자 제거(드라이브 루트 'C:\\'는 유지). 로컬 path.resolve를 쓰지 않는다. */
function cleanPath(remotePath) {
  const p = String(remotePath || '').trim();
  if (!p) return '';
  const drive = /^([A-Za-z]:)[\\/]*$/.exec(p);
  if (drive) return drive[1] + '\\';
  return p.replace(/[\\/]+$/, '') || p;
}

const sameTarget = (a, b) => !!a && !!b
  && String(a.host).toLowerCase() === String(b.host).toLowerCase()
  && String(a.user || '').toLowerCase() === String(b.user || '').toLowerCase()
  && (a.port || 0) === (b.port || 0);

/** ssh 공통 인자. 대화형(-t, 연결 유지) / 자동(-T, BatchMode + 제한 시간). */
function sshArgs(remote, { interactive = false } = {}) {
  const r = remote || {};
  const port = r.port ? ['-p', String(r.port)] : [];
  return interactive
    ? ['-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'StrictHostKeyChecking=accept-new', ...port, target(r)]
    : ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', ...port, target(r)];
}

const encodePs = script => Buffer.from(script, 'utf16le').toString('base64');
/** 원격 터미널에서 실행할 PowerShell 시작 명령(EncodedCommand라 따옴표 문제가 없다) */
function startCommand(projectId) {
  if (!/^[a-z0-9]{4,16}$/.test(String(projectId || ''))) throw new Error(`프로젝트 id 형식이 올바르지 않습니다: ${projectId}`);
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePs(PS_START(projectId))}`;
}

const sessionSshArgs = (remote, projectId) => [...sshArgs(remote, { interactive: true }), startCommand(projectId)];

/** ssh.exe 경로. PATH 우선, 없으면 Windows 번들 OpenSSH 위치 확인 */
async function findSsh({ where: wh = where, exists = fs.existsSync } = {}) {
  const list = await wh('ssh');
  if (list && list.length) return list[0];
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return exists(p) ? p : null;
}

/** dir 아래 모든 파일(재귀)을 { rel: '<prefix>/<상대경로>', b64 }로. rel 구분자는 항상 '/'. 정렬된 순서. */
function collectFiles(dir, prefix) {
  const out = [];
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        let b64;
        try { b64 = fs.readFileSync(path.join(d, e.name)).toString('base64'); } catch { continue; }
        out.push({ rel: `${prefix}/${r}`, b64 });
      }
    }
  };
  walk(dir, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 원격 에이전트에 보낼 payload. 모든 인자 선택(listPath ''=드라이브 목록도 유효 → undefined일 때만 null) */
function buildPayload({ session = null, launcherFiles = [], claudeFiles = [], claudeMd = null, key = null, checkPath, listPath } = {}) {
  const files = [];
  for (const f of Array.isArray(launcherFiles) ? launcherFiles : []) files.push({ root: 'launcher', rel: f.rel, b64: f.b64 });
  for (const f of Array.isArray(claudeFiles) ? claudeFiles : []) files.push({ root: 'claude', rel: f.rel, b64: f.b64 });
  return {
    v: 1, files,
    session: session && typeof session === 'object' ? session : null,
    claudeMd: claudeMd && typeof claudeMd.text === 'string' ? { text: claudeMd.text } : null,
    key: typeof key === 'string' && key ? key : null,
    checkPath: checkPath === undefined ? null : checkPath,
    listPath: listPath === undefined ? null : listPath,
  };
}

/** 표준 입력으로 보낼 스크립트: payload 할당 + 에이전트 원문 */
const buildAgentScript = (agentSource, payload) => `globalThis.__CL_PAYLOAD__ = ${JSON.stringify(payload)};\n${agentSource}`;

/** ssh 배너·경고가 섞여도 '@@CLR@@' 줄의 JSON을 읽는다(마지막 줄 기준) */
function parseAgentOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith(MARK)) continue;
    try { return JSON.parse(l.slice(MARK.length)); } catch { break; }
  }
  throw fail('bad-output', '원격 결과를 해석하지 못했습니다. 원격 Node.js 버전(18 이상)을 확인하세요.', stdout);
}

/** `ssh -T <target> node -` 로 에이전트를 돌리고 결과 객체를 받는다. 실패는 code가 붙은 Error로 reject. */
async function runAgent(remoteInfo, payload, { agentSource, ssh, spawn: spawnFn = cpSpawn, timeoutMs = 60000 } = {}) {
  const exe = ssh !== undefined ? ssh : await findSsh();
  if (!exe) throw fail('ssh-missing', 'OpenSSH 클라이언트(ssh.exe)를 찾을 수 없습니다. Windows 설정의 "선택적 기능"에서 OpenSSH 클라이언트를 설치하세요.');
  return new Promise((resolve, reject) => {
    let child, out = '', errTxt = '', done = false, timer = null;
    const finish = fn => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    try {
      child = spawnFn(exe, [...sshArgs(remoteInfo, { interactive: false }), 'node', '-'], { windowsHide: true, env: cleanEnv() });
    } catch (e) {
      reject(fail('ssh-missing', 'ssh를 실행하지 못했습니다.', e.message));
      return;
    }
    timer = setTimeout(() => finish(() => {
      try { child.kill(); } catch { /* 이미 끝남 */ }
      reject(fail('timeout', `원격 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다. 미니PC가 켜져 있고 ssh ${target(remoteInfo)}로 접속되는지 확인하세요.`));
    }), timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf8'); if (out.length > OUT_MAX) out = out.slice(-OUT_MAX); });
    child.stderr.on('data', d => { errTxt += d.toString('utf8'); if (errTxt.length > OUT_MAX) errTxt = errTxt.slice(-OUT_MAX); });
    child.stdin.on('error', () => { /* 원격이 먼저 닫힘(EPIPE) — close 이벤트로 처리 */ });
    child.on('error', e => finish(() => reject(fail('ssh-missing', 'ssh를 실행하지 못했습니다.', e.code === 'ENOENT' ? `${exe}을(를) 찾을 수 없습니다` : e.message))));
    child.on('close', code => finish(() => {
      if (code === 0) {
        let r;
        try { r = parseAgentOutput(out); } catch (e) { reject(e); return; }
        if (r && r.ok === false) { reject(fail('agent', String(r.error || '원격 작업이 실패했습니다.'))); return; }
        resolve(r);
        return;
      }
      if (NO_NODE_RE.test(errTxt)) { reject(fail('no-node', '원격 컴퓨터에서 node를 찾지 못했습니다. Node.js 18 이상을 설치한 뒤 다시 시도하세요.', errTxt)); return; }
      if (AUTH_RE.test(errTxt)) { reject(fail('auth', '원격 로그인이 거부되었습니다. 공개 키 인증이 필요합니다(비밀번호 입력 불가). ssh-keygen으로 키를 만들어 미니PC에 등록하세요.', errTxt)); return; }
      reject(fail('connect', '원격 컴퓨터에 연결하지 못했습니다. 호스트 이름·포트·네트워크(테일스케일 연결)를 확인하세요.', errTxt));
    }));
    child.stdin.end(buildAgentScript(agentSource, payload));
  });
}

/** 원격 프로젝트 하나를 열 준비: 파일 동기화 + 세션·키·CLAUDE.md 전송 + 원격 환경 검증 */
async function prepareOpen(project, { res, sessionExtra, key, ssh, spawn: spawnFn, timeoutMs } = {}) {
  if (!project || !project.remote) throw fail('no-remote', '원격 프로젝트가 아닙니다.');
  if (project.mode !== 'claude' && !(typeof key === 'string' && key)) throw fail('no-key', 'z.ai 키가 없습니다. 런처 → 설정에서 z.ai 키를 저장한 뒤 다시 여세요.');
  const launch = require('./launch'); // 순환 의존(launch ↔ remote) 방지: 호출 시점에 불러온다
  const session = launch.sessionData(project, sessionExtra);
  delete session.keyFile;
  delete session.glmConfigDir;
  const agentSource = fs.readFileSync(path.join(res.runtimeDir, 'remote-apply.cjs'), 'utf8');
  const payload = buildPayload({
    session,
    launcherFiles: collectFiles(res.runtimeDir, 'runtime'),
    claudeFiles: collectFiles(res.skillDir, 'skills/glm-delegate'),
    claudeMd: typeof res.snippet === 'string' ? { text: res.snippet } : null,
    key: project.mode === 'claude' ? null : key,
    checkPath: project.path,
  });
  const r = await runAgent(project.remote, payload, { agentSource, ssh, spawn: spawnFn, timeoutMs });
  if (r.pathExists === false) throw fail('no-path', `원격 폴더가 없습니다: ${project.path}`);
  if (!r.claude) throw fail('no-claude', '원격 컴퓨터에서 claude 명령을 찾지 못했습니다. Claude Code 설치를 확인하세요.');
  const major = Number((/v(\d+)/.exec(String(r.node || '')) || [])[1] || 0);
  if (major < 18) throw fail('old-node', `원격 Node.js가 오래되었습니다(${r.node || '버전 unknown'}). 18 이상을 설치하세요.`);
  return r;
}

/** 원격 폴더 하나 점검(파일 전송 없이 checkPath만). 결과 검증 throw 없이 그대로 돌려준다. */
async function checkRemote(remoteInfo, remotePath, { res, ssh, spawn: spawnFn, timeoutMs } = {}) {
  const agentSource = fs.readFileSync(path.join(res.runtimeDir, 'remote-apply.cjs'), 'utf8');
  return runAgent(remoteInfo, buildPayload({ checkPath: remotePath }), { agentSource, ssh, spawn: spawnFn, timeoutMs });
}

/** 원격 폴더의 하위 폴더 목록(listPath만 보낸다). ''면 드라이브 목록 */
async function listRemote(remoteInfo, remotePath, { res, ssh, spawn: spawnFn, timeoutMs } = {}) {
  const agentSource = fs.readFileSync(path.join(res.runtimeDir, 'remote-apply.cjs'), 'utf8');
  const r = await runAgent(remoteInfo, buildPayload({ listPath: remotePath }), { agentSource, ssh, spawn: spawnFn, timeoutMs });
  return r.list || { path: remotePath, parent: null, dirs: [], error: '폴더 목록을 가져오지 못했습니다.' };
}

module.exports = {
  normalizeRemote, target, label, baseName, cleanPath, sameTarget, sshArgs, encodePs, startCommand,
  sessionSshArgs, findSsh, collectFiles, buildPayload, buildAgentScript, parseAgentOutput, runAgent,
  prepareOpen, checkRemote, listRemote,
};
