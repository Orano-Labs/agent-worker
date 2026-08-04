import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Controller } from "@/internal/controller";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { EventQueue } from "@/internal/event-queue";
import { FS } from "@/internal/fs";
import { Image } from "@/internal/image";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";
import { Network } from "@/internal/network";
import { Orchestrator } from "@/internal/orchestrator";
import { Runner } from "@/internal/runner";
import { Variables } from "@/internal/variables";

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
Container.singleton(Runner, () => new Runner());

(async () => {
  const variables = Container.inject(Variables);
  const environment = Container.inject(Environment);
  const kv = Container.inject(KVStorage);
  const net = Container.inject(Network);
  const image = Container.inject(Image);
  const fs = Container.inject(FS);
  const orchestrator = Container.inject(Orchestrator);
  const director = Container.inject(Director);

  await variables.init();
  await environment.init();
  await kv.init();
  await net.init();
  await fs.init();
  await image.init();
  await director.init();

  const tasks = await Promise.all([
    orchestrator.create({
      config: {
        machineTier: "minimal",
        projectId: crypto.randomUUID(),
        env: {},
        metadata: {},
      },
    }),
    orchestrator.create({
      config: {
        machineTier: "minimal",
        projectId: crypto.randomUUID(),
        env: {},
        metadata: {},
      },
    }),
  ]);

  setInterval(async () => {
    await Promise.all(
      tasks.map((task) => {
        return fetch(`http://${task.net.veth.guest.ip}:3000`)
          .then((res) => {
            return res.text();
          })
          .then(console.log);
      }),
    );
  }, 2000);
})().catch((error) => {
  console.log(error);
});

process.on("unhandledRejection", console.log);
