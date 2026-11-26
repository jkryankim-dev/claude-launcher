// runtime/studio.mjs 테스트: 조직도 검증, 렌더링, sync/ensure 규칙, CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultOrg, validateOrg, renderAgent, renderPersona, renderOrgMd, renderClaudeSection,
  applySection, syncStudio, ensureStudio,
} from '../runtime/studio.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime/studio.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = p => fs.readFileSync(p, 'utf8');
const listMd = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { return []; } };

// 명세 표: [id, dept, engine, model, effort, reports_to]
const ROLES_TABLE = [
  ['game-designer', 'design', 'claude', 'opus', '', 'director'],
  ['narrative-writer', 'design', 'claude', 'sonnet', '', 'game-designer'],
  ['balance-data', 'design', 'glm', 'glm-5.3-flash', 'high', 'game-designer'],
  ['tech-director', 'dev', 'claude', 'opus', '', 'director'],
  ['gameplay-programmer', 'dev', 'glm', 'glm-5.3', 'max', 'tech-director'],
  ['engine-programmer', 'dev', 'glm', 'glm-5.3', 'max', 'tech-director'],
  ['ui-programmer', 'dev', 'glm', 'glm-5.3', 'high', 'tech-director'],
  ['art-director', 'art', 'claude', 'sonnet', '', 'director'],
  ['prompt-artist', 'art', 'claude', 'sonnet', '', 'art-director'],
  ['asset-lister', 'art', 'glm', 'glm-5.3-flash', 'low', 'art-director'],
  ['audio-director', 'sound', 'claude', 'sonnet', '', 'director'],
  ['sound-designer', 'sound', 'claude', 'sonnet', '', 'audio-director'],
  ['audio-programmer', 'sound', 'glm', 'glm-5.3', 'high', 'audio-director'],
  ['cue-sheet', 'sound', 'glm', 'glm-5.3-flash', 'low', 'audio-director'],
  ['qa-lead', 'qa', 'claude', 'sonnet', '', 'director'],
  ['test-writer', 'qa', 'glm', 'glm-5.3', 'high', 'qa-lead'],
  ['marketing-lead', 'marketing', 'claude', 'opus', '', 'director'],
  ['market-researcher', 'marketing', 'claude', 'sonnet', '', 'marketing-lead'],
  ['copywriter', 'marketing', 'claude', 'sonnet', '', 'marketing-lead'],
  ['trailer-producer', 'marketing', 'claude', 'sonnet', '', 'marketing-lead'],
  ['social-writer', 'marketing', 'glm', 'glm-5.3-flash', 'low', 'marketing-lead'],
  ['producer', 'ops', 'claude', 'haiku', '', 'director'],
  ['doc-writer', 'ops', 'glm', 'glm-5.3-flash', 'low', 'producer'],
];
const DEPTS = ['design', 'dev', 'art', 'sound', 'qa', 'marketing', 'ops'];

test('기본 조직도: 오류·경고 0으로 통과, 23개 역할·7개 부서가 표와 정확히 일치', () => {
  const org = defaultOrg();
  const v = validateOrg(org);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(org.departments.map(d => d.id), DEPTS);
  assert.deepEqual(org.roles.map(r => r.id), ROLES_TABLE.map(r => r[0]));
  assert.deepEqual(defaultOrg(), org); // 깊은 복사본
  assert.notEqual(defaultOrg(), defaultOrg());
  for (const [id, dept, engine, model, effort, rt] of ROLES_TABLE) {
    const r = org.roles.find(x => x.id === id);
    assert.equal(r.dept, dept, `${id} dept`);
    assert.equal(r.engine, engine, `${id} engine`);
    assert.equal(r.model, model, `${id} model`);
    assert.equal(r.effort || '', effort, `${id} effort`);
    assert.equal(r.reports_to, rt, `${id} reports_to`);
    assert.ok(r.when && r.when.trim(), `${id} when`);
    assert.ok(r.brief && r.brief.trim(), `${id} brief`);
    assert.ok(r.duties.length >= 3 && r.duties.length <= 5, `${id} duties 3~5개`);
    assert.ok(r.outputs.length >= 1, `${id} outputs`);
    const lines = r.brief.split('\n');
    assert.ok(lines.length >= 8 && lines.length <= 20, `${id} brief ${lines.length}줄(8~20)`);
    assert.ok(!r.tools || r.engine === 'claude' || !r.tools.includes('higgsfield'), `${id} glm은 higgsfield 도구 없음`);
  }
});

test('higgsfield 역할 3개: brief에 스타일 가이드·크레딧 승인·기록·일관성·금지 문구가 있다', () => {
  const org = defaultOrg();
  for (const id of ['prompt-artist', 'sound-designer', 'trailer-producer']) {
    const r = org.roles.find(x => x.id === id);
    assert.deepEqual(r.tools, ['higgsfield'], id);
    assert.match(r.brief, /style-guide\.md/);
    assert.match(r.brief, /크레딧을 보여 주고 사용자의 승인/);
    assert.match(r.brief, /프롬프트는 생성 전에 \.studio\/prompts\//);
    assert.match(r.brief, /참조 이미지·시드를 재사용/);
    assert.match(r.brief, /프롬프트에 넣지 않는다/);
    assert.match(r.brief, /mcp__higgsfield/);
  }
  for (const id of ['asset-lister', 'cue-sheet', 'social-writer']) {
    assert.match(org.roles.find(x => x.id === id).brief, /Higgsfield 등 외부 생성 도구를 직접 호출하지 않는다/);
  }
});

const role = over => ({
  id: 'r1', dept: 'design', name: '역할', when: '언제', engine: 'claude', model: 'opus',
  reports_to: 'director', brief: '지침', ...over,
});
const baseOrg = () => ({
  schema: 1, name: '스튜디오', director: { name: '디렉터' },
  departments: [{ id: 'design', name: '기획' }],
  roles: [role({})],
});
const errs = org => validateOrg(org).errors;
const has = (list, re) => assert.ok(list.some(s => re.test(s)), `기대 오류 없음: ${re} / ${JSON.stringify(list)}`);

test('validateOrg: 각 규칙의 실패 사례를 한국어 오류로 보고한다', () => {
  assert.deepEqual(errs(baseOrg()), []); // 최소 구성은 오류 0

  const dup = baseOrg();
  dup.roles.push(role({ id: 'r2', name: '둘' }));
  dup.roles.push(role({ id: 'r2', name: '셋' }));
  has(errs(dup), /역할 "r2".*중복/);

  has(errs({ ...baseOrg(), schema: 2 }), /schema는 1/);
  has(errs({ ...baseOrg(), departments: 'x' }), /departments가 배열/);
  has(errs({ ...baseOrg(), roles: 'x' }), /roles가 배열/);
  has(errs({ ...baseOrg(), roles: [role({ id: 'Bad-ID' })] }), /역할 "Bad-ID".*id는/);
  has(errs({ ...baseOrg(), roles: [role({ dept: 'nope' })] }), /역할 "r1".*dept.*departments에 없습니다/);
  has(errs({ ...baseOrg(), roles: [role({ engine: 'gpt' })] }), /역할 "r1".*engine은 claude 또는 glm/);
  has(errs({ ...baseOrg(), roles: [role({ model: 'glm-5.3' })] }), /역할 "r1".*claude 모델/);
  has(errs({ ...baseOrg(), roles: [role({ engine: 'glm', model: 'claude-sonnet-4' })] }), /역할 "r1".*claude로 시작할 수 없습니다/);
  has(errs({ ...baseOrg(), roles: [role({ engine: 'glm', model: '' })] }), /역할 "r1".*glm 모델은 비어 있지 않은 문자열/);
  has(errs({ ...baseOrg(), roles: [role({ effort: 'ultra' })] }), /역할 "r1".*effort는 low\|medium\|high\|xhigh\|max/);
  has(errs({ ...baseOrg(), roles: [role({ reports_to: 'ghost' })] }), /역할 "r1".*reports_to "ghost"/);
  has(errs({ ...baseOrg(), roles: [role({ reports_to: '' })] }), /역할 "r1".*reports_to가 필요합니다/);
  has(errs({ ...baseOrg(), roles: [role({ reports_to: 'r1' })] }), /역할 "r1".*자기 자신/);
  has(errs({ ...baseOrg(), roles: [role({ id: 'director' })] }), /예약어/);
  has(errs({ ...baseOrg(), roles: [role({ name: ' ' })] }), /역할 "r1".*name이 비어/);
  has(errs({ ...baseOrg(), roles: [role({ when: '' })] }), /역할 "r1".*when이 비어/);

  // 3단 순환: 경로가 메시지에 표시되고 한 번만 보고된다
  const cyc = { ...baseOrg(), departments: [{ id: 'design', name: '기획' }, { id: 'dev', name: '개발' }] };
  cyc.roles = [
    role({ id: 'aa', dept: 'design', reports_to: 'bb' }),
    role({ id: 'bb', dept: 'dev', reports_to: 'cc' }),
    role({ id: 'cc', dept: 'design', reports_to: 'aa' }),
  ];
  const ce = errs(cyc).filter(s => /순환합니다/.test(s));
  assert.equal(ce.length, 1, JSON.stringify(errs(cyc)));
  assert.match(ce[0], /역할 "aa".*aa → bb → cc → aa/);
  assert.ok(errs(cyc).length >= 1);
});

test('validateOrg: 경고(빈 부서, glm+higgsfield, brief 없음)', () => {
  const org = baseOrg();
  org.departments.push({ id: 'art', name: '아트' }); // 역할 0개
  org.roles[0].engine = 'glm';
  org.roles[0].model = 'glm-5.3';
  org.roles[0].tools = ['higgsfield'];
  delete org.roles[0].brief;
  const w = validateOrg(org).warnings;
  assert.equal(w.length, 3, JSON.stringify(w));
  assert.match(w[0], /부서 "art".*역할이 0개/);
  assert.match(w[1], /역할 "r1".*higgsfield/);
  assert.match(w[2], /역할 "r1".*brief이 없습니다/);
});

// 렌더링용 조직도: 특수문자(: ")와 줄바꿈이 들어간 when, 하위 glm 역할
const org2 = {
  schema: 1, name: '테스트 스튜디오', director: { name: '디렉터', note: '총괄 노트' },
  departments: [{ id: 'dev', name: '개발' }],
  roles: [
    { id: 'tech-director', dept: 'dev', name: '테크: "디렉터"', when: '설계가 필요할 때:\n여러 줄 when', engine: 'claude', model: 'opus', reports_to: 'director', duties: ['설계한다', '리뷰한다'], outputs: ['docs/tech/'], brief: '지침 본문' },
    { id: 'gameplay-programmer', dept: 'dev', name: '게임플레이 프로그래머', when: '구현할 때', engine: 'glm', model: 'glm-5.3', reports_to: 'tech-director', brief: '구현 지침' },
  ],
};

test('renderAgent: 머리말 name/description/model, 한 줄 description, 특수문자 이스케이프, 표식, 하위 glm 안내', () => {
  const md = renderAgent(org2.roles[0], org2);
  assert.match(md, /^---\nname: tech-director\ndescription: .+\nmodel: opus\n---\n<!-- studio:generated/);
  const m = md.match(/^description: (.*)$/m);
  assert.ok(m, 'description 줄');
  assert.ok(!m[1].includes('\n'), 'description은 한 줄');
  assert.ok(m[1].startsWith('"'), `특수문자(: ") 때문에 따옴표: ${m[1]}`);
  assert.ok(m[1].includes('\\"'), '내부 따옴표 이스케이프');
  assert.ok(m[1].includes('여러 줄 when'), 'when의 줄바꿈은 공백으로');
  assert.ok(md.includes('보고 대상: 디렉터(메인 세션 — 사용자)'));
  assert.ok(md.includes('사용 도구:') === false);
  assert.ok(md.includes('## 책임') && md.includes('## 산출물') && md.includes('## 지침'));
  assert.ok(md.includes('- gameplay-programmer (게임플레이 프로그래머, glm) — glm-delegate 명세 머리말에 `persona: gameplay-programmer`를 적어 맡긴다'));
  const plain = renderAgent(org2.roles[1], org2);
  assert.match(plain, /^description: 개발 · 게임플레이 프로그래머 — 구현할 때$/m); // 특수문자 없으면 따옴표 없이
  assert.ok(plain.includes('- 직속 하위 역할 없음'));
});

test('renderPersona·renderOrgMd·renderClaudeSection: 표식·머리말 없음·트리·표·운영 규칙', () => {
  const p = renderPersona(org2.roles[1], org2);
  assert.ok(p.startsWith('<!-- studio:generated'), '첫 줄 표식');
  assert.ok(!p.startsWith('---'), '머리말 없음');
  assert.ok(p.includes('# 게임플레이 프로그래머 (개발) — persona gameplay-programmer'));
  assert.ok(p.includes('보고 대상: tech-director (테크: "디렉터")'));
  assert.ok(p.includes('구현 지침'));

  const org = renderOrgMd(org2);
  assert.ok(org.includes('이 파일은 생성물'));
  assert.ok(org.includes('<!-- studio:generated'));
  assert.ok(org.includes('디렉터 (메인 세션 — 총괄)'));
  assert.ok(org.includes('  - 게임플레이 프로그래머 `gameplay-programmer` · glm'), '트리 들여쓰기');
  assert.ok(org.includes('| 역할 | engine · model · effort | 언제 |'));
  assert.ok(org.includes('| 테크: "디렉터" `tech-director` | claude · opus |'));

  const sec = renderClaudeSection(org2);
  assert.ok(!sec.includes('claude-launcher-studio:start'), '구간 본문에는 표식이 없다');
  assert.ok(sec.includes('`subagent_type: <id>`'));
  assert.ok(sec.includes('`persona: <id>`'));
  assert.ok(sec.includes('node "$STUDIO_TOOL" sync'));
  assert.ok(sec.includes('사용자 승인 없이 역할을 늘리거나 모델을 올리지 않는다'));
  assert.ok(sec.includes('| 개발 | tech-director | 테크: "디렉터" | claude · opus |'));
  assert.ok(sec.split('\n').length < 90, `본문이 너무 길다: ${sec.split('\n').length}줄`);
});

test('applySection: 추가·교체·멱등·CRLF 유지·바깥 보존·끝 표식 누락', () => {
  const S = '<!-- claude-launcher-studio:start -->', E = '<!-- claude-launcher-studio:end -->';
  const t1 = applySection('첫 줄\n둘째 줄\n', '구간 1');
  assert.equal(t1, `첫 줄\n둘째 줄\n\n${S}\n구간 1\n${E}`);
  assert.equal(applySection('', '구간 1'), `${S}\n구간 1\n${E}`); // 빈 파일
  assert.equal(applySection('A', 'b'), `A\n\n${S}\nb\n${E}`); // 줄바꿈 없는 파일

  const t2 = applySection(t1, '구간 2');
  assert.equal(t2, `첫 줄\n둘째 줄\n\n${S}\n구간 2\n${E}`);
  assert.equal(applySection(t2, '구간 2'), t2); // 멱등

  const crlf = '머리\r\n' + S + '\r\n옛 구간\r\n' + E + '\r\n끝\r\n';
  assert.equal(applySection(crlf, '새 구간'), '머리\r\n' + S + '\r\n새 구간\r\n' + E + '\r\n끝\r\n');
  assert.equal(applySection(crlf, '새 구간\r\n둘'), '머리\r\n' + S + '\r\n새 구간\r\n둘\r\n' + E + '\r\n끝\r\n');

  const mixed = 'A\n' + S + '\nx\n' + E + '\nB\n';
  const t4 = applySection(mixed, 'y');
  assert.ok(t4.startsWith('A\n' + S + '\n') && t4.endsWith('\n' + E + '\nB\n'), '바깥(A·B) 보존');
  assert.equal(applySection(t4, 'y'), t4);

  const broken = '앞\n' + S + '\n잡동사니\n더 있음';
  assert.equal(applySection(broken, '고침'), '앞\n' + S + '\n고침\n' + E + '\n');
  assert.equal(applySection('앞\n' + S, '고침'), '앞\n' + S + '\n고침\n' + E + '\n'); // 시작 표식만 있고 개행 없이 끝
});

test('ensureStudio 빈 폴더: 시딩 + agents 13·roles 10·ORG·CLAUDE·템플릿, 두 번째 호출은 변화 없음', () => {
  const dir = tmp();
  const r1 = ensureStudio(dir);
  assert.equal(r1.seeded, true);
  assert.ok(fs.existsSync(path.join(dir, '.studio', 'org.json')));
  assert.equal(listMd(path.join(dir, '.claude', 'agents')).length, 13);
  assert.equal(listMd(path.join(dir, '.studio', 'roles')).length, 10);
  for (const f of ['.studio/ORG.md', 'CLAUDE.md', '.studio/prompts/style-guide.md', '.studio/prompts/README.md']) {
    assert.ok(fs.existsSync(path.join(dir, ...f.split('/'))), f);
  }
  assert.ok(read(path.join(dir, 'CLAUDE.md')).includes('claude-launcher-studio:start'));
  assert.equal(r1.written.length, 25, JSON.stringify(r1.written)); // 13 agents + 10 roles + ORG.md + CLAUDE.md
  const r2 = ensureStudio(dir);
  assert.equal(r2.seeded, false);
  assert.deepEqual(r2.written, []);
  assert.deepEqual(r2.removed, []);
  assert.deepEqual(r2.kept, []);
});

test('기존 CLAUDE.md가 있는 폴더: 원래 내용 보존 + 구간 추가', () => {
  const dir = tmp();
  write(path.join(dir, 'CLAUDE.md'), '# 내 프로젝트\n\nnpm test를 돌린다.\n');
  const r = ensureStudio(dir);
  const md = read(path.join(dir, 'CLAUDE.md'));
  assert.match(md, /# 내 프로젝트/);
  assert.match(md, /npm test를 돌린다\./);
  assert.match(md, /claude-launcher-studio:start/);
  assert.ok(r.written.includes('CLAUDE.md'));
});

test('sync: 역할 추가→생성, engine 변경→반대쪽 정리, 삭제→정리', () => {
  const dir = tmp();
  ensureStudio(dir);
  const orgFile = path.join(dir, '.studio', 'org.json');
  const org = JSON.parse(read(orgFile));
  org.roles.push({ id: 'level-designer', dept: 'design', name: '레벨 디자이너', when: '레벨을 만들 때', engine: 'claude', model: 'sonnet', reports_to: 'game-designer', brief: '레벨 지침' });
  write(orgFile, JSON.stringify(org, null, 2));
  const r1 = syncStudio(dir);
  assert.ok(r1.written.includes('.claude/agents/level-designer.md'), JSON.stringify(r1));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'level-designer.md')));

  org.roles.find(r => r.id === 'level-designer').engine = 'glm';
  org.roles.find(r => r.id === 'level-designer').model = 'glm-5.3-flash';
  write(orgFile, JSON.stringify(org, null, 2));
  const r2 = syncStudio(dir);
  assert.ok(r2.written.includes('.studio/roles/level-designer.md'), JSON.stringify(r2));
  assert.ok(r2.removed.includes('.claude/agents/level-designer.md'), JSON.stringify(r2));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'level-designer.md')));
  assert.ok(fs.existsSync(path.join(dir, '.studio', 'roles', 'level-designer.md')));

  org.roles = org.roles.filter(r => r.id !== 'level-designer');
  write(orgFile, JSON.stringify(org, null, 2));
  const r3 = syncStudio(dir);
  assert.ok(r3.removed.includes('.studio/roles/level-designer.md'), JSON.stringify(r3));
  assert.ok(!fs.existsSync(path.join(dir, '.studio', 'roles', 'level-designer.md')));
});

test('표식 없는 손수 작성 agents/game-designer.md: 덮지도 지우지도 않고 경고, 표식 있는 낡은 파일은 정리', () => {
  const dir = tmp();
  ensureStudio(dir);
  const mine = '# 내가 쓴 게임 디자이너 지침\n';
  const f = path.join(dir, '.claude', 'agents', 'game-designer.md');
  write(f, mine);
  const r = syncStudio(dir);
  assert.equal(read(f), mine);
  assert.ok(r.kept.includes('.claude/agents/game-designer.md'), JSON.stringify(r.kept));
  assert.ok(!r.written.includes('.claude/agents/game-designer.md'));
  assert.ok(r.warnings.some(w => w.includes('.claude/agents/game-designer.md')));

  write(path.join(dir, '.claude', 'agents', 'stranger.md'), '# 낯선 파일\n');
  const r2 = syncStudio(dir);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'stranger.md')), '표식 없는 파일은 절대 지우지 않는다');
  assert.ok(!r2.removed.includes('.claude/agents/stranger.md'));

  write(path.join(dir, '.claude', 'agents', 'old-role.md'), '<!-- studio:generated — 예전 생성물 -->\n옛 역할\n');
  const r3 = syncStudio(dir);
  assert.ok(r3.removed.includes('.claude/agents/old-role.md'), JSON.stringify(r3));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'old-role.md')));
});

test('깨진 org.json: sync는 던지고 아무것도 쓰지 않음, ensure는 warnings으로 반환', () => {
  const dir = tmp();
  ensureStudio(dir);
  const before = JSON.stringify({
    agents: listMd(path.join(dir, '.claude', 'agents')),
    org: read(path.join(dir, '.studio', 'ORG.md')),
    md: read(path.join(dir, 'CLAUDE.md')),
  });
  write(path.join(dir, '.studio', 'org.json'), '{ "schema": 1, "roles": [ 망가짐');
  assert.throws(() => syncStudio(dir), /JSON 문법 오류 \(line \d+/);
  assert.equal(JSON.stringify({
    agents: listMd(path.join(dir, '.claude', 'agents')),
    org: read(path.join(dir, '.studio', 'ORG.md')),
    md: read(path.join(dir, 'CLAUDE.md')),
  }), before);

  const r = ensureStudio(dir);
  assert.equal(r.seeded, false);
  assert.deepEqual(r.written, []);
  assert.ok(r.warnings.some(w => /JSON 문법 오류/.test(w)), JSON.stringify(r.warnings));

  // JSON은 맞지만 규칙 위반인 org도 sync가 던진다
  write(path.join(dir, '.studio', 'org.json'), JSON.stringify({
    schema: 1, name: 's', director: { name: '디렉터' },
    departments: [{ id: 'design', name: '기획' }],
    roles: [{ id: 'Bad ID', dept: 'design', name: 'n', when: 'w', engine: 'claude', model: 'opus', reports_to: 'director', brief: 'b' }],
  }));
  assert.throws(() => syncStudio(dir), /검증 오류/);
});

test('사용자가 고친 style-guide.md는 ensure가 덮어쓰지 않는다', () => {
  const dir = tmp();
  ensureStudio(dir);
  const f = path.join(dir, '.studio', 'prompts', 'style-guide.md');
  write(f, '# 우리 화풍\n');
  const r = ensureStudio(dir);
  assert.equal(read(f), '# 우리 화풍\n');
  assert.ok(!r.written.some(p => p.includes('style-guide')));
});

test('CLI: ensure·validate·show 종료 코드와 출력', () => {
  const dir = tmp();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '' };
  const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  assert.equal(run([]).status, 0);
  assert.match(run([]).stdout, /사용법/);
  assert.match(run(['--help']).stdout, /ensure/);
  assert.equal(run(['ensure', dir]).status, 0);
  const ok = run(['validate', dir]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /오류 없음/);
  const shown = run(['show', dir]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /디렉터/);
  assert.match(shown.stdout, /게임 디자이너/);
  assert.match(shown.stdout, /게임플레이 프로그래머/);

  write(path.join(dir, '.studio', 'org.json'), '{ broken');
  const v = run(['validate', dir]);
  assert.equal(v.status, 1);
  assert.match(v.stderr || v.stdout, /JSON 문법 오류/);
  assert.equal(run(['show', dir]).status, 1);
});
