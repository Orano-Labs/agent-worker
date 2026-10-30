import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Environment } from "@aw/environment";
import { createConnectTransport } from "@connectrpc/connect-node";
import { config } from "dotenv";
import { Client, SupervisorPB } from "@/sdk";

const root = fileURLToPath(new URL("../", import.meta.url));
config({ path: resolve(root, ".env.manager"), quiet: true });
const environment = new Environment({ prefix: "AW_MANAGER", files: false });

(async () => {
  const baseUrl = environment.getUrl("DIRECTOR_URL", true);
  const privateKey = environment.get("PRIVATE_KEY", true);
  const endpoint = new URL(baseUrl);

  if (endpoint.username || endpoint.password) {
    throw new Error("Use signed authentication instead of URL credentials.");
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
  ) {
    throw new Error("Use HTTPS for remote provisioning; HTTP is allowed only on loopback.");
  }

  const outputPath = resolve(root, environment.get("SUPERVISOR_ENV_FILE", "../supervisor/.env"));
  // Reserve before creating the remote identity so an existing env file is never lost.
  const output = await open(outputPath, "wx", 0o600);
  let created = false;

  try {
    const transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });
    const managerClient = new Client(transport, { type: "manager", privateKey });
    const supervisor = await managerClient
      .createSupervisorService()
      .create(Client.createMessageValid(SupervisorPB.SupervisorServiceCreateRequestSchema, { capacity: 12000 }));
    created = true;

    // JSON quoting keeps a returned ID from introducing additional dotenv entries.
    await output.writeFile(
      `NODE_ENV=production\nAW_SUPERVISOR_ID=${JSON.stringify(supervisor.supervisor.id)}\nAW_SUPERVISOR_PRIVATE_KEY=${Buffer.from(supervisor.privateKey).toString("hex")}\n`,
    );
    await output.sync();
    console.log("Supervisor credentials saved to a local env file with owner-only permissions.");
  } finally {
    await output.close();
    if (!created) await unlink(outputPath);
  }
})().catch(() => {
  // RPC errors may contain sensitive response data; never dump them to the console.
  console.error(
    "Supervisor provisioning failed. Check .env.manager, HTTPS, service availability and output permissions; existing files are never overwritten.",
  );
  process.exitCode = 1;
});
