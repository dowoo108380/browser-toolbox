import { type ElementRef, elementRefSchema, v } from '../contracts/index.ts';
import type { KeyValueStore } from '../platform/index.ts';
import { type ErrorKind, createSerialQueue, errorKinds } from '../shared/index.ts';

// 문제 기록(COM-5). 주소, 제목, 사이트 이름, 파일 이름은 넣지 않는다(quality 082). 찾지 못한 외부 화면 요소의 이름표와
// 이름은 코드에 적힌 글이라 넣는다(COM-5 기대 동작 2, 결정 0026).

const problemsKey = 'problems';
// 최근 100개만 남긴다(COM-5 기대 동작 4).
const problemLimit = 100;

export interface Problem {
  readonly featureId: string | null;
  readonly kind: ErrorKind;
  // 찾지 못한 외부 화면 요소. 그 밖의 문제에는 없다.
  readonly element?: ElementRef | undefined;
}

const recordSchema = v.object({
  at: v.int(),
  featureId: v.nullable(v.string()),
  kind: v.picklist(errorKinds),
  element: v.optional(elementRefSchema),
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
        const parsed = v.safeParse(v.array(recordSchema), await deps.store.get(problemsKey));
        // 기록이 손상되었으면 새로 시작한다. 기록은 진단용이라 잃어도 기능에 영향이 없다.
        const previous = parsed.success ? parsed.output : [];
        const { featureId, kind, element } = problem;
        const record = {
          at: deps.now(),
          featureId,
          kind,
          ...(element === undefined ? {} : { element }),
        };
        const next = [...previous, record].slice(-problemLimit);
        await deps.store.set({ [problemsKey]: next });
      }),
  };
}
