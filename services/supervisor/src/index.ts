import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Container } from "@/helpers/container";
import { Controller } from "@/internal/controller";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";
import { Orchestrator } from "@/internal/orchestrator";
import { Terminator } from "@/internal/terminator";
import { Tunnel } from "@/internal/tunnel";
import { VM } from "@/internal/vm";
import { VMImage } from "@/internal/vm-image";
import { VMKernel } from "@/internal/vm-kernel";
import { VMNet } from "@/internal/vm-net";
import { VMWorkspace } from "@/internal/vm-workspace";

const ctrl = new AbortController();

Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Controller, () => new Controller());
Container.singleton(VMImage, () => new VMImage());
Container.singleton(VMKernel, () => new VMKernel());
Container.singleton(KVStorage, () => new KVStorage());
Container.singleton(VMNet, () => new VMNet());
Container.singleton(Orchestrator, () => new Orchestrator());
Container.singleton(VMWorkspace, () => new VMWorkspace());
Container.singleton(Director, () => new Director());
Container.singleton(VM, () => new VM());
Container.singleton(Tunnel, () => new Tunnel());
Container.singleton(Terminator, () => new Terminator());

(async () => {
  const environment = Container.inject(Environment);
  const terminator = Container.inject(Terminator);
  const kv = Container.inject(KVStorage);
  const image = Container.inject(VMImage);
  const kernel = Container.inject(VMKernel);
  const net = Container.inject(VMNet);
  const workspace = Container.inject(VMWorkspace);
  const o = Container.inject(Orchestrator);
  //   const director = Container.inject(Director);
  //   const controller = Container.inject(Controller);
  //   const tunnel = Container.inject(Tunnel);

  await environment.init();
  await kv.init();
  await image.init();
  await kernel.init();
  await workspace.init();
  await net.init();

  (async () => {
    const project = crypto.randomUUID();

    await mkdir(join(workspace.root, "projects", project), { recursive: true });

    const task = await o.run({
      instanceId: Math.random().toString().slice(2),
      config: {
        metadata: {},
        projectId: project,
        machineTier: "minimal",
        env: {},
      },
    });

    await task.ready.then(() => {
      console.log(`${task.net.veth.guest.ip}:8000`);
    });
    await task.closed;
  })();

  process.on("SIGINT", (signal) => terminator.terminate(signal)); // Ctrl+C
  process.on("SIGTERM", (signal) => terminator.terminate(signal)); // System or process manager
  process.on("SIGHUP", (signal) => terminator.terminate(signal)); // Terminal close or nodemon restart
})().catch((error) => {
  console.log(error);
});

// process.on("unhandledRejection", console.log);
