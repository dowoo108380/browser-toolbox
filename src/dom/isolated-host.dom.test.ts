import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedHost, hostTagName } from './isolated-host.ts';

// 시험 실행기가 문서 head에 둔 것은 건드리지 않는다. 테스트가 더한 것만 지운다.
const added: Element[] = [];

afterEach(() => {
  for (const element of added.splice(0)) element.remove();
  for (const host of document.querySelectorAll(hostTagName)) host.remove();
});

describe('격리된 화면 틀(quality 005)', () => {
  it('MED-3.5 같은 이름의 요소와 클래스를 꾸미는 페이지 CSS가 안쪽에 영향을 주지 않는다', () => {
    const pageStyle = document.createElement('style');
    pageStyle.textContent = `
      div, .label { color: rgb(255, 0, 0) !important; font-size: 40px !important; }
      * { display: none !important; }
    `;
    document.head.append(pageStyle);
    added.push(pageStyle);
    const { host, root } = createIsolatedHost(document, {
      name: 'test',
      css: '.label { color: rgb(0, 128, 0); font-size: 12px; }',
      parent: document.body,
    });
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = '1.5×';
    root.append(label);

    expect(getComputedStyle(host).display).toBe('block');
    expect(getComputedStyle(label).color).toBe('rgb(0, 128, 0)');
    expect(getComputedStyle(label).fontSize).toBe('12px');
    // 닫힌 shadow root라 페이지는 안을 볼 수 없다.
    expect(host.shadowRoot).toBeNull();
  });

  it('안쪽 스타일이 페이지에 새어 나가지 않는다', () => {
    const outside = document.createElement('div');
    outside.className = 'label';
    document.body.append(outside);
    added.push(outside);
    createIsolatedHost(document, {
      name: 'test',
      css: '.label { color: rgb(0, 128, 0); }',
      parent: document.body,
    });
    expect(getComputedStyle(outside).color).not.toBe('rgb(0, 128, 0)');
  });

  it('지우면 페이지에 남는 것이 없다', () => {
    const before = document.body.innerHTML;
    const host = createIsolatedHost(document, { name: 'test', css: '', parent: document.body });
    host.remove();
    expect(document.body.innerHTML).toBe(before);
  });
});
