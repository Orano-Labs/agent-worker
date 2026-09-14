import { Container } from "@aw/container";
import type { Logger } from "@aw/logging";
import { $, type LogEntry } from "zx";

export class Shell extends Container.ServiceConstructable {
  constructor() {
    super();
  }

  session(options: Shell.SessionOptions) {
    const commands: Record<string, Extract<LogEntry, { kind: "cmd" }>> = {};
    const logger = options.logger.namespace("$");

    return $({
      signal: options.signal,
      verbose: true,
      sync: false,
      log: (entry) => {
        if (entry.kind === "cmd") {
          commands[entry.id] = entry;
        }

        if (entry.kind === "end") {
          const cmd = commands[entry.id];

          if (!cmd) {
            return;
          }

          const durationMs = entry.duration ?? 0;
          const duration = durationMs < 1000 ? `${durationMs.toFixed(0)}ms` : `${(durationMs / 1000).toFixed(2)}s`;
          const summary = `${cmd.cwd}$ ${cmd.cmd} [exit=${entry.exitCode ?? 0}, duration=${duration}]`;

          if (entry.error) {
            logger.error(summary, { err: entry.error });
          } else {
            logger.debug(summary);
          }

          delete commands[entry.id];
        }
      },
    });
  }

  protected override async initialize(signal: AbortSignal) {
    await $({ signal, log: () => {} })`sudo -n -v`;
  }
}

export namespace Shell {
  export type SessionOptions = {
    signal: AbortSignal;
    logger: Logger;
  };
}
