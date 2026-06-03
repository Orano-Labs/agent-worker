import { Supervisor } from "@aw/vm-director/supervisor";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { Container } from "@/helpers/container";
import { Director } from "@/internal/director";
import { Logger } from "@/internal/logger";

export class Controller {
  #logger: Logger;
  #director: Director;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Controller");
    this.#director = Container.inject(Director);
  }

  async init() {
    const os = implement(Supervisor.CONTROLLER_CONTRACT);
    const router = os.router({
      host: {
        status: os.host.status.handler(async () => {
          throw new Error("Unimplemented");
        }),
      },
      task: {
        dispatch: os.task.dispatch.handler(async () => {
          throw new Error("Unimplemented");
        }),
        inspect: os.task.inspect.handler(async () => {
          throw new Error("Unimplemented");
        }),
        terminate: os.task.terminate.handler(async () => {
          throw new Error("Unimplemented");
        }),
      },
    });
    const handler = new RPCHandler(router, {
      rootInterceptors: [],
    });

    handler.upgrade(this.#director.socket);
  }
}
