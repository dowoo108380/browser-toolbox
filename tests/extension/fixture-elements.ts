import * as z from 'zod/mini';
import { defineFeature } from '../../src/contracts/index.ts';
import type { NamedElement } from '../../src/dom/index.ts';
import { definePagePart } from '../../src/page/index.ts';

// 시험 빌드(결정 0025)에만 들어가는 켜고 끄기 기능 하나. 시험 페이지(tests/fixtures/elements.html)의 "시험 대상 영역"에
// 기댄다(COM-6, 결정 0026). 사이트 모듈(sites/<사이트>/)이 요소를 정의하는 자리를 이 파일이 대신한다. 시험 페이지는 특정
// 사이트를 본뜨지 않는다. 사이트를 본뜬 시험 페이지는 그 사이트의 기능과 함께 만든다(quality 105).

// 기대는 요소. 외부 사이트에서처럼 클래스 이름이 아니라 역할과 aria-label로 찾는다(R-13).
export const fixtureTarget: NamedElement = {
  id: 'fixture.target',
  name: '시험 대상 영역',
  find: (document) => document.querySelector('[role="region"][aria-label="시험 대상 영역"]'),
};

// 기능이 페이지에 단 표시. 시험이 기능이 작용했는지 본다.
export const waitingAttribute = 'data-fixture-element-waiting';
export const appliedAttribute = 'data-fixture-element-applied';

export const fixtureElementFeature = defineFeature({
  id: 'fixture-element',
  requirements: [],
  name: '시험 요소 기능',
  description: '시험 요소 기능은 시험 빌드에만 있다.',
  category: 'page',
  kind: 'toggle',
  content: { sites: 'all', frames: 'top' },
  permissions: [],
  settings: { schema: z.object({ enabled: z.boolean() }), defaults: { enabled: false } },
});

// 켜지면 먼저 문서 루트에 표시를 달고(찾기 전에 적용한 변경, COM-6.1), 대상 영역을 찾으면 그 영역에도 표시를 단다.
// 모두 자원 범위에 맡겨, 끄거나 찾지 못하면 사라진다.
export const fixtureElementPart = definePagePart(
  fixtureElementFeature,
  (_settings, { document, scope, find }) => {
    const root = document.documentElement;
    root.setAttribute(waitingAttribute, '');
    scope.defer(() => {
      root.removeAttribute(waitingAttribute);
    });
    find(fixtureTarget, (target) => {
      target.setAttribute(appliedAttribute, '');
      scope.defer(() => {
        target.removeAttribute(appliedAttribute);
      });
    });
  },
);
