'use strict';
// 런처 안 터미널 세션: 의사 터미널 생성, 출력 버퍼(탭 재연결용), 입력·크기 조정·종료를 관리한다.
// 의사 터미널 생성 함수(spawnPty)는 주입받는다 — 앱에서는 @lydell/node-pty, 테스트에서는 가짜.
const MAX_BUF = 512 * 1024;

function createHost({ spawnPty, send }) {
  const sessions = new Map();
  let n = 0;
  function open({ file, args = [], cwd, env, cols = 120, rows = 32, meta = {} }) {
    const id = `t${Date.now().toString(36)}${(n++).toString(36)}`;
    const pty = spawnPty(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    const s = { id, pty, buf: '', seq: 0, alive: true, code: null, meta };
    sessions.set(id, s);
    pty.onData(data => {
      s.seq++;
      s.buf += data;
      if (s.buf.length > MAX_BUF) s.buf = s.buf.slice(-MAX_BUF);
      send('term:data', { id, seq: s.seq, data });
    });
    pty.onExit(e => {
      s.alive = false;
      s.code = e && typeof e.exitCode === 'number' ? e.exitCode : null;
      send('term:exit', { id, code: s.code });
    });
    return { id, ...meta };
  }
  const get = id => sessions.get(id);
  function attach(id) {
    const s = get(id);
    return s ? { id, buf: s.buf, seq: s.seq, alive: s.alive, code: s.code, ...s.meta } : null;
  }
  function input(id, data) {
    const s = get(id);
    if (s && s.alive && typeof data === 'string' && data) s.pty.write(data);
  }
  function resize(id, cols, rows) {
    const s = get(id);
    cols = Math.floor(Number(cols));
    rows = Math.floor(Number(rows));
    if (!s || !s.alive || !(cols > 1) || !(rows > 1)) return false;
    try { s.pty.resize(cols, rows); return true; } catch { return false; }
  }
  function kill(id) {
    const s = get(id);
    if (!s) return false;
    if (s.alive) { try { s.pty.kill(); } catch { /* 이미 종료 */ } }
    s.alive = false;
    sessions.delete(id);
    return true;
  }
  function killAll() { for (const id of [...sessions.keys()]) kill(id); }
  function running() { let c = 0; for (const s of sessions.values()) if (s.alive) c++; return c; }
  function list() { return [...sessions.values()].map(s => ({ id: s.id, alive: s.alive, code: s.code, ...s.meta })); }
  return { open, attach, input, resize, kill, killAll, running, list };
}
module.exports = { createHost, MAX_BUF };
