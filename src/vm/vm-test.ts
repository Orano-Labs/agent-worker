import { VMController } from "@/vm/vm-controller";

const env = new VMController({ root: "/home/angx.guest/projects/agent-worker/.vm" });

(async () => {
  await env.init();

  const vm = env.get("FrJuMWlegLN1");

  await vm.run();

  console.log(vm.ip);
  console.log(vm.session.process());
})();
