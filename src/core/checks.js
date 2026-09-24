'use strict';
// 환경 점검: Claude Code(버전), Node.js, Git, Windows Terminal, VS Code, z.ai 키
const claudebin = require('./claudebin');
const { execText, where, IS_WIN } = require('./proc');
const { findVSCode } = require('./launch');

async function runAll({ hasKey }) {
  const items = [];
  const add = (id, level, label, detail) => items.push({ id, level, label, detail });
  const bin = claudebin.resolve();
  if (!bin) add('claude', 'error', 'Claude Code 없음', 'claude 명령을 찾지 못했습니다. 설치 후 다시 점검하세요.');
  else {
    const c = claudebin.command(bin, ['--version']);
    const r = await execText(c.file, c.args, { timeout: 20000, verbatim: c.verbatim });
    const v = claudebin.parseVersion(r.out);
    if (!v) add('claude', 'error', 'Claude Code 확인 실패', `${bin.label} ${r.err}`.trim());
    else if (claudebin.semverLt(v, claudebin.MIN_CLAUDE)) add('claude', 'warn', `Claude Code ${v}`, `Fable 5.1은 ${claudebin.MIN_CLAUDE} 이상이 필요합니다. 설정에서 Claude Code 업데이트를 누르세요.`);
    else add('claude', 'ok', `Claude Code ${v}`, bin.label);
  }
  const nodes = await where('node');
  let node = null;
  if (!nodes.length) add('node', 'error', 'Node.js 없음', '세션 시작기와 GLM 위임에 필요합니다. nodejs.org에서 LTS를 설치하세요.');
  else {
    const r = await execText(nodes[0], ['--version']);
    const major = Number((/v(\d+)/.exec(r.out) || [])[1] || 0);
    if (major >= 18) { node = nodes[0]; add('node', 'ok', `Node.js ${r.out}`, nodes[0]); }
    else add('node', 'error', `Node.js ${r.out || '?'}`, '18 이상이 필요합니다.');
  }
  const gits = await where('git');
  add('git', gits.length ? 'ok' : 'warn', gits.length ? 'Git' : 'Git 없음', gits.length ? gits[0] : 'GLM 위임 결과를 되돌릴 수 없습니다.');
  let wt = null;
  if (IS_WIN) {
    wt = (await where('wt'))[0] || null;
    add('wt', wt ? 'ok' : 'warn', wt ? 'Windows Terminal' : 'Windows Terminal 없음', wt || '기본 콘솔 창으로 엽니다. Microsoft Store에서 설치를 권장합니다.');
    const code = findVSCode();
    add('vscode', code ? 'ok' : 'info', code ? 'VS Code' : 'VS Code 없음', code || 'VS Code로 열기를 쓰지 않으면 괜찮습니다.');
  }
  add('key', hasKey ? 'ok' : 'warn', hasKey ? 'z.ai 키' : 'z.ai 키 없음', hasKey ? 'Windows 계정으로 암호화해 저장됨' : 'GLM 위임과 GLM 전용 세션에 필요합니다.');
  return { at: new Date().toISOString(), items, node, wt };
}
module.exports = { runAll };
