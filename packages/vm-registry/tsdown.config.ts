import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    main: "src/index.ts",
    protocol: "src/protocol/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
});
