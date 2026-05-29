import { asError, isError } from "catch-unknown";

export namespace ErrorHelpers {
  export const is = isError;

  export const as = asError;
}
