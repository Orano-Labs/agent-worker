import type { DescMessage, MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

const createErrorBuilder = (code: Code, message: string) => {
  const headers = new Headers();
  const details: { desc: DescMessage; value: MessageInitShape<DescMessage> }[] = [];

  const builder = {
    error: () => {
      return new ConnectError(message, code, headers, details);
    },
    header: (key: string, value: string) => {
      headers.set(key, value);
      return builder;
    },
    detail: <T extends DescMessage>(desc: T, value: MessageInitShape<T>) => {
      details.push({ desc, value });
      return builder;
    },
  };

  return builder;
};

export const createCanceledError = (message: string) => createErrorBuilder(Code.Canceled, message);
export const createUnknownError = (message: string) => createErrorBuilder(Code.Unknown, message);
export const createInvalidArgumentError = (message: string) => createErrorBuilder(Code.InvalidArgument, message);
export const createDeadlineExceededError = (message: string) => createErrorBuilder(Code.DeadlineExceeded, message);
export const createNotFoundError = (message: string) => createErrorBuilder(Code.NotFound, message);
export const createAlreadyExistsError = (message: string) => createErrorBuilder(Code.AlreadyExists, message);
export const createPermissionDeniedError = (message: string) => createErrorBuilder(Code.PermissionDenied, message);
export const createResourceExhaustedError = (message: string) => createErrorBuilder(Code.ResourceExhausted, message);
export const createFailedPreconditionError = (message: string) => createErrorBuilder(Code.FailedPrecondition, message);
export const createAbortedError = (message: string) => createErrorBuilder(Code.Aborted, message);
export const createOutOfRangeError = (message: string) => createErrorBuilder(Code.OutOfRange, message);
export const createUnimplementedError = (message: string) => createErrorBuilder(Code.Unimplemented, message);
export const createInternalError = (message: string) => createErrorBuilder(Code.Internal, message);
export const createUnavailableError = (message: string) => createErrorBuilder(Code.Unavailable, message);
export const createDataLossError = (message: string) => createErrorBuilder(Code.DataLoss, message);
export const createUnauthenticatedError = (message: string) => createErrorBuilder(Code.Unauthenticated, message);
