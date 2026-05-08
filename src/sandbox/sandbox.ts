import { VM } from "@/vm/vm";

export class Sandbox {
  #vm: VM;

  constructor(vm: VM) {
    this.#vm = vm;
  }

  get running() {
    return !!this.#vm.session.process();
  }
}
