import { type AppError, type Result, appError, err, ok, withTimeout } from '../shared/index.ts';

// chrome.debugger를 감싼다(결정 0042). 이 확장의 디버거 연결을 직접 다루는 곳은 이 모듈뿐이고, 서비스 워커의 디버거 관리만
// 쓴다. 연결은 탭마다 하나다. 거절은 결과 값으로 바꾼다(아키텍처 7장 "오류").

// 프로토콜 판(debugger.attach의 requiredVersion). 지금 Chrome의 판이다.
const protocolVersion = '1.3';

// 디버거를 붙이고 명령 하나를 기다리는 한도(아키텍처 7장 "비동기, 제한 시간, 취소").
const debuggerTimeoutMs = 10_000;

// 연결이 밖에서 끊긴 까닭(debugger.onDetach). cancelled: 사용자가 디버깅 안내 막대에서 취소했다. Chrome은 이때 이 확장의
// 연결을 모두 함께 끊는다(Chromium debugger_api.cc의 OnInfoBarActionInternal). closed: 대상이 사라졌다(탭이 닫힘, 디버거를
// 붙일 수 없는 화면으로 이동함, 2026-10-21 실험).
export type DebuggerLoss = 'cancelled' | 'closed';

// 이 확장이 그 탭에 이미 붙어 있으면 Chrome이 이 문구로 거절한다(debugger_api.cc의 kAlreadyAttachedError. 같은 확장의 연결만
// 센다). 앞 서비스 워커가 붙인 연결이 남은 것이라 붙은 것으로 본다.
function isAlreadyAttached(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Another debugger is already attached');
}

// 붙어 있지 않은 탭에서 떼면 이 문구로 거절한다(kNotAttachedError). 이미 떨어진 것이다.
function isNotAttached(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Debugger is not attached');
}

// 그 탭에 붙인다. 다른 확장이나 개발자 도구가 붙어 있어도 함께 붙는다(Chrome의 다중 연결). 거절되면 permission이다. Chrome은
// 페이지 안에 다른 확장의 화면(iframe)이 있거나(2026-10-21 실험) 보안 경고 화면, 정책이 막은 곳이면 거절한다(Chromium
// debugger_api.cc의 ExtensionMayAttachToWebContents). 한도를 넘기면 timeout이고, 그 뒤에 붙으면 쓸 쪽이 없으므로 뗀다.
export async function attachDebugger(tabId: number): Promise<Result<null, AppError>> {
  const attaching = chrome.debugger.attach({ tabId }, protocolVersion);
  try {
    const attached = await withTimeout(debuggerTimeoutMs, () => attaching);
    if (attached.done) return ok(null);
    attaching.then(
      () => chrome.debugger.detach({ tabId }).catch(() => undefined),
      // 늦게 거절되었으면 붙지 않은 것이다. 뗄 것이 없다.
      () => undefined,
    );
    return err(appError('timeout', '디버거를 붙이는 데 너무 오래 걸렸다.'));
  } catch (error) {
    if (isAlreadyAttached(error)) return ok(null);
    return err(
      appError(
        'permission',
        '이 탭에 디버거를 붙이지 못했다. 페이지 안에 다른 확장이 넣은 화면이 있거나 보안 경고 화면이면 Chrome이 막는다.',
      ),
    );
  }
}

// 그 탭에서 뗀다. 이미 떨어졌거나 탭이 닫혔으면 할 일이 없다. 그 밖의 거절은 platform이다.
export async function detachDebugger(tabId: number): Promise<Result<null, AppError>> {
  try {
    const detached = await withTimeout(debuggerTimeoutMs, () => chrome.debugger.detach({ tabId }));
    return detached.done
      ? ok(null)
      : err(appError('timeout', '디버거를 떼는 데 너무 오래 걸렸다.'));
  } catch (error) {
    if (isNotAttached(error)) return ok(null);
    return err(appError('platform', '디버거를 떼지 못했다.'));
  }
}

// 붙은 탭에 프로토콜 명령 하나를 보낸다. 거절은 platform, 한도를 넘기면 timeout이다.
export async function sendDebuggerCommand(
  tabId: number,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<Result<unknown, AppError>> {
  try {
    const sent = await withTimeout(debuggerTimeoutMs, () =>
      chrome.debugger.sendCommand({ tabId }, method, { ...params }),
    );
    return sent.done
      ? ok(sent.value)
      : err(appError('timeout', `디버거 명령(${method})의 답이 없다.`));
  } catch {
    return err(appError('platform', `디버거 명령(${method})이 거절되었다.`));
  }
}

// 연결이 밖에서 끊긴 것을 듣는다. 서비스 워커가 처음 실행될 때 바로 부른다(이 확장이 스스로 뗀 것은 오지 않는다).
export function listenDebuggerLoss(handler: (tabId: number, loss: DebuggerLoss) => void): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    handler(source.tabId, reason === 'canceled_by_user' ? 'cancelled' : 'closed');
  });
}
