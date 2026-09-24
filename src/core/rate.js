'use strict';
// z.ai GLM Coding Plan 요금 시간대: 평일 14–18시 SGT(=15–19시 KST)가 피크, 그 밖은 크레딧 50%.
// 2026-09-25 ~ 2026-10-07은 종일 비피크 요금.
function zaiRate(date = new Date()) {
  const sgt = new Date(date.getTime() + 8 * 3600e3);
  const ymd = sgt.toISOString().slice(0, 10);
  if (ymd >= '2026-09-25' && ymd <= '2026-10-07') return { peak: false, factor: 0.5, label: '종일 비피크 기간', detail: '10월 7일까지 종일 비피크 요금(크레딧 50%)' };
  const day = sgt.getUTCDay(), h = sgt.getUTCHours();
  return day >= 1 && day <= 5 && h >= 14 && h < 18
    ? { peak: true, factor: 1, label: 'z.ai 피크', detail: '평일 15–19시(KST)는 비피크보다 크레딧 2배' }
    : { peak: false, factor: 0.5, label: 'z.ai 비피크', detail: '지금은 크레딧 50% 요금' };
}
module.exports = { zaiRate };
