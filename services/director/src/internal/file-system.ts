import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { createId } from "@orama/cuid2";
import { ZipArchive } from "archiver";

export class FileSystem extends Container.ServiceConstructable {
  #environment: Environment;

  constructor(...deps: [Environment]) {
    super();

    this.#environment = deps[0];
  }

  async resolveProjectOperators(projectId: string): Promise<FileSystem.Operators> {
    // TODO: return a remote Supervisor-backed adapter when the project is not hosted locally.
    return new FileSystem.Operators.LocalAdapter(this.#operatorPath("projects", projectId));
  }

  async resolveTemplateOperators(templateId: string): Promise<FileSystem.Operators> {
    return new FileSystem.Operators.LocalAdapter(this.#operatorPath("templates", templateId));
  }

  async createProjectDirectory(projectId: string) {
    const path = this.#operatorPath("projects", projectId);

    if (await this.#exists(path)) {
      throw new Error(`Project directory "${projectId}" already exists.`);
    }

    await mkdir(path, { recursive: true });

    return path;
  }

  async createTemplateDirectory(templateId: string) {
    const path = this.#operatorPath("templates", templateId);

    if (await this.#exists(path)) {
      throw new Error(`Template directory "${templateId}" already exists.`);
    }

    await mkdir(path, { recursive: true });

    return path;
  }

  async createProjectDirectoryFromTemplate(projectId: string, templateId: string) {
    return this.#copyDirectory("templates", templateId, "projects", projectId);
  }

  async createTemplateDirectoryFromTemplate(templateId: string, sourceTemplateId: string) {
    return this.#copyDirectory("templates", sourceTemplateId, "templates", templateId);
  }

  async removeProjectDirectory(projectId: string) {
    await this.#removeDirectory("projects", projectId);
  }

  async removeTemplateDirectory(templateId: string) {
    await this.#removeDirectory("templates", templateId);
  }

  async #copyDirectory(sourceKind: "projects" | "templates", sourceId: string, targetKind: "projects" | "templates", targetId: string) {
    const source = this.#operatorPath(sourceKind, sourceId);
    const target = this.#operatorPath(targetKind, targetId);
    const stagingRoot = resolve(this.#root, targetKind, ".staging");
    const staging = join(stagingRoot, createId());

    if (await this.#exists(target)) {
      throw new Error(`Directory "${targetId}" already exists.`);
    }

    // TODO: delegate to the Supervisor-hosted file system when the target is not local.
    await mkdir(stagingRoot, { recursive: true });

    try {
      await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});

      throw error;
    }

    return target;
  }

  async #removeDirectory(kind: "projects" | "templates", id: string) {
    await rm(this.#operatorPath(kind, id), { recursive: true, force: true });
  }

  async #exists(path: string) {
    return lstat(path).then(
      () => true,
      () => false,
    );
  }

  #operatorPath(kind: "projects" | "templates", id: string) {
    const base = resolve(this.#root, kind);
    const path = resolve(base, id);

    if (path === base || !path.startsWith(`${base}${sep}`)) {
      throw new Error("Invalid file system identifier.");
    }

    return path;
  }

  get #root() {
    const root = this.#environment.get("FS_ROOT");

    if (!root) {
      throw new Error("File system root is not configured.");
    }

    return resolve(root);
  }
}

export namespace FileSystem {
  export interface Operators {
    read(path: string, options?: Operators.ReadOptions): Promise<Uint8Array>;
    readStream(path: string, options?: Operators.ReadStreamOptions): Promise<ReadableStream<Uint8Array>>;
    readDirectory(path: string, options?: Operators.ReadDirectoryOptions): Promise<Operators.Entry[]>;
    write(path: string, data: Uint8Array): Promise<Operators.Entry>;
    writeStream(stream: ReadableStream<Operators.WriteChunk>): Promise<Operators.Entry>;
    rename(source: string, target: string): Promise<Operators.Entry>;
    remove(path: string, options?: Operators.RemoveOptions): Promise<void>;
    copy(source: string, target: string, options?: Operators.CopyOptions): Promise<Operators.Entry>;
    download(path: string): Promise<ReadableStream<Uint8Array>>;
    stat(path: string): Promise<Operators.StatResult>;
    createDirectory(path: string, options?: Operators.CreateDirectoryOptions): Promise<Operators.Entry>;
  }

  export namespace Operators {
    export type FileType = "regular" | "block-device" | "character-device" | "fifo" | "socket" | "unknown";

    export type Entry = {
      name: string;
      size: number;
      createTime: Date;
      modifyTime: Date;
      symlink: boolean;
    } & (
      | {
          kind: "file";
          fileType: FileType;
        }
      | {
          kind: "directory";
          state: "expanded";
          entries: Entry[];
        }
      | {
          kind: "directory";
          state: "unexpanded";
        }
    );

    export type Stats = {
      total: number;
      used: number;
      available: number;
    };

    export type StatResult = {
      entry: Entry;
      stats: Stats;
    };

    export type WriteChunk = {
      path: string;
      data: Uint8Array;
    };

    export type ReadOptions = {
      offset?: number;
      size?: number;
    };

    export type ReadStreamOptions = {
      offset?: number;
    };

    export type ReadDirectoryOptions = {
      depth?: number;
    };

    export type RemoveOptions = {
      recursive?: boolean;
    };

    export type CopyOptions = {
      recursive?: boolean;
      overwrite?: boolean;
    };

    export type CreateDirectoryOptions = {
      recursive?: boolean;
    };

    export class LocalAdapter implements Operators {
      #root: string;
      #rootReal: Promise<string>;

      constructor(root: string) {
        this.#root = resolve(root);
        this.#rootReal = realpath(this.#root).catch(() => this.#root);
      }

      async read(path: string, options: ReadOptions = {}) {
        const fullpath = await this.#resolve(path);
        const handle = await open(fullpath, "r");

        try {
          const info = await handle.stat();
          const offset = options.offset ?? 0;
          const size = options.size ?? Math.max(0, info.size - offset);
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, offset);

          return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        } finally {
          await handle.close();
        }
      }

      async readStream(path: string, options: ReadStreamOptions = {}) {
        const fullpath = await this.#resolve(path);
        const stream = createReadStream(fullpath, { start: options.offset ?? 0 });

        return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      }

      async readDirectory(path: string, options: ReadDirectoryOptions = {}) {
        const fullpath = await this.#resolve(path);

        return this.#readDirectory(fullpath, options.depth ?? 0);
      }

      async write(path: string, data: Uint8Array) {
        const fullpath = await this.#resolve(path);

        await writeFile(fullpath, data);

        return this.#entry(fullpath, basename(fullpath), 0);
      }

      async writeStream(stream: ReadableStream<WriteChunk>) {
        const reader = stream.getReader();

        let requestedPath: string | undefined;
        let fullpath: string | undefined;
        let handle: Awaited<ReturnType<typeof open>> | undefined;

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            if (requestedPath === undefined) {
              requestedPath = value.path;
              fullpath = await this.#resolve(value.path);
              handle = await open(fullpath, "w");
            } else if (value.path !== requestedPath) {
              throw new Error("Write stream path changed unexpectedly.");
            }

            if (!handle) {
              throw new Error("Write stream handle is not available.");
            }

            await handle.write(value.data);
          }
        } finally {
          reader.releaseLock();
          await handle?.close();
        }

        if (!fullpath) {
          throw new Error("Write stream did not contain any chunks.");
        }

        return this.#entry(fullpath, basename(fullpath), 0);
      }

      async rename(source: string, target: string) {
        const sourcePath = await this.#resolve(source);
        const targetPath = await this.#resolve(target);

        await rename(sourcePath, targetPath);

        return this.#entry(targetPath, basename(targetPath), 0);
      }

      async remove(path: string, options: RemoveOptions = {}) {
        const fullpath = await this.#resolve(path);

        if (fullpath === this.#root) {
          throw new Error("Cannot remove the file system root.");
        }

        await rm(fullpath, { recursive: options.recursive ?? false });
      }

      async copy(source: string, target: string, options: CopyOptions = {}) {
        const sourcePath = await this.#resolve(source);
        const targetPath = await this.#resolve(target);
        const overwrite = options.overwrite ?? false;

        await cp(sourcePath, targetPath, {
          recursive: options.recursive ?? false,
          force: overwrite,
          errorOnExist: !overwrite,
        });

        return this.#entry(targetPath, basename(targetPath), 0);
      }

      async download(path: string) {
        const fullpath = await this.#resolve(path);
        const info = await stat(fullpath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        if (info.isFile()) {
          archive.file(fullpath, { name: basename(fullpath) });
        } else {
          archive.directory(fullpath, false);
        }

        return new ReadableStream<Uint8Array>({
          start(controller) {
            archive.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            archive.on("end", () => controller.close());
            archive.on("error", (error) => controller.error(error));

            void archive.finalize();
          },
          cancel() {
            archive.destroy();
          },
        });
      }

      async stat(path: string) {
        const fullpath = await this.#resolve(path);
        const entry = await this.#entry(fullpath, basename(fullpath) || "/", 0);
        const info = await statfs(fullpath);
        const total = Number(info.blocks) * Number(info.bsize);
        const free = Number(info.bfree) * Number(info.bsize);

        return {
          entry,
          stats: {
            total,
            used: total - free,
            available: Number(info.bavail) * Number(info.bsize),
          },
        };
      }

      async createDirectory(path: string, options: CreateDirectoryOptions = {}) {
        const fullpath = await this.#resolve(path);

        await mkdir(fullpath, { recursive: options.recursive ?? false });

        return this.#entry(fullpath, basename(fullpath) || "/", 0);
      }

      async #readDirectory(from: string, depth: number): Promise<Entry[]> {
        const result: Entry[] = [];

        for (const item of await readdir(from, { withFileTypes: true })) {
          result.push(await this.#entry(join(from, item.name), item.name, depth));
        }

        return result;
      }

      async #entry(fullpath: string, name: string, depth: number): Promise<Entry> {
        const info = await lstat(fullpath);
        const symlink = info.isSymbolicLink();
        const target = symlink ? await this.#resolveSymlink(fullpath, info) : info;
        const base = {
          name,
          size: Number(target.size),
          createTime: target.birthtime,
          modifyTime: target.mtime,
          symlink,
        };

        if (target.isDirectory()) {
          if (!symlink && depth > 0) {
            return {
              ...base,
              kind: "directory",
              state: "expanded",
              entries: await this.#readDirectory(fullpath, depth - 1),
            };
          }

          return { ...base, kind: "directory", state: "unexpanded" };
        }

        return {
          ...base,
          kind: "file",
          fileType: this.#fileType(target),
        };
      }

      async #resolveSymlink(fullpath: string, fallback: Awaited<ReturnType<typeof lstat>>) {
        const target = await realpath(fullpath).catch(() => null);

        if (!target) {
          return fallback;
        }

        const root = await this.#rootReal;

        if (!this.#isWithin(target, root)) {
          return fallback;
        }

        return stat(fullpath).catch(() => fallback);
      }

      async #resolve(path: string) {
        if (path.includes("\0")) {
          throw new Error("Invalid file system path.");
        }

        const relative = path.replace(/^[/\\]+/, "");
        const fullpath = resolve(this.#root, relative);

        if (!this.#isWithin(fullpath, this.#root)) {
          throw new Error("Path escapes the file system root.");
        }

        const root = await this.#rootReal;
        const existing = await this.#realpathNearest(fullpath);

        if (!this.#isWithin(existing, root)) {
          throw new Error("Path escapes the file system root.");
        }

        return fullpath;
      }

      async #realpathNearest(path: string) {
        let current = path;

        while (true) {
          try {
            return await realpath(current);
          } catch (error) {
            const parent = dirname(current);

            if (parent === current) {
              throw error;
            }

            current = parent;
          }
        }
      }

      #isWithin(path: string, root: string) {
        if (root === sep) {
          return path.startsWith(sep);
        }

        return path === root || path.startsWith(`${root}${sep}`);
      }

      #fileType(info: Awaited<ReturnType<typeof lstat>>): FileType {
        if (info.isFile()) return "regular";
        if (info.isBlockDevice()) return "block-device";
        if (info.isCharacterDevice()) return "character-device";
        if (info.isFIFO()) return "fifo";
        if (info.isSocket()) return "socket";

        return "unknown";
      }
    }
  }
}
