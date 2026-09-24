'use strict';
// 모델·effort 목록(카탈로그): 앱에 들어 있는 catalog.json과 GitHub에서 받은 캐시 중 버전이 높은 쪽 + 직접 추가한 모델
const { readJSON, writeJSON } = require('./config');

const DEFAULT_EFFORTS = { claude: ['low', 'medium', 'high', 'max'], glm: ['low', 'high', 'max'] };
const FALLBACK = {
  schema: 1, version: 0,
  claude: { models: [{ id: 'fable', label: 'Fable (최신)', efforts: DEFAULT_EFFORTS.claude }, { id: 'opus', label: 'Opus (최신)', efforts: DEFAULT_EFFORTS.claude }, { id: 'sonnet', label: 'Sonnet (최신)', efforts: DEFAULT_EFFORTS.claude }] },
  glm: { fastModel: 'glm-5.3-flash', models: [{ id: 'glm-5.3', label: 'GLM-5.3', efforts: DEFAULT_EFFORTS.glm }, { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', efforts: DEFAULT_EFFORTS.glm }] },
};
function valid(c) {
  const ok = k => c && c[k] && Array.isArray(c[k].models) && c[k].models.every(m => m && typeof m.id === 'string' && m.id);
  return !!c && Number.isInteger(c.version) && ok('claude') && ok('glm');
}
function base(P) {
  const list = [readJSON(P.bundledCatalog), readJSON(P.catalogCache)].filter(valid);
  if (!list.length) return JSON.parse(JSON.stringify(FALLBACK));
  return list.sort((a, b) => b.version - a.version)[0];
}
function effective(P, cfg) {
  const cat = JSON.parse(JSON.stringify(base(P)));
  for (const kind of ['claude', 'glm']) {
    for (const m of cfg?.userModels?.[kind] || []) if (!cat[kind].models.some(x => x.id === m.id)) cat[kind].models.push({ ...m, user: true });
  }
  return cat;
}
/** 이전 → 새 카탈로그에서 추가된 모델, 모델별 추가 effort, 빠진 모델 */
function diff(a, b) {
  const res = [];
  for (const kind of ['claude', 'glm']) {
    const old = new Map((a?.[kind]?.models || []).map(m => [m.id, m]));
    for (const m of b[kind].models) {
      const o = old.get(m.id);
      if (!o) res.push({ kind, type: 'model', id: m.id, label: m.label || m.id });
      else {
        const add = (m.efforts || []).filter(e => !(o.efforts || []).includes(e));
        if (add.length) res.push({ kind, type: 'effort', id: m.id, efforts: add });
      }
    }
    const now = new Set(b[kind].models.map(m => m.id));
    for (const id of old.keys()) if (!now.has(id)) res.push({ kind, type: 'removed', id });
  }
  return res;
}
function effortsFor(cat, kind, id) {
  const m = cat?.[kind]?.models?.find(x => x.id === id);
  return m ? (m.efforts || []) : DEFAULT_EFFORTS[kind];
}
function catalogUrl(repo, token, override) {
  if (override) return override;
  if (!repo) return '';
  return token
    ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/catalog.json?ref=main`
    : `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/catalog.json`;
}
async function fetchRemote(url, token, fetchImpl = globalThis.fetch) {
  if (!url) throw new Error('카탈로그 주소를 알 수 없습니다');
  const headers = { 'Cache-Control': 'no-cache', 'User-Agent': 'claude-launcher' };
  if (token) { headers.Authorization = `Bearer ${token}`; headers.Accept = 'application/vnd.github.raw+json'; }
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`모델 목록 받기 실패 (HTTP ${res.status})`);
  let cat;
  try { cat = JSON.parse(await res.text()); } catch { throw new Error('모델 목록 형식 오류(JSON 아님)'); }
  if (!valid(cat)) throw new Error('모델 목록 형식 오류');
  return cat;
}
function saveCache(P, cat) {
  if (!valid(cat)) throw new Error('모델 목록 형식 오류');
  writeJSON(P.catalogCache, cat);
}
module.exports = { DEFAULT_EFFORTS, valid, base, effective, diff, effortsFor, catalogUrl, fetchRemote, saveCache };
