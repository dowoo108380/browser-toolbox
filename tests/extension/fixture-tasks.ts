import * as z from 'zod/mini';
import { type TaskPart, defineTaskPart } from '../../src/background/index.ts';
import { type ActionFeature, defineFeature } from '../../src/contracts/index.ts';
import { chromeSessionStore } from '../../src/platform/index.ts';
import { appError, err, ok } from '../../src/shared/index.ts';
import type { TaskOutcome } from '../../src/storage/index.ts';

// 시험 빌드(결정 0025)에만 들어가는 실행 기능 둘. 제품의 실행 기능과 같은 정의 함수(defineFeature, defineTaskPart)를 쓴다.
// 일은 확장 전체 시험이 서비스 워커에서 storage.session의 releaseKey에 그 기능의 끝을 쓸 때까지 기다린다. 그래서 진행 중,
// 끝남의 때를 시험이 정하고 제품 코드에는 시험만을 위한 신호가 없다. 둘째 기능은 COM-10.7의 "다른 작업 기능"이다.

export const releaseKey = 'fixture-task:release';

const releaseSchema = z.object({
  featureId: z.string(),
  outcome: z.enum(['succeed', 'fail', 'cancel']),
  // 같은 끝을 거듭 쓸 수 있게 차례 번호를 함께 쓴다. 같은 값이면 Chrome이 바뀜 알림을 보내지 않는다.
  serial: z.number(),
});

export type Release = z.infer<typeof releaseSchema>;

export const fixtureSummary = '시험 결과';
export const fixtureFailure = '시험 작업이 실패했다.';

function fixtureFeature(id: string, name: string): ActionFeature {
  return defineFeature({
    id,
    requirements: [],
    name,
    description: `${name}은 시험 빌드에만 있다.`,
    category: 'tabs',
    kind: 'action',
    content: null,
    permissions: [],
    task: { timeoutMs: 20_000 },
  });
}

export const fixtureTask = fixtureFeature('fixture-task', '시험 작업');
export const fixtureOther = fixtureFeature('fixture-other', '다른 시험 작업');

function outcomeOf(outcome: Release['outcome']): TaskOutcome {
  switch (outcome) {
    case 'succeed':
      return ok({ summary: fixtureSummary });
    case 'fail':
      return err(appError('unavailable', fixtureFailure));
    case 'cancel':
      return err(appError('cancelled', '시험이 멈추라고 했다.'));
  }
}

// 그 기능의 끝이 쓰일 때까지 기다린다. 멈춤 신호(탭 닫힘, 제한 시간)가 오면 그만둔다.
function waitForRelease(featureId: string, signal: AbortSignal): Promise<TaskOutcome> {
  return new Promise((resolve) => {
    const stop = chromeSessionStore().onChanged(releaseKey, (value) => {
      const release = releaseSchema.safeParse(value);
      if (!release.success || release.data.featureId !== featureId) return;
      stop();
      resolve(outcomeOf(release.data.outcome));
    });
    signal.addEventListener(
      'abort',
      () => {
        stop();
        resolve(err(appError('cancelled', '시험 작업을 멈췄다.')));
      },
      { once: true },
    );
  });
}

export const fixtureParts: readonly TaskPart[] = [fixtureTask, fixtureOther].map((feature) =>
  defineTaskPart(feature, ({ signal }) => waitForRelease(feature.id, signal)),
);
