// 서비스 워커가 만들어 사용자에게 보이는 문구(결정 0007): 작업을 시작하지 못한 이유, 작업의 실패 이유, 확장 아이콘의 제목(COM-10).
// 주소, 제목, 파일 이름은 넣지 않는다(quality 082).

export const strings = {
  notAction: '실행 기능이 아니라 작업을 시작할 수 없다.',
  noTab: '작업을 시작할 탭이 없다.',
  running: (name: string) => `이 탭에서 ${name} 진행 중이다. 끝난 뒤 다시 한다.`,
  readFailed: '작업 기록을 읽지 못했다.',
  writeFailed: '작업 기록을 남기지 못했다.',
  timeout: (seconds: number) => `${String(seconds)}초 안에 끝나지 않아 멈췄다.`,
  unexpected: '작업 중에 예상하지 못한 오류가 났다.',
  interrupted: '확장이 작업 도중 다시 시작되어 끝까지 하지 못했다. 다시 실행한다.',
  // 끝났고 아직 보지 않은 작업이 있는 탭의 확장 아이콘 제목(결정 0024). 배지 글자만으로는 화면 낭독기가 알 수 없다.
  badgeTitle: {
    succeeded: (name: string) => `Browser Toolbox: ${name} 끝남`,
    failed: (name: string) => `Browser Toolbox: ${name} 실패`,
  },
};
