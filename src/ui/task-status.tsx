import type { TaskRecord } from '../storage/index.ts';
import { strings } from './strings.ts';

// 팝업 위쪽의 작업 칸(COM-10 기대 동작 3, 결정 0024). 지금 탭에서 진행 중인 작업이나 아직 보지 않았던 마지막 결과를 보인다.
// 칸은 늘 있고 내용만 바뀐다. 바뀔 때 화면 낭독기가 읽게 하려면 알림 영역이 내용보다 먼저 있어야 하기 때문이다.

function textOf(task: TaskRecord, name: string): string {
  switch (task.status) {
    case 'running':
      return strings.taskRunning(name);
    case 'succeeded':
      return strings.taskSucceeded(name, task.summary);
    case 'failed':
      return task.error.kind === 'cancelled'
        ? strings.taskCancelled(name, task.error.message)
        : strings.taskFailed(name, task.error.message);
  }
}

interface TaskStatusProps {
  // 보일 작업. 없으면 칸이 빈다.
  readonly task: TaskRecord | null;
  readonly nameOf: (featureId: string) => string;
}

export function TaskStatus({ task, nameOf }: TaskStatusProps) {
  return (
    <div class="task" aria-live="polite">
      {task !== null && <p>{textOf(task, nameOf(task.featureId))}</p>}
    </div>
  );
}
