import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import type { ConnectRouter } from "@connectrpc/connect";
import { GRPCHandler } from "@/api/grpc-handler";
import { FileUploadService } from "@/generated/proto/api/v1/file-system_pb";
import type { Repository } from "@/internal/repository";

export class FileUploadServiceImplementation extends GRPCHandler.ServiceImplementation {
  #repository: Repository;
  #environment: Environment;
  #logger: Logger;

  constructor(...deps: [Repository, Environment, Logger]) {
    super();

    this.#repository = deps[0];
    this.#environment = deps[1];
    this.#logger = deps[2].namespace("FileSystemService");
  }

  setup(router: ConnectRouter) {
    router.service(FileUploadService, {});
  }
}
