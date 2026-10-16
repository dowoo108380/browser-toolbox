import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TaskPart, defineTaskPart } from '../../src/background/index.ts';
import { type ActionFeature, defineFeature, taskStart } from '../../src/contracts/index.ts';
import { type FakeStore, createFakeStore } from '../../src/platform/fake.ts';
import { type AppError, appError, err, ok } from '../../src/shared/index.ts';
import { type TaskOutcome, tasksKey } from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';
import { renderTestPopup } from '../support/popup.ts';

// 작업 결과 알림(COM-10, 결정 0012, 0024)을 실제 모듈끼리 연결해 본다. 팝업(실행 단추, 작업 칸, 작업 기록 읽기)과
// 서비스 워커(라우터, 작업 실행, 작업 기록 쓰기)는 실제 코드이고, 가짜는 저장소와 메시지 통로뿐이다. 일의 끝은 시험이 정한다.
// 파일 저장(COM-10.1), 배지와 페이지 위 알림은 그 부분을 만든 뒤와 확장 전체 시험(시험 빌드, 결정 0025)에서 본다.

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

function actionFeature(id: string, name: string): ActionFeature {
  return defineFeature({
    id,
    requirements: [],
    name,
    description: `${name} 시험`,
    category: 'subtitles',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 60_000 },
  });
}

const save = actionFeature('save', '자막 저장');
const copy = actionFeature('copy', '자막 복사');

// 시험이 끝을 정하는 일. 불린 차례대로 끝낸다.
function controlled(feature: ActionFeature) {
  const pending: ((outcome: TaskOutcome) => void)[] = [];
  const part: TaskPart = defineTaskPart(
    feature,
    () =>
      new Promise<TaskOutcome>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    part,
    finish: async (outcome: TaskOutcome) => {
      await vi.waitFor(() => {
        expect(pending.length).toBeGreaterThan(0);
      });
      pending.shift()?.(outcome);
    },
  };
}

function startExtension(
  options: {
    readonly deliver?: (type: string, send: () => Promise<unknown>) => Promise<unknown>;
  } = {},
) {
  const store = createFakeStore();
  const session = createFakeStore();
  const saving = controlled(save);
  const copying = controlled(copy);
  const request = startTestBackground({
    store,
    session,
    features: [save, copy],
    taskParts: [saving.part, copying.part],
    startTime: 1_790_000_000_000,
    ...(options.deliver === undefined ? {} : { deliver: options.deliver }),
  });
  return { store, session, request, saving, copying };
}

async function openPopup(extension: ReturnType<typeof startExtension>, tabId: number) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await renderTestPopup(container, {
    store: extension.store,
    session: extension.session,
    request: extension.request,
    features: [save, copy],
    tabId,
  });
  const button = (featureId: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[data-feature="${featureId}"]`);
    if (found === null) throw new Error(`${featureId}의 단추가 없다.`);
    return found;
  };
  // 서비스 워커가 깨어나고 지금 탭을 알아 단추를 쓸 수 있을 때까지 기다린다.
  await vi.waitFor(() => {
    expect(button('save').hasAttribute('aria-disabled')).toBe(false);
  });
  return {
    button,
    text: () => container.querySelector('.task')?.textContent ?? '',
    reason: (featureId: string) =>
      container.querySelector(`#feature-unavailable-${featureId}`)?.textContent ?? null,
    run: (featureId: string) =>
      act(() => {
        button(featureId).click();
      }),
    close: () => {
      render(null, container);
    },
  };
}

const records = (session: FakeStore) => session.peek(tasksKey);

describe('COM-10 작업 결과 알림(실제 팝업과 서비스 워커)', () => {
  it('COM-10.1 COM-10.3 COM-10.4 팝업을 닫아도 작업은 끝나고, 다시 열면 결과가 한 번 보인 뒤 지워진다', async () => {
    const extension = startExtension();
    const first = await openPopup(extension, 1);
    await first.run('save');
    await vi.waitFor(() => {
      expect(first.text()).toBe('자막 저장: 진행 중이다.');
    });
    first.close();

    await extension.saving.finish(ok({ summary: '영상.txt' }));
    // 팝업이 닫힌 동안 끝난 결과는 기록에 남아 있다(아직 보지 않음).
    await vi.waitFor(() => {
      expect(records(extension.session)).toEqual({
        '1': { id: 'task-1', featureId: 'save', status: 'succeeded', summary: '영상.txt' },
      });
    });

    const second = await openPopup(extension, 1);
    await vi.waitFor(() => {
      expect(second.text()).toBe('자막 저장: 끝났다. 영상.txt');
    });
    // 보인 뒤 서비스 워커가 지운다. 열린 팝업은 그대로 보인다.
    await vi.waitFor(() => {
      expect(records(extension.session)).toEqual({});
    });
    expect(second.text()).toBe('자막 저장: 끝났다. 영상.txt');
    second.close();

    const third = await openPopup(extension, 1);
    expect(third.text()).toBe('');
  });

  it('COM-10.2 실패한 작업은 다시 연 팝업에 그 이유가 보인다', async () => {
    const extension = startExtension();
    const first = await openPopup(extension, 1);
    await first.run('save');
    first.close();
    await extension.saving.finish(err(appError('unavailable', '자막이 없는 영상이다.')));
    const second = await openPopup(extension, 1);
    await vi.waitFor(() => {
      expect(second.text()).toBe('자막 저장: 실패했다. 자막이 없는 영상이다.');
    });
  });

  it('COM-10.5 탭 1에서 시작한 작업은 탭 2의 팝업에 보이지 않고 탭 2의 단추를 막지 않는다', async () => {
    const extension = startExtension();
    const inFirst = await openPopup(extension, 1);
    await inFirst.run('save');
    const inSecond = await openPopup(extension, 2);
    await vi.waitFor(() => {
      expect(inFirst.text()).toBe('자막 저장: 진행 중이다.');
    });
    expect(inSecond.text()).toBe('');
    expect(inSecond.button('copy').hasAttribute('aria-disabled')).toBe(false);
    await extension.saving.finish(ok({ summary: null }));
    await vi.waitFor(() => {
      expect(inFirst.text()).toBe('자막 저장: 끝났다.');
    });
    expect(inSecond.text()).toBe('');
  });

  it('COM-10.7 작업이 진행 중인 탭의 팝업은 다른 작업 기능에 이유를 보이고, 서비스 워커에 직접 보내도 거절된다', async () => {
    const extension = startExtension();
    const popup = await openPopup(extension, 1);
    await popup.run('save');
    await vi.waitFor(() => {
      expect(popup.reason('copy')).toBe('쓸 수 없음: 이 탭에서 자막 저장 진행 중');
    });
    expect(popup.button('copy').getAttribute('aria-disabled')).toBe('true');
    const direct = await extension.request(taskStart, { featureId: 'copy', tabId: 1 });
    expect(direct).toEqual(
      err<AppError>(appError('unavailable', '이 탭에서 자막 저장 진행 중이다. 끝난 뒤 다시 한다.')),
    );
    expect(records(extension.session)).toEqual({
      '1': { id: 'task-1', featureId: 'save', status: 'running' },
    });
  });

  it('COM-10.8 결과를 본 확인이 다음 작업을 시작한 뒤에 닿아도 다음 작업의 진행과 결과가 남는다', async () => {
    // 확인(task.seen)이 서비스 워커에 닿는 때를 시험이 정한다.
    let releaseSeen: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseSeen = resolve;
    });
    const extension = startExtension({
      deliver: async (type, send) => {
        if (type === 'task.seen') await held;
        return send();
      },
    });
    const first = await openPopup(extension, 1);
    await first.run('save');
    await extension.saving.finish(ok({ summary: null }));
    await vi.waitFor(() => {
      expect(first.text()).toBe('자막 저장: 끝났다.');
    });
    // 확인이 붙잡힌 사이 같은 팝업에서 다음 작업을 시작한다.
    await first.run('copy');
    await vi.waitFor(() => {
      expect(records(extension.session)).toEqual({
        '1': { id: 'task-2', featureId: 'copy', status: 'running' },
      });
    });
    releaseSeen();
    await extension.copying.finish(ok({ summary: '복사함' }));
    await vi.waitFor(() => {
      expect(first.text()).toBe('자막 복사: 끝났다. 복사함');
    });
    // 첫 작업의 늦은 확인은 둘째 작업을 지우지 않았다. 둘째의 결과는 그 팝업의 확인으로 지워진다.
    await vi.waitFor(() => {
      expect(records(extension.session)).toEqual({});
    });
  });
});
