import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/rpc.ts",
    "websocket-server": "src/adapters/rpc-websocket-server.ts",
    "websocket-client": "src/adapters/rpc-websocket-client.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  target: false,
});
