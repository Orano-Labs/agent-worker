import { DescEnum, DescField, DescFile, DescMessage, DescOneof, DescService, getOption, hasOption, ScalarType } from "@bufbuild/protobuf";
import { scalarTypeScriptType, wktPublicImportPaths } from "@bufbuild/protobuf/codegenv2";
import {
  FeatureSet_FieldPresence,
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_compiler_plugin,
  file_google_protobuf_cpp_features,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_go_features,
  file_google_protobuf_java_features,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
  isWrapperDesc,
} from "@bufbuild/protobuf/wkt";
import { createEcmaScriptPlugin, GeneratedFile, Printable, Schema } from "@bufbuild/protoplugin";
import { field as FieldExtension, FieldRules, Ignore } from "@/generated/buf-validate-minimal_pb";

export class Generator {
  #fieldIsLegacyRequired(field: DescField) {
    return field.fieldKind === "message" && field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED;
  }

  #fieldIsProtoValidateDisabled(field: DescField) {
    if (field.message === undefined) {
      return false;
    }

    const fieldRules = getOption(field, FieldExtension);

    if (fieldRules.ignore === Ignore.ALWAYS) {
      return true;
    }

    const childRules: FieldRules | undefined =
      field.fieldKind === "list" && fieldRules.type.case === "repeated"
        ? fieldRules.type.value.items
        : field.fieldKind === "map" && fieldRules.type.case === "map"
          ? fieldRules.type.value.values
          : undefined;

    if (childRules) {
      return childRules.ignore === Ignore.ALWAYS;
    }

    return false;
  }

  #fieldIsProtoValidateRequired(field: DescField) {
    if (!hasOption(field, FieldExtension)) {
      return false;
    }

    const fieldRules = getOption(field, FieldExtension);

    if (fieldRules.ignore === Ignore.ALWAYS) {
      return false;
    }

    return fieldRules.required;
  }

  #fieldHasPresence(desc: DescField) {
    switch (desc.fieldKind) {
      case "scalar":
      case "enum":
        return desc.proto.proto3Optional;
      case "message":
        return true;
      case "list":
      case "map":
        return false;
    }
  }

  #fieldIsOptional(desc: DescField) {
    let optional = this.#fieldHasPresence(desc);

    if (optional) {
      if (this.#fieldIsLegacyRequired(desc) || this.#fieldIsProtoValidateRequired(desc)) {
        optional = false;
      }
    }

    return optional;
  }

  #fieldIsStruct(desc: DescField) {
    return desc.message?.typeName === "google.protobuf.Struct";
  }

  #fieldIsTimestamp(desc: DescField) {
    return desc.message?.typeName === "google.protobuf.Timestamp";
  }

  #generateFile(ctx: Generator.Context) {
    ctx.f.preamble(ctx.file);

    ctx.print``;

    for (const desc of ctx.schema.typesInFile(ctx.file)) {
      switch (desc.kind) {
        case "message": {
          this.#generateMessage(ctx, desc);
          break;
        }
        case "enum": {
          this.#generateEnum(ctx, desc);
          break;
        }
        case "service": {
          this.#generateService(ctx, desc);
          break;
        }
      }
    }
  }

  #generateService(ctx: Generator.Context, desc: DescService) {
    const name = ctx.f.importSchema(desc).name;

    ctx.print`${ctx.f.jsDoc(desc, "")}`;
    ctx.print`${ctx.f.export("interface", name)}<T> {`;

    for (const method of desc.methods) {
      const req = this.#generateTypeReference(ctx, method.input);
      const res = this.#generateTypeReference(ctx, method.output);

      if (desc.methods.indexOf(method) !== 0) {
        ctx.print``;
      }

      ctx.print`${ctx.f.jsDoc(method, "  ")}`;

      if (method.methodKind === "unary") {
        ctx.print`  ${method.localName}(request: ${req}, context: T): Promise<${res}>;`;
      }

      if (method.methodKind === "client_streaming") {
        ctx.print`  ${method.localName}(request: AsyncIterable<${req}>, context: T): Promise<${res}>;`;
      }

      if (method.methodKind === "server_streaming") {
        ctx.print`  ${method.localName}(request: ${req}, context: T): AsyncIterable<${res}>;`;
      }

      if (method.methodKind === "bidi_streaming") {
        ctx.print`  ${method.localName}(request: AsyncIterable<${req}>, context: T): AsyncIterable<${res}>;`;
      }
    }

    ctx.print`};`;
    ctx.print``;

    ctx.print`const ${name}$$ = {`;

    for (const method of desc.methods) {
      const req = this.#generateTypeReference(ctx, method.input);
      const res = this.#generateTypeReference(ctx, method.output);

      if (method.methodKind === "unary") {
        ctx.print`  ${method.localName}: /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createUnaryMethod("${method.localName}", ${ctx.f.importSchema(desc)}.method.${method.localName}, ${req}, ${res}),`;
      }

      if (method.methodKind === "client_streaming") {
        ctx.print`  ${method.localName}: /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createClientStreamingMethod("${method.localName}", ${ctx.f.importSchema(desc)}.method.${method.localName}, ${req}, ${res}),`;
      }

      if (method.methodKind === "server_streaming") {
        ctx.print`  ${method.localName}: /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createServerStreamingMethod("${method.localName}", ${ctx.f.importSchema(desc)}.method.${method.localName}, ${req}, ${res}),`;
      }

      if (method.methodKind === "bidi_streaming") {
        ctx.print`  ${method.localName}: /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createBidiStreamingMethod("${method.localName}", ${ctx.f.importSchema(desc)}.method.${method.localName}, ${req}, ${res}),`;
      }
    }

    ctx.print`} as const;`;
    ctx.print``;

    ctx.print`${ctx.f.jsDoc(desc, "")}`;
    ctx.print`${ctx.f.export("const", name)}: ReturnType<typeof ${ctx.f.import("Proto", "@aw/proto")}.createService<typeof ${name}$$, typeof ${ctx.f.importSchema(desc)}>> = /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createService(${name}$$, ${ctx.f.importSchema(desc)});`;
    ctx.print``;
  }

  #generateMessage(ctx: Generator.Context, desc: DescMessage) {
    const name = ctx.f.importShape(desc).name;

    ctx.print`${ctx.f.jsDoc(desc, "")}`;
    ctx.print`${ctx.f.export("type", name)} = {`;

    for (const member of desc.members) {
      this.#generateMessageMember(ctx, member);

      if (desc.members.indexOf(member) < desc.members.length - 1) {
        ctx.print``;
      }
    }

    ctx.print`};`;
    ctx.print``;

    ctx.print`${ctx.f.jsDoc(desc, "")}`;
    ctx.print`${ctx.f.export("const", name)}: ReturnType<typeof ${ctx.f.import("Proto", "@aw/proto")}.createMessage<${name}>> = /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createMessage(${ctx.f.importSchema(desc)}, {`;

    this.#generateMessageConverters(ctx, desc);

    ctx.print`});`;
    ctx.print``;
    ctx.print``;
  }

  #generateMessageMember(ctx: Generator.Context, desc: DescField | DescOneof) {
    ctx.print`${ctx.f.jsDoc(desc, "  ")}`;

    if (desc.kind === "field") {
      this.#generateMessageFieldMember(ctx, desc);
    } else {
      this.#generateMessageOneOfMember(ctx, desc);
    }
  }

  #generateMessageFieldMember(ctx: Generator.Context, desc: DescField) {
    ctx.print`  ${desc.localName}${this.#fieldIsOptional(desc) ? "?" : ""}: ${this.#generateMessageFieldType(ctx, desc)}${this.#fieldIsOptional(desc) ? " | undefined" : ""};`;
  }

  #generateMessageOneOfMember(ctx: Generator.Context, desc: DescOneof) {
    ctx.print`  ${desc.localName}:`;

    for (const field of desc.fields) {
      ctx.print`${ctx.f.jsDoc(field, "    ")}`;
      ctx.print`    | { case: "${field.localName}"; value: ${this.#generateMessageFieldType(ctx, field)} }`;
    }

    ctx.print`    | { case: undefined; value?: undefined };`;
  }

  #generateMessageFieldType(ctx: Generator.Context, desc: DescField): Printable[] {
    const type: Printable[] = [];

    if (this.#fieldIsProtoValidateDisabled(desc)) {
      throw new Error(
        `Cannot disable proto validate for field "${desc.parent.typeName}.${desc.name} = ${desc.number}": (buf.validate.field).ignore = IGNORE_ALWAYS is not supported`,
      );
    }

    switch (desc.fieldKind) {
      case "scalar":
        type.push(scalarTypeScriptType(desc.scalar, desc.longAsString));
        break;
      case "message":
        if (isWrapperDesc(desc.message) && desc.oneof === undefined) {
          type.push(scalarTypeScriptType(desc.message.fields[0].scalar, false));
        } else {
          type.push(this.#generateTypeReference(ctx, desc.message));
        }
        break;
      case "enum":
        type.push(this.#generateTypeReference(ctx, desc.enum));
        break;
      case "list":
        switch (desc.listKind) {
          case "enum":
            type.push(this.#generateTypeReference(ctx, desc.enum), "[]");
            break;
          case "scalar":
            type.push(scalarTypeScriptType(desc.scalar, desc.longAsString), "[]");
            break;
          case "message":
            type.push(this.#generateTypeReference(ctx, desc.message), "[]");
            break;
        }
        break;
      case "map": {
        let keyType: string;
        switch (desc.mapKey) {
          case ScalarType.INT32:
          case ScalarType.FIXED32:
          case ScalarType.UINT32:
          case ScalarType.SFIXED32:
          case ScalarType.SINT32:
            keyType = "number";
            break;
          default:
            keyType = "string";
            break;
        }
        let valueType: Printable;
        switch (desc.mapKind) {
          case "scalar":
            valueType = scalarTypeScriptType(desc.scalar, false);
            break;
          case "message":
            valueType = this.#generateTypeReference(ctx, desc.message);
            break;
          case "enum":
            valueType = this.#generateTypeReference(ctx, desc.enum);
            break;
        }
        type.push("{ [key: ", keyType, "]: ", valueType, " }");
        break;
      }
    }

    return type;
  }

  #generateMessageConverters(ctx: Generator.Context, desc: DescMessage) {
    const runtimeShape = desc.file.proto.name in wktPublicImportPaths ? ctx.f.importShape(desc) : ctx.f.importValid(desc);
    const name = ctx.f.importShape(desc).name;

    const fields = (source: "shape" | "message", method: "fromRuntimeShape" | "toRuntimeShape") => {
      const convertTimestamp =
        method === "fromRuntimeShape"
          ? ctx.f.import("timestampDate", "@bufbuild/protobuf/wkt")
          : ctx.f.import("timestampFromDate", "@bufbuild/protobuf/wkt");

      for (const member of desc.members) {
        const key = member.localName;
        const accessor = `${source}.${key}`;

        if (member.kind === "field") {
          const guard = this.#fieldIsOptional(member) ? `${accessor} === undefined ? undefined : ` : "";

          if (this.#fieldIsStruct(member)) {
            ctx.print`      ${key}: ${guard}${accessor},`;

            continue;
          }

          if (this.#fieldIsTimestamp(member)) {
            switch (member.fieldKind) {
              case "message":
                ctx.print`      ${key}: ${guard}${convertTimestamp}(${accessor}),`;
                break;
              case "list":
                ctx.print`      ${key}: ${guard}${accessor}.map((v) => ${convertTimestamp}(v)),`;
                break;
              case "map":
                ctx.print`      ${key}: ${guard}Object.fromEntries(Object.entries(${accessor}).map(([k, v]) => [k, ${convertTimestamp}(v)] as const)),`;
                break;
            }

            continue;
          }

          if (member.message && !(member.fieldKind === "message" && isWrapperDesc(member.message))) {
            const target = this.#generateTypeReference(ctx, member.message);

            switch (member.fieldKind) {
              case "message":
                ctx.print`      ${key}: ${guard}${target}.${method}(${accessor}),`;
                break;
              case "list":
                ctx.print`      ${key}: ${guard}${accessor}.map((v) => ${target}.${method}(v)),`;
                break;
              case "map":
                ctx.print`      ${key}: ${guard}Object.fromEntries(Object.entries(${accessor}).map(([k, v]) => [k, ${target}.${method}(v)] as const)),`;
                break;
            }

            continue;
          }

          ctx.print`      ${key}: ${guard}${accessor},`;

          continue;
        }

        const conversion: Printable[] = [];

        for (const field of member.fields) {
          if (this.#fieldIsStruct(field)) {
            continue;
          }

          if (this.#fieldIsTimestamp(field)) {
            conversion.push(
              `${accessor}.case === "${field.localName}" ? { case: "${field.localName}", value: `,
              convertTimestamp,
              `(${accessor}.value) } : `,
            );

            continue;
          }

          if (field.message && !(field.fieldKind === "message" && isWrapperDesc(field.message))) {
            const target = this.#generateTypeReference(ctx, field.message);

            conversion.push(
              `${accessor}.case === "${field.localName}" ? { case: "${field.localName}", value: `,
              target,
              `.${method}(${accessor}.value) } : `,
            );
          }
        }

        conversion.push(accessor);

        ctx.print`      ${member.localName}: ${conversion},`;
      }
    };

    ctx.print`  fromRuntimeShape: (s) => {`;

    if (desc.members.length > 0) {
      ctx.print`    const shape = s as ${runtimeShape};`;
      ctx.print``;
    }

    ctx.print`    return {`;

    fields("shape", "fromRuntimeShape");

    ctx.print`    } satisfies ${name} as ${name};`;
    ctx.print`  },`;

    ctx.print`  toRuntimeShape: (message) => {`;
    ctx.print`    return {`;
    ctx.print`      $typeName: "${desc.typeName}",`;

    fields("message", "toRuntimeShape");

    ctx.print`    };`;
    ctx.print`  },`;
  }

  #generateTypeReference(ctx: Generator.Context, desc: DescMessage | DescEnum): Printable {
    if (desc.kind === "message" && desc.typeName === "google.protobuf.Struct") {
      return ctx.f.runtime.JsonObject;
    }

    if (desc.kind === "message" && desc.typeName === "google.protobuf.Timestamp") {
      return "Date";
    }

    const shape = ctx.f.importShape(desc);

    if (desc.file === ctx.file) {
      return shape.name;
    }

    return ctx.f.import(shape.name, `./${desc.file.name}.js`);
  }

  #generateEnum(ctx: Generator.Context, desc: DescEnum) {
    const name = ctx.f.importShape(desc).name;

    ctx.print`${ctx.f.jsDoc(desc)}`;
    ctx.print`${ctx.f.export("type", name)} = (typeof ${name}$$[keyof typeof ${name}$$]) | (number & { __unknown_enum: true })`;
    ctx.print``;

    ctx.print`const ${name}$$ = {`;

    for (const value of desc.values) {
      if (desc.values.indexOf(value) > 0) {
        ctx.print``;
      }
      ctx.print`${ctx.f.jsDoc(value, "  ")}`;
      ctx.print`  ${value.localName}: ${value.number},`;
    }

    ctx.print`} as const;`;
    ctx.print``;
    ctx.print`${ctx.f.jsDoc(desc, "")}`;
    ctx.print`${ctx.f.export("const", name)}: ReturnType<typeof ${ctx.f.import("Proto", "@aw/proto")}.createEnum<${name}, typeof ${name}$$>> = /*@__PURE__*/ ${ctx.f.import("Proto", "@aw/proto")}.createEnum(${ctx.f.importSchema(desc)}, ${name}$$);`;
    ctx.print``;
  }

  #generate(schema: Schema) {
    const files = [
      ...schema.files,
      file_google_protobuf_any,
      file_google_protobuf_api,
      file_google_protobuf_compiler_plugin,
      file_google_protobuf_cpp_features,
      file_google_protobuf_descriptor,
      file_google_protobuf_duration,
      file_google_protobuf_empty,
      file_google_protobuf_field_mask,
      file_google_protobuf_go_features,
      file_google_protobuf_java_features,
      file_google_protobuf_source_context,
      file_google_protobuf_struct,
      file_google_protobuf_timestamp,
      file_google_protobuf_type,
      file_google_protobuf_wrappers,
    ];

    for (const file of files) {
      this.#generateFile(this.#createContext(schema, file, ".ts"));
    }

    const registry = schema.generateFile("registry.ts");

    registry.print("const r = ", registry.import("createRegistry", "@bufbuild/protobuf"), "(");

    for (const file of files) {
      registry.print("  ", registry.importSchema(file), ",");
    }

    registry.print(");");
    registry.print("");
    registry.print("for (const entity of r) {");
    registry.print("   ", registry.import("Proto", "@aw/proto"), ".registry.add(entity)");
    registry.print("}");
  }

  #createContext(schema: Schema, file: DescFile, suffix: string) {
    const f = schema.generateFile(`${file.name}${suffix}`);
    const ctx: Generator.Context = {
      schema,
      file,
      f,
      print: (fragments, ...values) => {
        const printables: Printable[] = [];

        for (let i = 0; i < fragments.length; i++) {
          printables.push(fragments[i]);

          if (i < values.length) {
            printables.push(values[i]);
          }
        }

        f.print(...printables);
      },
    };

    return ctx;
  }

  createPlugin() {
    return createEcmaScriptPlugin({
      name: "protoc-gen-s",
      version: "v1.0.0",
      generateTs: (schema) => {
        this.#generate(schema);
      },
    });
  }
}

export namespace Generator {
  export type Context = {
    schema: Schema;
    file: DescFile;
    f: GeneratedFile;
    print(fragments: TemplateStringsArray, ...values: (string | Printable)[]): void;
  };

  export type Plugin = (generator: Generator, schema: Schema) => void;
}
