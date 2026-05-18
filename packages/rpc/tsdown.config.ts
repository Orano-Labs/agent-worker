import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/rpc.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
});
