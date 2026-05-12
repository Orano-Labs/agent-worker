import { join } from "node:path";
import { spawn } from "node-pty";
import type { VM } from "@/vm";

export class VMTerminal {
  #vm: VM;
  #command: string;
  #env: NodeJS.ProcessEnv;

  #pty: ReturnType<typeof spawn>;

  #exited: boolean;

  constructor(options: VMTerminal.Options) {
    this.#vm = options.vm;
    this.#command = options.command;
    this.#env = Object.freeze(options.env || {});
    this.#exited = false;

    const args: string[] = [];

    args.push("-q");
    args.push("-t");
    args.push("-i", join(this.#vm.root, "id_rsa"));

    args.push("-o", "LogLevel=quiet");
    args.push("-o", "ConnectTimeout=10");
    args.push("-o", "ServerAliveInterval=30");
    args.push("-o", "ServerAliveCountMax=3");
    args.push("-o", "StrictHostKeyChecking=no");
    args.push("-o", "UserKnownHostsFile=/dev/null");
    args.push("-o", "BatchMode=yes");

    args.push(`root@${this.#vm.ip}`);

    args.push(JSON.stringify(this.#command));

    this.#pty = spawn("ssh", args, {
      name: "xterm-256color",
    });

    this.#pty.onExit(() => {
      this.#exited = true;
    });
  }

  get vm() {
    return this.#vm;
  }

  get command() {
    return this.#command;
  }

  get env() {
    return this.#env;
  }

  get pid() {
    return this.#pty.pid;
  }

  get cols() {
    return this.#pty.cols;
  }

  get rows() {
    return this.#pty.rows;
  }

  get exited() {
    return this.#exited;
  }

  onData(callback: (data: string) => void) {
    const disposable = this.#pty.onData((e) => {
      callback(e);
    });

    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (code: number, signal?: number) => void) {
    const disposable = this.#pty.onExit((e) => {
      callback(e.exitCode, e.signal);
    });

    return () => {
      disposable.dispose();
    };
  }

  resize(cols: number, rows: number) {
    return this.#pty.resize(cols, rows);
  }

  write(data: string | Buffer) {
    return this.#pty.write(data);
  }

  kill(signal?: string) {
    return this.#pty.kill(signal);
  }

  attach(i: NodeJS.ReadStream, o: NodeJS.WriteStream) {
    const onDataDisposable = this.#pty.onData((data) => {
      o.write(data);
    });
    const onExitDisposable = this.#pty.onExit(() => {
      onDataDisposable.dispose();
      onExitDisposable.dispose();

      i.removeListener("data", onInput);
      o.removeListener("resize", onResize);

      if (i.isTTY) {
        i.setRawMode(false);
      }

      o.write("\n");

      process.exit();
    });

    if (i.isTTY) {
      i.setRawMode(true);
    }

    const onInput = (data: Buffer) => {
      this.write(data);
    };

    const onResize = () => {
      this.resize(o.columns, o.rows);
    };

    i.on("data", onInput);
    o.on("resize", onResize);

    return () => {
      onExitDisposable.dispose();
    };
  }
}

export namespace VMTerminal {
  export type Options = {
    vm: VM;
    command: string;
    env?: NodeJS.ProcessEnv;
    protocol?: "ssh" | "mosh";
  };

  export type EventListener =
    | {
        type: "data";
        listener: () => void;
      }
    | {
        type: "exit";
        listener: () => void;
      };
}
