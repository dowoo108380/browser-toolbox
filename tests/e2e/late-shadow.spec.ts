import { expect, fixtureOrigin, hostCount, openPopup, test } from './support/extension.ts';

// 기능을 켜 둔 채 연 페이지에서, 이미 파싱된 요소에 페이지 스크립트가 나중에 붙인 shadow root 안의 영상(결정 0019의 한계, N-17).
// 실험(결정 0019 "기능을 켜 둔 채 연 페이지"): 확장은 페이지를 연 뒤 약 20ms에 문서를 처음 훑는다. 그보다 먼저 root가 붙으면 찾고,
// 뒤에 붙으면 놓친다. 파서가 요소를 넣은 뒤 그 뒤의 스크립트를 돌리기 전에 관찰 알림을 먼저 처리하므로(HTML 명세의 microtask
// checkpoint), 기능이 먼저 시작했으면 요소 바로 뒤의 인라인 스크립트도 늦다.
// 이 시험은 그 순서를 확실히 만들려고, 확장이 문서를 훑은 것(보통 영상의 표시창)을 본 뒤에 page.evaluate로 root를 단다.
// 지금 동작(놓침)을 고정한다. 고치면(MED-1·MED-4를 만들 때 다시 봄) 이 시험의 기대를 바꾼다.
// 기능을 켜기 전에 root가 붙은 경우(찾음)는 tests/e2e/shadow-video.spec.ts가 본다.

test('N-17 기능을 켜 둔 채 연 페이지에서 이미 훑은 요소에 나중에 붙은 shadow root 안의 영상에는 띄우지 못하고, 기능을 껐다 켜면 띄운다', async ({
  context,
  extensionId,
}) => {
  const popup = await openPopup(context, extensionId);
  const toggle = popup.getByRole('switch', { name: '미디어 배속' });
  await toggle.check();

  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`${fixtureOrigin}/late-shadow.html`);
  // 확장이 문서를 훑었다(보통 영상의 표시창). 사용자 정의 요소와 div에는 아직 root가 없다.
  await expect.poll(() => hostCount(page)).toBe(1);

  // 사이트의 스크립트가 나중에 root를 단다: 사용자 정의 요소를 정의해 업그레이드하고(생성자가 root와 영상을 닮),
  // div에 root와 영상을 직접 단다.
  await page.evaluate(() => {
    const video = () => {
      const element = document.createElement('video');
      element.style.cssText = 'display: block; width: 320px; height: 180px';
      return element;
    };
    customElements.define(
      'test-player',
      // eslint-disable-next-line no-restricted-syntax -- 사용자 정의 요소는 플랫폼이 HTMLElement 상속을 요구한다(quality 048의 예외).
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).append(video());
        }
      },
    );
    document.getElementById('plain-player')?.attachShadow({ mode: 'open' }).append(video());
  });
  // 두 영상이 페이지에 생겼다. 확장의 관찰이 돌 틈(두 화면 프레임)을 준 뒤에도 표시창은 보통 영상의 것 하나뿐이다.
  expect(
    await page.evaluate(
      () =>
        ['custom-player', 'plain-player'].filter(
          (id) =>
            document.getElementById(id)?.shadowRoot?.querySelector('video') instanceof
            HTMLVideoElement,
        ).length,
    ),
  ).toBe(2);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  expect(await hostCount(page)).toBe(1);

  // 확장은 그 뒤의 바뀜은 계속 본다: 나중에 더한 보통 영상에는 띄운다.
  await page.evaluate(() => {
    document.body.append(document.createElement('video'));
  });
  await expect.poll(() => hostCount(page)).toBe(2);

  // 기능을 껐다 켜면 처음부터 다시 훑어, 그때 붙어 있는 root 안의 영상에도 띄운다.
  await toggle.uncheck();
  await expect.poll(() => hostCount(page)).toBe(0);
  await toggle.check();
  await expect.poll(() => hostCount(page)).toBe(4);
  expect(pageErrors).toEqual([]);
});
