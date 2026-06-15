import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { EventQueue } from "@/internal/event-queue";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import { Variables } from "@/internal/variables";
import { Controller } from "./internal/controller";
import { FS } from "./internal/fs";
import { Image } from "./internal/image";
import { KVStorage } from "./internal/kv-storage";
import { Orchestrator } from "./internal/orchestrator";

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(EventQueue, () => new EventQueue());
Container.singleton(Director, () => new Director());
Container.singleton(Controller, () => new Controller());
Container.singleton(Image, () => new Image());
Container.singleton(KVStorage, () => new KVStorage());
Container.singleton(Network, () => new Network());
Container.singleton(Orchestrator, () => new Orchestrator());
Container.singleton(FS, () => new FS());

(async () => {
  const variables = Container.inject(Variables);
  const environment = Container.inject(Environment);
  const kv = Container.inject(KVStorage);
  const net = Container.inject(Network);
  const director = Container.inject(Director);
  const controller = Container.inject(Controller);
  const image = Container.inject(Image);
  const fs = Container.inject(FS);
  const orchestrator = Container.inject(Orchestrator);

  await variables.init();
  await environment.init();
  await kv.init();
  await net.init();
  await image.init();

  orchestrator.create();
})();
