#!/usr/bin/env node
// 테스트용 가짜 claude: stream-json 이벤트를 흉내 내고, 받은 인자·환경·프롬프트를 MOCK_LOG에 남긴다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\n'); process.exit(0); }
const mode = process.env.MOCK_MODE || 'edit';
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => main().catch(e => { process.stderr.write(String(e?.stack || e)); process.exitCode = 1; }));

async function main() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(ANTHROPIC_|CLAUDE|GLM_|ZAI_|API_TIMEOUT|FOO_)/i.test(k)) env[k] = v;
  if (process.env.MOCK_LOG) fs.writeFileSync(process.env.MOCK_LOG, JSON.stringify({ args, cwd: process.cwd(), env, stdin }, null, 2));
  const ri = args.indexOf('--resume');
  const sid = ri >= 0 ? args[ri + 1] : (process.env.MOCK_SID || crypto.randomUUID());
  const model = args[args.indexOf('--model') + 1];
  emit({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [], permissionMode: 'dontAsk' });
  const usage = { input_tokens: 12000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 150000, output_tokens: 5000 };
  const modelUsage = { [model]: { inputTokens: 12000, outputTokens: 5000, cacheReadInputTokens: 150000, cacheCreationInputTokens: 3000 } };
  if (mode === 'sleep') { await sleep(600e3); return; }
  if (mode === 'autherr') {
    emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: 'authentication_error' });
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 {"error":{"message":"Invalid API key"}}', num_turns: 1, duration_ms: 400, usage });
    process.exitCode = 1; return;
  }
  if (mode === 'maxturns') {
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '작업 중' }] } });
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, duration_ms: 1000, usage });
    process.exitCode = 1; return;
  }
  if (mode === 'check') {
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'GLM_OK' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'GLM_OK', num_turns: 1, duration_ms: 300, usage, modelUsage });
    return;
  }
  let n = 0;
  for (const f of (process.env.MOCK_FILES || '').split(',').filter(Boolean)) {
    const op = f[0] === '+' ? 'create' : f[0] === '-' ? 'delete' : 'edit';
    const rel = op === 'edit' ? f : f.slice(1);
    const abs = path.resolve(process.cwd(), rel);
    n++;
    if (op === 'delete') {
      fs.rmSync(abs, { force: true });
      emit({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: `rm ${rel}` } }] } });
      continue;
    }
    if (op === 'create') { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'export const created = true;\n'); }
    else fs.appendFileSync(abs, '// edited by mock\n');
    emit({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name: op === 'create' ? 'Write' : 'Edit', input: { file_path: abs } }] } });
  }
  if (process.env.MOCK_BASH_FILE) {
    fs.appendFileSync(path.resolve(process.env.MOCK_BASH_FILE), '<!-- bash -->\n');
    n++;
    emit({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'sed -i ...' } }] } });
  }
  if (process.env.MOCK_SLOW) await sleep(Number(process.env.MOCK_SLOW));
  emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 100, error_status: 429, error: 'rate_limit' });
  const report = ['## 결과', '완료 — 모의 작업', '## 변경 파일', '- 모의 변경', '## 판단한 부분', '없음', '## 범위 밖 필요 변경', '없음', '## 검증', '- node -e → 통과'].join('\n');
  emit({ type: 'result', subtype: 'success', is_error: false, result: report, num_turns: n + 1, duration_ms: 1234, usage, modelUsage,
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'npm run build' } }] });
}
