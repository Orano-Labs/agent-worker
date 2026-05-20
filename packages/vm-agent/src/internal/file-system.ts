import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolve as resolvePosixFormat } from "node:path/posix";

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

  normalize(path: string) {
    return resolvePosixFormat("/", path);
  }

  resolve(worktree: FileSystem.Worktree, path: string) {
    if (worktree.type === "main") {
      return resolve(this.#worktree.resolve(worktree.type), this.normalize(path));
    }

    return resolve(this.#worktree.resolve(worktree.type, worktree.id), this.normalize(path));
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
}
