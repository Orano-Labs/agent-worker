import { type Result as OriginResult, err as originError, ok as originOk } from "neverthrow";

export type Result<T, E> = OriginResult<T, E>;

export namespace Result {
  export const ok = originOk;
  export const error = originError;
}
