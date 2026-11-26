'use strict';
// 표시용 작은 포맷 함수들(의존성 없음): 상대 시간, 대화 묶음, 줄 단위 diff, 경과 시간, 모델 짧은 이름.
// 브라우저(window.FMT)와 Node(module.exports) 둘 다에서 쓴다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FMT = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const toMs = ts => {
    if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.getTime() : null;
    if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
    const t = Date.parse(String(ts ?? ''));
    return Number.isFinite(t) ? t : null;
  };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /** 상대 시간: "방금", "3분 전", "5시간 전"(같은 날), "어제", "3일 전", "11월 15일"(연도가 다르면 "2025년 11월 15일") */
  function relTime(ts, now) {
    const t = toMs(ts);
    if (t == null) return '';
    const n = now == null ? Date.now() : (toMs(now) ?? Date.now());
    const diff = n - t;
    if (diff < 60000 && diff > -60000) return '방금';
    const d1 = new Date(t), d2 = new Date(n);
    if (sameDay(d1, d2)) {
      const m = Math.floor(Math.abs(diff) / 60000);
      if (m < 60) return `${m}분 전`;
      return `${Math.floor(m / 60)}시간 전`;
    }
    const yd = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate() - 1);
    if (sameDay(d1, yd)) return '어제';
    const days = Math.floor(diff / 86400000);
    if (days > 0 && days < 7) return `${days}일 전`;
    const y = d1.getFullYear() !== d2.getFullYear() ? `${d1.getFullYear()}년 ` : '';
    return `${y}${d1.getMonth() + 1}월 ${d1.getDate()}일`;
  }

  /** 대화 목록 묶음 키: today | yesterday | week | older (달력 기준) */
  function groupOf(ts, now) {
    const t = toMs(ts);
    if (t == null) return 'older';
    const n = now == null ? Date.now() : (toMs(now) ?? Date.now());
    const d1 = new Date(t), d2 = new Date(n);
    if (sameDay(d1, d2)) return 'today';
    const yd = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate() - 1);
    if (sameDay(d1, yd)) return 'yesterday';
    const diff = n - t;
    if (diff > 0 && diff < 7 * 86400000) return 'week';
    return 'older';
  }

  /** 세션 목록을 오늘·어제·이번 주·이전 묶음으로 나눈다. items는 {updatedAt, ...} 배열(정렬 가정하지 않음). */
  function sessionGroups(items, now) {
    const order = [['today', '오늘'], ['yesterday', '어제'], ['week', '이번 주'], ['older', '이전']];
    const buckets = new Map(order.map(([k]) => [k, []]));
    for (const it of Array.isArray(items) ? items : []) buckets.get(groupOf(it && it.updatedAt, now)).push(it);
    return order.map(([key, label]) => ({ key, label, items: buckets.get(key) })).filter(g => g.items.length);
  }

  /** 줄 단위 diff: 앞·뒤 공통 줄을 뺀 나머지를(−/+)로. 같으면 빈 배열. 빈 문자열은 줄이 없는 것으로 본다. */
  function lineDiff(oldStr, newStr) {
    const split = s => { const t = String(s ?? ''); return t === '' ? [] : t.split('\n'); };
    const A = split(oldStr);
    const B = split(newStr);
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0;
    while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    const out = [];
    for (let i = s; i < A.length - e; i++) out.push({ t: '-', s: A[i] });
    for (let i = s; i < B.length - e; i++) out.push({ t: '+', s: B[i] });
    return out;
  }

  /** 경과 시간: "34초", "12:05", "1:02:03". 값이 없으면 ''. */
  function fmtElapsed(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = v => String(v).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  /** 모델 짧은 이름: claude- 접두사를 뗀다(예: claude-sonnet-5-5 → sonnet-5-5). */
  function shortModel(id) {
    const s = String(id || '');
    if (!s) return '';
    return /^claude-/i.test(s) ? (s.slice(7) || s) : s;
  }

  return { relTime, groupOf, sessionGroups, lineDiff, fmtElapsed, shortModel };
});
