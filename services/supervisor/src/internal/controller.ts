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

  async init() {}
}
