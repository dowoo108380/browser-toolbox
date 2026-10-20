import { attachDebugger, detachDebugger, sendDebuggerCommand } from '../../src/platform/index.ts';
import type { AppError, Result } from '../../src/shared/index.ts';
import type { TabIds } from './run-tabs.ts';

// 디버거 경계(결정 0042, src/platform/debugger.ts)가 실제 Chrome에서 시험의 가짜 Chrome(tests/support/fake-browser.ts)과
// 같게 나누는지 확장의 서비스 워커 안에서 돌린다. 확장 전체 시험이 이 파일을 esbuild로 묶어 서비스 워커에서 실행한다
// (tests/e2e/tab-contract.spec.ts). 배포물에는 들어가지 않는다. 거절 문구로 나누는 곳(이 확장이 이미 붙음, 붙어 있지 않음)이
// Chrome이 바뀌어 어긋나면 여기서 드러난다.

export interface DebuggerContractResult {
  // 처음 붙이기, 이미 붙은 탭에 다시 붙이기, 붙은 탭에 명령.
  readonly attach: string;
  readonly attachAgain: string;
  readonly command: string;
  // 떼기, 이미 뗀 탭에서 다시 떼기, 뗀 탭에 명령.
  readonly detach: string;
  readonly detachAgain: string;
  readonly commandAfterDetach: string;
  // 붙일 수 없는 화면(chrome://)과 닫힌 탭에 붙이기.
  readonly attachInternal: string;
  readonly attachClosed: string;
}

// 결과의 종류(성공이면 ok).
const kindOf = (result: Result<unknown, AppError>) => (result.ok ? 'ok' : result.error.kind);

export async function run(tabs: TabIds): Promise<DebuggerContractResult> {
  const evaluate = { expression: '1 + 1' };
  const attach = kindOf(await attachDebugger(tabs.page));
  const attachAgain = kindOf(await attachDebugger(tabs.page));
  const command = kindOf(await sendDebuggerCommand(tabs.page, 'Runtime.evaluate', evaluate));
  const detach = kindOf(await detachDebugger(tabs.page));
  const detachAgain = kindOf(await detachDebugger(tabs.page));
  const commandAfterDetach = kindOf(
    await sendDebuggerCommand(tabs.page, 'Runtime.evaluate', evaluate),
  );
  return {
    attach,
    attachAgain,
    command,
    detach,
    detachAgain,
    commandAfterDetach,
    attachInternal: kindOf(await attachDebugger(tabs.internal)),
    attachClosed: kindOf(await attachDebugger(tabs.closed)),
  };
}

declare global {
  // 이 파일을 묶어 서비스 워커에서 실으면 이 전역에 실행기를 둔다(tests/contract/run-tabs.ts와 같다).
  var debuggerContractRunner: { readonly run: typeof run } | undefined;
}

globalThis.debuggerContractRunner = { run };
