import { Application } from "@/application";

Application.run().catch((error) => {
  console.error(error);
  process.exit(1);
});
