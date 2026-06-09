import { default as createClient } from "openapi-fetch";
import { Agent, fetch, Request } from "undici";

import type { components, paths as FirecrackerEndpoints } from "./firecracker.api";

export class Firecracker {
  #agent: Agent;

  constructor(socket: string) {
    this.#agent = new Agent({ socketPath: socket });
  }

  async #fetch(...args: Parameters<typeof fetch>) {
    return fetch(args[0], { ...args[1], dispatcher: this.#agent }).then((response) => {
      return response;
    });
  }

  #client = createClient<FirecrackerEndpoints>({
    baseUrl: "http://localhost",
    // @ts-expect-error
    fetch: this.#fetch.bind(this),
    // @ts-expect-error
    Request: Request,
  });

  get client() {
    return this.#client;
  }

  get #get() {
    return this.#client.GET;
  }

  get #put() {
    return this.#client.PUT;
  }

  get #patch() {
    return this.#client.PATCH;
  }

  async #unwrap<T>(p: Promise<{ data?: T; error?: components["schemas"]["Error"] }>): Promise<T> {
    return p.then((resp) => {
      if (resp.error) {
        throw new Firecracker.APIError(resp.error.fault_message || "Unknown error");
      }
      return resp.data as T;
    });
  }

  // GET /
  async getInstanceInformation() {
    return this.#unwrap(this.#get("/"));
  }

  // PUT /actions
  async createSyncAction(action: components["schemas"]["InstanceActionInfo"]) {
    return this.#unwrap(this.#put("/actions", { body: action }));
  }

  // GET /balloon
  async getBalloonConfig() {
    return this.#unwrap(this.#get("/balloon"));
  }

  // PUT /balloon
  async setBalloonConfig(balloon: components["schemas"]["Balloon"]) {
    return this.#unwrap(this.#put("/balloon", { body: balloon }));
  }

  // PATCH /balloon
  async updateBalloonConfig(balloonUpdate: components["schemas"]["BalloonUpdate"]) {
    return this.#unwrap(this.#patch("/balloon", { body: balloonUpdate }));
  }

  // GET /balloon/statistics
  async getBalloonStats() {
    return this.#unwrap(this.#get("/balloon/statistics"));
  }

  // PATCH /balloon/statistics
  async updateBalloonStatsInterval(statsUpdate: components["schemas"]["BalloonStatsUpdate"]) {
    return this.#unwrap(this.#patch("/balloon/statistics", { body: statsUpdate }));
  }

  // PATCH /balloon/hinting/start
  async startBalloonHinting(cmd?: components["schemas"]["BalloonStartCmd"]) {
    return this.#unwrap(this.#patch("/balloon/hinting/start", { body: cmd }));
  }

  // GET /balloon/hinting/status
  async getBalloonHintingStatus() {
    return this.#unwrap(this.#get("/balloon/hinting/status"));
  }

  // PATCH /balloon/hinting/stop
  async stopBalloonHinting() {
    return this.#unwrap(this.#patch("/balloon/hinting/stop"));
  }

  // PUT /boot-source
  async setBootSource(bootSource: components["schemas"]["BootSource"]) {
    return this.#unwrap(this.#put("/boot-source", { body: bootSource }));
  }

  // PUT /cpu-config
  async setCpuConfiguration(cpuConfig?: components["schemas"]["CpuConfig"]) {
    return this.#unwrap(this.#put("/cpu-config", { body: cpuConfig }));
  }

  // PUT /drives/{drive_id}
  async setDrive(driveId: string, drive: components["schemas"]["Drive"]) {
    return this.#unwrap(
      this.#put("/drives/{drive_id}", {
        params: { path: { drive_id: driveId } },
        body: drive,
      }),
    );
  }

  // PATCH /drives/{drive_id}
  async updateDrive(driveId: string, partialDrive: components["schemas"]["PartialDrive"]) {
    return this.#unwrap(
      this.#patch("/drives/{drive_id}", {
        params: { path: { drive_id: driveId } },
        body: partialDrive,
      }),
    );
  }

  // PUT /pmem/{id}
  async setPmemDevice(id: string, pmem: components["schemas"]["Pmem"]) {
    return this.#unwrap(this.#put("/pmem/{id}", { params: { path: { id } }, body: pmem }));
  }

  // PUT /logger
  async setLogger(logger: components["schemas"]["Logger"]) {
    return this.#unwrap(this.#put("/logger", { body: logger }));
  }

  // GET /machine-config
  async getMachineConfiguration() {
    return this.#unwrap(this.#get("/machine-config"));
  }

  // PUT /machine-config
  async setMachineConfiguration(config?: components["schemas"]["MachineConfiguration"]) {
    return this.#unwrap(this.#put("/machine-config", { body: config }));
  }

  // PATCH /machine-config
  async updateMachineConfiguration(config?: components["schemas"]["MachineConfiguration"]) {
    return this.#unwrap(this.#patch("/machine-config", { body: config }));
  }

  // PUT /metrics
  async setMetrics(metrics: components["schemas"]["Metrics"]) {
    return this.#unwrap(this.#put("/metrics", { body: metrics }));
  }

  // GET /mmds
  async getMmds() {
    return this.#unwrap(this.#get("/mmds"));
  }

  // PUT /mmds
  async setMmds(contents: components["schemas"]["MmdsContentsObject"]) {
    return this.#unwrap(this.#put("/mmds", { body: contents }));
  }

  // PATCH /mmds
  async updateMmds(contents: components["schemas"]["MmdsContentsObject"]) {
    return this.#unwrap(this.#patch("/mmds", { body: contents }));
  }

  // PUT /mmds/config
  async setMmdsConfig(config: components["schemas"]["MmdsConfig"]) {
    return this.#unwrap(this.#put("/mmds/config", { body: config }));
  }

  // PUT /entropy
  async setEntropyDevice(entropy: components["schemas"]["EntropyDevice"]) {
    return this.#unwrap(this.#put("/entropy", { body: entropy }));
  }

  // PUT /serial
  async setSerialDevice(serial: components["schemas"]["SerialDevice"]) {
    return this.#unwrap(this.#put("/serial", { body: serial }));
  }

  // GET /hotplug/memory
  async getMemoryHotplugStatus() {
    return this.#unwrap(this.#get("/hotplug/memory"));
  }

  // PUT /hotplug/memory
  async setMemoryHotplugConfig(config: components["schemas"]["MemoryHotplugConfig"]) {
    return this.#unwrap(this.#put("/hotplug/memory", { body: config }));
  }

  // PATCH /hotplug/memory
  async updateMemoryHotplugSize(update: components["schemas"]["MemoryHotplugSizeUpdate"]) {
    return this.#unwrap(this.#patch("/hotplug/memory", { body: update }));
  }

  // PUT /network-interfaces/{iface_id}
  async setNetworkInterface(ifaceId: string, networkInterface: components["schemas"]["NetworkInterface"]) {
    return this.#unwrap(
      this.#put("/network-interfaces/{iface_id}", {
        params: { path: { iface_id: ifaceId } },
        body: networkInterface,
      }),
    );
  }

  // PATCH /network-interfaces/{iface_id}
  async updateNetworkInterface(ifaceId: string, partialInterface: components["schemas"]["PartialNetworkInterface"]) {
    return this.#unwrap(
      this.#patch("/network-interfaces/{iface_id}", {
        params: { path: { iface_id: ifaceId } },
        body: partialInterface,
      }),
    );
  }

  // PUT /snapshot/create
  async createSnapshot(params: components["schemas"]["SnapshotCreateParams"]) {
    return this.#unwrap(this.#put("/snapshot/create", { body: params }));
  }

  // PUT /snapshot/load
  async loadSnapshot(params: components["schemas"]["SnapshotLoadParams"]) {
    return this.#unwrap(this.#put("/snapshot/load", { body: params }));
  }

  // GET /version
  async getFirecrackerVersion() {
    return this.#unwrap(this.#get("/version"));
  }

  // PATCH /vm
  async updateVmState(state: components["schemas"]["Vm"]) {
    return this.#unwrap(this.#patch("/vm", { body: state }));
  }

  // GET /vm/config
  async getFullVmConfiguration() {
    return this.#unwrap(this.#get("/vm/config"));
  }

  // PUT /vsock
  async setVsock(vsock: components["schemas"]["Vsock"]) {
    return this.#unwrap(this.#put("/vsock", { body: vsock }));
  }
}

export namespace Firecracker {
  export class APIError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "FirecrackerAPIError";
    }
  }
}
