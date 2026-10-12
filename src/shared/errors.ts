// 오류 종류는 docs의 아키텍처 7장 목록과 같다. 늘릴 때는 그 목록을 함께 고친다.
export const errorKinds = [
  'invalid-input',
  'not-found',
  'timeout',
  'unavailable',
  'permission',
  'disconnected',
  'limit',
  'cancelled',
  'platform',
  'unexpected',
] as const;

export type ErrorKind = (typeof errorKinds)[number];

export interface AppError {
  readonly kind: ErrorKind;
  // 사용자에게 보일 수 있는 한국어 설명. 주소, 제목, 파일 이름을 넣지 않는다(quality 082).
  readonly message: string;
}

export function appError(kind: ErrorKind, message: string): AppError {
  return { kind, message };
}
