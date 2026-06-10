import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "https://raw.githubusercontent.com/firecracker-microvm/firecracker/refs/tags/v1.16.0/src/firecracker/swagger/firecracker.yaml",
  output: "src/helpers/firecracker",
  plugins: ["@hey-api/client-fetch"],
});
