import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";

import { Container } from "@/helpers/container";
import { Worktree } from "@/internal/worktree";

export class FileSystem {
  #worktree: Worktree;

  constructor() {
    this.#worktree = Container.inject(Worktree);
  }

  async #assertExist(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.metadata(worktree, path);

    if (!metadata) {
      throw new FileSystem.NotExistentError(path);
    }

    return metadata;
  }

  async #assertFile(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.#assertExist(worktree, path);

    if (metadata.type !== "file") {
      throw new FileSystem.NotFileError(path);
    }

    return metadata as FileSystem.Metadata & { type: "file" };
  }

  async #assertDirectory(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.#assertExist(worktree, path);

    if (metadata.type !== "directory") {
      throw new FileSystem.NotDirectoryError(path);
    }

    return metadata as FileSystem.Metadata & { type: "directory" };
  }

  async #assertSymlink(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.#assertExist(worktree, path);

    if (metadata.type !== "symlink") {
      throw new FileSystem.NotSymlinkError(path);
    }

    return metadata as FileSystem.Metadata & { type: "symlink" };
  }

  async #assertEntry(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.#assertExist(worktree, path);

    if (metadata.type === "unknown") {
      throw new FileSystem.NotSupportedEntryTypeError(metadata.type);
    }

    return metadata as FileSystem.Metadata & { type: "file" | "directory" | "symlink" };
  }

  async exists(worktree: FileSystem.Worktree, path: string) {
    return this.metadata(worktree, path).then((result) => {
      return !!result;
    });
  }

  async remove(worktree: FileSystem.Worktree, path: string) {
    await this.#assertExist(worktree, path).then((metadata) => {
      return rm(metadata.realpath, { force: true, recursive: true });
    });
  }

  async move(worktree: FileSystem.Worktree, source: string, destination: string) {
    const sourceMetadata = await this.#assertEntry(worktree, source);
    const destinationMetadata = await this.#assertDirectory(worktree, destination);

    await rename(sourceMetadata.realpath, destinationMetadata.realpath);
  }

  async list(worktree: FileSystem.Worktree, path: string) {
    const metadata = await this.#assertDirectory(worktree, path);

    return await readdir(metadata.realpath)
      .then((result) => {
        return Promise.all(
          result.map(async (entry) => {
            return {
              name: entry,
              metadata: await this.metadata(worktree, join(metadata.realpath, entry)),
            };
          }),
        );
      })
      .then((result) => {
        return result.filter((entry) => entry.metadata !== null) as FileSystem.Entry[];
      });
  }

  async metadata(worktree: FileSystem.Worktree, path: string) {
    const realpath = this.resolve(worktree, path);

    return await stat(realpath)
      .then<FileSystem.Metadata>((result) => {
        let type: FileSystem.Metadata["type"];

        if (result.isFile()) {
          type = "file";
        } else if (result.isDirectory()) {
          type = "directory";
        } else if (result.isSymbolicLink()) {
          type = "symlink";
        } else {
          type = "unknown";
        }

        return {
          type,
          realpath,
          createTime: result.birthtime,
          updateTime: result.mtime,
          size: result.size,
        };
      })
      .catch(() => {
        return null;
      });
  }

  async copy(worktree: FileSystem.Worktree, source: string, destination: string) {}

  #inside(root: string, target: string) {
    const relation = relative(root, target);

    return Boolean(relation && relation !== ".." && !relation.startsWith(`..${sep}`) && relation !== resolve(target));
  }

  resolve(worktree: FileSystem.Worktree, path: string) {
    const root = worktree.type === "main" ? this.#worktree.resolve(worktree.type) : this.#worktree.resolve(worktree.type, worktree.id);
    const target = join(root, path);

    if (!this.#inside(root, target)) {
      throw new FileSystem.InvalidPath(path, "Access denied, path is outside the worktree root");
    }

    return target;
  }
}

export namespace FileSystem {
  export type Metadata = {
    realpath: string;
    type: "file" | "directory" | "symlink" | "unknown";
    createTime: Date;
    updateTime: Date;
    size: number;
  };

  export type Entry = {
    name: string;
    metadata: Metadata;
  };

  export type Worktree =
    | {
        type: "main";
      }
    | {
        type: "session";
        id: string;
      };

  export class NotExistentError extends Error {
    constructor(path: string) {
      super(`Path ${path} does not exist`);
    }
  }

  export class NotFileError extends Error {
    constructor(path: string) {
      super(`Path ${path} is not a file`);
    }
  }

  export class NotDirectoryError extends Error {
    constructor(path: string) {
      super(`Path ${path} is not a directory`);
    }
  }

  export class NotSymlinkError extends Error {
    constructor(path: string) {
      super(`Path ${path} is not a symlink`);
    }
  }

  export class NotSupportedEntryTypeError extends Error {
    constructor(type: string) {
      super(`Entry type ${type} is not supported`);
    }
  }

  export class InvalidPath extends Error {
    constructor(path: string, message?: string) {
      super(`Path ${path} is invalid${message ? `: ${message}` : ""}`);
    }
  }
}
