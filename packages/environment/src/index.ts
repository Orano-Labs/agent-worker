import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Container } from "@aw/container";

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IPV4_REGEX = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])){3}$/;
const IPV6_REGEX =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:)+:([0-9a-f]{1,4}:)*[0-9a-f]{1,4}|([0-9a-f]{1,4}:)*::([0-9a-f]{1,4}:)*[0-9a-f]{0,4}|::|(([0-9a-f]{1,4}:){1,6}|:):((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]))(%[0-9a-z.\-:]+)?$/i;

export class Environment extends Container.ServiceConstructable {
  #root: string;
  #mode: Environment.Mode;
  #prefix: string;
  #fiels: boolean;

  #messages: string[];
  #warnings: string[];

  constructor(options?: Partial<Environment.Options>) {
    super();

    this.#root = options?.root ?? process.cwd();
    this.#mode = Environment.Mode.Development;
    this.#prefix = options?.prefix ?? "";
    this.#fiels = options?.files ?? true;
    this.#messages = [];
    this.#warnings = [];

    if (this.#prefix) {
      this.#prefix += "_";
    }

    if (this.#fiels) {
      try {
        const file = join(this.#root, ".env");
        const content = readFileSync(file, "utf-8");

        Object.assign(process.env, parseEnv(content));
        this.#messages.push(`Loaded ".env" file at "${file}".`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          this.#warnings.push(`Failed to load ".env" file: ${error instanceof Error ? error.message : String(error)}.`);
        }
      }

      const nodeEnv = process.env.NODE_ENV?.toLowerCase();

      if (nodeEnv === Environment.Mode.Development || nodeEnv === Environment.Mode.Production || nodeEnv === Environment.Mode.Test) {
        this.#mode = nodeEnv;
      } else if (nodeEnv) {
        this.#warnings.push(`NODE_ENV="${nodeEnv}" is not recognized; defaulting to "${this.#mode}".`);
      }

      {
        const name = `.env.${this.#mode}`;
        const file = join(this.#root, name);

        try {
          const content = readFileSync(file, "utf-8");

          Object.assign(process.env, parseEnv(content));
          this.#messages.push(`Loaded "${name}" file at "${file}".`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            this.#warnings.push(`Failed to load "${name}" file: ${error instanceof Error ? error.message : String(error)}.`);
          }
        }
      }
    }

    if (this.#mode !== Environment.Mode.Production) {
      this.#warnings.push(`Running in "${this.#mode}" mode; this mode is not recommended for production.`);
    }
  }

  get mode() {
    return this.#mode;
  }

  get messages() {
    return this.#messages;
  }

  get warnings() {
    return this.#warnings;
  }

  get root() {
    return this.#root;
  }

  get(key: string): string | undefined;
  get(key: string, fallback: string): string;
  get(key: string, fallback: Record<Environment.Mode, string>): string;
  get(key: string, required: true): string;

  get(key: string, fallbackOrRequired?: string | Record<Environment.Mode, string> | true): string | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }

    if (fallbackOrRequired === true) {
      throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
    }

    if (typeof fallbackOrRequired === "object") {
      return fallbackOrRequired[this.#mode];
    }

    return fallbackOrRequired;
  }

  getBoolean(key: string): boolean | undefined;
  getBoolean(key: string, fallback: boolean): boolean;
  getBoolean(key: string, fallback: Record<Environment.Mode, boolean>): boolean;
  getBoolean(key: string, required: true): boolean;

  getBoolean(key: string, fallbackOrRequired?: boolean | Record<Environment.Mode, boolean> | true): boolean | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const normalized = value.trim().toLowerCase();

    switch (normalized) {
      case "true":
      case "t":
      case "yes":
      case "on":
      case "1":
        return true;
      case "false":
      case "f":
      case "no":
      case "off":
      case "0":
        return false;
      default:
        throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid boolean: "${value}".`);
    }
  }

  getNumber(key: string): number | undefined;
  getNumber(key: string, fallback: number): number;
  getNumber(key: string, fallback: Record<Environment.Mode, number>): number;
  getNumber(key: string, required: true): number;

  getNumber(key: string, fallbackOrRequired?: number | Record<Environment.Mode, number> | true): number | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const parsed = Number(value.trim());

    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid number: "${value}".`);
    }

    return parsed;
  }

  getInteger(key: string): number | undefined;
  getInteger(key: string, fallback: number): number;
  getInteger(key: string, fallback: Record<Environment.Mode, number>): number;
  getInteger(key: string, required: true): number;

  getInteger(key: string, fallbackOrRequired?: number | Record<Environment.Mode, number> | true): number | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (Number.isNaN(parsed) || !Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid integer: "${value}".`);
    }

    return parsed;
  }

  getPort(key: string): number | undefined;
  getPort(key: string, fallback: number): number;
  getPort(key: string, fallback: Record<Environment.Mode, number>): number;
  getPort(key: string, required: true): number;

  getPort(key: string, fallbackOrRequired?: number | Record<Environment.Mode, number> | true): number | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const parsed = Number.parseInt(value.trim(), 10);

    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid number: "${value}".`);
    }

    if (parsed < 1 || parsed > 65535) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid port (1–65535): ${parsed}.`);
    }

    return parsed;
  }

  getHost(key: string): string | undefined;
  getHost(key: string, fallback: string): string;
  getHost(key: string, fallback: Record<Environment.Mode, string>): string;
  getHost(key: string, required: true): string;

  getHost(key: string, fallbackOrRequired?: string | Record<Environment.Mode, string> | true): string | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const trimmed = value.trim();

    if (!this.#isIP(trimmed) && !this.#isFQDN(trimmed)) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid host: "${trimmed}".`);
    }

    return trimmed;
  }

  getUrl(key: string): string | undefined;
  getUrl(key: string, fallback: string): string;
  getUrl(key: string, fallback: Record<Environment.Mode, string>): string;
  getUrl(key: string, required: true): string;

  getUrl(key: string, fallbackOrRequired?: string | Record<Environment.Mode, string> | true): string | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const trimmed = value.trim();

    if (!this.#isUrl(trimmed)) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid URL: "${trimmed}".`);
    }

    return trimmed;
  }

  getEmail(key: string): string | undefined;
  getEmail(key: string, fallback: string): string;
  getEmail(key: string, fallback: Record<Environment.Mode, string>): string;
  getEmail(key: string, required: true): string;

  getEmail(key: string, fallbackOrRequired?: string | Record<Environment.Mode, string> | true): string | undefined {
    const value = process.env[`${this.#prefix}${key}`];

    if (value === undefined || value.trim().length === 0) {
      if (fallbackOrRequired === true) {
        throw new Error(`Required environment variable "${this.#prefix}${key}" is not set.`);
      }

      if (typeof fallbackOrRequired === "object") {
        return fallbackOrRequired[this.#mode];
      }

      return fallbackOrRequired;
    }

    const trimmed = value.trim();

    if (!EMAIL_REGEX.test(trimmed)) {
      throw new Error(`Environment variable "${this.#prefix}${key}" is not a valid email: "${trimmed}".`);
    }

    return trimmed;
  }

  #isIP(input: string) {
    if (!input.length) {
      return false;
    }

    return IPV4_REGEX.test(input) || IPV6_REGEX.test(input);
  }

  #isFQDN(input: string) {
    if (!input.length) {
      return false;
    }

    const parts = input.split(".");

    for (let part: string, i = 0; i < parts.length; i++) {
      part = parts[i];
      if (!/^[a-z\u00a1-\uffff0-9-]+$/i.test(part)) return false;
      if (/[\uff01-\uff5e]/.test(part)) return false;
      if (part[0] === "-" || part[part.length - 1] === "-") return false;
    }

    return true;
  }

  #isUrl(input: string) {
    try {
      new URL(input);
    } catch {
      return false;
    }

    return true;
  }
}

export namespace Environment {
  export enum Mode {
    Production = "production",
    Development = "development",
    Test = "test",
  }

  export type Options = {
    prefix: string;
    root: string;
    files: boolean;
  };
}
