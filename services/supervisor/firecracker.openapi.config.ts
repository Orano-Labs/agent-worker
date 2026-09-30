import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig(async () => {
  const response = await fetch("https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest");

  if (!response.ok) {
    throw new Error(`Failed to fetch latest Firecracker release: ${response.status} ${response.statusText}`);
  }

  const latest: unknown = await response.json();

  if (
    // biome-ignore format: x
    typeof latest !== "object" || latest === null || !("tag_name" in latest) || typeof latest.tag_name !== "string"
  ) {
    throw new Error(`Unexpected GitHub API response for latest Firecracker release: ${JSON.stringify(latest).slice(0, 200)}`);
  }

  const tag = (latest as { tag_name: string }).tag_name;

  return {
    input: `https://raw.githubusercontent.com/firecracker-microvm/firecracker/refs/tags/${tag}/src/firecracker/swagger/firecracker.yaml`,
    output: "src/helpers/firecracker",
    plugins: ["@hey-api/client-fetch"],
  } as const;
});
