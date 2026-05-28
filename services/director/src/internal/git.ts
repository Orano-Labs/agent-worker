import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";
import { GitAPI } from "@/supports/git";

export class Git {
  #client?: GitAPI.Client;

  #logger: Logger;
  #variables: Variables;

  #status: Git.Status;

  constructor() {
    this.#status = {
      type: "error",
      message: "Not initialized",
    };

    this.#logger = Container.inject(Logger).scope("Git");
    this.#variables = Container.inject(Variables);
  }

  get status() {
    return this.#status;
  }

  get ready() {
    return this.#status.type === "ready";
  }

  get client() {
    if (!this.#client) {
      throw new Error("Git client is not available");
    }

    return this.#client;
  }

  async init() {
    this.#logger.info("Initializing...");

    const url = this.#variables.get("AW_DIRECTOR_GITEA_URL");
    const token = this.#variables.get("AW_DIRECTOR_GITEA_ACCESS_TOKEN");

    if (!url) {
      const message = "AW_DIRECTOR_GITEA_URL is not set, cannot initialize git";

      this.#logger.error(message);
      this.#status = { type: "error", message };

      return;
    }

    if (!token) {
      const message = "AW_DIRECTOR_GITEA_ACCESS_TOKEN is not set, cannot initialize git";

      this.#logger.error(message);
      this.#status = { type: "error", message };

      return;
    }

    const client = GitAPI.create({
      baseUrl: `${url}/api/v1`,
      headers: {
        Authorization: `token ${token}`,
      },
    });

    try {
      const result = await client.GET("/version");

      if (result.response.status !== 200) {
        throw new Error(`Gitea API returned status ${result.response.status}`);
      }

      this.#logger.info(`Gitea version: ${result.data?.version}`);
    } catch (error) {
      const message = `Cannot connect to Gitea: ${error}`;

      this.#logger.error(message);
      this.#status = { type: "error", message };

      return;
    }

    this.#status = {
      type: "ready",
    };

    this.#logger.info("Initialization completed");
  }
}

export namespace Git {
  export type Status =
    | {
        type: "ready";
      }
    | {
        type: "error";
        message: string;
      };
}
