# Claude 런처

폴더마다 메인(Claude 구독)과 작업자(GLM, z.ai)의 모델·effort를 정해 두고, 클릭하면 그 설정으로 Windows Terminal에서 Claude Code를 여는 Windows 앱입니다. 메인 세션(Fable 등)은 설계와 리뷰를 맡고, 토큰이 많이 드는 반복 작업은 GLM 작업자가 맡습니다.

- 폴더별 기본값: 모드(분담 / Claude만 / GLM만), 메인 모델·effort, 작업자 모델·effort, 열기 방식(터미널 탭 / 새 창 / VS Code)
- 여러 폴더를 골라 한 창에 분할로 열기 (최대 2×2, 그 이상은 같은 창의 새 탭)
- 앱과 위임 스킬은 GitHub 릴리스에서 스스로 업데이트하고, 모델·effort 목록은 [업데이트 확인]으로 갱신
- z.ai 키는 Windows 계정으로 암호화(DPAPI)해 저장하고, 세션을 열 때만 꺼내 씀

## 처음 설치 (한 번만)

준비물: Windows 11, Node.js LTS, Git, Claude Code 2.1.255 이상(Fable 5.1용), Windows Terminal, z.ai GLM Coding Plan 키, GitHub 계정

1. GitHub에 새 저장소를 만듭니다. 예: `claude-launcher`. 비밀값이 들어가지 않으므로 공개 저장소를 권장합니다.
2. 이 폴더를 `C:\dev\claude-launcher`에 풀고 저장소에 올립니다.
   ```powershell
   cd C:\dev\claude-launcher
   git init
   git add -A
   git commit -m "v1.0.0"
   git branch -M main
   git remote add origin https://github.com/<계정>/claude-launcher.git
   git push -u origin main
   ```
3. 버전 태그를 올립니다. GitHub Actions가 Windows에서 테스트한 뒤 설치 파일을 만들어 릴리스합니다(5–10분).
   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. 저장소의 Releases에서 `Claude-Launcher-Setup-1.0.0.exe`를 받아 실행합니다. 서명하지 않은 개인 앱이라 SmartScreen 경고가 뜨면 **추가 정보 → 실행**을 누릅니다.
5. 첫 실행 마법사에서 환경 점검 결과를 보고, z.ai 키와 새 폴더 기본값을 정한 뒤 **시작하기**를 누릅니다.
6. **폴더 추가**를 누르거나 폴더를 창에 끌어다 놓습니다.
7. 설정 → **위임 연결 점검**으로 GLM 연결을 확인합니다. `✅ 준비 완료`가 나오면 끝입니다.

설치한 뒤로는 새 버전이 나오면 앱이 스스로 받아 둡니다. 배너의 **재시작해서 적용**을 누르거나 다음 실행 때 적용됩니다.

## 쓰는 법

| 모드 | 열리는 세션 | 위임 |
|---|---|---|
| 분담 | 메인 모델로 여는 Claude 구독 세션 (예: `claude --model fable --effort high`) | 반복 작업은 glm-delegate 스킬로 GLM 작업자에게 넘김 |
| Claude만 | Claude 구독 세션 | 하지 않음 |
| GLM만 | z.ai 엔드포인트에 연결한 세션 (설정 폴더 `~/.claude-glm`) | 하지 않음 |

- 행의 **열기** 또는 행 더블클릭으로 엽니다. 체크한 뒤 **선택한 폴더를 분할 창으로 열기**를 누르면 한 창에 나란히 열립니다.
- 행 왼쪽 색은 모드 색이고, 열린 Windows Terminal 탭도 같은 색입니다.
- 분담 모드에서는 평소처럼 일을 시키면 됩니다. 여러 파일에 같은 규칙을 적용하는 일 같은 반복 작업은 메인 세션이 명세를 써서 GLM에 넘기고, 요약만 받아 리뷰합니다. 직접 지시하려면 "GLM에 위임해서 …"라고 말합니다.
- 위임 기록은 각 저장소의 `.glm/runs/`에 남고 커밋되지 않습니다. 되돌리기(`--rollback`)와 후속 지시(`--resume`)는 `skills/glm-delegate/SKILL.md`에 정리되어 있습니다.
- Claude Code가 끝나도 탭은 그 폴더의 PowerShell로 남습니다. 이어서 하려면 화면에 안내된 `claude --continue …`를 입력합니다. 설정에서 끌 수 있습니다.
- 행의 ⋯ 버튼에서 이름, 폴더, claude 추가 인자(예: `--permission-mode plan`), 순서를 바꿉니다.

## 업데이트와 패치

| 대상 | 방법 |
|---|---|
| 앱 + 위임 스킬 + 세션 시작기 | 버전 태그를 올리면 자동으로 빌드·배포되고, 설치된 앱이 스스로 받아 적용 |
| 모델·effort 목록 | `catalog.json`을 고치고 `version`을 1 올려 main에 푸시 → 앱의 [업데이트 확인]에 표시 → [적용]. 재설치 필요 없음 |
| Claude Code 본체 | 설정 → **Claude Code 업데이트** (본체도 원래 스스로 업데이트됨) |

- 패치 만드는 법: 이 저장소(`C:\dev\claude-launcher`)도 런처에 폴더로 등록해 두고, 열어서 "○○ 기능 추가하고 릴리스해줘"라고 시키면 됩니다. 저장소의 `CLAUDE.md`에 구조와 배포 규칙이 적혀 있습니다.
- Claude 쪽은 `fable`, `opus` 같은 별칭이 최신 모델을 따라가므로 목록을 거의 바꿀 일이 없습니다. 목록 변경은 주로 GLM 새 모델이나 새 effort 단계 때문입니다.
- 새 모델을 당장 써야 하면 설정 → **모델 직접 추가**로 이 PC에서 바로 쓸 수 있습니다.

## 저장 위치

| 위치 | 내용 |
|---|---|
| `%APPDATA%\claude-launcher\` | `config.json`(폴더 목록·기본값), `zai-key.dpapi`(암호화된 키), `runtime\`(세션 시작기), `sessions\`, `catalog.json`(받은 모델 목록) |
| `%USERPROFILE%\.claude\skills\glm-delegate\` | 위임 스킬 |
| `%USERPROFILE%\.claude\CLAUDE.md` | 표시 주석 사이의 분담 규칙만 관리. 처음 바꾸기 전 원본은 `CLAUDE.md.launcher-backup` |
| `%USERPROFILE%\.claude-glm\` | GLM만 모드 세션의 설정 |
| `%USERPROFILE%\.claude-glm-worker\` | 위임 작업자의 설정 |

## 문제 해결

- 열기를 눌러도 반응이 없으면 상단 점검 칩을 확인합니다. Windows Terminal이 없으면 기본 콘솔 창으로 열리고, Node.js가 없으면 열 수 없습니다.
- Fable이 실패하면 Claude Code가 2.1.255 이상인지 확인합니다 (설정 → Claude Code 업데이트).
- 위임 연결 점검이 실패하면 메시지를 봅니다. 401은 키 오류, 429는 z.ai 한도입니다. effort 관련 400이 나오면 작업자 effort를 **기본**으로 바꿉니다.
- [업데이트 확인]이 실패하면 저장소 공개 여부를 확인합니다. 비공개라면 설정에 GitHub 토큰(Contents 읽기 권한)을 넣습니다.
- 첫 릴리스가 Windows 테스트에서 실패하면 Actions 로그를 확인해 고칩니다. 급하면 Actions → release → Run workflow에서 **테스트 건너뛰기**를 켜고 실행합니다.
- 로컬에서 직접 빌드하려면 `npm install` → `npm run dist` → `dist\`의 설치 파일을 씁니다. 이때는 `package.json`의 `repository`를 본인 저장소로 바꿔야 자동 업데이트가 동작합니다.

## 알아둘 점

- 위임 작업의 코드는 z.ai로 전송됩니다. 비밀값이나 고객 개인정보가 든 파일은 명세의 scope에서 빼세요.
- z.ai는 평일 15–19시(KST)가 피크라 비피크보다 크레딧이 2배 듭니다. 상단 칩에 표시됩니다.
- GLM만 모드 세션은 설정 폴더가 달라서 전역 CLAUDE.md·MCP 설정이 구독 세션과 따로입니다.
- 위임 스킬을 쓰지 않으려면 설정에서 분담 규칙을 끄고 `%USERPROFILE%\.claude\skills\glm-delegate`를 지웁니다.
- 모델별 effort 목록은 `catalog.json`에서 조정합니다. 어떤 모델이 특정 effort를 거부하면 **기본**을 고르세요.
