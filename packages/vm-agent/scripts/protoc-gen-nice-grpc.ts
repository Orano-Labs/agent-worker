import { createEcmaScriptPlugin, runNodeJs } from "@bufbuild/protoplugin";

runNodeJs(
  createEcmaScriptPlugin({
    name: "protoc-gen-nice-grpc",
    version: `v0.0.1`,
    generateTs: (schema) => {
      for (const file of schema.files) {
        const f = schema.generateFile(`${file.name}_nice.ts`);

        f.preamble(file);

        for (const type of schema.typesInFile(file)) {
          if (type.kind === "message") {
            const shape = f.importShape(type);
            const schema = f.importSchema(type);
            const valid = f.importValid(type);

            f.print();
            f.print(f.jsDoc(type));
            f.print(f.export("type", shape.name), " = ", valid, ";");
            f.print();
            f.print(f.export("namespace", shape.name), " {};");
          }

          if (type.kind === "enum") {
            const shape = f.importShape(type);
            const schema = f.importSchema(type);

            f.print();
            f.print(f.jsDoc(type));
            f.print(f.export("type", shape.name), " = ", shape, ";");
            f.print();
            f.print(f.export("namespace", shape.name), " {};");
          }
        }
      }
    },
  }),
);
