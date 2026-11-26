'use strict';
// 표시용 포맷 함수 테스트: src/renderer/lib/fmt.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relTime, groupOf, sessionGroups, lineDiff, fmtElapsed, shortModel } = require('./fmt');

const NOW = new Date('2026-11-26T15:00:00+09:00').getTime();
const at = (iso, h, m) => new Date(iso).getTime();

test('relTime: 방금·분·시간(같은 날)·어제·일전·날짜', () => {
  assert.equal(relTime(new Date(NOW - 30 * 1000).toISOString(), NOW), '방금');
  assert.equal(relTime(new Date(NOW - 3 * 60 * 1000).toISOString(), NOW), '3분 전');
  assert.equal(relTime(new Date(NOW - 5 * 3600 * 1000).toISOString(), NOW), '5시간 전');
  assert.equal(relTime('2026-11-25T12:00:00+09:00', NOW), '어제');
  assert.equal(relTime('2026-11-23T12:00:00+09:00', NOW), '3일 전');
  assert.equal(relTime('2026-11-15T12:00:00+09:00', NOW), '11월 15일');
  assert.equal(relTime('2025-12-31T12:00:00+09:00', NOW), '2025년 12월 31일');
  assert.equal(relTime('2026-11-26T00:10:00+09:00', at('2026-11-26T00:30:00+09:00', 0)), '20분 전');
  assert.equal(relTime('2026-11-25T23:50:00+09:00', at('2026-11-26T00:10:00+09:00', 0)), '어제', '20분 차이여도 달력상 어제');
  assert.equal(relTime('', NOW), '');
  assert.equal(relTime(null, NOW), '');
  assert.equal(relTime('가짜', NOW), '');
  assert.equal(relTime(NOW - 45 * 1000, NOW), '방금', '숫자 밀리초도 받는다');
});

test('groupOf/sessionGroups: 오늘·어제·이번 주·이전 묶음', () => {
  assert.equal(groupOf('2026-11-26T09:00:00+09:00', NOW), 'today');
  assert.equal(groupOf('2026-11-25T09:00:00+09:00', NOW), 'yesterday');
  assert.equal(groupOf('2026-11-24T09:00:00+09:00', NOW), 'week');
  assert.equal(groupOf('2026-11-15T09:00:00+09:00', NOW), 'older');
  assert.equal(groupOf(null, NOW), 'older');
  const groups = sessionGroups([
    { id: 'a', updatedAt: '2026-11-26T10:00:00+09:00' },
    { id: 'b', updatedAt: '2026-11-25T10:00:00+09:00' },
    { id: 'c', updatedAt: '2026-11-20T10:00:00+09:00' },
    { id: 'd', updatedAt: '2025-01-01T10:00:00+09:00' },
    { id: 'e', updatedAt: null },
  ], NOW);
  assert.deepEqual(groups.map(g => g.label), ['오늘', '어제', '이번 주', '이전']);
  assert.deepEqual(groups[0].items.map(i => i.id), ['a']);
  assert.deepEqual(groups[3].items.map(i => i.id), ['d', 'e'], '시간 모르는 것은 이전으로');
  assert.deepEqual(sessionGroups([], NOW), []);
  assert.deepEqual(sessionGroups(null, NOW), []);
});

test('lineDiff: 공통 줄 제거·추가만·삭제만·동일·빈 값', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), [
    { t: '-', s: 'b' },
    { t: '+', s: 'B' },
  ]);
  assert.deepEqual(lineDiff('a\nb', 'a\nb\nc\nd'), [
    { t: '+', s: 'c' },
    { t: '+', s: 'd' },
  ]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a'), [{ t: '-', s: 'b' }, { t: '-', s: 'c' }]);
  assert.deepEqual(lineDiff('같음', '같음'), []);
  assert.deepEqual(lineDiff('', '새 줄'), [{ t: '+', s: '새 줄' }]);
  assert.deepEqual(lineDiff(null, undefined), []);
  assert.deepEqual(lineDiff('한줄', ''), [{ t: '-', s: '한줄' }]);
  // 앞뒤가 같은 줄이 반복되어도 앞쪽을 공통으로 잡아 빈 중간을 만들지 않는다
  const d = lineDiff('x\nx', 'x\nx\nx');
  assert.deepEqual(d, [{ t: '+', s: 'x' }]);
});

test('fmtElapsed', () => {
  assert.equal(fmtElapsed(0), '0초');
  assert.equal(fmtElapsed(34000), '34초');
  assert.equal(fmtElapsed(60000), '1:00');
  assert.equal(fmtElapsed(725000), '12:05');
  assert.equal(fmtElapsed(3723000), '1:02:03');
  assert.equal(fmtElapsed(null), '');
  assert.equal(fmtElapsed(-5), '');
  assert.equal(fmtElapsed(NaN), '');
  assert.equal(fmtElapsed('12000'), '');
});

test('shortModel', () => {
  assert.equal(shortModel('claude-sonnet-5-5'), 'sonnet-5-5');
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5-5');
  assert.equal(shortModel('glm-5.3'), 'glm-5.3');
  assert.equal(shortModel(''), '');
  assert.equal(shortModel(null), '');
  assert.equal(shortModel('claude-'), 'claude-', '접두사만 있으면 그대로');
});
