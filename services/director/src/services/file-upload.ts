import type { ConnectRouter } from "@connectrpc/connect";

import { FileUploadService } from "@/generated/proto/api/v1/file-system_pb";
import { Container } from "@/helpers/container";
import { Cache } from "@/internal/cache";
import { GRPCServer } from "@/internal/grpc-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";

export class FileUploadServiceImplementation {
  #cache: Cache;
  #repository: Repository;
  #server: GRPCServer;

  #variables: Variables;
  #logger: Logger;

  constructor() {
    this.#cache = Container.inject(Cache);
    this.#repository = Container.inject(Repository);
    this.#server = Container.inject(GRPCServer);
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger);
  }

  setup(router: ConnectRouter) {
    router.service(FileUploadService, {});
  }
}
