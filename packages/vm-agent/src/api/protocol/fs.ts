import { RPCMethod } from "@aw/rpc";
import { z } from "zod/v4";

export namespace FSProtocol {
  export const ContextSchema = z.discriminatedUnion("branch", [
    z.object({
      branch: z.literal("main"),
    }),
    z.object({
      branch: z.literal("session"),
      id: z.uuid(),
    }),
  ]);

  export const MetadataSchema = z.object({
    type: z.enum(["file", "directory", "symlink", "unknown"]),
    createTime: z.date(),
    updateTime: z.date(),
    size: z.number(),
  });

  export const EntrySchema = z.object({
    name: z.string(),
    metadata: MetadataSchema,
  });

  export const PathSchema = z.string().max(512);

  export const ListRequestSchema = z.object({
    context: ContextSchema,
    path: PathSchema,
  });

  export const ListResponseSchema = z.object({
    entries: EntrySchema.array(),
  });

  export const RemoveRequestSchema = z.object({
    context: ContextSchema,
    path: PathSchema,
  });

  export const RemoveResponseSchema = z.undefined();

  export const CopyRequestSchema = z.object({
    context: ContextSchema,
    destination: PathSchema,
    source: PathSchema,
  });

  export const CopyResponseSchema = z.undefined();

  export const MoveRequestSchema = z.object({
    context: ContextSchema,
    destination: PathSchema,
    source: PathSchema,
  });

  export const MoveResponseSchema = z.undefined();

  export const MetadataRequestSchema = z.object({
    context: ContextSchema,
    path: PathSchema,
  });

  export const MetadataResponseSchema = z.object({
    metadata: MetadataSchema.nullable(),
  });

  export const WriteMetadataSchema = z.object({
    "x/vm-agent.fs/write": PathSchema,
  });

  export const WriteRequestSchema = z.object({});

  export const WriteResponseSchema = z.undefined();

  export const ReadRequestSchema = z.object({
    context: ContextSchema,
    path: PathSchema,
  });

  export const ReadResponseSchema = z.instanceof(Uint8Array);

  export type Context = z.infer<typeof ContextSchema>;
  export type Metadata = z.infer<typeof MetadataSchema>;
  export type Entry = z.infer<typeof EntrySchema>;
  export type Path = z.infer<typeof PathSchema>;

  export type MoveRequest = z.infer<typeof MoveRequestSchema>;
  export type MoveResponse = z.infer<typeof MoveResponseSchema>;
  export type MetadataRequest = z.infer<typeof MetadataRequestSchema>;
  export type MetadataResponse = z.infer<typeof MetadataResponseSchema>;
  export type ListRequest = z.infer<typeof ListRequestSchema>;
  export type ListResponse = z.infer<typeof ListResponseSchema>;
  export type RemoveRequest = z.infer<typeof RemoveRequestSchema>;
  export type RemoveResponse = z.infer<typeof RemoveResponseSchema>;
  export type CopyRequest = z.infer<typeof CopyRequestSchema>;
  export type CopyResponse = z.infer<typeof CopyResponseSchema>;

  export const methods = {
    list: RPCMethod.defineUnary(ListRequestSchema, ListResponseSchema),
    remove: RPCMethod.defineUnary(RemoveRequestSchema, RemoveResponseSchema),
    copy: RPCMethod.defineUnary(CopyRequestSchema, CopyResponseSchema),
    move: RPCMethod.defineUnary(MoveRequestSchema, MoveResponseSchema),
    metadata: RPCMethod.defineUnary(MetadataRequestSchema, MetadataResponseSchema),
    read: RPCMethod.defineServerStream(ReadRequestSchema, ReadResponseSchema),
  } as const;
}
