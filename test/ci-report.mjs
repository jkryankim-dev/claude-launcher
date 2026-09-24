// CI 전용: TAP 결과에서 실패한 테스트를 GitHub 주석과 작업 요약으로 올린다.
// 공개 저장소의 실행 페이지에서 로그인 없이 실패 원인을 볼 수 있게 하기 위함.
import fs from 'node:fs';

const file = process.argv[2] || 'test-results.tap';
let tap = '';
try { tap = fs.readFileSync(file, 'utf8'); } catch { console.log(`${file} 없음`); process.exit(0); }
const lines = tap.split(/\r?\n/);
const fails = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const detail = [];
  for (let j = i + 1; j < lines.length && !/^\s*(not )?ok \d+ /.test(lines[j]) && detail.length < 60; j++) detail.push(lines[j]);
  fails.push({ name: m[1].trim(), detail: detail.join('\n').trim() });
}
const escMsg = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => escMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
for (const f of fails.slice(0, 10)) console.log(`::error title=${escProp(f.name)}::${escMsg(f.detail.slice(0, 4000))}`);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const body = fails.map(f => `### ${f.name}\n\n\`\`\`\n${f.detail}\n\`\`\`\n`).join('\n');
  fs.appendFileSync(summary, `## 실패한 테스트 ${fails.length}개\n\n${body}\n`);
}
console.log(`실패한 테스트 ${fails.length}개를 표시했습니다.`);
