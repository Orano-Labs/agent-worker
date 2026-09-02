import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Controller } from "@/internal/controller";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { FS } from "@/internal/fs";
import { Image } from "@/internal/image";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import { Orchestrator } from "@/internal/orchestrator";
import { Runner } from "@/internal/runner";
import { Tunnel } from "@/internal/tunnel";
import { Variables } from "@/internal/variables";

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Variables, () => new Variables());
Container.singleton(Controller, () => new Controller());
Container.singleton(Image, () => new Image());
Container.singleton(KVStorage, () => new KVStorage());
Container.singleton(Network, () => new Network());
Container.singleton(Orchestrator, () => new Orchestrator());
Container.singleton(FS, () => new FS());
Container.singleton(Director, () => new Director());
Container.singleton(Runner, () => new Runner());
Container.singleton(Tunnel, () => new Tunnel());

(async () => {
  const variables = Container.inject(Variables);
  const environment = Container.inject(Environment);
  const kv = Container.inject(KVStorage);
  const net = Container.inject(Network);
  const image = Container.inject(Image);
  const fs = Container.inject(FS);
  const o = Container.inject(Orchestrator);
  const director = Container.inject(Director);
  const controller = Container.inject(Controller);
  const tunnel = Container.inject(Tunnel);

  await variables.init();
  await environment.init();
  await kv.init();
  await net.init();
  // await fs.init();
  await image.init();
  // await director.init();
  // await tunnel.init();
  // await controller.init();

  const task = await o.run({
    instanceId: Math.random().toString().slice(2),
    config: {
      metadata: {},
      projectId: crypto.randomUUID(),
      machineTier: "minimal",
      env: {},
    },
  });

  await task.ready.then(() => {
    console.log(`${task.net.veth.guest.ip}:8000`);
  });
  await task.closed;

  process.exit(0);
})().catch((error) => {
  console.log(error);
});

process.on("unhandledRejection", console.log);
