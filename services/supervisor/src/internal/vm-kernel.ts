import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";

export class VMKernel {
  #env: Environment;
  #logger: Logger;

  get path() {
    return this.#env.kernel;
  }

  constructor() {
    this.#env = Container.inject(Environment);
    this.#logger = Container.inject(Logger).prefix("VMKernel");
  }

  async #exec(command: string) {
    return new Promise<Record<"stderr" | "stdout", string>>((resolve, reject) => {
      const [cmd, ...args] = command.split(" ");

      const cp = spawn(cmd, args, {
        shell: true,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      cp.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      cp.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      cp.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
        }
      });

      cp.on("error", (error) => {
        reject(error);
      });
    });
  }

  async init() {
    let exists = false;

    try {
      await stat(this.path);
      exists = true;
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") {
        throw new Error(`Failed to check status for kernel path: ${this.path}`);
      }
    }

    if (exists) {
      return this.#logger.info("Kernel exists. Skipping build.");
    }

    this.#logger.info(`Kernel not found at ${this.path}. Building from source...`);

    try {
      await this.#exec(`command -v bash`);
    } catch {
      throw new Error("Missing system dependency: bash. Please install it manually.");
    }

    const script = join(process.cwd(), "scripts/build-kernel.sh");

    try {
      await this.#exec(`bash "${script}" "${this.path}"`);
    } catch (err) {
      throw new Error(`Failed to build kernel: ${ErrorHelpers.as(err).message}`);
    }

    this.#logger.info(`Kernel built successfully at: ${this.path}`);
  }
}
