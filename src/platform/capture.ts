import { type AppError, type Result, appError, err, ok } from '../shared/index.ts';

// 창의 지금 탭의 보이는 화면을 PNG data URL로 찍는다(chrome.tabs.captureVisibleTab, 결정 0048). 디버거가 없어 디버깅 안내
// 막대가 뜨지 않는다. activeTab 권한이 그 탭에 있어야 한다: 사용자가 그 탭에서 팝업을 열면 Chrome이 준다. 호스트 권한(http·https)
// 만으로는 "Either the '<all_urls>' or 'activeTab' permission is required."로 거절된다(2026-10-21 실험).
export async function captureVisibleTab(windowId: number): Promise<Result<string, AppError>> {
  try {
    return ok(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }));
  } catch {
    return err(
      appError(
        'permission',
        '이 탭의 보이는 화면을 찍지 못했다. 이 탭에서 팝업을 다시 열고 시작한다.',
      ),
    );
  }
}
