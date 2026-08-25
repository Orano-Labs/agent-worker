import type { ConnectRouter } from "@connectrpc/connect";
import { FileUploadService } from "@/generated/proto/api/v1/file-system_pb";

export class FileUploadServiceImplementation {
  setup(router: ConnectRouter) {
    router.service(FileUploadService, {});
  }
}
