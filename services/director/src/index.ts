import { Bootstrapper } from "@/bootstrapper";
import { Container } from "@/helpers/container";

const main = async () => {
  await Container.inject(Bootstrapper).boot();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
