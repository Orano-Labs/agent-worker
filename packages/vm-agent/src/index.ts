import { Bootstrapper } from "@/bootstrapper";
import { Container } from "@/helpers/container";

process.env.VM_AGENT_REGISTRY_URL = "http://localhost:3000";
process.env.VM_AGENT_REGISTRY_AUTH_TOKEN = "token";

const main = async () => {
  await Container.inject(Bootstrapper).boot();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
