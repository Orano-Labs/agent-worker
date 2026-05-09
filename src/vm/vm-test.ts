import { createServer } from "node:http";
import { Server, Socket } from "socket.io";

import { VMController } from "@/vm/vm-controller";
import { VMTerminal } from "@/vm/vm-terminal";

const env = new VMController({ root: "/home/angx.guest/projects/agent-worker/.vm" });

const server = createServer();
const io = new Server(server, {
  cors: {
        origin: "*",
        methods: ["GET", "POST"]
  },
});

(async () => {
  await env.init();

  const vm = env.get("FrJuMWlegLN1");

  await vm.run();

  console.log(vm.ip);
  console.log(vm.session.process());

  const buffer = [] as string[];
    const terminal = new VMTerminal({ vm, command: "node" });

    terminal.onData((data) => {
      buffer.push(data)
    })


  let socket: Socket | null = null;


    io.on("connection", (s) => {
        socket = s;

        for (const data of buffer) {
            s.emit("data", data)
        }

        terminal.onData((data) => {
            s.emit("data", data)
        })

        s.on("data", (data) => {
            terminal.write(data)
        })

    })

  // const terminal = new VMTerminal({ vm, command: "node" });

  server.listen(8888, "127.0.0.1", () => {
    console.log(`Socket.io running at http://127.0.0.1:8888`);
  });
})();
