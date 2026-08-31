import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
  unbundle: true,
  deps: {},
  define: {
    VERSION: JSON.stringify(process.env.npm_package_version),
  },
  copy: ["src/index.html"]
});
