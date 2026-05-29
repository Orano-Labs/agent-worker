import { Container } from "@/helpers/container";
import { ErrorHelpers } from "@/helpers/error-helpers";
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
      await client.GET("/version").then((result) => {
        if (!result.data) {
          throw new Error(`Failed to retrieve gitea version: (${result.response.status} ${result.response.statusText})`);
        }

        this.#logger.info(`Gitea version: ${result.data.version}`);
      });

      await client.GET("/user").then((result) => {
        if (!result.data) {
          throw new Error(`Failed to retrieve user information: (${result.response.status} ${result.response.statusText})`);
        }

        this.#logger.info(`Gitea user: ${result.data.login} (${result.data.email})`);
      });
    } catch (error) {
      const message = `Gitea connection failed: ${ErrorHelpers.as(error).message}`;

      this.#logger.error(message, { error });
      this.#status = { type: "error", message };

      return;
    }

    this.#client = client;

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
