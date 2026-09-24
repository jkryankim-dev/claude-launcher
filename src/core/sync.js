'use strict';
// 앱에 들어 있는 파일(위임 스킬·세션 시작기)을 설치 위치로 복사. 내용이 바뀐 파일만 쓴다.
const fs = require('node:fs');
const path = require('node:path');

function syncDir(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`원본 폴더가 없습니다: ${src}`);
  const changed = [];
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, ent.name), dp = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(sp, dp); continue; }
      if (!ent.isFile()) continue;
      const a = fs.readFileSync(sp);
      let b = null;
      try { b = fs.readFileSync(dp); } catch { /* 새 파일 */ }
      if (!b || !a.equals(b)) { fs.writeFileSync(dp, a); changed.push(path.relative(dst, dp)); }
    }
  };
  walk(src, dst);
  return changed;
}
module.exports = { syncDir };
