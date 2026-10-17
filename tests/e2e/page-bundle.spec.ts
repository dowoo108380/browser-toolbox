import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fixtureElementFeature } from '../extension/fixture-elements.ts';
import { fixtureOther, fixtureTask } from '../extension/fixture-tasks.ts';
import { fixtureDistPath } from './support/extension.ts';

// 모든 페이지의 모든 프레임에 실리는 묶음에는 그 묶음에 페이지 쪽 일이 있는 기능의 정의만 들어간다(결정 0027). 페이지에
// 작용하지 않는 기능이 늘어도 페이지마다 그 정의를 싣고 스키마를 만들고 항목을 검증하는 비용이 늘지 않게 하려는 것이다.
// 시험 빌드에는 페이지에 작용하지 않는 기능(시험 작업 둘)과 작용하는 기능(미디어 배속, 시험 요소 기능)이 함께 있다.

const bundle = (file: string) => readFileSync(path.join(fixtureDistPath, file), 'utf8');

test('결정 0027 콘텐츠 스크립트 묶음에는 페이지 쪽 일이 있는 기능의 정의만 들어간다', () => {
  const content = bundle('content-common.js');
  const worker = bundle('sw.js');
  for (const { id } of [fixtureTask, fixtureOther]) {
    // 정의가 묶음에 들어가면 그 id가 글자 그대로 남는다(서비스 워커 묶음에서 확인).
    expect(worker, `서비스 워커 묶음의 ${id}`).toContain(`"${id}"`);
    expect(content, `콘텐츠 스크립트 묶음의 ${id}`).not.toContain(`"${id}"`);
  }
  for (const id of ['media-speed', fixtureElementFeature.id]) {
    expect(content, `콘텐츠 스크립트 묶음의 ${id}`).toContain(`"${id}"`);
  }
});
