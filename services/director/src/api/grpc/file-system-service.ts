import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { ZipArchive } from "archiver";
import { Base } from "@/api/grpc/base";
import {
  FileSystem,
  FileSystemService,
  FileSystemServiceCopyRequest,
  FileSystemServiceCopyResponse,
  FileSystemServiceCreateRequest,
  FileSystemServiceCreateResponse,
  FileSystemServiceDeleteRequest,
  FileSystemServiceDeleteResponse,
  FileSystemServiceDownloadRequest,
  FileSystemServiceDownloadResponse,
  FileSystemServiceMoveRequest,
  FileSystemServiceMoveResponse,
  FileSystemServiceReadRequest,
  FileSystemServiceReadResponse,
  FileSystemServiceTreeRequest,
  FileSystemServiceTreeResponse,
  FileSystemServiceWriteRequest,
  FileSystemServiceWriteResponse,
  FileSystemType,
  TreeNode,
} from "@/generated/proto/api/v1/file-system";
import { Authenticator } from "@/internal/authenticator";
import { GRPCHandler } from "@/internal/grpc-handler";
import { Projects } from "@/internal/projects";
import { Templates } from "@/internal/templates";

const MAX_READ_SIZE = 10 * 1024 * 1024;
const ARCHIVE_CHUNK_SIZE = 65536;

export class FileSystemServiceImpl extends Base implements FileSystemService<GRPCHandler.Context> {
  #environment: Environment;
  #projects: Projects;
  #templates: Templates;
  #logger: Logger;

  constructor(...deps: [Authenticator, Environment, Projects, Templates, Logger]) {
    const logger = deps[4].namespace("GRPC.FileSystemServiceImpl");

    super(deps[0], logger);

    this.#environment = deps[1];
    this.#projects = deps[2];
    this.#templates = deps[3];
    this.#logger = logger;
  }

  async tree(request: FileSystemServiceTreeRequest, context: GRPCHandler.Context): Promise<FileSystemServiceTreeResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.root ?? "/");
    const fullpath = this.#resolvePath(fs.root, path);
    const resolved = await this.#stat(fullpath);

    if (!resolved.isDirectory()) {
      throw GRPCHandler.Error.failedPrecondition("Path is not a directory.");
    }

    return {
      name: basename(path) || "/",
      size: BigInt(resolved.size),
      mtime: resolved.mtime,
      ctime: resolved.ctime,
      children: await this.#buildDirectoryTree(fullpath, request.depth),
    };
  }

  async *download(
    request: FileSystemServiceDownloadRequest,
    context: GRPCHandler.Context,
  ): AsyncIterable<FileSystemServiceDownloadResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.path || "/");
    const fullpath = this.#resolvePath(fs.root, path);
    const resolved = await this.#stat(fullpath);

    if (!resolved.isFile() && !resolved.isDirectory()) {
      throw GRPCHandler.Error.failedPrecondition("Path is not a file or directory.");
    }

    const archive = new ZipArchive({ zlib: { level: 9 } });

    if (resolved.isFile()) {
      archive.file(fullpath, { name: basename(fullpath) });
    } else {
      archive.directory(fullpath, false);
    }

    let buffer = Buffer.alloc(0);

    try {
      for await (const chunk of archive) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        buffer = Buffer.concat([buffer, data]);

        while (buffer.length >= ARCHIVE_CHUNK_SIZE) {
          const slice = buffer.subarray(0, ARCHIVE_CHUNK_SIZE);

          buffer = buffer.subarray(ARCHIVE_CHUNK_SIZE);

          yield { chunk: new Uint8Array(slice) };
        }
      }

      if (buffer.length > 0) {
        yield { chunk: new Uint8Array(buffer) };
      }
    } catch (error) {
      this.#logger.error("Failed to create archive.", { err: error });

      throw GRPCHandler.Error.internal("Failed to create archive.");
    }
  }

  async delete(request: FileSystemServiceDeleteRequest, context: GRPCHandler.Context): Promise<FileSystemServiceDeleteResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.path);
    const fullpath = this.#resolvePath(fs.root, path);

    if (path === "/") {
      throw GRPCHandler.Error.failedPrecondition("Cannot delete root directory.");
    }

    try {
      await rm(fullpath, { recursive: true });
    } catch (error) {
      if (this.#isErrorWithCode(error, "ENOENT")) {
        throw GRPCHandler.Error.notFound("Path not found.");
      }

      throw error;
    }

    return {};
  }

  async move(request: FileSystemServiceMoveRequest, context: GRPCHandler.Context): Promise<FileSystemServiceMoveResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const source = this.#resolvePath(fs.root, this.#normalizePath(request.source));
    const target = this.#resolvePath(fs.root, this.#normalizePath(request.target));

    try {
      await rename(source, target);
    } catch (error) {
      if (this.#isErrorWithCode(error, "ENOENT")) {
        throw GRPCHandler.Error.notFound("Path not found.");
      }

      throw error;
    }

    return {};
  }

  async copy(request: FileSystemServiceCopyRequest, context: GRPCHandler.Context): Promise<FileSystemServiceCopyResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const source = this.#resolvePath(fs.root, this.#normalizePath(request.source));
    const target = this.#resolvePath(fs.root, this.#normalizePath(request.target));

    try {
      await cp(source, target, { recursive: true });
    } catch (error) {
      if (this.#isErrorWithCode(error, "ENOENT")) {
        throw GRPCHandler.Error.notFound("Path not found.");
      }

      throw error;
    }

    return {};
  }

  async create(request: FileSystemServiceCreateRequest, context: GRPCHandler.Context): Promise<FileSystemServiceCreateResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.target || "/");
    const fullpath = this.#resolvePath(fs.root, path);

    if (request.directory) {
      try {
        await mkdir(fullpath, { recursive: true });
      } catch (error) {
        if (this.#isErrorWithCode(error, "EEXIST")) {
          throw GRPCHandler.Error.failedPrecondition("Target directory already exists.");
        }

        throw GRPCHandler.Error.internal("Failed to create directory.");
      }
    } else {
      try {
        await writeFile(fullpath, "", { flag: "wx" });
      } catch (error) {
        if (this.#isErrorWithCode(error, "EEXIST")) {
          throw GRPCHandler.Error.failedPrecondition("Target file already exists.");
        }

        throw GRPCHandler.Error.internal("Failed to create file.");
      }
    }

    return {};
  }

  async write(request: FileSystemServiceWriteRequest, context: GRPCHandler.Context): Promise<FileSystemServiceWriteResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.target);
    const fullpath = this.#resolvePath(fs.root, path);
    const resolved = await this.#stat(fullpath);

    if (!resolved.isFile()) {
      throw GRPCHandler.Error.failedPrecondition("Path is not a file.");
    }

    await writeFile(fullpath, request.content);

    return {};
  }

  async read(request: FileSystemServiceReadRequest, context: GRPCHandler.Context): Promise<FileSystemServiceReadResponse> {
    const fs = await this.#resolveFileSystem(request.fs, context);
    const path = this.#normalizePath(request.target);
    const fullpath = this.#resolvePath(fs.root, path);
    const resolved = await this.#stat(fullpath);

    if (!resolved.isFile()) {
      throw GRPCHandler.Error.failedPrecondition("Path is not a file.");
    }

    if (resolved.size > MAX_READ_SIZE) {
      throw GRPCHandler.Error.failedPrecondition("File exceeds the maximum readable size of 10 MiB.");
    }

    return {
      content: await readFile(fullpath),
    };
  }

  async #buildDirectoryTree(from: string, depth: number): Promise<TreeNode[]> {
    const result: TreeNode[] = [];

    for (const item of await readdir(from)) {
      const fullpath = join(from, item);
      const stats = await lstat(fullpath);

      if (stats.isSymbolicLink()) {
        result.push({
          name: item,
          size: BigInt(stats.size),
          mtime: stats.mtime,
          ctime: stats.ctime,
          type: {
            case: "symlink",
            value: { target: await readlink(fullpath) },
          },
        });
      } else if (stats.isDirectory()) {
        const loaded = depth > 0;

        result.push({
          name: item,
          size: BigInt(stats.size),
          mtime: stats.mtime,
          ctime: stats.ctime,
          type: {
            case: "directory",
            value: {
              children: loaded ? await this.#buildDirectoryTree(fullpath, depth - 1) : [],
              loaded,
            },
          },
        });
      } else if (stats.isFile()) {
        result.push({
          name: item,
          size: BigInt(stats.size),
          mtime: stats.mtime,
          ctime: stats.ctime,
          type: {
            case: "file",
            value: { mimetype: "application/octet-stream" },
          },
        });
      }
    }

    return result;
  }

  async #resolveFileSystem(fs: FileSystem, context: GRPCHandler.Context) {
    const identity = this.getAuthenticationIdentityMust(context, "user", "manager");
    const root = this.#environment.get("FS_ROOT");

    if (!root) {
      throw GRPCHandler.Error.unavailable("File system root not configured.");
    }

    if (fs.type === FileSystemType.TEMPLATE) {
      if (identity.type !== "manager") {
        throw GRPCHandler.Error.permissionDenied("Template file systems require a manager identity.");
      }

      const template = await this.#templates.get(fs.id);

      if (!template) {
        throw GRPCHandler.Error.notFound("Template not found.");
      }

      return { type: "template" as const, id: template.id, root: join(root, "templates", template.id) };
    }

    if (fs.type === FileSystemType.PROJECT) {
      if (identity.type !== "user") {
        throw GRPCHandler.Error.permissionDenied("Project file systems require a user identity.");
      }

      const project = await this.#projects.get(fs.id);

      if (!project || project.ownerId !== identity.id) {
        throw GRPCHandler.Error.notFound("Project not found.");
      }

      return { type: "project" as const, id: project.id, root: join(root, "projects", project.id) };
    }

    throw GRPCHandler.Error.invalidArgument("Unsupported file system type.");
  }

  #normalizePath(path: string) {
    return join("/", normalize(path));
  }

  #resolvePath(root: string, path: string) {
    const fullpath = join(root, path);

    if (fullpath !== root && !fullpath.startsWith(`${root}/`)) {
      throw GRPCHandler.Error.permissionDenied("Path traversal denied.");
    }

    return fullpath;
  }

  async #stat(path: string) {
    try {
      return await stat(path);
    } catch (error) {
      if (this.#isErrorWithCode(error, "ENOENT")) {
        throw GRPCHandler.Error.notFound("Path not found.");
      }

      throw error;
    }
  }

  #isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
  }

  setup(register: (route: GRPCHandler.Route) => void): void {
    const interceptors = [this.createAuthenticationInterceptor(), this.createAccessControlInterceptor("user", "manager")];

    register(GRPCHandler.route(FileSystemService.methods.tree, this.tree.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.download, this.download.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.delete, this.delete.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.move, this.move.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.copy, this.copy.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.create, this.create.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.write, this.write.bind(this)).use(...interceptors));
    register(GRPCHandler.route(FileSystemService.methods.read, this.read.bind(this)).use(...interceptors));
  }
}
