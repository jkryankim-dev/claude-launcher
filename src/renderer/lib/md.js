'use strict';
// 작은 마크다운 렌더러(의존성 없음): 입력을 먼저 HTML 이스케이프한 뒤 변환해
// 원본 HTML 태그·이벤트 속성·javascript: 링크가 절대 살아남지 않게 한다.
// 브라우저(window.MD)와 Node(module.exports) 둘 다에서 쓴다. DOM에 의존하지 않는 순수 함수.
// 지원: 제목(#~####) · 굵게·기울임·취소선 · 인라인 코드 · 코드 블록(언어 표시·복사 버튼) ·
//       목록(순서·비순서·중첩·체크박스) · 인용 · 표(GFM) · http(s) 링크 · 가로줄 · 줄바꿈.
// 스트리밍 중간 상태(닫히지 않은 코드 펜스·행이 모자란 표)도 깨지지 않게 그린다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MD = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

  const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
  const CLOSE_RE = /^(`{3,}|~{3,})\s*$/;
  const HEAD_RE = /^ {0,3}(#{1,4})(?:\s+(.*?))?\s*#*\s*$/;
  const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const QUOTE_RE = /^ {0,3}&gt;\s?/;
  const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
  const CHECK_RE = /^\[([ xX])\]\s+/;
  const URL_RE = /^https?:\/\//i;

  // ── 인라인: 코드 → 링크 → 강조 → 자리표시자 복원. 자리표시자(\u0001·\u0002)는 입력에서 미리 뺀다.
  function inline(src) {
    const codes = [], links = [];
    let t = String(src).replace(/`([^`]+)`/g, (_m, c) => `\u0001C${codes.push(c) - 1}\u0001`);
    t = t.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (m, label, url) => {
      const u = String(url).trim().split(/\s+/)[0];
      const html = URL_RE.test(u)
        ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${inline(label)}</a>`
        : m; // http(s)가 아니면 링크로 만들지 않고 글자 그대로 보여 준다
      return `\u0001L${links.push(html) - 1}\u0001`;
    });
    t = t
      .replace(/\*\*\*([^\n*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^\n*]+)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/__([^\n_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w_])_([^\n_]+)_(?![\w_])/g, '$1<em>$2</em>')
      .replace(/~~([^\n~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0001L(\d+)\u0001/g, (_m, i) => links[i]);
    return t.replace(/\u0001C(\d+)\u0001/g, (_m, i) => `<code>${codes[i]}</code>`);
  }

  function isBlockStart(line) {
    return FENCE_RE.test(line) || HEAD_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line);
  }

  // ── 목록: 들여쓰기 2칸을 1단계로, 건너뛰는 들여쓰기는 한 단계씩만 내려간다.
  function renderList(items) {
    let html = '';
    const stack = []; // 열려 있는 목록들의 순서(unordered)
    let prev = -1;
    const closePair = () => (stack.pop() ? '</ol></li>' : '</ul></li>');
    for (const it of items) {
      let lvl = Math.floor(it.indent / 2);
      if (prev < 0) lvl = 0;
      else if (lvl > prev + 1) lvl = prev + 1;
      if (lvl === prev) { if (stack.length) html += '</li>'; }
      else if (lvl < prev) {
        html += '</li>'; // 현재 항목을 닫고 (리스트 + 부모 항목) 쌍으로 닫는다
        while (stack.length > lvl + 1) html += closePair();
      }
      if (lvl === stack.length) {
        const start = it.ordered && it.start > 1 ? ` start="${it.start}"` : '';
        html += it.ordered ? `<ol${start}>` : '<ul>';
        stack.push(it.ordered);
      }
      const cm = CHECK_RE.exec(it.rest);
      const body = cm
        ? `<input type="checkbox" disabled${cm[1] === ' ' ? '' : ' checked'}> ${inline(it.rest.slice(cm[0].length))}`
        : inline(it.rest);
      html += `<li>${body}`;
      prev = lvl;
    }
    if (stack.length) html += '</li>';
    while (stack.length > 1) html += closePair();
    if (stack.length) html += stack.pop() ? '</ol>' : '</ul>';
    return html;
  }

  // ── 표(GFM): 헤더 행 다음 줄이 구분 행일 때만 표로 본다. 행이 모자라도 그대로 그린다.
  function splitRow(line) {
    let s = line.trim().replace(/\\\|/g, '\u0002');
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim().replace(/\u0002/g, '|'));
  }
  function isDelimRow(line) {
    if (!line.includes('|') || !line.includes('-')) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every(c => /^:?\s*-{1,}\s*:?$/.test(c));
  }
  function tableAt(lines, i) {
    if (!lines[i].includes('|') || i + 1 >= lines.length || !isDelimRow(lines[i + 1])) return null;
    const aligns = splitRow(lines[i + 1]).map(c => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : 'left';
    });
    const head = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim() && lines[j].includes('|') && !isBlockStart(lines[j])) {
      rows.push(splitRow(lines[j]));
      j++;
    }
    const n = Math.max(head.length, aligns.length);
    const cell = (c, a, tag) => `<${tag}${a && a !== 'left' ? ` style="text-align:${a}"` : ''}>${inline(c)}</${tag}>`;
    let html = `<div class="md-table-wrap"><table><thead><tr>${head.map((c, k) => cell(c, aligns[k], 'th')).join('')}</tr></thead>`;
    if (rows.length) html += `<tbody>${rows.map(r => `<tr>${Array.from({ length: n }, (_v, k) => cell(r[k] ?? '', aligns[k], 'td')).join('')}</tr>`).join('')}</tbody>`;
    return { html: `${html}</table></div>`, next: j };
  }

  // ── 블록 단위 변환. lines는 이미 이스케이프된 줄 배열.
  function renderBlocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = FENCE_RE.exec(line))) {
        const mark = m[1][0];
        const lang = String(m[2] || '').trim();
        const body = [];
        i++;
        while (i < lines.length) {
          const cm = CLOSE_RE.exec(lines[i]);
          if (cm && cm[1][0] === mark && cm[1].length >= m[1].length) break;
          body.push(lines[i]);
          i++;
        }
        i++; // 닫는 펜스(또는 끝)를 지난다
        out.push(`<div class="md-code"><div class="md-code-bar"><span class="md-lang">${lang || '코드'}</span><button type="button" class="md-copy" aria-label="코드 복사">복사</button></div><pre><code>${body.join('\n')}</code></pre></div>`);
        continue;
      }
      if ((m = HEAD_RE.exec(line))) {
        const lv = m[1].length;
        out.push(`<h${lv}>${inline(m[2] || '')}</h${lv}>`);
        i++;
        continue;
      }
      if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }
      if (QUOTE_RE.test(line)) {
        const q = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) { q.push(lines[i].replace(QUOTE_RE, '')); i++; }
        out.push(`<blockquote>${renderBlocks(q)}</blockquote>`);
        continue;
      }
      const tb = tableAt(lines, i);
      if (tb) { out.push(tb.html); i = tb.next; continue; }
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < lines.length) {
          const lm = LIST_RE.exec(lines[i]);
          if (!lm) break;
          items.push({ indent: lm[1].length, ordered: !!lm[3], start: lm[3] ? Number(lm[3]) : 1, rest: lm[4] });
          i++;
        }
        out.push(renderList(items));
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !tableAt(lines, i)) { para.push(lines[i]); i++; }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  /** 마크다운 문자열 → HTML 문자열. 모든 입력은 먼저 이스케이프된다. */
  function renderMarkdown(src) {
    const text = String(src ?? '').replace(/[\u0000\u0001\u0002]/g, '').replace(/\r\n?/g, '\n');
    return renderBlocks(esc(text).split('\n'));
  }

  return { renderMarkdown };
});
