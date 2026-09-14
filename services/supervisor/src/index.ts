import { Container } from "@/helpers/container";
import { Controller } from "@/internal/controller";
import { Director } from "@/internal/director";
import { Environment } from "@/internal/environment";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";
import { Orchestrator } from "@/internal/orchestrator";
import { Terminator } from "@/internal/terminator";
import { Tunnel } from "@/internal/tunnel";
import { VMManager } from "@/internal/vm";
import { VMImage } from "@/internal/vm-image";
import { VMKernel } from "@/internal/vm-kernel";
import { VMNet } from "@/internal/vm-net";
import { VMWorkspace } from "@/internal/vm-workspace";

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
Container.singleton(VMManager, () => new VMManager());
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
  // const o = Container.inject(Orchestrator);
  const director = Container.inject(Director);
  const controller = Container.inject(Controller);
  const tunnel = Container.inject(Tunnel);

  await environment.init();
  await kv.init();
  await image.init();
  await kernel.init();
  await workspace.init();
  await net.init();
  await director.init();
  await controller.init();
  await tunnel.init();

  // const MANAGER_PVKEY = "302e020100300506032b657004220420404df1fafc1102a40a88e898c1f570b581137bf4fca7c51d67f2b01aa88d4d47";

  // (async () => {
  //   const transport = createGrpcWebTransport({
  //     baseUrl: "http://127.0.0.1:3008/grpc",
  //     httpVersion: "1.1",
  //   });

  //   // @ts-expect-error
  //   const managerClient = new Client(transport, { type: "manager", privateKey: MANAGER_PVKEY }, false);

  //   const userService = managerClient.createUserService();
  //   const user = await userService.create(Client.createMessageValid(UserPB.UserServiceCreateRequestSchema, {}));

  //   const userClient = new Client(
  //     // @ts-expect-error
  //     transport,
  //     { type: "user", id: user.user.id, privateKey: Buffer.from(user.privateKey).toString("hex") },
  //     false,
  //   );

  //   const projectService = userClient.createProjectService();
  //   const project = await projectService.create(
  //     Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
  //       name: "TESTXXXX",
  //       resourceTier: ProjectPB.ProjectResourceTier.MINIMUM,
  //     }),
  //   );

  //   const task = await o.run({
  //     instanceId: Math.random().toString().slice(2),
  //     config: {
  //       metadata: {},
  //       projectId: project.project.id,
  //       machineTier: "minimal",
  //       env: {},
  //     }
  //   });

  //   await task.ready;
  //   await task.closed;

  // })().catch((error) => {
  //   console.log(error);

  //   return  terminator.terminate("SIGINT")
  // });

  process.on("SIGINT", (signal) => terminator.terminate(signal)); // Ctrl+C
  process.on("SIGTERM", (signal) => terminator.terminate(signal)); // System or process manager
  process.on("SIGHUP", (signal) => terminator.terminate(signal)); // Terminal close or nodemon restart
})().catch((error) => {
  console.log(error);
});
