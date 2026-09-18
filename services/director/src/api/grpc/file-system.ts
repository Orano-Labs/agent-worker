import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import type { Environment } from "@aw/environment";
import type { Logger } from "@aw/logging";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ZipArchive } from "archiver";
import { GRPCHandler } from "@/api/grpc-handler";
import {
  FileSystemService,
  type FileSystemServiceCreateRequestValid,
  FileSystemServiceCreateResponseSchema,
  type FileSystemServiceDeleteRequestValid,
  FileSystemServiceDeleteResponseSchema,
  type FileSystemServiceDownloadRequestValid,
  FileSystemServiceDownloadResponseSchema,
  type FileSystemServiceReadRequestValid,
  FileSystemServiceReadResponseSchema,
  type FileSystemServiceTreeRequestValid,
  FileSystemServiceTreeResponseSchema,
  type FileSystemServiceWriteRequestValid,
  FileSystemServiceWriteResponseSchema,
  FileSystemType,
  type FileSystemValid,
  TreeNodeDirectorySchema,
  TreeNodeFileSchema,
  TreeNodeSchema,
  TreeNodeSymlinkSchema,
  type TreeNodeValid,
} from "@/generated/proto/api/v1/file-system_pb";
import { Protobuf } from "@/helpers/protobuf";
import type { Repository } from "@/internal/repository";

export class FileSystemServiceImplementation extends GRPCHandler.ServiceImplementation {
  #repository: Repository;

  #environment: Environment;
  #logger: Logger;

  constructor(...deps: [Repository, Environment, Logger]) {
    super();

    this.#repository = deps[0];
    this.#environment = deps[1];
    this.#logger = deps[2].namespace("FileSystemService");
  }

  get #root() {
    const root = this.#environment.get("FS_ROOT");

    if (!root) {
      throw new ConnectError("File system root not configured.", Code.Unavailable);
    }

    return root;
  }

  #normalizePath(path: string) {
    return join("/", normalize(path));
  }

  async #resolveFileSystemInfo(fs: FileSystemValid, context: HandlerContext) {
    const identityType = GRPCHandler.getIdentityCaseContextMust(context);

    if (fs.type === FileSystemType.TEMPLATE && identityType !== "manager") {
      throw new ConnectError("Template file systems require a manager identity.", Code.PermissionDenied);
    }

    if (fs.type === FileSystemType.PROJECT && identityType !== "user") {
      throw new ConnectError("Project file systems require a user identity.", Code.PermissionDenied);
    }

    if (fs.type !== FileSystemType.TEMPLATE && fs.type !== FileSystemType.PROJECT) {
      throw new ConnectError("Unsupported file system type.", Code.InvalidArgument);
    }

    if (fs.type === FileSystemType.TEMPLATE) {
      const template = await this.#repository.client.template.findFirst({
        where: {
          id: fs.id,
          deleteTime: null,
        },
      });

      if (!template) {
        throw new ConnectError("Template not found.", Code.NotFound);
      }

      return { type: "template", root: join(this.#root, "templates", template.id), ...template } as const;
    } else {
      const user = GRPCHandler.getUserIdentityContextMust(context);
      const project = await this.#repository.client.project.findFirst({
        where: {
          id: fs.id,
          ownerId: user,
          deleteTime: null,
        },
      });

      if (!project) {
        throw new ConnectError("Project not found.", Code.NotFound);
      }

      return { type: "project", root: join(this.#root, "projects", project.id), ...project } as const;
    }
  }

  async #buildDirectoryTree(from: string, depth: number): Promise<TreeNodeValid[]> {
    const result: TreeNodeValid[] = [];

    for (const item of await readdir(from)) {
      const fullPath = join(from, item);
      const stats = await stat(join(from, item));

      if (stats.isFile()) {
        result.push(
          Protobuf.createValid(TreeNodeSchema, {
            name: item,
            size: BigInt(stats.size),
            mtime: Protobuf.Timestamp.fromDate(stats.mtime),
            ctime: Protobuf.Timestamp.fromDate(stats.ctime),
            type: {
              case: "file",
              value: Protobuf.createValid(TreeNodeFileSchema, {
                mimetype: "application/octet-stream",
              }),
            },
          }),
        );
      } else if (stats.isSymbolicLink()) {
        result.push(
          Protobuf.createValid(TreeNodeSchema, {
            name: item,
            size: BigInt(stats.size),
            mtime: Protobuf.Timestamp.fromDate(stats.mtime),
            ctime: Protobuf.Timestamp.fromDate(stats.ctime),
            type: {
              case: "symlink",
              value: Protobuf.createValid(TreeNodeSymlinkSchema, {
                target: await readlink(fullPath),
              }),
            },
          }),
        );
      } else if (stats.isDirectory()) {
        let children: TreeNodeValid[] = [];
        let loaded = false;

        if (depth > 0) {
          loaded = true;
          children = await this.#buildDirectoryTree(join(from, item), depth - 1);
        }

        result.push(
          Protobuf.createValid(TreeNodeSchema, {
            name: item,
            size: BigInt(stats.size),
            mtime: Protobuf.Timestamp.fromDate(stats.mtime),
            ctime: Protobuf.Timestamp.fromDate(stats.ctime),
            type: {
              case: "directory",
              value: Protobuf.createValid(TreeNodeDirectorySchema, {
                children,
                loaded,
              }),
            },
          }),
        );
      }
    }

    return result;
  }

  async #tree(request: FileSystemServiceTreeRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.root || "/");
    const fullpath = join(info.root, path);

    const resolved = await stat(fullpath).catch(() => {
      throw new ConnectError("Path not found.", Code.NotFound);
    });

    if (!resolved.isDirectory()) {
      throw new ConnectError("Path is not a directory.", Code.FailedPrecondition);
    }

    return Protobuf.createValid(FileSystemServiceTreeResponseSchema, {
      name: basename(path),
      size: BigInt(resolved.size),
      mtime: Protobuf.Timestamp.fromDate(resolved.mtime),
      ctime: Protobuf.Timestamp.fromDate(resolved.ctime),
      children: await this.#buildDirectoryTree(fullpath, request.depth),
    });
  }

  async #download(request: FileSystemServiceDownloadRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.path || "/");
    const fullpath = join(info.root, path);

    const resolved = await stat(fullpath).catch(() => {
      throw new ConnectError("Path not found.", Code.NotFound);
    });

    if (!resolved.isFile() && !resolved.isDirectory()) {
      throw new ConnectError("Path is not a file or directory.", Code.FailedPrecondition);
    }

    const self = this;

    return (async function* () {
      const archive = new ZipArchive({ zlib: { level: 9 } });

      if (resolved.isFile()) {
        archive.file(fullpath, { name: basename(fullpath) });
      } else {
        archive.directory(fullpath, false);
      }

      const MAX_CHUNK = 65536;

      let buffer = Buffer.alloc(0);

      try {
        for await (const chunk of archive) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

          buffer = Buffer.concat([buffer, data]);

          while (buffer.length >= MAX_CHUNK) {
            const slice = buffer.subarray(0, MAX_CHUNK);

            buffer = buffer.subarray(MAX_CHUNK);

            yield Protobuf.createValid(FileSystemServiceDownloadResponseSchema, {
              chunk: new Uint8Array(slice),
            });
          }
        }

        if (buffer.length > 0) {
          yield Protobuf.createValid(FileSystemServiceDownloadResponseSchema, {
            chunk: new Uint8Array(buffer),
          });
        }
      } catch (error) {
        self.#logger.error("Failed to create archive", {
          err: error,
        });

        throw new ConnectError("Failed to create archive.", Code.Internal);
      }
    })();
  }

  async #create(request: FileSystemServiceCreateRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.target || "/");
    const fullpath = join(info.root, path);

    if (!fullpath.startsWith(`${info.root}/`) && fullpath !== info.root) {
      throw new ConnectError("Path traversal denied.", Code.PermissionDenied);
    }

    if (request.directory) {
      try {
        await mkdir(fullpath, { recursive: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new ConnectError("Target directory already exists", Code.FailedPrecondition);
        }

        throw new ConnectError("Failed to create directory", Code.Internal);
      }
    } else {
      try {
        await writeFile(fullpath, "", { flag: "wx" });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new ConnectError("Target file already exists", Code.FailedPrecondition);
        }

        throw new ConnectError("Failed to create file", Code.Internal);
      }
    }

    return Protobuf.createValid(FileSystemServiceCreateResponseSchema, {});
  }

  async #delete(request: FileSystemServiceDeleteRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.path);
    const fullpath = join(info.root, path);

    if (path === "/") {
      throw new ConnectError("Cannot delete root directory.", Code.FailedPrecondition);
    }

    try {
      await rm(fullpath, { recursive: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new ConnectError("Path not found.", Code.NotFound);
      }

      throw error;
    }

    return Protobuf.createValid(FileSystemServiceDeleteResponseSchema, {});
  }

  async #read(request: FileSystemServiceReadRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.target);
    const fullpath = join(info.root, path);

    const resolved = await stat(fullpath).catch(() => {
      throw new ConnectError("Path not found.", Code.NotFound);
    });

    if (!resolved.isFile()) {
      throw new ConnectError("Path is not a file.", Code.FailedPrecondition);
    }

    if (resolved.size > 1024 * 1024) {
      throw new ConnectError("File exceeds the maximum readable size of 1 MiB.", Code.FailedPrecondition);
    }

    return Protobuf.createValid(FileSystemServiceReadResponseSchema, {
      content: await readFile(fullpath),
    });
  }

  async #write(request: FileSystemServiceWriteRequestValid, context: HandlerContext) {
    const info = await this.#resolveFileSystemInfo(request.fs, context);
    const path = this.#normalizePath(request.target);
    const fullpath = join(info.root, path);

    const resolved = await stat(fullpath).catch(() => {
      throw new ConnectError("Path not found.", Code.NotFound);
    });

    if (!resolved.isFile()) {
      throw new ConnectError("Path is not a file.", Code.FailedPrecondition);
    }

    await writeFile(fullpath, request.content);

    return Protobuf.createValid(FileSystemServiceWriteResponseSchema, {});
  }

  setup(router: ConnectRouter) {
    router.service(FileSystemService, {
      tree: async (request, context) => {
        return this.#tree(request as FileSystemServiceTreeRequestValid, context);
      },
      download: (request, context) => {
        const self = this;

        return (async function* () {
          yield* await self.#download(request as FileSystemServiceDownloadRequestValid, context);
        })();
      },
      create: async (request, context) => {
        return this.#create(request as FileSystemServiceCreateRequestValid, context);
      },
      delete: async (request, context) => {
        return this.#delete(request as FileSystemServiceDeleteRequestValid, context);
      },
      read: async (request, context) => {
        return this.#read(request as FileSystemServiceReadRequestValid, context);
      },
      write: async (request, context) => {
        return this.#write(request as FileSystemServiceWriteRequestValid, context);
      },
    });
  }
}
