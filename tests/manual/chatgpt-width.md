# 로그인한 chatgpt.com에서 대화 열·작성란 너비(GPT-2) 확인

자동 시험은 2026-10-18에 로그인하지 않은 chatgpt.com을 본뜬 시험 페이지(`tests/fixtures/chatgpt.html`)에서 돈다(결정 0031). 로그인한 화면은 본뜨지 않았으므로(사용자 지시) 같은 구조인지 모른다. 이 절차로 실제로 쓰는 화면에서 확인한다. 화면 구조가 다르면 기능은 15초 뒤 "찾지 못함"을 보이도록 만들어져 있다(COM-6). 그때는 아래 "찾지 못함이 나오면"대로 구조만 뽑아 알린다.

## 준비

- `pnpm verify`를 통과한 빌드(`dist/`)를 정식 Chrome에 올린다(`tests/manual/smoke-chrome.md`의 1–2단계).
- 평소 쓰는 Chrome 프로필에서 chatgpt.com에 로그인해 둔다. 이 확장은 대화 내용을 읽거나 밖으로 보내지 않는다(페이지에 스타일 요소 하나를 넣고, 정해 둔 요소가 있는지만 본다).
- 창을 1600px보다 넓게 둔다(정한 너비 1200px이 원래 너비보다 넓어 보이도록).
- 메시지가 여러 개이고 긴 답이 있는 대화 하나를 고른다.

## 절차

1. 그 대화(`https://chatgpt.com/c/…`)를 연다. 그 탭을 보는 채로 팝업을 열고 "ChatGPT" 범주를 고른다.
   - 기대(결정 0029): "대화 열·작성란 너비"에 "쓸 수 없음"이 보이지 않는다. 스위치는 "꺼짐", 아래 "최대 너비(px)" 칸에 `1200`이 있다.
2. 스위치를 켠다.
   - 기대(GPT-2.1): 새로 고침 없이 대화의 메시지 열과 아래 작성란이 함께 넓어진다. 둘의 왼쪽·오른쪽 끝이 맞고 가운데에 놓인다. 긴 답의 글줄이 길어진다.
3. 팝업의 칸에 `1600`을 쓰고 Enter, 이어서 ↑를 두 번 누른다.
   - 기대(GPT-2.1, 결정 0030): Enter에 열과 작성란이 1600px로, ↑마다 10px씩 넓어진다(팝업을 닫지 않아도 탭에 바로 보인다).
4. 칸에 `500`을 쓰고 Enter를 누른 뒤 Esc를 누른다.
   - 기대: Enter에 "640–3840 사이의 정수만 쓸 수 있어 저장하지 않았다."가 보이고 페이지는 그대로다. Esc에 칸이 저장된 값(1620)으로 돌아간다.
5. 옆 메뉴에서 다른 대화를 연다. "새 채팅"을 누른다. 프로젝트나 GPT를 쓰면 그 안의 대화도 하나 연다.
   - 기대(GPT-2.2): 어느 화면에서든 정한 너비가 그대로다. 새 채팅 화면에서는 작성란이 그 너비다.
6. 대화 화면과 새 채팅 화면에서 각각 20초 넘게 기다린 뒤 팝업을 다시 연다.
   - 기대(COM-6, 결정 0031): "찾지 못함"이 보이지 않는다. 이것이 로그인한 화면의 구조가 본뜬 구조와 맞는지 보는 단계다.
7. 창을 좁힌다(예: Windows 키 + ←로 화면의 반).
   - 기대(GPT-2.3): 열과 작성란이 창에 맞춰 줄고 가로 스크롤 막대가 생기지 않는다.
8. 스위치를 끈다.
   - 기대(GPT-2.4): 새로 고침 없이 열과 작성란이 켜기 전 너비로 돌아간다.
9. chatgpt.com이 아닌 탭(예: 뉴스 사이트)에서 팝업의 "ChatGPT" 범주를 연다.
   - 기대(COM-2 기대 동작 4, 결정 0029): "쓸 수 없음: chatgpt.com에서만 쓸 수 있음"이 보인다. 칸과 스위치는 그대로 쓸 수 있다(모든 탭에 대한 설정).

## 찾지 못함이 나오거나 너비가 바뀌지 않으면

로그인한 화면의 구조가 본뜬 것과 다르다는 뜻이다. 대화 내용 없이 구조만 뽑아 알린다.

1. 그 대화 화면에서 작성란을 한 번 누른다(초점을 둔다).
2. F12로 개발자 도구를 열고 "Console"에 아래를 붙여 넣고 Enter를 누른다. 요소의 종류, 속성 이름(값은 `role`만), 배치, 그려진 너비와 최대 너비만 나온다. 글, 주소, 대화 제목, 속성의 값은 나오지 않는다.

   ```js
   (() => {
     const describe = (element) => {
       const style = getComputedStyle(element);
       const names = [...element.attributes]
         .map((attribute) => attribute.name)
         .filter((name) => name !== 'class' && name !== 'style');
       const role = element.getAttribute('role');
       const width = Math.round(element.getBoundingClientRect().width);
       return `${element.localName}${role ? `[role=${role}]` : ''} ${names.join(' ')} | ${style.display} | 너비 ${width} | 최대 ${style.maxWidth}`;
     };
     const upward = (start) => {
       const lines = [];
       for (
         let element = start;
         element && element !== document.body;
         element = element.parentElement
       ) {
         lines.push(describe(element));
       }
       return lines.join('\n');
     };
     const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 3);
     console.log(
       `[작성란에서 위로]\n${upward(document.activeElement)}\n\n[화면 가운데에서 위로]\n${upward(middle)}`,
     );
   })();
   ```

3. 나온 글을 [GitHub Issues](https://github.com/dowoo108380/browser-toolbox/issues)의 결함 양식에 붙인다(Chrome 버전, 확장 버전, 사이트 `chatgpt.com`, ChatGPT 화면 언어, 몇 단계에서 무엇이 보였는지). 그 구조로 `src/sites/chatgpt/`의 선택자와 화면별 요소를 고친다(결정 0031 다시 볼 조건).

## 기록

확인한 날짜, Chrome 버전, 빌드(커밋), ChatGPT 화면 언어, 각 단계의 결과와 다른 점을 `docs/history.md`의 맨 아래에 더한다.
