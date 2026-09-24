'use strict';
// ~/.claude/CLAUDE.md 안의 런처 관리 영역(표시 주석 사이)만 추가·갱신·제거한다. 나머지 내용은 그대로 둔다.
const fs = require('node:fs');
const path = require('node:path');

const START = '<!-- claude-launcher:start — 이 영역은 Claude 런처가 관리합니다 -->';
const END = '<!-- claude-launcher:end -->';
const BLOCK = /<!-- claude-launcher:start[^>]*-->[\s\S]*?<!-- claude-launcher:end -->\n?/;
const BLOCK_WITH_GAP = /\n?<!-- claude-launcher:start[^>]*-->[\s\S]*?<!-- claude-launcher:end -->\n?/;

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function has(file) { return BLOCK.test(read(file)); }
function apply(file, content) {
  const cur = read(file);
  const block = `${START}\n${String(content).trim()}\n${END}\n`;
  const next = BLOCK.test(cur) ? cur.replace(BLOCK, () => block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur.trim() ? '\n' : ''}${block}`;
  if (next === cur) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (cur && !fs.existsSync(file + '.launcher-backup')) fs.writeFileSync(file + '.launcher-backup', cur);
  fs.writeFileSync(file, next);
  return true;
}
function remove(file) {
  const cur = read(file);
  if (!BLOCK.test(cur)) return false;
  fs.writeFileSync(file, cur.replace(BLOCK_WITH_GAP, () => ''));
  return true;
}
module.exports = { apply, remove, has };
