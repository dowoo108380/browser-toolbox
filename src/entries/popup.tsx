import { render } from 'preact';
import { settingsUpdate } from '../contracts/index.ts';
import { features } from '../features/list.ts';
import { chromeLocalStore, chromeRequester } from '../platform/index.ts';
import { settingsFormat, startSettingsReader } from '../storage/index.ts';
import { PopupApp } from '../ui/index.ts';

const request = chromeRequester();
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
