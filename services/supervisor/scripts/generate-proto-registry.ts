import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "tinyglobby";

const root = resolve("./src/gen/proto");
const target = resolve(root, "registry.ts");

const WKT = [
  "any",
  "api",
  "compiler_plugin",
  "cpp_features",
  "descriptor",
  "duration",
  "empty",
  "field_mask",
  "go_features",
  "java_features",
  "source_context",
  "struct",
  "timestamp",
  "type",
  "wrappers",
];

(async () => {
  const files = await glob({
    cwd: root,
    patterns: ["supervisor/**/*_pb.ts"],
  });

  const protoFiles: Map<string, string> = new Map();

  for (const file of files) {
    const path = `@/gen/proto/${file.slice(0, -3)}`;
    const mod = await import(path);

    for (const [key, value] of Object.entries(mod)) {
      if (typeof value === "object" && value && "kind" in value && value.kind === "file") {
        protoFiles.set(key, `import { ${key} } from "${path}";`);
      }
    }
  }

  await writeFile(
    target,
    `import { createRegistry } from "@bufbuild/protobuf";

${WKT.map((name) => `import { file_google_protobuf_${name} } from "@bufbuild/protobuf/wkt";`).join("\n")}

${[...protoFiles.values()].join("\n")}

import { Proto } from "@aw/proto";

const FILES = [
${WKT.map((name) => `  file_google_protobuf_${name},`).join("\n")}

${[...protoFiles.keys()].map((name) => `  ${name},`).join("\n")}
] as const;

for (const entity of createRegistry(...FILES)) {
  Proto.registry.add(entity)
}
`,
  );
})();
