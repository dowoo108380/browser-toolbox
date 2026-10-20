import type * as v from './schema.ts';

// 기능별 명령(아키텍처 4장, 결정 0043). 한 기능의 서비스 워커 쪽과 페이지 쪽이 주고받는 요청이다. 명령은 그 기능의
// feature.ts가 정하고, 보낼 때는 공용 봉투(messages.ts의 featureCommand)에 기능 id와 이름을 실어 보낸다. 받는 쪽은 봉투를
// 검증한 뒤 이 스키마로 내용을 다시 검증하고, 보낸 쪽은 응답을 value로 검증한다. 공용 메시지 목록에 기능마다의 메시지를
// 더하지 않기 위해서다(기능별 명령은 그 기능이 정한다, 아키텍처 4장).
export interface FeatureCommand<Payload, Value> {
  readonly featureId: string;
  readonly name: string;
  readonly payload: v.Schema<Payload>;
  readonly value: v.Schema<Value>;
}

export function defineCommand<Payload, Value>(
  command: FeatureCommand<Payload, Value>,
): FeatureCommand<Payload, Value> {
  return command;
}
