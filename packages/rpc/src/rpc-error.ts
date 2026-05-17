import { asError } from "catch-unknown";

import type { RPCMessage } from "@/rpc-message";

export class RPCError extends Error {
  #message: string;
  #cause?: unknown;
  #code: RPCError.Code;

  #details: Map<string, RPCMessage.Transferable>;

  constructor(code: RPCError.Code, message: string, cause?: unknown) {
    super(message, { cause });

    this.#message = message;
    this.#cause = cause;
    this.#code = code;
    this.#details = new Map();
  }

  get message() {
    return this.#message;
  }

  get cause() {
    return this.#cause;
  }

  get code() {
    return this.#code;
  }

  get details() {
    return Object.fromEntries(this.#details.entries());
  }

  get isCanceled() {
    return this.#code === RPCError.Code.Canceled;
  }

  get isUnknown() {
    return this.#code === RPCError.Code.Unknown;
  }

  get isInvalidArgument() {
    return this.#code === RPCError.Code.InvalidArgument;
  }

  get isDeadlineExceeded() {
    return this.#code === RPCError.Code.DeadlineExceeded;
  }

  get isNotfound() {
    return this.#code === RPCError.Code.Notfound;
  }

  get isAlreadyExists() {
    return this.#code === RPCError.Code.AlreadyExists;
  }

  get isPermissionDenied() {
    return this.#code === RPCError.Code.PermissionDenied;
  }

  get isResourceExhausted() {
    return this.#code === RPCError.Code.ResourceExhausted;
  }

  get isFailedPrecondition() {
    return this.#code === RPCError.Code.FailedPrecondition;
  }

  get isAborted() {
    return this.#code === RPCError.Code.Aborted;
  }

  get isOutOfRange() {
    return this.#code === RPCError.Code.OutOfRange;
  }

  get isUnimplemented() {
    return this.#code === RPCError.Code.Unimplemented;
  }

  get isInternal() {
    return this.#code === RPCError.Code.Internal;
  }

  get isUnavailable() {
    return this.#code === RPCError.Code.Unavailable;
  }

  get isDataLoss() {
    return this.#code === RPCError.Code.DataLoss;
  }

  get isUnauthenticated() {
    return this.#code === RPCError.Code.Unauthenticated;
  }

  with(key: string, value?: RPCMessage.Transferable) {
    if (value !== undefined) {
      this.#details.set(key, value);
    } else {
      this.#details.delete(key);
    }

    return this;
  }

  transferable() {
    const error: RPCMessage.Error = {
      code: this.#code,
      message: this.message,
      details: Object.fromEntries(this.#details.entries()),
    };

    return error;
  }

  detail(key: string) {
    return this.#details.get(key);
  }

  static normalizeCode(code: number) {
    switch (code) {
      case 1:
        return RPCError.Code.Canceled;
      case 2:
        return RPCError.Code.Unknown;
      case 3:
        return RPCError.Code.InvalidArgument;
      case 4:
        return RPCError.Code.DeadlineExceeded;
      case 5:
        return RPCError.Code.Notfound;
      case 6:
        return RPCError.Code.AlreadyExists;
      case 7:
        return RPCError.Code.PermissionDenied;
      case 8:
        return RPCError.Code.ResourceExhausted;
      case 9:
        return RPCError.Code.FailedPrecondition;
      case 10:
        return RPCError.Code.Aborted;
      case 11:
        return RPCError.Code.OutOfRange;
      case 12:
        return RPCError.Code.Unimplemented;
      case 13:
        return RPCError.Code.Internal;
      case 14:
        return RPCError.Code.Unavailable;
      case 15:
        return RPCError.Code.DataLoss;
      case 16:
        return RPCError.Code.Unauthenticated;
      default:
        return RPCError.Code.Unknown;
    }
  }

  static fromUnknown(value: unknown, code: RPCError.Code = RPCError.Code.Unknown) {
    if (value instanceof RPCError) {
      return value;
    } else {
      const normalized = asError(value);
      const error = new RPCError(code, normalized.message, value);

      error.stack = normalized.stack;

      return error;
    }
  }

  static fromTransferable(error: RPCMessage.Error) {
    const code = RPCError.normalizeCode(error.code);
    const message = error.message;

    const instance = new RPCError(code, message);

    if (error.details) {
      for (const entry of Object.entries(error.details)) {
        instance.with(...entry);
      }
    }

    return instance;
  }

  static createCanceled(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Canceled, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createCanceled);
    }

    return error;
  }

  static createUnknown(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Unknown, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createUnknown);
    }

    return error;
  }

  static createInvalidArgument(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.InvalidArgument, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createInvalidArgument);
    }

    return error;
  }

  static createDeadlineExceeded(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.DeadlineExceeded, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createDeadlineExceeded);
    }

    return error;
  }

  static createNotfound(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Notfound, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createNotfound);
    }

    return error;
  }

  static createAlreadyExists(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.AlreadyExists, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createAlreadyExists);
    }

    return error;
  }

  static createPermissionDenied(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.PermissionDenied, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createPermissionDenied);
    }

    return error;
  }

  static createResourceExhausted(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.ResourceExhausted, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createResourceExhausted);
    }

    return error;
  }

  static createFailedPrecondition(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.FailedPrecondition, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createFailedPrecondition);
    }

    return error;
  }

  static createAborted(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Aborted, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createAborted);
    }

    return error;
  }

  static createOutOfRange(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.OutOfRange, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createOutOfRange);
    }

    return error;
  }

  static createUnimplemented(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Unimplemented, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createUnimplemented);
    }

    return error;
  }

  static createInternal(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Internal, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createInternal);
    }

    return error;
  }

  static createUnavailable(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Unavailable, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createUnavailable);
    }

    return error;
  }

  static createDataLoss(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.DataLoss, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createDataLoss);
    }

    return error;
  }

  static createUnauthenticated(message: string, cause?: unknown) {
    const error = new RPCError(RPCError.Code.Unauthenticated, message, cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(error, RPCError.createUnauthenticated);
    }

    return error;
  }
}

export namespace RPCError {
  export enum Code {
    /**
     * Canceled, usually by the user
     */
    Canceled = 1,
    /**
     * Unknown error
     */
    Unknown = 2,
    /**
     * Argument invalid regardless of system state
     */
    InvalidArgument = 3,
    /**
     * Operation expired, may or may not have completed.
     */
    DeadlineExceeded = 4,
    /**
     * Entity not found.
     */
    Notfound = 5,
    /**
     * Entity already exists.
     */
    AlreadyExists = 6,
    /**
     * Operation not authorized.
     */
    PermissionDenied = 7,
    /**
     * Quota exhausted.
     */
    ResourceExhausted = 8,
    /**
     * Argument invalid in current system state.
     */
    FailedPrecondition = 9,
    /**
     * Operation aborted.
     */
    Aborted = 10,
    /**
     * Out of bounds, use instead of FailedPrecondition.
     */
    OutOfRange = 11,
    /**
     * Operation not implemented or disabled.
     */
    Unimplemented = 12,
    /**
     * Internal error, reserved for "serious errors".
     */
    Internal = 13,
    /**
     * Unavailable, client should back off and retry.
     */
    Unavailable = 14,
    /**
     * Unrecoverable data loss or corruption.
     */
    DataLoss = 15,
    /**
     * Request isn't authenticated.
     */
    Unauthenticated = 16,
  }
}
