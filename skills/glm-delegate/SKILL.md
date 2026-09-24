---
name: glm-delegate
description: 토큰이 많이 드는 단순·반복 코딩 작업을 z.ai GLM 작업자(별도 헤드리스 Claude Code)에게 위임하고, 메인 세션은 명세 작성과 리뷰만 한다. 여러 파일에 같은 규칙을 적용하는 일괄 수정(이름 변경, API 마이그레이션, 에러 처리 통일, JSDoc·타입 추가, 테스트·목업 데이터·i18n 키 생성, 린트 오류 대량 수정)이나 큰 코드베이스·로그 전수 조사가 필요하면 사용자가 GLM을 언급하지 않아도 사용한다. 설계 판단, 원인이 불분명한 디버깅, 인증·결제·세금 로직, 3개 이하 파일의 작은 수정에는 쓰지 않는다.
argument-hint: "[위임할 작업 설명]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/glm-run.mjs" *)
---

# GLM 위임 — 메인(설계·리뷰) + GLM 작업자(반복 작업)

먼저 확인한다. 환경변수 `GLM_WORKER=1`이면 너는 작업자다. 이 스킬을 쓰지 말고 받은 명세만 수행한다. `GLM_DELEGATE=off`이면 위임하지 말고 직접 처리한다.

## 1. 쪼개기

- 명세 하나에는 한 종류의 규칙과 파일 10–25개를 담는다. 규칙이 여러 종류면 명세도 여러 개로 나눈다.
- 대상 목록을 모르면 먼저 scan 명세로 목록을 뽑고, 그 결과로 edit 명세를 나눈다.
- 3개 이하 파일이나 판단이 필요한 부분은 직접 한다.

## 2. 명세 쓰기 — `.glm/tasks/<slug>.md`

작업자는 대화를 할 수 없으니 명세만 보고 끝까지 할 수 있어야 한다. 무엇이 어떻게 바뀌어야 하는지(결과)와 규칙·예시를 쓰고, 방법을 시시콜콜 지시하지 않는다.

~~~markdown
---
title: API 라우트 에러 응답을 apiError()로 통일
role: edit                 # edit(수정) | scan(읽기 전용 조사)
scope:                     # 수정 허용 범위. 실행 폴더 기준 글롭, !는 제외, 대괄호는 글자 그대로
  - src/app/api/**/route.ts
  - "!src/app/api/legacy/**"
verify:                    # 끝난 뒤 런처가 직접 다시 돌리는 검증 명령(읽기 전용 검사만)
  - npx tsc --noEmit
# model: flash             # 아주 단순한 치환이면 glm-5.3-flash
# effort: max              # 어려운 편이면
---
## 목표
에러 응답을 `src/lib/apiError.ts`의 `apiError(status, message)`로 통일한다.

## 규칙
1. `return NextResponse.json({ error: msg }, { status: N })` → `return apiError(N, msg)`
2. 파일에 `apiError` import가 없으면 추가한다.
3. 성공 응답과 헤더 설정은 건드리지 않는다.

## 예시
```ts
// 전
return NextResponse.json({ error: '권한 없음' }, { status: 403 });
// 후
return apiError(403, '권한 없음');
```

## 대상
scope 전체 (약 20개 파일 예상)
~~~

조사 명세 예시:

~~~markdown
---
title: 미번역 한글 문자열 위치 조사
role: scan
scope: [src/components]
---
src/components 아래 JSX 텍스트 중 t()로 감싸지 않은 한글 문자열을 모두 찾아 `경로:줄 — 문자열` 목록으로 보고한다.
~~~

## 3. 실행

```bash
node "${CLAUDE_SKILL_DIR}/scripts/glm-run.mjs" .glm/tasks/<slug>.md
```

- 몇 분에서 30분까지 걸리므로 Bash 도구의 `run_in_background`로 실행하고 완료를 기다린다.
- 동시에 최대 3개까지, scope가 겹치지 않을 때만 병렬로 돌린다.
- 진행 확인은 `--status latest`만 쓴다. `.glm/runs/`의 로그(stream.jsonl 등)를 통째로 읽지 않는다.
- 작업자 모델·effort 기본값은 런처가 폴더별로 넣어 준다(`GLM_MODEL`, `GLM_EFFORT`). 명세의 model/effort가 있으면 그쪽이 우선한다.

## 4. 리뷰

출력된 요약만 보고 판단한다.

| 결과 | 조치 |
|---|---|
| ✅ 완료 + 검증 PASS | `git diff`로 대표 파일 1–2개만 확인한다. 규칙 위반이 보이면 후속 지시를 보낸다 |
| 검증 FAIL 또는 부분 완료 | 고칠 점만 적은 후속 명세로 `--resume <runId> <후속.md>` (최대 2번, 그다음엔 직접 처리) |
| ⚠ 범위 밖 변경 | `--rollback <runId>`로 되돌린 뒤 명세를 보완해 다시 실행한다 |
| 권한 거부 | 필요한 명령을 `allow_bash`에 추가해 다시 실행한다 |
| 인증·한도 오류 | 멈추고 사용자에게 알린다 |

## 5. 보고

끝에 한 줄로 `GLM 위임 n건 · 직접 처리 m건`과 바뀐 내용을 요약한다. 커밋은 리뷰를 마친 뒤 메인 세션이 한다(작업자는 커밋할 수 없다).

## 주의

- 작업 대상 코드는 z.ai로 전송된다. 비밀값이나 고객 개인정보가 담긴 파일은 scope에서 뺀다.
- `--rollback <runId>`는 그 실행이 바꾼 파일만 되돌리고, 실행 뒤 직접 고친 파일은 건너뛴다. 후속 실행이 있으면 최신 것부터 되돌린다.
