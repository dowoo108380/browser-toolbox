import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { storageEnsureReady } from '../../src/contracts/index.ts';
import { features } from '../../src/features/list.ts';
import { createFakeLocalStore } from '../../src/platform/fake.ts';
import {
  type Snapshot,
  type StoredSettings,
  repairNoticeKey,
  settingsFormat,
  settingsKey,
  startSettingsReader,
} from '../../src/storage/index.ts';
import { startTestBackground } from '../support/background.ts';

// COM-3.5: 지금까지 낸 판마다 남긴 설정 표본을 이 판이 올바르게 읽는다(결정 0021). 표본은 tests/samples/settings/에
// 판마다 하나 있고, 그 판의 확장이 chrome.storage.local의 settings에 실제로 쓴 값 그대로다. 파일 이름은 그 판의
// manifest 버전이다. 실제 기능 목록과 실제 형식으로 서비스 워커와 읽기 도우미를 잇고, 가짜는 저장소와 메시지 통로뿐이다.
//
// "올바르게 읽는다"는 다음 셋이다.
// - 손상, 더 새 형식, 문제를 알리지 않고 복구 알림을 남기지 않는다.
// - 서비스 워커가 준비한 값(지금 형식이면 표본 그대로, 옛 형식이면 이전한 값)의 항목(기능 하나의 설정, 사이트 하나에서
//   기능 하나의 설정)을 하나도 빠짐없이 읽는다. 표본은 늘 이 판보다 옛 판이 쓴 것이라 이 판이 모르는 항목은 없어야 한다.
//   모르는 항목은 손상이 아니라 조용히 무시되므로(결정 0011, 0017), 기능 id나 사이트 설정을 이전 함수 없이 바꾸면 여기서
//   드러난다.
// - 항목마다 저장된 필드를 모두 같은 값으로 읽는다. 그 뒤의 판이 더한 필드(없으면 기본값)는 더 있어도 된다.
// 그래서 같은 형식 버전 안에서 기능의 스키마가 저장된 값을 거절하거나, 필드를 버리거나, 다르게 읽게 바뀌면 이 시험이
// 실패한다. 그런 변경은 형식 버전을 올리고 이전 함수를 둔다. 옛 형식 표본을 이전한 값이 맞는지는 그 이전 함수의 시험이
// 같은 표본으로 본다(quality 075).

const samplesDirectory = path.join(import.meta.dirname, '..', 'samples', 'settings');

// 표본은 저장소에서 읽은 값과 같이 믿을 수 없는 입력으로 다룬다(타입 없이 읽는다).
const samples = readdirSync(samplesDirectory)
  .sort()
  .map((file) => {
    const value: unknown = JSON.parse(readFileSync(path.join(samplesDirectory, file), 'utf8'));
    return { file, value };
  });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 항목마다 이름과 값. 이름은 실패할 때 어느 항목인지 보이려는 것이다(호스트에 점이 있어 배열로 쓴다).
function storedItems(settings: StoredSettings): Map<string, unknown> {
  const items = new Map<string, unknown>();
  for (const [id, value] of Object.entries(settings.features)) {
    items.set(JSON.stringify(['features', id]), value);
  }
  for (const [host, entry] of Object.entries(settings.sites)) {
    if (!isRecord(entry)) throw new Error(`사이트 ${host}의 값이 객체가 아니다.`);
    for (const [id, value] of Object.entries(entry)) {
      items.set(JSON.stringify(['sites', host, id]), value);
    }
  }
  return items;
}

function readItems(snapshot: Snapshot): Map<string, unknown> {
  const items = new Map<string, unknown>();
  for (const [id, value] of snapshot.features) items.set(JSON.stringify(['features', id]), value);
  for (const [host, entry] of snapshot.sites) {
    for (const [id, value] of entry) items.set(JSON.stringify(['sites', host, id]), value);
  }
  return items;
}

describe('COM-3.5 지금까지 낸 판의 설정 표본', () => {
  it('표본이 있고, 파일 이름은 그 표본을 쓴 판의 manifest 버전(점으로 나눈 정수 1–4개)이다', () => {
    expect(samples).not.toHaveLength(0);
    for (const { file } of samples) expect(file).toMatch(/^\d+(\.\d+){0,3}\.json$/);
  });

  it.each(samples)(
    '$file: 손상 없이 읽고, 저장된 항목을 하나도 빠짐없이 저장된 값 그대로 쓴다',
    async ({ value }) => {
      const store = createFakeLocalStore({ [settingsKey]: value });
      const request = startTestBackground({ store, features, startTime: 1_800_000_000_000 });
      const applied: Snapshot[] = [];
      const reported: unknown[] = [];
      const stop = startSettingsReader(
        { store, request, format: settingsFormat, specs: features },
        {
          apply: (snapshot) => applied.push(snapshot),
          corrupt: (scope) => reported.push({ corrupt: scope }),
          newer: (version) => reported.push({ newer: version }),
          problem: (error) => reported.push({ problem: error }),
        },
      );
      // 서비스 워커는 시작할 때 설정을 준비한다(옛 형식이면 이전한다). 준비는 한 줄에서 차례로 하므로 이 요청의 응답이
      // 오면 시작 때의 준비도 끝났다. 읽기 도우미가 받아들인 뒤에 한 번 더 보내, 읽기 도우미가 부탁한 준비도 끝난 뒤에 본다.
      expect(await request(storageEnsureReady, {})).toEqual({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(applied).not.toHaveLength(0);
      });
      expect(await request(storageEnsureReady, {})).toEqual({ ok: true, value: null });
      stop();

      expect(reported).toEqual([]);
      expect(store.peek(repairNoticeKey)).toBeUndefined();
      // 서비스 워커가 준비한 값은 지금 형식이다. 아니면 여기서 던진다.
      const prepared = settingsFormat.structure.parse(store.peek(settingsKey));
      const snapshot = applied.at(-1);
      if (snapshot === undefined) throw new Error('읽기 도우미가 설정을 넘기지 않았다.');
      const stored = storedItems(prepared);
      const read = readItems(snapshot);
      expect([...read.keys()].sort()).toEqual([...stored.keys()].sort());
      for (const [name, storedValue] of stored) {
        if (isRecord(storedValue)) expect(read.get(name), name).toMatchObject(storedValue);
        else expect(read.get(name), name).toEqual(storedValue);
      }
    },
  );
});
