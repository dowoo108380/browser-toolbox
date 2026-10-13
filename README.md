# Browser Toolbox

웹을 쓰는 동안 늘 켜 두는 Chrome 확장이다. 미디어 배속, YouTube, 자막, 탭, 페이지, ChatGPT 도구를 한곳에 모은다.

> **개발 중이다.** 지금은 모든 층을 지나는 가장 작은 기능(영상 위에 지금 배속을 보이는 표시창)만 있다. 나머지 기능은 차례로 더한다.

## 지원 환경

- Windows의 데스크톱 Chrome 150 이상(manifest의 `minimum_chrome_version`과 같다)
- 화면 문구는 한국어다.
- Chrome 웹 스토어에는 올리지 않는다. 직접 빌드하거나 릴리스의 ZIP을 받아 "압축 해제된 확장"으로 불러온다.

## 설치

1. 아래 "빌드"대로 `dist/`를 만들거나, 릴리스의 ZIP을 받아 풀고 체크섬(`.sha256`)을 확인한다.
2. Chrome에서 `chrome://extensions`를 열고 오른쪽 위의 "개발자 모드"를 켠다.
3. "압축 해제된 확장 프로그램을 로드합니다"를 누르고 `dist/`(또는 푼 폴더)를 고른다.

확장을 지우면 Chrome이 그 확장의 설정도 지운다.

## 빌드

[pnpm](https://pnpm.io/installation) 12가 있으면 된다. Node.js는 pnpm이 저장소에 적힌 판(`package.json`의 `devEngines`)을 받아 쓴다.

```bash
pnpm install
pnpm verify
```

- `pnpm install`은 의존성과 테스트용 Chromium을 저장소 안(`node_modules`)에 받는다. Windows의 경로 길이 제한(260자) 때문에 저장소는 짧은 경로(대략 100자 이하)에 둔다. 경로가 길면 테스트용 Chromium이 실행되지 않는다(`spawn UNKNOWN`).
- `pnpm verify`는 CI와 같은 검사 전체다: 타입 검사, 린트, 서식, 구조 규칙, 안 쓰는 코드, 단위·DOM 테스트, 빌드(`dist/`), 확장 전체 테스트, 배포 ZIP과 SHA-256(`artifacts/`).

| 명령            | 하는 일                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `pnpm build`    | `dist/`에 압축 해제된 확장을 만든다.                                              |
| `pnpm check`    | 빌드 없이 빠르게 검사한다(타입, 린트, 서식, 구조, 안 쓰는 코드, 단위·DOM 테스트). |
| `pnpm test:e2e` | 빌드한 확장을 Chromium에 올려 시험 페이지에서 확인한다.                           |
| `pnpm package`  | `dist/`를 배포 ZIP과 체크섬으로 묶는다.                                           |
| `pnpm generate` | 기능을 더하거나 뺀 뒤 진입점별 등록 목록을 다시 만든다.                           |
| `pnpm mutation` | 핵심 로직에 돌연변이 테스트를 돌린다(느리다).                                     |
| `pnpm measure`  | 성능 예산(페이지마다 더 드는 시간, 팝업이 뜨는 시간, 크기)을 잰다.                |

## 권한

| 권한                        | 쓰는 곳                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `storage`                   | 설정을 저장한다.                                                                      |
| `scripting`                 | 확장을 다시 로드하거나 갱신했을 때, 열린 탭에 남은 옛 스크립트에게 정리하라고 알린다. |
| `http://*/*`, `https://*/*` | 모든 페이지의 모든 프레임에 있는 영상에 작용한다.                                     |

확장은 스스로 외부 서버에 데이터를 보내지 않는다.

## 문제 알리기

결함과 요청은 [GitHub Issues](https://github.com/dowoo108380/browser-toolbox/issues)에 양식으로 남긴다. 결함 양식은 Chrome 버전, 확장 버전, 사이트, 재현 절차를 묻는다. 이슈는 누구나 볼 수 있으므로 개인정보와 로그인한 화면의 내용은 넣지 않고, 사이트는 도메인만 적는다.

## 구조

```text
src/
  shared/      순수 도구(결과 값, 오류 종류)
  contracts/   메시지 정의, 기능 정의의 타입
  platform/    chrome.* API를 감싸는 경계와 테스트용 가짜
  storage/     설정 저장 형식, 형식 이전, 설정 읽기 도우미
  dom/         웹 페이지 위 화면 틀(닫힌 shadow root)
  page/        콘텐츠 스크립트 실행 틀
  background/  서비스 워커(메시지 라우터, 설정 쓰기, 문제 기록)
  ui/          확장 화면(Preact)
  features/    기능 하나 = 폴더 하나, features/list.ts가 기능 목록
  entries/     진입점(서비스 워커, 팝업, 콘텐츠 스크립트)
scripts/       빌드, 등록 목록 생성, 패키징
tests/         확장 전체 테스트(e2e), 실제 모듈끼리 연결한 시험(integration), 시험 페이지
```

- 층은 위에서 아래로만 가져다 쓴다. 기능끼리는 서로 가져오지 않는다. 규칙은 `.dependency-cruiser.json`에 있고 `pnpm verify`가 검사한다.
- 설정은 `chrome.storage.local`의 `settings` 키 하나에 둔다. 쓰는 곳은 서비스 워커 하나다.
- 저장된 설정을 읽을 수 없어 기본값으로 고쳐 쓰면, 서비스 워커가 무엇을 바꿨는지 `repairNotice` 키에 먼저 남기고 팝업이 사용자가 확인할 때까지 보인다.

## 라이선스

MIT. 배포물에는 실행 중에 쓰는 라이브러리(Preact, zod)의 라이선스가 `THIRD_PARTY_NOTICES.txt`로 들어간다.
