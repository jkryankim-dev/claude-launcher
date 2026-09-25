'use strict';
// 런처 안 터미널 세션 관리 테스트 (가짜 의사 터미널 + 가능하면 실제 @lydell/node-pty)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHost, MAX_BUF } = require('../src/core/ptyhost');

function fakeSpawner() {
  const made = [];
  const spawnPty = (file, args, opts) => {
    const h = { data: [], exit: [] };
    const p = {
      file, args, opts, written: '', killed: false, cols: opts.cols, rows: opts.rows,
      onData: cb => h.data.push(cb), onExit: cb => h.exit.push(cb),
      write: d => { p.written += d; }, resize: (c, r) => { p.cols = c; p.rows = r; }, kill: () => { p.killed = true; },
      emit: d => h.data.forEach(cb => cb(d)), exit: code => h.exit.forEach(cb => cb({ exitCode: code })),
    };
    made.push(p);
    return p;
  };
  return { spawnPty, made };
}

test('ptyhost: 열기, 출력 순번, 재연결 버퍼, 입력, 크기, 종료', () => {
  const sent = [];
  const f = fakeSpawner();
  const host = createHost({ spawnPty: f.spawnPty, send: (ch, d) => sent.push([ch, d]) });
  const s = host.open({ file: 'node', args: ['start.mjs', '--project', 'p1'], cwd: '/x', env: { A: '1' }, cols: 100, rows: 30, meta: { projectId: 'p1', name: 'cuboerp' } });
  assert.match(s.id, /^t/);
  assert.equal(s.name, 'cuboerp');
  const p = f.made[0];
  assert.deepEqual([p.file, p.args, p.opts.cwd, p.opts.cols, p.opts.rows, p.opts.name], ['node', ['start.mjs', '--project', 'p1'], '/x', 100, 30, 'xterm-256color']);
  p.emit('hello ');
  p.emit('world');
  assert.deepEqual(sent.map(x => [x[0], x[1].seq, x[1].data]), [['term:data', 1, 'hello '], ['term:data', 2, 'world']]);
  const a = host.attach(s.id);
  assert.equal(a.buf, 'hello world');
  assert.equal(a.seq, 2);
  assert.equal(a.alive, true);
  host.input(s.id, 'ls\r');
  assert.equal(p.written, 'ls\r');
  assert.equal(host.resize(s.id, 90.7, 20), true);
  assert.deepEqual([p.cols, p.rows], [90, 20]);
  assert.equal(host.resize(s.id, 0, 20), false);
  assert.equal(host.running(), 1);
  p.exit(3);
  assert.deepEqual(sent.at(-1), ['term:exit', { id: s.id, code: 3 }]);
  assert.equal(host.running(), 0);
  host.input(s.id, 'x');
  assert.equal(p.written, 'ls\r', '끝난 세션에는 입력하지 않음');
  assert.equal(host.list()[0].alive, false);
  assert.equal(host.kill(s.id), true);
  assert.equal(host.attach(s.id), null);
});

test('ptyhost: 버퍼 상한과 전체 종료', () => {
  const f = fakeSpawner();
  const host = createHost({ spawnPty: f.spawnPty, send: () => {} });
  const a = host.open({ file: 'x' });
  host.open({ file: 'y' });
  f.made[0].emit('a'.repeat(MAX_BUF + 10));
  assert.equal(host.attach(a.id).buf.length, MAX_BUF);
  assert.equal(host.running(), 2);
  host.killAll();
  assert.ok(f.made.every(p => p.killed));
  assert.equal(host.running(), 0);
  assert.equal(host.list().length, 0);
});

function skipReal() {
  if (process.platform === 'win32' && process.env.CI) return 'Windows 빌드 서버에서는 건너뜀';
  try { require.resolve('@lydell/node-pty'); return false; } catch { return '@lydell/node-pty 미설치(npm install 후 실행)'; }
}
test('실제 의사 터미널로 명령 실행 (크기 전달·TTY 확인)', { skip: skipReal() }, async () => {
  const pty = require('@lydell/node-pty');
  const sent = [];
  let done;
  const finished = new Promise(r => { done = r; });
  const host = createHost({ spawnPty: (f, a, o) => pty.spawn(f, a, o), send: (ch, d) => { sent.push([ch, d]); if (ch === 'term:exit') done(d); } });
  host.open({ file: process.execPath, args: ['-e', "process.stdout.write('pty-ok:' + process.stdout.isTTY + ':' + process.stdout.columns); setTimeout(() => {}, 300)"], cwd: process.cwd(), env: process.env, cols: 77, rows: 20 });
  const ex = await Promise.race([finished, new Promise(r => setTimeout(() => r('timeout'), 15000))]);
  assert.notEqual(ex, 'timeout', '의사 터미널이 끝나지 않음');
  const text = sent.filter(x => x[0] === 'term:data').map(x => x[1].data).join('');
  assert.match(text, /pty-ok:true:77/);
  host.killAll();
});
