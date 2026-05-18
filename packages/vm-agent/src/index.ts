import { Container } from "@/helpers/container";
import { Bootstrapper } from "@/internal/bootstrapper";

Container.singleton(Bootstrapper, () => new Bootstrapper());

const main = async () => {
  await Container.inject(Bootstrapper).boot();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
