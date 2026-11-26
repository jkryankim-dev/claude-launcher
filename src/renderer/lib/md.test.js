'use strict';
// 마크다운 렌더러 테스트: src/renderer/lib/md.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('./md');

const has = (html, s) => html.includes(s);
const no = (html, s) => !html.includes(s);

test('빈 입력·null·undefined', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
  assert.equal(renderMarkdown('\n\n\n'), '');
});

test('제목 #~#### 과 꼬리 #', () => {
  assert.equal(renderMarkdown('# 제목'), '<h1>제목</h1>');
  assert.equal(renderMarkdown('## 제목'), '<h2>제목</h2>');
  assert.equal(renderMarkdown('#### 넷째'), '<h4>넷째</h4>');
  assert.equal(renderMarkdown('## 제목 ##'), '<h2>제목</h2>');
  assert.equal(renderMarkdown('#띄어쓰기없음'), '<p>#띄어쓰기없음</p>');
  assert.equal(renderMarkdown('##### 다섯개'), '<p>##### 다섯개</p>');
});

test('굵게·기울임·취소선·인라인 코드', () => {
  assert.equal(renderMarkdown('**굵게**'), '<p><strong>굵게</strong></p>');
  assert.equal(renderMarkdown('*기울임*'), '<p><em>기울임</em></p>');
  assert.equal(renderMarkdown('***둘다***'), '<p><strong><em>둘다</em></strong></p>');
  assert.equal(renderMarkdown('~~취소~~'), '<p><del>취소</del></p>');
  assert.equal(renderMarkdown('__밑줄굵게__'), '<p><strong>밑줄굵게</strong></p>');
  assert.equal(renderMarkdown('a_b_c'), '<p>a_b_c</p>', '단어 안 밑줄은 기울임 아님');
  assert.equal(renderMarkdown('`<b>코드</b>`'), '<p><code>&lt;b&gt;코드&lt;/b&gt;</code></p>');
  assert.equal(renderMarkdown('굵고 *기울* 섞기'), '<p>굵고 <em>기울</em> 섞기</p>');
});

test('코드 블록: 언어 표시·복사 버튼·내부 HTML 이스케이프', () => {
  const h = renderMarkdown('```js\nconst a = "<b>";\n```');
  assert.ok(has(h, '<div class="md-code">'));
  assert.ok(has(h, '<span class="md-lang">js</span>'));
  assert.ok(has(h, '<button type="button" class="md-copy"'));
  assert.ok(has(h, '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>'));
  const h2 = renderMarkdown('~~~\n평문\n~~~');
  assert.ok(has(h2, '<span class="md-lang">코드</span>'));
  assert.ok(has(h2, '<pre><code>평문</code></pre>'));
});

test('닫히지 않은 코드 펜스도 깨지지 않는다', () => {
  const h = renderMarkdown('스트리밍 중\n```python\nprint(1)');
  assert.ok(has(h, '<p>스트리밍 중</p>'));
  assert.ok(has(h, '<span class="md-lang">python</span>'));
  assert.ok(has(h, 'print(1)'));
  assert.ok(no(h, '<script'), '펜스 안 HTML이 태그로 해석되지 않음');
});

test('펜스보다 짧은 닫는 표시는 본문으로', () => {
  const h = renderMarkdown('````\n```\n계속 본문\n````');
  assert.ok(has(h, '```'), '안쪽 3개 펜스는 본문');
});

test('목록: 순서·비순서·중첩·시작 번호·체크박스', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('* a\n* b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(
    renderMarkdown('- a\n  - b\n  - c\n- d'),
    '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>',
    '2단 중첩'
  );
  const h = renderMarkdown('- [ ] 할 일\n- [x] 끝낸 일');
  assert.ok(has(h, '<input type="checkbox" disabled>'));
  assert.ok(has(h, '<input type="checkbox" disabled checked>'));
  assert.ok(has(h, '할 일'), '체크박스 뒤 본문');
});

test('인용·가로줄·줄바꿈·문단', () => {
  assert.equal(renderMarkdown('> 인용'), '<blockquote><p>인용</p></blockquote>');
  assert.equal(renderMarkdown('> 인용\n> 두줄'), '<blockquote><p>인용<br>두줄</p></blockquote>');
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('***'), '<hr>');
  assert.equal(renderMarkdown('첫줄\n둘째줄'), '<p>첫줄<br>둘째줄</p>');
  assert.equal(renderMarkdown('문단1\n\n문단2'), '<p>문단1</p><p>문단2</p>');
});

test('표(GFM): 정렬·행이 모자랄 때·셀 안 인라인 문법·셀 안 HTML', () => {
  const h = renderMarkdown('| 이름 | 값 |\n| --- | ---: |\n| a | 1 |\n| **b** | `2` |');
  assert.ok(has(h, '<table>'), '표 생성');
  assert.ok(has(h, '<thead>'));
  assert.ok(has(h, '<th style="text-align:right">값</th>'), '오른쪽 정렬');
  assert.ok(has(h, '<td>a</td>'));
  assert.ok(has(h, '<strong>b</strong>'), '셀 안 굵게');
  assert.ok(has(h, '<code>2</code>'), '셀 안 코드');
  const h2 = renderMarkdown('| a | b |\n| --- | --- |');
  assert.ok(has(h2, '<thead>'), '행 없는 표도 깨지지 않음');
  assert.ok(no(h2, '<tbody>'));
  const h3 = renderMarkdown('| <img src=x> |\n| --- |\n| <script> |');
  assert.ok(no(h3, '<img'), '표 셀 안 HTML 태그 제거');
  assert.ok(no(h3, '<script'));
  assert.ok(has(h3, '&lt;img src=x&gt;'));
});

test('링크: http(s)만, 나머지는 글자 그대로', () => {
  const ok1 = renderMarkdown('[사이트](https://example.com/a?b=1&c=2)');
  assert.ok(has(ok1, '<a href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(has(ok1, 'target="_blank"'));
  assert.ok(has(ok1, 'rel="noopener noreferrer"'));
  assert.ok(has(ok1, '>사이트</a>'));
  const ok2 = renderMarkdown('[x](http://example.com)');
  assert.ok(has(ok2, '<a href="http://example.com"'));
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(renderMarkdown('[x](data:text/html,<b>)'), '<p>[x](data:text/html,&lt;b&gt;)</p>');
  assert.equal(renderMarkdown('[x](ftp://a.com)'), '<p>[x](ftp://a.com)</p>');
  assert.equal(renderMarkdown('[x]()'), '<p>[x]()</p>');
  const bold = renderMarkdown('[**굵게 링크**](https://a.com)');
  assert.ok(has(bold, '<a href="https://a.com"'));
  assert.ok(has(bold, '><strong>굵게 링크</strong></a>'));
});

test('XSS: 태그·속성·스크립트가 살아남지 않는다', () => {
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">클릭</a>',
    '<a href="JaVaScRiPt:alert(1)">클릭</a>',
    '<a href=" javascript:alert(1)">클릭</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">클릭</a>',
    '<a href="vbscript:msgbox(1)">클릭</a>',
    '<div onclick="alert(1)">x</div>',
    '<div onmouseover=alert(1)>x</div>',
    '<body onload=alert(1)>',
    '" onmouseover="alert(1)',
    "' onclick='alert(1)",
    '<span class="x" title="&quot; onmouseover=&quot;alert(1)">y</span>',
    '<form action="javascript:alert(1)"><input></form>',
    '<video><source onerror="alert(1)"></video>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<textarea></textarea><script>alert(1)</script>',
    '## <img src=x onerror=attack> 제목',
    '- <a href="javascript:alert(1)">목록</a>',
    '> <script>alert(1)</script>',
    '<a href="https://x.com" target="_blank" onmouseover="attack">y</a>',
    '```\n<img src=x onerror=alert(1)>\n```\n<svg onload=attack>',
    '| <img src=x> |\n| --- |\n| <svg onload=attack> |',
    '[x](https://ok.com/" onmouseover="attack)',
    '[<img src=x>](https://ok.com)',
  ];
  // 이스케이프를 거쳤으니 공격 문장은 글자로만 남는다. 살아 있는 태그·위험 속성이 있는지 검사한다.
  const TAGS = ['<script', '<img', '<svg', '<iframe', '<body', '<form', '<video', '<source', '<math', '<mtext', '<mglyph', '<style', '<textarea', '<input>'];
  for (const v of vectors) {
    const h = renderMarkdown(v);
    for (const bad of TAGS) assert.ok(no(h, bad), `태그가 살아남: ${bad} / 입력: ${v}`);
    const hrefs = h.match(/href="([^"]*)"/g) || [];
    for (const x of hrefs) assert.ok(/^href="https?:/.test(x), `href가 http(s)가 아님: ${x} / 입력: ${v}`);
    assert.ok(no(h, '="alert(1)"'), `속성 값이 그대로 주입됨: ${v}`);
    assert.ok(no(h, '=attack"'), `속성 값이 그대로 주입됨: ${v}`);
    assert.ok(no(h, 'action="'), `form action 속성이 살아남: ${v}`);
  }
  // 이스케이프 확인: 위험 문장이 눈에 보이는 글자로 남는다
  assert.ok(has(renderMarkdown('<script>alert(1)</script>'), '&lt;script&gt;'));
  assert.ok(has(renderMarkdown('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;'));
});

test('XSS: 코드 블록·인라인 코드 안의 공격 문장은 글자로 보인다', () => {
  const h = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(has(h, '&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(no(h, '<img'));
  const h2 = renderMarkdown('설명 `<a href="javascript:x">악</a>` 끝');
  assert.ok(has(h2, '<code>&lt;a href=&quot;javascript:x&quot;&gt;악&lt;/a&gt;</code>'));
  assert.ok(no(h2, 'href="javascript'));
});

test('XSS: 속성 주입 시도는 이스케이프된 채 문자열로만 남는다', () => {
  const h = renderMarkdown('" autofocus onfocus=alert(1) x="');
  assert.ok(has(h, '&quot; autofocus'), '따옴표가 이스케이프됨');
  assert.ok(no(h, '="alert'), '속성 값으로 해석되지 않음');
  const h2 = renderMarkdown('[x](https://a.com/" onmouseover="alert(1))');
  assert.ok(has(h2, 'href="https://a.com/&quot;"'), 'URL 안 따옴표가 이스케이프됨');
  assert.ok(no(h2, '="alert'), '속성 주입 안 됨');
});

test('경계: 매우 긴 줄·제어 문자·CRLF', () => {
  const long = 'a'.repeat(50000);
  assert.equal(renderMarkdown(long), `<p>${long}</p>`);
  assert.equal(renderMarkdown('a\r\nb'), '<p>a<br>b</p>');
  assert.equal(renderMarkdown('a\rb'), '<p>a<br>b</p>');
  const h2 = renderMarkdown('a\u0000b\u0001c\u0002d');
  assert.equal(h2, '<p>abcd</p>', '자리표시자 문자는 제거');
});

test('조합: 제목 안 인라인·인용 안 목록·링크 안 강조', () => {
  assert.equal(renderMarkdown('## `code` 제목'), '<h2><code>code</code> 제목</h2>');
  const h = renderMarkdown('> - 인용 목록\n> - 둘');
  assert.ok(has(h, '<blockquote><ul><li>인용 목록</li><li>둘</li></ul></blockquote>'));
  const h2 = renderMarkdown('[*기울 링크*](https://a.com)');
  assert.ok(has(h2, '<a href="https://a.com"'));
  assert.ok(has(h2, '><em>기울 링크</em></a>'));
});

test('코드 블록 안 마크다운 문법은 변환하지 않는다', () => {
  const h = renderMarkdown('```\n# 제목 아님\n**굵게 아님**\n```');
  assert.ok(has(h, '# 제목 아님'));
  assert.ok(has(h, '**굵게 아님**'));
  assert.ok(no(h, '<strong>'));
  assert.ok(no(h, '<h1>'));
});
