import * as fs from "node:fs";
import * as os from "node:os";

import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";
import { createConnectTransport } from "@connectrpc/connect-node";
import { makePushPullAsyncIterableIterator } from "@n1ru4l/push-pull-async-iterable-iterator";
import { Container } from "@/helpers/container";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Director {
  #logger: Logger;
  #variables: Variables;

  #client?: Client;
  #supervisorPortal?: ReturnType<Client["createSupervisorPortalService"]>;

  #stream?: ReturnType<typeof makePushPullAsyncIterableIterator<SupervisorPortalPB.SupervisorPortalServiceReportRequestValid>>;
  #reportTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Director");
    this.#variables = Container.inject(Variables);
  }

  async init() {
    const baseUrl = this.#variables.get("AW_SUPERVISOR_DIRECTOR_HOST_URL");
    const id = this.#variables.get("AW_SUPERVISOR_ID");
    const privateKey = this.#variables.get("AW_SUPERVISOR_PRIVATE_KEY");

    if (!baseUrl) {
      throw new Error("AW_SUPERVISOR_DIRECTOR_HOST_URL is not set");
    }

    if (!id) {
      throw new Error("AW_SUPERVISOR_ID is not set");
    }

    if (!privateKey) {
      throw new Error("AW_SUPERVISOR_PRIVATE_KEY is not set");
    }

    const transport = createConnectTransport({
      httpVersion: "2",
      baseUrl,
    });

    const identity: Client.Identity = {
      type: "supervisor",
      id,
      privateKey,
    };

    // @ts-expect-error
    this.#client = new Client(transport, identity, true);
    this.#supervisorPortal = this.#client.createSupervisorPortalService();

    this.#runReportLoop();
  }

  async #runReportLoop() {
    if (!this.#supervisorPortal) {
      throw new Error("xxx");
    }

    this.#logger.info("Director initialized, reporting loop started");

    while (true) {
      this.#stream = makePushPullAsyncIterableIterator<SupervisorPortalPB.SupervisorPortalServiceReportRequestValid>();

      this.report();

      this.#reportTimer = setInterval(() => {
        this.report();
      }, 3000);

      try {
        await this.#supervisorPortal.report(this.#stream.asyncIterableIterator, {});
      } catch (err) {
        this.#logger.errorFrom(err, "Report stream closed with error");
      }

      if (this.#reportTimer) {
        clearInterval(this.#reportTimer);
        this.#reportTimer = undefined;
      }

      this.#logger.warn("Report stream disconnected, reconnecting in 5 seconds...");

      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
  }

  async report() {
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    const cpuUsage = cpuCount > 0 ? loadAvg / cpuCount : 0;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = totalMem > 0 ? (totalMem - freeMem) / totalMem : 0;

    let diskUsage = 0;

    try {
      const stat = fs.statfsSync("/");
      const totalBlocks = stat.blocks;
      const freeBlocks = stat.bfree;
      diskUsage = totalBlocks > 0 ? (totalBlocks - freeBlocks) / totalBlocks : 0;
    } catch {
      // TODO: x
    }

    this.#stream?.pushValue({
      $typeName: "api.v1.SupervisorPortalServiceReportRequest",
      runningProjects: 0,
      cpuUsage,
      memoryUsage,
      diskUsage,
    });
  }

  async fetch() {
    if (!this.#supervisorPortal) {
      throw new Error("xxx");
    }

    return this.#supervisorPortal
      .fetch(Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceFetchRequestSchema, {}))
      .then((response) => {
        if (response.task) {
          return {
            project: response.task.projectId,
            token: response.task.token,
          };
        }
      });
  }
}
