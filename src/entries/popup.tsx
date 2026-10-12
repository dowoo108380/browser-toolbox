import { render } from 'preact';
import { settingsUpdate, storageEnsureReady } from '../contracts/index.ts';
import { features } from '../features/list.ts';
import { chromeLocalStore, chromeRequester } from '../platform/index.ts';
import { settingsFormat, startSettingsReader } from '../storage/index.ts';
import { PopupApp } from '../ui/index.ts';

const request = chromeRequester();

// 팝업이 열리면 바로 서비스 워커를 깨운다. 서비스 워커가 깨어나는 중에 요청을 보내고 팝업이 곧바로 닫히면
// 그 요청이 닿지 않을 수 있다(N-12, 05단계 확인). 사용자가 무엇을 누를 때쯤에는 깨어 있게 한다.
// 결과는 쓰지 않는다. 설정에 문제가 있으면 읽기 도우미가 따로 알린다.
void request(storageEnsureReady, {});

const root = document.getElementById('root');
if (root === null) throw new Error('팝업 문서에 #root가 없다.');

render(
  <PopupApp
    features={features}
    subscribe={(handlers) =>
      startSettingsReader(
        { store: chromeLocalStore(), request, format: settingsFormat, specs: features },
        handlers,
      )
    }
    update={(featureId, patch) => request(settingsUpdate, { featureId, patch })}
  />,
  root,
);
