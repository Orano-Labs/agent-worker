import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, Stats } from "node:fs";
import {
  access as fsAccess,
  constants as fsConstants,
  copyFile as fsCopyFile,
  cp as fsCp,
  link as fsLink,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { default as chokidar } from "chokidar";
import { glob as tinyGlob } from "tinyglobby";

export class FileSystem extends Container.ServiceConstructable {
  #logger: Logger;
  #environment: Environment;

  #root: string;
  #storage: AsyncLocalStorage<{ root: string }>;

  constructor(...deps: [Environment, Logger]) {
    super();

    this.#environment = deps[0];
    this.#logger = deps[1].namespace("FileSystem");
    this.#root = (() => {
      const resolved = resolve(this.#environment.get("FS_ROOT") || "/");

      try {
        // Canonicalize eagerly so symlinks in FS_ROOT itself (e.g. macOS "/var") do not break containment checks.
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    })();

    this.#storage = new AsyncLocalStorage();

    if (!isAbsolute(this.#root)) {
      throw new FileSystem.Exception(FileSystem.Exception.Code.NOT_ABSOLUTE, `FS_ROOT must be an absolute path, got "${this.#root}".`);
    }
  }

  /**
   * The root directory given by `FS_ROOT`.
   */
  get root() {
    return this.#root;
  }

  /**
   * The active (narrowed) root. It falls back to {@link FileSystem.root}
   * when no narrowed root is active in the current asynchronous context.
   */
  get narrowedRoot() {
    return this.#storage.getStore()?.root ?? this.#root;
  }

  /**
   * Run `operation` with the root narrowed to a subdirectory of the active
   * root. Every file system operation performed inside `operation` (and its
   * asynchronous continuations) is contained within the narrowed directory
   * through `AsyncLocalStorage`.
   */
  async narrow<T>(subdirectory: string, operation: () => Promise<T>) {
    const base = this.narrowedRoot;
    const narrowed = this.#resolveWithin(base, resolve(base, subdirectory));

    return this.#storage.run({ root: narrowed }, operation);
  }

  async access(path: string, options?: FileSystem.AccessOptions) {
    const target = await this.#check(path);
    let bits = fsConstants.F_OK;

    if (options?.readable) {
      bits |= fsConstants.R_OK;
    }

    if (options?.writable) {
      bits |= fsConstants.W_OK;
    }

    try {
      await fsAccess(target, bits);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async copy(fromPath: string, toPath: string, options?: FileSystem.CopyOptions) {
    const from = await this.#check(fromPath);
    const to = await this.#check(toPath);

    try {
      await fsCp(from, to, {
        recursive: true,
        force: options?.overwrite !== false,
        errorOnExist: options?.overwrite === false,
        preserveTimestamps: options?.preserveTimestamps,
      });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async copyFile(fromPath: string, toPath: string) {
    const from = await this.#check(fromPath);
    const to = await this.#check(toPath);

    try {
      await fsCopyFile(from, to);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async exists(path: string) {
    try {
      await this.access(path);
      return true;
    } catch (error) {
      if (FileSystem.Exception.isEscalation(error)) {
        throw error;
      }

      return false;
    }
  }

  async makeDirectory(path: string, options?: FileSystem.MakeDirectoryOptions) {
    const target = await this.#check(path);

    try {
      await fsMkdir(target, { recursive: options?.recursive, mode: options?.mode });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async link(fromPath: string, toPath: string) {
    const from = await this.#check(fromPath);
    const to = await this.#check(toPath);

    try {
      await fsLink(from, to);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async readDirectory(path: string, options?: FileSystem.ReadDirectoryOptions) {
    const target = await this.#check(path);
    const entries: Array<string> = [];

    const walk = async (current: string, prefix: string) => {
      for (const entry of await fsReaddir(current, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;

        entries.push(name);

        if (options?.recursive && entry.isDirectory()) {
          await walk(join(current, entry.name), name);
        }
      }
    };

    try {
      await walk(target, "");
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }

    return entries;
  }

  async readFile(path: string) {
    const target = await this.#check(path);

    try {
      return await fsReadFile(target);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async readFileString(path: string, encoding: BufferEncoding = "utf-8") {
    const target = await this.#check(path);

    try {
      return await fsReadFile(target, { encoding });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async remove(path: string, options?: FileSystem.RemoveOptions) {
    const target = await this.#check(path);

    try {
      await fsRm(target, { recursive: options?.recursive, force: options?.force });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async rename(oldPath: string, newPath: string) {
    const from = await this.#check(oldPath);
    const to = await this.#check(newPath);

    try {
      await fsRename(from, to);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async stat(path: string) {
    const target = await this.#check(path);

    try {
      return this.#formatStat(await fsStat(target));
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async glob(pattern: string, options?: FileSystem.GlobOptions) {
    // The base used to search must be canonical (real), while the returned
    // paths keep the abstract (as-requested) form of the root.
    const base = options?.root ? await this.#check(resolve(options.root)) : this.narrowedRoot;
    const abstractBase = options?.root ? resolve(options.root) : this.narrowedRoot;
    let results: Array<string>;

    try {
      results = await tinyGlob([pattern], {
        cwd: base,
        absolute: true,
        onlyFiles: false,
        expandDirectories: false,
        followSymbolicLinks: false,
        ignore: options?.exclude ? [...options.exclude] : [],
      });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }

    // Defensively filter in case a result resolves outside of the scope,
    // then re-express surviving results as abstract paths within the root.
    return results
      .filter((result) => {
        const rel = relative(base, result);

        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      })
      .map((result) => resolve(abstractBase, relative(base, result)));
  }

  async *watch(path: string, options?: FileSystem.WatchOptions) {
    // Watch the canonical (real) target, but report abstract paths that stay
    // within the root as the caller expressed them.
    const requested = resolve(path);
    const target = await this.#check(requested);
    const watcher = chokidar.watch(target, {
      ignoreInitial: true,
      depth: options?.recursive ? undefined : 0,
      followSymlinks: false,
    });
    const queue: Array<FileSystem.WatchEvent> = [];
    let notify: (() => void) | undefined;
    let closed = false;

    const push = (event: FileSystem.WatchEvent) => {
      queue.push(event);
      notify?.();
      notify = undefined;
    };

    const abstract = (path: string) => resolve(requested, relative(target, path));

    watcher.on("add", (path) => push({ type: "create", path: abstract(path) }));
    watcher.on("addDir", (path) => push({ type: "create", path: abstract(path) }));
    watcher.on("change", (path) => push({ type: "update", path: abstract(path) }));
    watcher.on("unlink", (path) => push({ type: "remove", path: abstract(path) }));
    watcher.on("unlinkDir", (path) => push({ type: "remove", path: abstract(path) }));
    watcher.on("error", (error) =>
      push({
        type: "remove",
        path: `watcher:error:${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    watcher.on("close", () => {
      closed = true;
      notify?.();
      notify = undefined;
    });

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as FileSystem.WatchEvent;
        }

        if (closed) {
          break;
        }

        await new Promise<void>((resolveNext) => {
          notify = resolveNext;
        });
      }
    } finally {
      await watcher.close();
    }
  }

  async writeFile(path: string, data: Uint8Array, options?: FileSystem.WriteFileOptions) {
    const target = await this.#check(path);

    try {
      await fsWriteFile(target, data, { flag: options?.flag, mode: options?.mode });
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error);
    }
  }

  async writeFileString(path: string, data: string, options?: FileSystem.WriteFileOptions) {
    return this.writeFile(path, Buffer.from(data, "utf-8"), options);
  }

  protected override async initialize(signal: AbortSignal) {
    signal.throwIfAborted();

    if (this.#root === "/") {
      this.#logger.warn('FS_ROOT falls back to "/", every path on the host is accessible.');
    }

    try {
      await fsAccess(this.#root, fsConstants.W_OK | fsConstants.R_OK);
    } catch (error) {
      throw FileSystem.Exception.fromUnknown(error, `FS_ROOT "${this.#root}" is not readable/writable for this process.`);
    }
  }

  /**
   * Resolve a user provided path and verify that it stays inside the
   * scoped root. The path must be absolute and must not escape the root
   * lexically or through symbolic links.
   */
  async #check(path: string) {
    if (!isAbsolute(path)) {
      throw new FileSystem.Exception(FileSystem.Exception.Code.NOT_ABSOLUTE, `Only absolute paths are accepted, got "${path}".`);
    }

    const base = this.narrowedRoot;
    const real = await this.#canonicalize(resolve(path));

    this.#resolveWithin(base, real);

    return real;
  }

  /**
   * Canonicalize `resolved` by resolving the real location of its existing
   * prefix, so symbolic links (including one in FS_ROOT itself) cannot
   * smuggle us outside of the scoped root.
   */
  async #canonicalize(resolved: string) {
    const segments = resolved.split(sep);

    for (let index = segments.length; index > 1; index--) {
      const prefix = segments.slice(0, index).join(sep);
      const suffix = segments.slice(index);

      try {
        const real = await fsRealpath(prefix);

        return resolve(real, ...suffix);
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

        if (code === "ENOENT") {
          continue;
        }

        if (code === "ELOOP" || code === "ENAMETOOLONG") {
          throw FileSystem.Exception.fromUnknown(error);
        }

        this.#logger.debug(`realpath check fallback for "${prefix}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return resolved;
  }

  #formatStat(stats: Stats) {
    const type = (() => {
      if (stats.isFile()) {
        return "file" as const;
      }

      if (stats.isDirectory()) {
        return "directory" as const;
      }

      if (stats.isSymbolicLink()) {
        return "symbolic-link" as const;
      }

      if (stats.isBlockDevice()) {
        return "block-device" as const;
      }

      if (stats.isCharacterDevice()) {
        return "character-device" as const;
      }

      if (stats.isFIFO()) {
        return "fifo" as const;
      }

      if (stats.isSocket()) {
        return "socket" as const;
      }

      return "unknown" as const;
    })();

    return {
      type,
      mtime: stats.mtime,
      atime: stats.atime,
      birthtime: stats.birthtime,
      dev: BigInt(stats.dev),
      ino: BigInt(stats.ino),
      mode: stats.mode,
      nlink: BigInt(stats.nlink),
      uid: stats.uid,
      gid: stats.gid,
      rdev: BigInt(stats.rdev),
      size: Number(stats.size),
      blksize: stats.blksize,
      blocks: stats.blocks === undefined ? undefined : BigInt(stats.blocks),
    };
  }

  /**
   * Resolve a user provided path and verify that it stays inside `base`.
   * The path must be absolute and must not escape the root lexically.
   */
  #resolveWithin(base: string, path: string): string {
    if (!isAbsolute(path)) {
      throw new FileSystem.Exception(FileSystem.Exception.Code.NOT_ABSOLUTE, `Only absolute paths are accepted, got "${path}".`);
    }

    const resolved = resolve(path);
    const rel = relative(base, resolved);

    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new FileSystem.Exception(FileSystem.Exception.Code.OUT_OF_BOUNDS, `Path "${path}" escapes the scoped root "${base}".`);
    }

    return resolved;
  }
}

export namespace FileSystem {
  export class Exception extends Error {
    code: Exception.Code;

    constructor(code: Exception.Code, message: string, options?: ErrorOptions) {
      super(message, options);

      this.code = code;
    }

    static isEscalation(error: unknown): error is Exception {
      return error instanceof Exception && (error.code === Exception.Code.OUT_OF_BOUNDS || error.code === Exception.Code.NOT_ABSOLUTE);
    }

    static isErrnoCode(
      code: unknown,
    ): code is Exclude<Exception.Code, Exception.Code.OUT_OF_BOUNDS | Exception.Code.NOT_ABSOLUTE | Exception.Code.UNKNOWN> {
      return (
        typeof code === "string" &&
        code in Exception.Code &&
        code !== Exception.Code.OUT_OF_BOUNDS &&
        code !== Exception.Code.NOT_ABSOLUTE &&
        code !== Exception.Code.UNKNOWN
      );
    }

    static fromUnknown(error: unknown, message?: string): Exception {
      if (error instanceof Exception) {
        return error;
      }

      const cause = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;

      if (cause && Exception.isErrnoCode(cause.code)) {
        return new Exception(cause.code, message ?? cause.message, { cause });
      }

      return new Exception(Exception.Code.UNKNOWN, message ?? (error instanceof Error ? error.message : String(error)), { cause });
    }
  }

  export namespace Exception {
    export enum Code {
      /** The provided path is not absolute. */
      NOT_ABSOLUTE = "NOT_ABSOLUTE",
      /** The provided path escapes the scoped root. */
      OUT_OF_BOUNDS = "OUT_OF_BOUNDS",
      /** Any error that could not be mapped to a specific code. */
      UNKNOWN = "UNKNOWN",
      ENOENT = "ENOENT",
      EEXIST = "EEXIST",
      EACCES = "EACCES",
      EPERM = "EPERM",
      EISDIR = "EISDIR",
      ENOTDIR = "ENOTDIR",
      ENOTEMPTY = "ENOTEMPTY",
      ELOOP = "ELOOP",
      EMFILE = "EMFILE",
      ENAMETOOLONG = "ENAMETOOLONG",
      EINVAL = "EINVAL",
      EBADF = "EBADF",
      ENOSPC = "ENOSPC",
      EROFS = "EROFS",
    }
  }

  /**
   * Options for {@link FileSystem.access}. Without options only existence is checked.
   */
  export type AccessOptions = {
    /** Additionally check that the path is readable. */
    readable?: boolean;
    /** Additionally check that the path is writable. */
    writable?: boolean;
  };

  /**
   * Options for {@link FileSystem.copy}.
   */
  export type CopyOptions = {
    /** Overwrite existing files (default: `true`). */
    overwrite?: boolean;
    /** Preserve the timestamps of the copied files. */
    preserveTimestamps?: boolean;
  };

  /**
   * Options for {@link FileSystem.glob}.
   */
  export type GlobOptions = {
    /** Directory (within the scoped root) to search in; defaults to the scoped root. */
    root?: string;
    /** Glob patterns to exclude from the results. */
    exclude?: ReadonlyArray<string>;
  };

  /**
   * Options for {@link FileSystem.makeDirectory}.
   */
  export type MakeDirectoryOptions = {
    /** Create missing parent directories (default: `false`). */
    recursive?: boolean;
    /** Permissions to use for newly created directories. */
    mode?: number;
  };

  /**
   * Options for {@link FileSystem.readDirectory}.
   */
  export type ReadDirectoryOptions = {
    /** Also list the contents of subdirectories (default: `false`). */
    recursive?: boolean;
  };

  /**
   * Options for {@link FileSystem.remove}.
   */
  export type RemoveOptions = {
    /** Remove directories and their contents recursively. */
    recursive?: boolean;
    /** Ignore errors if the path does not exist. */
    force?: boolean;
  };

  /**
   * Options for {@link FileSystem.watch}.
   */
  export type WatchOptions = {
    /**
     * When `true`, changes in subdirectories are also reported.
     */
    recursive?: boolean;
  };

  /**
   * A single change reported by {@link FileSystem.watch}.
   */
  export type WatchEvent = {
    /** The kind of change that happened. */
    type: "create" | "update" | "remove";
    /** Path of the changed file or directory, relative to the watched path. */
    path: string;
  };

  /**
   * Flags accepted by {@link FileSystem.writeFile} and {@link FileSystem.writeFileString}.
   */
  export type OpenFlag = "r" | "r+" | "w" | "wx" | "w+" | "wx+" | "a" | "ax" | "a+" | "ax+";

  /**
   * Options for {@link FileSystem.writeFile} and {@link FileSystem.writeFileString}.
   */
  export type WriteFileOptions = {
    /** File system flag used to open the file (default: `"w"`). */
    flag?: OpenFlag;
    /** Permissions to use for a newly created file. */
    mode?: number;
  };

  /**
   * Basic information about a file, as returned by {@link FileSystem.stat}.
   */
  export type Stat = {
    readonly type: "file" | "directory" | "symbolic-link" | "block-device" | "character-device" | "fifo" | "socket" | "unknown";
    readonly mtime?: Date;
    readonly atime?: Date;
    readonly birthtime?: Date;
    readonly dev: bigint;
    readonly ino?: bigint;
    readonly mode: number;
    readonly nlink?: bigint;
    readonly uid?: number;
    readonly gid?: number;
    readonly rdev?: bigint;
    readonly size: number;
    readonly blksize?: number;
    readonly blocks?: bigint;
  };
}
