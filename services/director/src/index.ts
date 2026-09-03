import { createGrpcWebTransport } from "@connectrpc/connect-node";
import { Bootstrapper } from "@/bootstrapper";
import { Container } from "@/helpers/container";
import { Client, FileSystemPB, ProjectPB, SupervisorPB, UserPB } from "./sdk";

const main = async () => {
  // await Container.inject(Bootstrapper).boot();

  const transport = createGrpcWebTransport({
    baseUrl: "http://117.55.235.4:3008/grpc",
    httpVersion: "1.1",
  });

  const managerClient = new Client(transport, { type: "manager", privateKey: "302e020100300506032b657004220420404df1fafc1102a40a88e898c1f570b581137bf4fca7c51d67f2b01aa88d4d47" }, false);

  const supervisorService = managerClient.createSupervisorService();
  // const userService = managerClient.createUserService();

  // const user = await userService.create(Client.createMessageValid(UserPB.UserServiceCreateRequestSchema, {}));
  const supervisor = await supervisorService.create(
    Client.createMessageValid(SupervisorPB.SupervisorServiceCreateRequestSchema, {
      capacity: 12000,
    }),
  );

  // const userClient = new Client(transport, { type: "user", id: user.user.id, privateKey: Buffer.from(user.privateKey).toString("hex") });
  // const projectService = userClient.createProjectService();
  // const fileSystemService = userClient.createFileSystemService();

  // const projects = await Promise.all(
  //   Array.from({ length: 1 }).map((_, index) => {
  //     return projectService.create(
  //       Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
  //         name: `project-${index + 1}`,
  //         resourceTier: ProjectPB.ProjectResourceTier.MINIMUM,
  //       }),
  //     );
  //   }),
  // );

  // console.log("user:", { id: user.user.id, privateKey: Buffer.from(user.privateKey).toString("hex") });
  console.log("supervisor:", { id: supervisor.supervisor.id, privateKey: Buffer.from(supervisor.privateKey).toString("hex") });
  // console.log(
  //   "projects:",
  //   projects.map((p) => p.project.id),
  // );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
