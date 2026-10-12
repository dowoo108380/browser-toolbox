import { storageEnsureReady } from '../contracts/index.ts';
import type { LocalStore, Requester } from '../platform/index.ts';
import { type AppError, appError } from '../shared/index.ts';
import { type SettingsFormat, settingsKey } from './format.ts';
import type { FeatureSettingsSpec } from './items.ts';
import { type ReaderState, type Snapshot, initialReaderState, receive } from './reader.ts';

// 읽기 도우미(결정 0011 읽는 쪽 계약). 콘텐츠 스크립트와 확장 화면은 설정을 이것으로만 읽는다.

export interface SettingsReaderDeps {
  readonly store: LocalStore;
  readonly request: Requester;
  readonly format: SettingsFormat;
  readonly specs: readonly FeatureSettingsSpec[];
}

export interface SettingsReaderHandlers {
  readonly apply: (snapshot: Snapshot) => void;
  readonly corrupt: (items: 'all' | readonly string[]) => void;
  readonly newer: (version: number) => void;
  readonly problem: (error: AppError) => void;
}

// 서비스 워커에 준비를 부탁한 뒤 다시 읽어도 받아들일 값이 없을 때, 연달아 다시 부탁하는 횟수(quality 069).
const maxEnsureAttempts = 3;

export function startSettingsReader(
  deps: SettingsReaderDeps,
  handlers: SettingsReaderHandlers,
): () => void {
  let state: ReaderState = initialReaderState;
  let stopped = false;
  let ensuring = false;
  let attempts = 0;

  const dispatch = (raw: unknown) => {
    if (stopped) return;
    const step = receive(state, raw, deps.format, deps.specs);
    if (step.state.accepted !== null) attempts = 0;
    state = step.state;
    for (const effect of step.effects) {
      switch (effect.kind) {
        case 'apply':
          handlers.apply(effect.snapshot);
          break;
        case 'corrupt':
          handlers.corrupt(effect.items);
          break;
        case 'newer':
          handlers.newer(effect.version);
          break;
        case 'ensureReady':
          void ensureReady();
          break;
      }
    }
  };

  const read = async () => {
    let raw: unknown;
    try {
      raw = await deps.store.get(settingsKey);
    } catch {
      handlers.problem(appError('platform', '설정을 읽지 못했다.'));
      return;
    }
    dispatch(raw);
  };

  // 진행 중이면 다시 보내지 않는다. 끝나면 다시 읽으므로 그사이에 온 값도 맞춰진다.
  const ensureReady = async () => {
    if (ensuring || stopped) return;
    if (attempts >= maxEnsureAttempts) {
      handlers.problem(
        appError('unexpected', '서비스 워커가 준비했다고 했지만 설정을 읽을 수 없다.'),
      );
      return;
    }
    ensuring = true;
    attempts += 1;
    const result = await deps.request(storageEnsureReady, {});
    ensuring = false;
    if (!result.ok) {
      handlers.problem(result.error);
      return;
    }
    await read();
  };

  // 바뀜 알림을 먼저 듣고 읽는다. 순서가 어떻든 receive가 맞춘다.
  const unsubscribe = deps.store.onChanged(settingsKey, dispatch);
  void read();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
