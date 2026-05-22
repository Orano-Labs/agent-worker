import { createReadStream } from "node:fs";
import { copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import type { RPCMethod } from "@aw/rpc";
import { RPCError } from "@aw/rpc";
import type { FSProtocol } from "@/api/protocol/fs";
import { Container } from "@/helpers/container";
import { Worktree } from "@/internal/worktree";

type Implementation = RPCMethod.Collection.HandlersImplementation<typeof FSProtocol.methods>;

export class FSImplementation implements Implementation {
  #worktree: Worktree;

  constructor() {
    this.#worktree = Container.inject(Worktree);
  }

  #root(ctx: FSProtocol.Context) {
    return ctx.branch === "main" ? this.#worktree.resolve("main") : this.#worktree.resolve("session", ctx.id);
  }

  #resolve(ctx: FSProtocol.Context, path: string) {
    return join(this.#root(ctx), path);
  }

  #inside(root: string, target: string) {
    const relation = relative(root, target);

    console.log(relation);

    return Boolean(relation && relation !== ".." && !relation.startsWith(`..${sep}`) && relation !== resolve(target));
  }

  #eq(a: string, b: string) {
    return relative(a, b) === "";
  }

  async #metadata(path: string) {
    return await stat(path)
      .then<FSProtocol.Metadata>((result) => {
        let type: FSProtocol.Metadata["type"];

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
          createTime: result.birthtime,
          updateTime: result.mtime,
          size: result.size,
        };
      })
      .catch(() => {
        return null;
      });
  }

  list: Implementation["list"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const target = this.#resolve(input.context, input.path);

    if (!this.#inside(root, target) && !this.#eq(root, target)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    await this.#metadata(target).then((result) => {
      if (!result) {
        throw RPCError.createNotfound(`Path '${input.path}' does not exist.`);
      }

      if (result.type !== "directory") {
        throw RPCError.createFailedPrecondition(`Path '${input.path}' is not a directory.`);
      }
    });

    const entries = await readdir(target)
      .then((result) => {
        return Promise.all(
          result.map(async (entry) => {
            return {
              name: entry,
              metadata: await this.#metadata(join(target, entry)),
            };
          }),
        );
      })
      .then((result) => {
        return result.filter((entry) => entry.metadata !== null) as FSProtocol.Entry[];
      });

    return {
      entries,
    };
  };

  remove: Implementation["remove"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const target = this.#resolve(input.context, input.path);

    if (!this.#inside(root, target)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    await this.#metadata(target).then((result) => {
      if (!result) {
        throw RPCError.createNotfound(`Path '${input.path}' does not exist.`);
      }

      if (result.type === "unknown") {
        throw RPCError.createNotfound(`Path '${input.path}' does not exist.`);
      }
    });

    await rm(target, { recursive: true, force: true });
  };

  move: Implementation["move"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const source = this.#resolve(input.context, input.source);
    const destination = this.#resolve(input.context, input.destination);

    if (!this.#inside(root, source) || !this.#inside(root, destination)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    if (this.#inside(destination, source)) {
      throw RPCError.createInvalidArgument("Source path cannot be inside the destination path.");
    }

    await this.#metadata(source).then((result) => {
      if (!result) {
        throw RPCError.createNotfound(`Source path '${input.source}' does not exist.`);
      }
    });

    await this.#metadata(destination).then((result) => {
      if (result) {
        throw RPCError.createAlreadyExists(`Destination path '${input.destination}' already exists.`);
      }
    });

    await rename(source, destination);
  };

  copy: Implementation["copy"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const source = this.#resolve(input.context, input.source);
    const destination = this.#resolve(input.context, input.destination);

    if (!this.#inside(root, source) || !this.#inside(root, destination)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    await this.#metadata(source).then((result) => {
      if (!result) {
        throw RPCError.createNotfound(`Source path '${input.source}' does not exist.`);
      }

      if (result.type !== "file") {
        throw RPCError.createFailedPrecondition(`Source path '${input.source}' is not a file.`);
      }
    });

    await this.#metadata(destination).then((result) => {
      if (result) {
        throw RPCError.createAlreadyExists(`Destination path '${input.destination}' already exists.`);
      }
    });

    await copyFile(source, destination);
  };

  metadata: Implementation["metadata"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const target = this.#resolve(input.context, input.path);

    if (!this.#inside(root, target) && !this.#eq(root, target)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    return {
      metadata: await this.#metadata(target),
    };
  };

  read: Implementation["read"] = async (input) => {
    const root = this.#root(input.context);

    await this.#metadata(root).then((result) => {
      if (!result || result.type !== "directory") {
        throw RPCError.createNotfound(`Worktree for branch '${input.context.branch}' not found.`);
      }
    });

    const target = this.#resolve(input.context, input.path);

    if (!this.#inside(root, target) && !this.#eq(root, target)) {
      throw RPCError.createOutOfRange("Path is outside of the worktree.");
    }

    await this.#metadata(target).then((result) => {
      if (!result) {
        throw RPCError.createNotfound(`Path '${input.path}' does not exist.`);
      }

      if (result.type !== "file") {
        throw RPCError.createFailedPrecondition(`Path '${input.path}' is not a file.`);
      }
    });

    return Readable.toWeb(createReadStream(target, { encoding: "utf-8" }));
  };
}
