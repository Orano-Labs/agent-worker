import { resolve } from "node:path";
import { parseArgs } from "node:util";

export class CommandLine {
  #cwd: string;
  #logLevel?: string;
  #logColorize?: boolean;

  constructor() {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      allowNegative: true,
      options: CommandLine.SCHEMA,
    });

    this.#cwd = resolve(parsed.values.cwd);
    this.#logLevel = parsed.values["log-level"];
    this.#logColorize = parsed.values["log-colorize"];
  }

  get cwd() {
    return this.#cwd;
  }

  get logLevel() {
    return this.#logLevel;
  }

  get logColorize() {
    return this.#logColorize;
  }
}

export namespace CommandLine {
  export const SCHEMA = {
    cwd: { type: "string", default: process.cwd() },

    "log-level": { type: "string" },
    "log-colorize": { type: "boolean" },
  } as const;
}
