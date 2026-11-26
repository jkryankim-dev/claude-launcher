#!/usr/bin/env node
/**
 * studio.mjs — 게임 스튜디오 조직도 도구
 * 게임 개발 폴더의 조직도 원본 .studio/org.json 하나에서
 * Claude 서브에이전트(.claude/agents/<id>.md), GLM 역할 지침(.studio/roles/<id>.md),
 * 조직도 그림(.studio/ORG.md), 폴더 CLAUDE.md 구간을 만들거나 정리한다.
 *   node studio.mjs <ensure|sync|validate|show> [dir]
 * 런처가 %APPDATA%\claude-launcher\runtime\ 에 설치·갱신한다. 의존성 없는 순수 Node ESM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARK = 'studio:generated';
const MARKER_LINE = `<!-- ${MARK} — .studio/org.json에서 생성됨. 직접 고치지 말고 org.json을 고친 뒤 sync -->`;
const SEC_START = '<!-- claude-launcher-studio:start -->';
const SEC_END = '<!-- claude-launcher-studio:end -->';
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const fwd = p => p.split(path.sep).join('/');
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const isGlm = r => r?.engine === 'glm';
const oneLine = s => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();

/** 기본 조직도(옆의 studio-org.default.json)의 깊은 복사본 */
export function defaultOrg() {
  const file = fileURLToPath(new URL('./studio-org.default.json', import.meta.url));
  return JSON.parse(JSON.stringify(JSON.parse(readText(file))));
}

/** YAML 스칼라: 값에 특수문자(: # 따옴표 등)가 있으면 큰따옴표로 감싸고 이스케이프한다 */
function yamlScalar(v) {
  const s = String(v);
  if (!s) return '""';
  if (/[:#"\\\r\n\t]/.test(s) || /^\s|\s$|^[-?&*!|>%@`{[]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
  }
  return s;
}

/** 조직도 검증. 한국어 메시지로 어느 역할의 어느 필드가 잘못됐는지 명시한다. */
export function validateOrg(org) {
  const errors = [], warnings = [];
  if (!org || typeof org !== 'object' || Array.isArray(org)) {
    return { errors: ['org.json의 내용이 객체가 아닙니다'], warnings };
  }
  if (org.schema !== 1) errors.push(`schema는 1이어야 합니다 (현재: ${JSON.stringify(org.schema)})`);
  const depts = Array.isArray(org.departments) ? org.departments : [];
  const roles = Array.isArray(org.roles) ? org.roles : [];
  if (!Array.isArray(org.departments)) errors.push('departments가 배열이 아닙니다');
  if (!Array.isArray(org.roles)) errors.push('roles가 배열이 아닙니다');

  const deptIds = new Set();
  for (const d of depts) {
    if (!d || typeof d !== 'object') { errors.push('departments 항목이 객체가 아닙니다'); continue; }
    const label = d.id != null ? `부서 "${d.id}"` : '부서 (id 없음)';
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) errors.push(`${label}: id는 소문자로 시작하는 2~40자(a-z·0-9·-)여야 합니다 (현재: ${JSON.stringify(d.id ?? null)})`);
    else if (deptIds.has(d.id)) errors.push(`${label}: id가 중복됩니다`);
    else deptIds.add(d.id);
    if (typeof d.name !== 'string' || !d.name.trim()) errors.push(`${label}: name이 비어 있습니다`);
  }

  const ids = new Set(), byId = new Map(), checked = [];
  for (const r of roles) {
    if (!r || typeof r !== 'object') { errors.push('roles 항목이 객체가 아닙니다'); continue; }
    const label = r.id != null ? `역할 "${r.id}"` : '역할 (id 없음)';
    if (r.id === 'director') errors.push(`역할 "director": id는 총괄 예약어라 쓸 수 없습니다`);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errors.push(`${label}: id는 소문자로 시작하는 2~40자(a-z·0-9·-)여야 합니다 (현재: ${JSON.stringify(r.id ?? null)})`);
    else if (ids.has(r.id)) errors.push(`${label}: id가 중복됩니다`);
    else { ids.add(r.id); byId.set(r.id, r); checked.push(r); }
    if (typeof r.dept !== 'string' || !deptIds.has(r.dept)) errors.push(`${label}: dept ${JSON.stringify(r.dept ?? null)}가 departments에 없습니다`);
    if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`${label}: name이 비어 있습니다`);
    if (typeof r.when !== 'string' || !r.when.trim()) errors.push(`${label}: when이 비어 있습니다`);
    if (r.engine !== 'claude' && r.engine !== 'glm') errors.push(`${label}: engine은 claude 또는 glm이어야 합니다 (현재: ${JSON.stringify(r.engine ?? null)})`);
    if (r.engine === 'claude') {
      const m = r.model;
      if (typeof m !== 'string' || !(CLAUDE_MODELS.has(m) || m.startsWith('claude-'))) {
        errors.push(`${label}: claude 모델은 opus|sonnet|haiku|fable|inherit 또는 claude-로 시작하는 문자열이어야 합니다 (현재: ${JSON.stringify(m ?? null)})`);
      }
    } else if (r.engine === 'glm') {
      const m = r.model;
      if (typeof m !== 'string' || !m) errors.push(`${label}: glm 모델은 비어 있지 않은 문자열이어야 합니다 (현재: ${JSON.stringify(m ?? null)})`);
      else if (m.startsWith('claude')) errors.push(`${label}: glm 역할의 모델 "${m}"은(는) claude로 시작할 수 없습니다`);
    }
    if (r.effort != null && !EFFORTS.has(r.effort)) errors.push(`${label}: effort는 low|medium|high|xhigh|max 중 하나여야 합니다 (현재: ${JSON.stringify(r.effort)})`);
  }

  for (const r of checked) {
    const rt = r.reports_to;
    if (typeof rt !== 'string' || !rt) { errors.push(`역할 "${r.id}": reports_to가 필요합니다 (director 또는 역할 id)`); continue; }
    if (rt === 'director') continue;
    if (!ids.has(rt)) errors.push(`역할 "${r.id}": reports_to "${rt}"가 director나 존재하는 역할 id가 아닙니다`);
    else if (rt === r.id) errors.push(`역할 "${r.id}": reports_to가 자기 자신입니다`);
  }

  // 순환: director에서 시작해 reports_to 사슬을 따라가고, 돌아오면 경로를 오류로 남긴다
  const ok = new Set(), bad = new Set();
  for (const r of checked) {
    if (ok.has(r.id) || bad.has(r.id)) continue;
    const rt = r.reports_to;
    if (typeof rt !== 'string' || rt === 'director' || rt === r.id) continue;
    const chain = [r.id], seen = new Set([r.id]);
    let cur = ids.has(rt) ? rt : undefined;
    while (typeof cur === 'string' && cur !== 'director' && byId.has(cur) && !seen.has(cur) && !ok.has(cur) && !bad.has(cur)) {
      chain.push(cur); seen.add(cur);
      const nxt = byId.get(cur).reports_to;
      cur = typeof nxt === 'string' && nxt ? nxt : undefined;
    }
    if (seen.has(cur)) {
      const cyc = chain.slice(chain.indexOf(cur)).concat(cur);
      cyc.forEach(id => bad.add(id));
      errors.push(`역할 "${cyc[0]}": reports_to가 순환합니다: ${cyc.join(' → ')}`);
    } else chain.forEach(id => ok.add(id));
  }

  const byDept = new Map();
  for (const r of checked) {
    if (!byDept.has(r.dept)) byDept.set(r.dept, []);
    byDept.get(r.dept).push(r);
  }
  for (const d of depts) {
    if (d?.id && deptIds.has(d.id) && !byDept.get(d.id)?.length) warnings.push(`부서 "${d.id}"(${d.name || '이름 없음'}): 역할이 0개입니다`);
  }
  for (const r of checked) {
    if (r.engine === 'glm' && Array.isArray(r.tools) && r.tools.includes('higgsfield')) {
      warnings.push(`역할 "${r.id}": glm 역할인데 tools에 higgsfield가 있습니다(GLM 작업자는 생성 도구를 직접 호출할 수 없습니다)`);
    }
    if (typeof r.brief !== 'string' || !r.brief.trim()) warnings.push(`역할 "${r.id}": brief이 없습니다`);
  }
  return { errors, warnings };
}

const allRoles = org => (Array.isArray(org?.roles) ? org.roles : []).filter(r => r && r.id);
const deptNameOf = (org, id) => (org?.departments || []).find(d => d?.id === id)?.name || (id || '?');
const childRoles = (org, id) => allRoles(org).filter(r => r.reports_to === id);
const roleById = (org, id) => allRoles(org).find(r => r.id === id);
const reportsLabel = (org, rt) => rt === 'director' ? '디렉터(메인 세션 — 사용자)'
  : rt ? `${rt} (${roleById(org, rt)?.name || '?'})` : '디렉터(미지정)';
const modelLabel = r => [r.engine, r.model, r.effort].filter(Boolean).join(' · ');

/** .claude/agents/<id>.md 내용(머리말 + 표식 + 본문) */
export function renderAgent(role, org) {
  const dept = deptNameOf(org, role.dept);
  const out = ['---',
    `name: ${role.id}`,
    `description: ${yamlScalar(oneLine(`${dept} · ${role.name} — ${role.when}`))}`,
    `model: ${role.model}`,
    '---',
    MARKER_LINE,
    '',
    `# ${role.name} (${dept})`,
    '',
    `보고 대상: ${reportsLabel(org, role.reports_to)}`];
  if (Array.isArray(role.tools) && role.tools.length) out.push(`사용 도구: ${role.tools.join(', ')}`);
  out.push('', '## 함께 일하는 역할');
  const kids = childRoles(org, role.id);
  if (!kids.length) out.push('- 직속 하위 역할 없음');
  for (const k of kids) {
    const tail = isGlm(k) ? ` — glm-delegate 명세 머리말에 \`persona: ${k.id}\`를 적어 맡긴다` : '';
    out.push(`- ${k.id} (${k.name}, ${k.engine})${tail}`);
  }
  if (Array.isArray(role.duties) && role.duties.length) { out.push('', '## 책임'); role.duties.forEach(d => out.push(`- ${d}`)); }
  if (Array.isArray(role.outputs) && role.outputs.length) { out.push('', '## 산출물'); role.outputs.forEach(o => out.push(`- ${o}`)); }
  out.push('', '## 지침', '');
  out.push(typeof role.brief === 'string' && role.brief.trim()
    ? role.brief.trim() : '(brief 없음 — .studio/org.json에 brief을 추가하고 sync하세요)');
  return out.join('\n') + '\n';
}

/** .studio/roles/<id>.md 내용(GLM 작업자 프롬프트에 붙는 역할 지침, 머리말 없음) */
export function renderPersona(role, org) {
  const dept = deptNameOf(org, role.dept);
  const out = [MARKER_LINE, '',
    `# ${role.name} (${dept}) — persona ${role.id}`, '',
    `너는 게임 스튜디오 조직의 ${role.name}(${role.id}, ${dept} 부서)다. 상위 역할이 내린 명세를 받아 일하고 보고서 형식으로 결과를 보고한다.`, '',
    `보고 대상: ${reportsLabel(org, role.reports_to)}`];
  if (Array.isArray(role.tools) && role.tools.length) out.push(`참고 도구: ${role.tools.join(', ')}`);
  if (Array.isArray(role.duties) && role.duties.length) { out.push('', '## 책임'); role.duties.forEach(d => out.push(`- ${d}`)); }
  if (Array.isArray(role.outputs) && role.outputs.length) { out.push('', '## 산출물'); role.outputs.forEach(o => out.push(`- ${o}`)); }
  out.push('', '## 지침', '');
  out.push(typeof role.brief === 'string' && role.brief.trim()
    ? role.brief.trim() : '(brief 없음 — .studio/org.json에 brief을 추가하고 sync하세요)');
  return out.join('\n') + '\n';
}

/** reports_to 기준 트리(형제는 org 순서). 사이클·미배치에도 멈추지 않게 placed로 막는다 */
export function renderTreeLines(org) {
  const roles = allRoles(org);
  const placed = new Set(), lines = [];
  const walk = (id, depth) => {
    for (const r of roles) {
      if (placed.has(r.id) || r.reports_to !== id) continue;
      placed.add(r.id);
      lines.push(`${'  '.repeat(depth)}- ${r.name} \`${r.id}\` · ${isGlm(r) ? 'glm' : 'claude'}`);
      walk(r.id, depth + 1);
    }
  };
  lines.push(`- ${org?.director?.name || '디렉터'} (메인 세션 — 총괄)${org?.director?.note ? ` — ${org.director.note}` : ''}`);
  walk('director', 1);
  for (const r of roles) if (!placed.has(r.id)) lines.push(`- ${r.name} \`${r.id}\` · (reports_to 미배치)`);
  return lines;
}

/** .studio/ORG.md 내용(트리 + 부서별 표) */
export function renderOrgMd(org) {
  const out = [MARKER_LINE, '',
    `# ${org?.name || '게임 스튜디오'} 조직도`, '',
    '> 이 파일은 생성물입니다. 직접 고치지 말고 `.studio/org.json`을 고친 뒤 `node studio.mjs sync`를 돌리세요.', '',
    '## 조직 트리', '', ...renderTreeLines(org)];
  for (const d of org?.departments || []) {
    out.push('', `## ${d?.name || '?'} (${d?.id})`, '');
    if (d?.mission) out.push(`미션: ${d.mission}`, '');
    const rs = allRoles(org).filter(r => r.dept === d.id);
    if (!rs.length) { out.push('(역할 없음)'); continue; }
    out.push('| 역할 | engine · model · effort | 언제 |', '|---|---|---|');
    for (const r of rs) out.push(`| ${r.name} \`${r.id}\` | ${modelLabel(r)} | ${oneLine(r.when)} |`);
  }
  return out.join('\n') + '\n';
}

/** 폴더 CLAUDE.md에 들어갈 구간 본문(표식 제외). 디렉터(메인 세션)가 읽는 운영 규칙 */
export function renderClaudeSection(org) {
  const out = ['## 게임 스튜디오 조직도 모드', '',
    `이 폴더는 게임 스튜디오 조직도 모드다. 너(메인 세션)는 디렉터이고 사용자는 대표다. 조직도 원본은 \`.studio/org.json\`, 조직도 그림은 \`.studio/ORG.md\`다.${org?.director?.note ? ` 디렉터 노트: ${oneLine(org.director.note)}` : ''}`, '',
    '일 나누기(보고 라인을 따른다):',
    '- Claude 역할: Agent 도구에 `subagent_type: <id>`로 부른다.',
    '- GLM 역할: glm-delegate 스킬로 맡긴다. 명세 머리말에 `persona: <id>`를 적으면 조직도의 모델·effort가 기본으로 쓰인다.',
    '- 부서장(Claude 역할)이 방향·명세·리뷰를 맡고, 그 아래 GLM 역할이 실행을 맡는다.', '',
    '| 부서 | id | 이름 | engine · model | 언제 |', '|---|---|---|---|---|'];
  for (const r of allRoles(org)) {
    out.push(`| ${deptNameOf(org, r.dept)} | ${r.id} | ${r.name} | ${[r.engine, r.model].filter(Boolean).join(' · ')} | ${oneLine(r.when)} |`);
  }
  out.push('',
    '## 조직 확장 절차', '',
    '사용자 승인 없이 역할을 늘리거나 모델을 올리지 않는다.',
    '1. 사용자와 의논해 필요한 역할·부서를 정한다(왜 필요한지, 어느 엔진·모델이 맞는지 — 판단이 필요한 일은 claude, 양이 많은 실행은 glm).',
    '2. `.studio/org.json`을 고친다.',
    '3. `node "$STUDIO_TOOL" sync`를 돌린다(PowerShell은 `node $env:STUDIO_TOOL sync`).',
    '4. 새 Claude 역할은 다음 세션부터 Agent 목록에 보인다고 사용자에게 알린다.', '',
    '## 규칙', '',
    '- 생성물(`studio:generated` 표식이 있는 파일: `.claude/agents/`, `.studio/roles/`, `.studio/ORG.md`, 이 구간)은 직접 고치지 않는다. `.studio/org.json`을 고친 뒤 sync한다.',
    '- Higgsfield(이미지·영상·음악 생성): 프롬프트는 `.studio/prompts/`에 기록하고 `.studio/prompts/style-guide.md`를 따른다. 생성 전에 예상 크레딧을 보여 주고 사용자의 승인을 받는다.');
  return out.join('\n');
}

const SEC_BLOCK_RE = new RegExp(`${SEC_START}\\r?\\n[\\s\\S]*?${SEC_END}`);
const SEC_BROKEN_RE = new RegExp(`${SEC_START}(\\r?\\n[\\s\\S]*)?$`);

/** 표식 사이 구간을 section으로 교체하고, 표식이 없으면 끝에 추가(앞에 빈 줄 하나). 바깥은 한 글자도 바꾸지 않고 줄바꿈 방식(CRLF/LF)을 유지한다. */
export function applySection(text, section) {
  const cur = String(text ?? '');
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const body = String(section ?? '').replace(/\r?\n/g, '\n').replace(/^\n+|\n+$/g, '');
  const block = [SEC_START, body, SEC_END].join('\n').replace(/\n/g, eol);
  if (SEC_BLOCK_RE.test(cur)) return cur.replace(SEC_BLOCK_RE, () => block);
  if (SEC_BROKEN_RE.test(cur)) return cur.replace(SEC_BROKEN_RE, () => block) + eol;
  if (!cur) return block;
  return cur + (cur.endsWith('\n') ? '' : eol) + (cur.trim() ? eol : '') + block;
}

/** JSON 텍스트에서 처음 구문이 어긋나는 근사 위치(line·column). V8 메시지에 position이 없을 때 보조로 쓴다 */
function jsonErrorPos(text) {
  let i = 0, line = 1, col = 0;
  const st = []; // { t: 'o'|'a', want: 'k'|'v'|'c' } — k: 키, v: 값, c: 쉼표·닫기
  const fail = () => ({ line, col });
  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t') { i++; col++; }
      else if (c === '\n') { i++; line++; col = 0; }
      else if (c === '\r') { i++; }
      else break;
    }
  };
  const lit = w => { for (const ch of w) { if (text[i] !== ch) return false; i++; col++; } return true; };
  const str = () => {
    if (text[i] !== '"') return false;
    i++; col++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n' || text[i] === '\r') return false;
      if (text[i] === '\\') { i += 2; col += 2; continue; }
      i++; col++;
    }
    if (text[i] !== '"') return false;
    i++; col++;
    return true;
  };
  const num = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) return false;
    i += m[0].length; col += m[0].length;
    return true;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') { st.push({ t: 'o', want: 'k' }); i++; col++; return true; }
    if (c === '[') { st.push({ t: 'a', want: 'v' }); i++; col++; return true; }
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    return num();
  };
  for (;;) {
    ws();
    if (i >= text.length) return fail();
    const top = st[st.length - 1], c = text[i];
    if (!top) { // 최상위: 값 하나뿐
      if (!value()) return fail();
      ws();
      return i < text.length ? fail() : null;
    }
    if (top.t === 'o' && top.want === 'k') {
      if (c === '}') { st.pop(); i++; col++; continue; }
      if (c !== '"' || !str()) return fail();
      ws();
      if (text[i] !== ':') return fail();
      i++; col++;
      top.want = 'v';
      continue;
    }
    if (top.want === 'c') { // 값 뒤: 쉼표 또는 닫기
      const close = top.t === 'o' ? '}' : ']';
      if (c === ',') { i++; col++; top.want = top.t === 'o' ? 'k' : 'v'; continue; }
      if (c === close) { st.pop(); i++; col++; continue; }
      return fail();
    }
    if (top.t === 'o' && c === '}') return fail(); // 값 자리에 닫기
    if (!value()) return fail();
    top.want = 'c';
  }
}

/** org.json 읽기(BOM 허용). JSON 문법 오류는 줄 위치를 담아 던진다 */
function loadOrg(dir) {
  const file = path.join(dir, '.studio', 'org.json');
  const raw = readText(file);
  if (raw === null) throw new Error(`\`.studio/org.json\`을 찾을 수 없습니다: ${file}. \`node studio.mjs ensure\`를 먼저 실행하세요`);
  const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw; // 65279 = BOM(U+FEFF)
  let org;
  try { org = JSON.parse(text); }
  catch (e) {
    const m = /position (\d+)/.exec(String(e.message));
    let p = null;
    if (m) {
      const off = Math.min(Number(m[1]), text.length);
      const upto = text.slice(0, off);
      p = { line: upto.split('\n').length, col: off - upto.lastIndexOf('\n') };
    } else p = jsonErrorPos(text);
    const at = p ? ` (line ${p.line}, column ${p.col})` : '';
    throw new Error(`\`.studio/org.json\` JSON 문법 오류${at}: ${e.message}`);
  }
  return org;
}

const STYLE_GUIDE_TPL = `# 스타일 가이드(생성 프롬프트 공통 기준)

이 파일은 ensure가 처음 한 번만 만드는 템플릿이다. 자유롭게 고친다. 이미지·영상·3D·사운드 생성 역할은 모든 프롬프트를 이 기준에 맞춘다.

## 화풍(이미지·영상·3D)
- (예: 저폴리곤 / 셀 셰이딩 / 사실적 — 게임 전체의 묘사 방식)

## 팔레트
- 주색: HEX
- 보조색: HEX
- 강조색: HEX
- 사용 규칙(명암·채도 제한):

## 카메라
- 기본 구도·초점 거리·앵글 선호:

## 금지 요소
- (예: 실존 인물·로고·워터마크·특정 게임의 캐릭터·텍스트 오버레이)

## 사운드 톤·악기(사운드 생성)
- 톤(감정·시대감·밀도):
- 악기·재질:

## 음량 기준
- BGM·SFX·음성 상대 음량, 다이내믹스:

## 작성 안내
- 한 항목은 한 문장 이상으로 구체적으로 쓴다. 비어 있으면 생성 역할이 임의로 정하지 않고 비어 있다고 보고한다.
- 프롬프트 기록 양식과 폴더 규칙은 .studio/prompts/README.md를 따른다.
`;

const PROMPTS_README_TPL = `# .studio/prompts/ — 생성 프롬프트 기록

생성 역할(prompt-artist, sound-designer, trailer-producer)은 프롬프트를 생성 전에 여기에 저장한다.
같은 캐릭터·장소는 참조 이미지·시드를 재사용해 일관성을 지킨다. 기존 게임·작품의 캐릭터·로고·화풍 이름을 프롬프트에 넣지 않는다.

## 폴더 규칙
- image/ — 캐릭터·환경·아이콘 등 정지 이미지
- video/ — 컷·모션 영상
- 3d/ — 3D 모델·턴테이블
- sound/ — 효과음·환경음·음악·음성
- marketing/ — 트레일러·광고 소재

## 기록 양식(<이름>.md)
~~~markdown
# <이름> (<용도>)
- 요청 역할·명세:
- 프롬프트 원문:
- 모델·설정(해상도·길이·시드 등):
- 참조 이미지·시드:
- 결과 링크:
- 채택 여부: 채택 | 재시도(n) | 기각
~~~
`;

/** org.json으로 생성물을 만들거나 정리한다. errors가 있으면 아무것도 쓰지 않고 던진다 */
export function syncStudio(dir) {
  const root = path.resolve(dir || process.cwd());
  const org = loadOrg(root);
  const { errors, warnings } = validateOrg(org);
  if (errors.length) throw new Error(`조직도 검증 오류 ${errors.length}건:\n- ${errors.join('\n- ')}`);
  const rel = p => fwd(path.relative(root, p));
  const written = [], removed = [], kept = [];
  const writeAtomic = (abs, content) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.studio-tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
  };

  // 생성물 대상: glm 역할 → .studio/roles/<id>.md, claude 역할 → .claude/agents/<id>.md, ORG.md, CLAUDE.md 구간
  const targets = allRoles(org).map(r => isGlm(r)
    ? { file: path.join(root, '.studio', 'roles', `${r.id}.md`), content: renderPersona(r, org) }
    : { file: path.join(root, '.claude', 'agents', `${r.id}.md`), content: renderAgent(r, org) });
  targets.push({ file: path.join(root, '.studio', 'ORG.md'), content: renderOrgMd(org) });

  // 덮어쓰기 규칙: 표식 없는 기존 파일은 사용자 작성이므로 kept + 경고. 내용이 같으면 쓰지 않는다
  for (const t of targets) {
    const cur = readText(t.file);
    if (cur === t.content) continue;
    if (cur !== null && !cur.includes(MARK)) {
      kept.push(rel(t.file));
      warnings.push(`"${rel(t.file)}": 사용자가 작성한 것으로 보아 건드리지 않았습니다(${MARK} 표식 없음)`);
      continue;
    }
    writeAtomic(t.file, t.content);
    written.push(rel(t.file));
  }

  // CLAUDE.md는 구간만 교체(구간 밖 보존). 구간이 없으면 끝에 추가
  const claudeMd = path.join(root, 'CLAUDE.md');
  const curMd = readText(claudeMd);
  const nextMd = applySection(curMd ?? '', renderClaudeSection(org));
  if (curMd !== nextMd) { writeAtomic(claudeMd, nextMd); written.push(rel(claudeMd)); }

  // 정리 규칙: 표식 있는 생성물 중 현재 조직에 없는 역할(다른 engine 포함)의 파일만 삭제
  const expected = new Set(allRoles(org).map(r => isGlm(r)
    ? `.studio/roles/${r.id}.md` : `.claude/agents/${r.id}.md`));
  for (const seg of [['.claude', 'agents'], ['.studio', 'roles']]) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, ...seg), { withFileTypes: true }); } catch { /* 폴더 없음 */ }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const key = `${seg.join('/')}/${e.name}`;
      const cur = readText(path.join(root, ...seg, e.name));
      if (cur === null || !cur.includes(MARK) || expected.has(key)) continue;
      fs.unlinkSync(path.join(root, ...seg, e.name));
      removed.push(key);
    }
  }
  return { written, removed, kept, warnings };
}

/** 최초 시딩: org.json·프롬프트 템플릿이 없으면 기본값으로 쓰고 sync한다. org가 깨져 있어도 던지지 않는다(세션 시작을 막지 않음) */
export function ensureStudio(dir) {
  const root = path.resolve(dir || process.cwd());
  const studioDir = path.join(root, '.studio');
  let seeded = false;
  if (readText(path.join(studioDir, 'org.json')) === null) {
    fs.mkdirSync(studioDir, { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'org.json'), JSON.stringify(defaultOrg(), null, 2) + '\n');
    seeded = true;
  }
  for (const [name, tpl] of [['style-guide.md', STYLE_GUIDE_TPL], ['README.md', PROMPTS_README_TPL]]) {
    const f = path.join(studioDir, 'prompts', name);
    if (readText(f) === null) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, tpl); }
  }
  try { return { seeded, ...syncStudio(root) }; }
  catch (e) { return { seeded, written: [], removed: [], kept: [], warnings: [String(e?.message || e)] }; }
}

const USAGE = `사용법: node studio.mjs <ensure|sync|validate|show> [dir]
  ensure    조직도·프롬프트 템플릿이 없으면 기본값으로 만들고 sync한다
  sync      .studio/org.json으로 생성물을 만들거나 정리한다
  validate  조직도를 검증한다(오류·경고 출력)
  show      조직도 트리를 표준 출력으로 보여 준다
  dir       대상 폴더(기본: 현재 폴더)`;

function main(argv) {
  const out = s => process.stdout.write(s + '\n');
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { out(USAGE); return; }
  const dir = argv[1] || process.cwd();
  if (cmd === 'validate') {
    const { errors, warnings } = validateOrg(loadOrg(dir));
    for (const e of errors) out(`  ✕ ${e}`);
    for (const w of warnings) out(`  ⚠ ${w}`);
    if (errors.length) { out(`오류 ${errors.length}건, 경고 ${warnings.length}건`); process.exitCode = 1; }
    else out(`✓ 오류 없음${warnings.length ? ` (경고 ${warnings.length}건)` : ''}`);
    return;
  }
  if (cmd === 'show') { out(renderTreeLines(loadOrg(dir)).join('\n')); return; }
  if (cmd === 'ensure' || cmd === 'sync') {
    const r = cmd === 'ensure' ? ensureStudio(dir) : syncStudio(dir);
    out(`${cmd === 'ensure' && r.seeded ? '✓ .studio/org.json을 기본 조직도로 새로 만들었습니다' : '✓ 완료'} — ${dir}`);
    const list = (label, items) => { if (items.length) { out(`${label} ${items.length}건:`); items.forEach(p => out(`  - ${p}`)); } };
    list('쓴 파일', r.written);
    list('지운 파일', r.removed);
    list('건드리지 않은 파일(사용자 작성)', r.kept);
    if (r.warnings.length) { out(`경고 ${r.warnings.length}건:`); r.warnings.forEach(w => out(`  ⚠ ${w}`)); }
    return;
  }
  process.stderr.write(`알 수 없는 명령: ${cmd}\n\n${USAGE}\n`);
  process.exitCode = 1;
}

// 임포트될 때는 CLI가 돌지 않게 한다(Windows 경로 비교는 pathToFileURL로)
const isMain = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try { main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`✕ ${e?.message || e}\n`); process.exitCode = 1; }
}
