import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { EventQueue } from "@/internal/event-queue";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(EventQueue, () => new EventQueue());
Container.singleton(Director, () => new Director());

(async () => {
  const variables = Container.inject(Variables);
  const environment = Container.inject(Environment);
  const queue = Container.inject(EventQueue);
  const director = Container.inject(Director);

  await variables.init();
  await environment.init();
  await director.init();
})();
