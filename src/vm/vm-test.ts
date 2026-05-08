import { VMController } from "@/vm/vm-controller";

const env = new VMController({ root: "/home/angx.guest/projects/kairo/.vm" });

(async () => {
  await env.init();

  const vm = env.get("HY3JRkJOc41A");

  await vm.run();

  console.log(vm.ip);
  console.log(vm.session.process());

  await vm.package();
})();
