import { mkdir, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ZipArchive } from "archiver";
import {
  FileSystemService,
  type FileSystemServiceCreateRequestValid,
  FileSystemServiceCreateResponseSchema,
  type FileSystemServiceDeleteRequestValid,
  FileSystemServiceDeleteResponseSchema,
  type FileSystemServiceDownloadRequestValid,
  FileSystemServiceDownloadResponseSchema,
  type FileSystemServiceTreeRequestValid,
  FileSystemServiceTreeResponseSchema,
  TreeNodeDirectorySchema,
  TreeNodeFileSchema,
  TreeNodeSchema,
  TreeNodeSymlinkSchema,
  type TreeNodeValid,
} from "@/generated/proto/api/v1/file-system_pb";
import { Container } from "@/helpers/container";
import { Protobuf } from "@/helpers/protobuf";
import { GRPCServer } from "@/internal/grpc-server";
import { Logger } from "@/internal/logger";
import { Repository } from "@/internal/repository";
import { Variables } from "@/internal/variables";

export class FileSystemServiceImplementation {
  #repository: Repository;
  #server: GRPCServer;

  #variables: Variables;
  #logger: Logger;

  constructor() {
    this.#repository = Container.inject(Repository);
    this.#server = Container.inject(GRPCServer);
    this.#variables = Container.inject(Variables);
    this.#logger = Container.inject(Logger).scope("FileSystemService");
  }

  get #root() {
    const root = this.#variables.get("AW_DIRECTOR_FS_ROOT");

    if (!root) {
      throw new ConnectError("File system root not configured.", Code.Unavailable);
    }

    return root;
  }

  #normalizePath(path: string) {
    return join("/", normalize(path));
  }

  async #findProjectMust(projectId: string, context: HandlerContext) {
    const user = this.#server.getUserIdentityContextMust(context);
    const project = await this.#repository.client.project.findFirst({
      where: {
        id: projectId,
        ownerId: user,
        deleteTime: null,
      },
    });

    if (!project) {
      throw new ConnectError("Project not found.", Code.NotFound);
    }

    return project;
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
    const project = await this.#findProjectMust(request.projectId, context);

    const projectRoot = join(this.#root, "projects", project.id);
    const path = this.#normalizePath(request.root || "/");
    const fullpath = join(projectRoot, path);

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
      // TODO:xxx
      children: await this.#buildDirectoryTree(fullpath, request.depth),
    });
  }

  async #download(request: FileSystemServiceDownloadRequestValid, context: HandlerContext) {
    const project = await this.#findProjectMust(request.projectId, context);

    const projectRoot = join(this.#root, "projects", project.id);
    const path = this.#normalizePath(request.path);
    const fullpath = join(projectRoot, path);

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
    const project = await this.#findProjectMust(request.projectId, context);

    const projectRoot = join(this.#root, "projects", project.id);
    const path = this.#normalizePath(request.target);
    const fullpath = join(projectRoot, path);

    if (!fullpath.startsWith(`${projectRoot}/`) && fullpath !== projectRoot) {
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
    const project = await this.#findProjectMust(request.projectId, context);

    const projectRoot = join(this.#root, "projects", project.id);
    const path = this.#normalizePath(request.path);
    const fullpath = join(projectRoot, path);

    if (path === "/") {
      throw new ConnectError("Cannot delete root directory.", Code.FailedPrecondition);
    }

    try {
      await rm(fullpath, { recursive: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new ConnectError("Path not found.", Code.NotFound);
      }

      throw error;
    }

    return Protobuf.createValid(FileSystemServiceDeleteResponseSchema, {});
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
        return this.#delete(request, context);
      },
    });
  }
}
