import { createGrpcWebTransport } from "@connectrpc/connect-node";
import { Client, SupervisorPB } from "@/sdk";

const MANAGER_PVKEY = "302e020100300506032b657004220420404df1fafc1102a40a88e898c1f570b581137bf4fca7c51d67f2b01aa88d4d47";

(async () => {
  const transport = createGrpcWebTransport({
    baseUrl: "http://117.55.235.4:3008/grpc",
    httpVersion: "1.1",
  });

  const managerClient = new Client(transport, { type: "manager", privateKey: MANAGER_PVKEY }, false);

  const supervisorService = managerClient.createSupervisorService();
  const supervisor = await supervisorService.create(
    Client.createMessageValid(SupervisorPB.SupervisorServiceCreateRequestSchema, {
      capacity: 12000,
    }),
  );

  console.log("supervisor:", { id: supervisor.supervisor.id, privateKey: Buffer.from(supervisor.privateKey).toString("hex") });
})().catch((error) => {
  console.log(error);
});
