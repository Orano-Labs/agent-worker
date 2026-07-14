import * as pb from "@bufbuild/protobuf";
import * as pbInternal from "@bufbuild/protobuf/wkt";
import * as pbValidate from "@bufbuild/protovalidate";

export namespace Protobuf {
  const validator = pbValidate.createValidator({
    failFast: true,
  });

  export type MessageDescriptor = import("@bufbuild/protobuf").DescMessage;

  export type MessageValid<T extends MessageDescriptor> = import("@bufbuild/protobuf").MessageValidType<T>;

  export type MessageShape<T extends MessageDescriptor> = import("@bufbuild/protobuf").MessageShape<T>;

  export type MessageShapeInit<T extends MessageDescriptor> = import("@bufbuild/protobuf").MessageInitShape<T>;

  export const encode = <T extends MessageDescriptor>(schema: T, message: MessageShape<T>) => {
    return pb.toBinary(schema, message, { writeUnknownFields: false });
  };

  export const decode = <T extends MessageDescriptor>(schema: T, binary: Uint8Array) => {
    return pb.fromBinary(schema, binary);
  };

  export const create = <T extends MessageDescriptor>(desc: T, init: MessageShapeInit<T>) => {
    return pb.create(desc, init);
  };

  export const createValid = <T extends MessageDescriptor>(desc: T, init: Omit<MessageValid<T>, "$typeName" | "$unknown">) => {
    return pb.create(desc, init as unknown as MessageShapeInit<T>) as MessageValid<T>;
  };

  export const validate = <T extends MessageDescriptor>(desc: T, shape: MessageShape<T>) => {
    return validator.validate(desc, shape);
  };

  export type Timestamp = import("@bufbuild/protobuf/wkt").Timestamp;

  export namespace Timestamp {
    export const toDate = (timestamp: Timestamp) => {
      return pbInternal.timestampDate(timestamp);
    };

    export const fromDate = (date: Date) => {
      return pbInternal.timestampFromDate(date);
    };

    export const now = () => {
      return pbInternal.timestampNow();
    };
  }
}
