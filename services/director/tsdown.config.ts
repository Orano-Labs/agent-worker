import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sdk: "src/sdk/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
  deps: {},
  define: {
    VERSION: JSON.stringify(process.env.npm_package_version),
  },
});
