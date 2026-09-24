# claude-launcher 개발 메모

Windows용 Electron 앱. 폴더별 모델·effort로 Claude Code를 연다. 메인(Claude 구독) + 작업자(GLM) 분담.

## 구조
- `src/main.js` Electron 메인(IPC, 업데이트), `src/preload.js` 렌더러용 좁은 API
- `src/renderer/` 빌드 도구 없는 HTML/CSS/JS
- `src/core/` Electron 없이 도는 순수 Node 모듈(테스트 대상). 로직은 여기에 둔다
- `runtime/start-session.mjs` Windows Terminal 탭에서 실행되는 세션 시작기(앱이 `%APPDATA%\claude-launcher\runtime`에 복사)
- `skills/glm-delegate/` GLM 위임 스킬(앱이 `~/.claude/skills`에 복사). `scripts/glm-run.mjs`는 의존성 없는 단일 파일
- `catalog.json` 모델·effort 목록. 설치된 앱이 main 브랜치의 이 파일을 받아 갱신한다

## 규칙
- 테스트: `npm test` (node:test). 새 로직은 core/runtime/skills에 두고 테스트를 붙인다
- 비밀값을 코드·카탈로그·세션 파일에 넣지 않는다(저장소 공개 전제). z.ai 키는 DPAPI 파일(zai-key.dpapi)에만 둔다
- 사용자 설정(`%APPDATA%\claude-launcher\config.json`) 형식을 바꿀 때는 `config.normalize`가 옛 형식도 받아들이게 한다

## 배포
- 모델 목록만 바뀔 때: `catalog.json` 수정 + `version` 1 올림 → main에 푸시. 앱 재배포는 필요 없다
- 앱·스킬 변경: 커밋 → `git tag vX.Y.Z` → `git push origin vX.Y.Z`. Actions가 빌드·릴리스하고 설치된 앱이 스스로 업데이트한다
- 태그를 올리기 전에 `npm test` 통과를 확인한다
