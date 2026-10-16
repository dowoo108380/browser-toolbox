import * as z from 'zod/mini';
import type { KeyValueStore } from '../platform/index.ts';
import { type ErrorKind, createSerialQueue, errorKinds } from '../shared/index.ts';

// 문제 기록(COM-5). 주소, 제목, 사이트 이름, 파일 이름은 넣지 않는다(quality 082).

const problemsKey = 'problems';
// 최근 100개만 남긴다(COM-5 기대 동작 4).
const problemLimit = 100;

export interface Problem {
  readonly featureId: string | null;
  readonly kind: ErrorKind;
}

const recordSchema = z.object({
  at: z.int(),
  featureId: z.nullable(z.string()),
  kind: z.enum(errorKinds),
});

export interface ProblemLog {
  readonly record: (problem: Problem) => Promise<void>;
}

export function createProblemLog(deps: {
  readonly store: KeyValueStore;
  readonly now: () => number;
}): ProblemLog {
  const enqueue = createSerialQueue();
  return {
    record: (problem) =>
      enqueue(async () => {
        const parsed = z.array(recordSchema).safeParse(await deps.store.get(problemsKey));
        // 기록이 손상되었으면 새로 시작한다. 기록은 진단용이라 잃어도 기능에 영향이 없다.
        const previous = parsed.success ? parsed.data : [];
        const next = [...previous, { at: deps.now(), ...problem }].slice(-problemLimit);
        await deps.store.set({ [problemsKey]: next });
      }),
  };
}
