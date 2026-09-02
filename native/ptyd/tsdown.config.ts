import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "lib/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
  unbundle: true,
  deps: {},
  define: {
    VERSION: JSON.stringify(process.env.npm_package_version),
  },
});
