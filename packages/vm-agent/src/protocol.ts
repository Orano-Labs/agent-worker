export * from "@/protocol/vm/agent/v1/fs_archive_pb";
export * from "@/protocol/vm/agent/v1/fs_pb";
export * from "@/protocol/vm/agent/v1/sessions_pb";

import {} from "@/protocol/vm/agent/v1/fs_archive_pb";
import type {
  VMAgentFSServiceCopyRequestValid as FSServiceCopyRequest,
  VMAgentFSServiceCopyResponseValid as FSServiceCopyResponse,
  VMAgentFSServiceListRequestValid as FSServiceListRequest,
  VMAgentFSServiceListResponseValid as FSServiceListResponse,
  VMAgentFSServiceMoveRequestValid as FSServiceMoveRequest,
  VMAgentFSServiceMoveResponseValid as FSServiceMoveResponse,
  VMAgentFSServiceReadRequestValid as FSServiceReadRequest,
  VMAgentFSServiceReadResponseValid as FSServiceReadResponse,
  VMAgentFSServiceRemoveRequestValid as FSServiceRemoveRequest,
  VMAgentFSServiceRemoveResponseValid as FSServiceRemoveResponse,
  VMAgentFSServiceStatsRequestValid as FSServiceStatsRequest,
  VMAgentFSServiceStatsResponseValid as FSServiceStatsResponse,
  VMAgentFSServiceWriteRequestValid as FSServiceWriteRequest,
  VMAgentFSServiceWriteResponseValid as FSServiceWriteResponse,
} from "@/protocol/vm/agent/v1/fs_pb";

export interface VMAgentFSServiceImplementation<T> {
  list(request: FSServiceListRequest, context: T): Promise<FSServiceListResponse>;
  read(request: FSServiceReadRequest, context: T): AsyncIterable<FSServiceReadResponse>;
  write(request: AsyncIterable<FSServiceWriteRequest>, context: T): Promise<FSServiceWriteResponse>;
  remove(request: FSServiceRemoveRequest, context: T): Promise<FSServiceRemoveResponse>;
  move(request: FSServiceMoveRequest, context: T): Promise<FSServiceMoveResponse>;
  copy(request: FSServiceCopyRequest, context: T): Promise<FSServiceCopyResponse>;
  stats(request: FSServiceStatsRequest, context: T): Promise<FSServiceStatsResponse>;
}
