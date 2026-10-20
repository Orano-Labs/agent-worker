import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment } from "@aw/environment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSystem } from "@/internal/file-system";

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

const writeStream = (path: string, chunks: Uint8Array[]) => {
  return new ReadableStream<FileSystem.Operators.WriteChunk>({
    start(controller) {
      for (const data of chunks) {
        controller.enqueue({ path, data });
      }

      controller.close();
    },
  });
};

describe("FileSystem.Operators.LocalAdapter", () => {
  let root: string;
  let adapter: FileSystem.Operators;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-director-fs-test-"));
    adapter = new FileSystem.Operators.LocalAdapter(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("files", () => {
    it("writes, reads and stats a file", async () => {
      const content = Buffer.from("hello world");
      const entry = await adapter.write("/hello.txt", content);

      expect(entry).toMatchObject({
        name: "hello.txt",
        size: content.length,
        kind: "file",
        fileType: "regular",
        symlink: false,
      });

      expect(Buffer.from(await adapter.read("/hello.txt"))).toEqual(content);

      const result = await adapter.stat("/hello.txt");

      expect(result.entry).toMatchObject({
        name: "hello.txt",
        size: content.length,
        kind: "file",
      });
      expect(result.stats.total).toBeGreaterThan(0);
    });

    it("reads a byte range", async () => {
      await adapter.write("/range.txt", Buffer.from("0123456789"));

      expect(Buffer.from(await adapter.read("/range.txt", { offset: 2, size: 4 }))).toEqual(Buffer.from("2345"));
      expect(Buffer.from(await adapter.read("/range.txt", { offset: 8 }))).toEqual(Buffer.from("89"));
    });

    it("streams a file and respects the offset", async () => {
      await adapter.write("/stream.txt", Buffer.from("0123456789"));

      expect(await collect(await adapter.readStream("/stream.txt"))).toEqual(Buffer.from("0123456789"));
      expect(await collect(await adapter.readStream("/stream.txt", { offset: 4 }))).toEqual(Buffer.from("456789"));
    });

    it("writes a file from a stream", async () => {
      const entry = await adapter.writeStream(writeStream("/streamed.txt", [Buffer.from("hello "), Buffer.from("world")]));

      expect(entry).toMatchObject({
        name: "streamed.txt",
        size: 11,
        kind: "file",
      });

      expect(Buffer.from(await adapter.read("/streamed.txt"))).toEqual(Buffer.from("hello world"));
    });

    it("rejects a write stream that changes path", async () => {
      const stream = new ReadableStream<FileSystem.Operators.WriteChunk>({
        start(controller) {
          controller.enqueue({ path: "/first.txt", data: Buffer.from("first") });
          controller.enqueue({ path: "/second.txt", data: Buffer.from("second") });
          controller.close();
        },
      });

      await expect(adapter.writeStream(stream)).rejects.toThrow("path changed");
    });

    it("renames a file", async () => {
      await adapter.write("/before.txt", Buffer.from("content"));

      const entry = await adapter.rename("/before.txt", "/after.txt");

      expect(entry).toMatchObject({ name: "after.txt", kind: "file" });
      expect(Buffer.from(await adapter.read("/after.txt"))).toEqual(Buffer.from("content"));
      await expect(adapter.read("/before.txt")).rejects.toThrow();
    });

    it("removes a file", async () => {
      await adapter.write("/remove.txt", Buffer.from("content"));

      await adapter.remove("/remove.txt");

      await expect(adapter.stat("/remove.txt")).rejects.toThrow();
    });
  });

  describe("directories", () => {
    it("creates nested directories", async () => {
      const entry = await adapter.createDirectory("/nested/deep", { recursive: true });

      expect(entry).toMatchObject({
        name: "deep",
        kind: "directory",
        state: "unexpanded",
      });
    });

    it("loads directory entries only up to the requested depth", async () => {
      await adapter.createDirectory("/dir/sub", { recursive: true });
      await adapter.write("/dir/sub/file.txt", Buffer.from("content"));

      const shallow = await adapter.readDirectory("/dir");
      const deep = await adapter.readDirectory("/dir", { depth: 1 });

      expect(shallow).toEqual([
        expect.objectContaining({
          name: "sub",
          kind: "directory",
          state: "unexpanded",
        }),
      ]);

      expect(deep).toEqual([
        expect.objectContaining({
          name: "sub",
          kind: "directory",
          state: "expanded",
          entries: [expect.objectContaining({ name: "file.txt", kind: "file" })],
        }),
      ]);
    });

    it("removes a directory recursively", async () => {
      await adapter.createDirectory("/dir/sub", { recursive: true });
      await adapter.write("/dir/sub/file.txt", Buffer.from("content"));

      await adapter.remove("/dir", { recursive: true });

      await expect(adapter.stat("/dir")).rejects.toThrow();
    });

    it("refuses to remove the root directory", async () => {
      await expect(adapter.remove("/")).rejects.toThrow("Cannot remove the file system root");
    });
  });

  describe("copy", () => {
    it("copies a file", async () => {
      await adapter.write("/source.txt", Buffer.from("content"));

      const entry = await adapter.copy("/source.txt", "/target.txt");

      expect(entry).toMatchObject({ name: "target.txt", kind: "file" });
      expect(Buffer.from(await adapter.read("/target.txt"))).toEqual(Buffer.from("content"));
    });

    it("copies a directory recursively", async () => {
      await adapter.createDirectory("/source/sub", { recursive: true });
      await adapter.write("/source/sub/file.txt", Buffer.from("content"));

      await adapter.copy("/source", "/target", { recursive: true });

      expect(Buffer.from(await adapter.read("/target/sub/file.txt"))).toEqual(Buffer.from("content"));
    });

    it("does not overwrite by default", async () => {
      await adapter.write("/source.txt", Buffer.from("source"));
      await adapter.write("/target.txt", Buffer.from("target"));

      await expect(adapter.copy("/source.txt", "/target.txt")).rejects.toThrow();
      expect(Buffer.from(await adapter.read("/target.txt"))).toEqual(Buffer.from("target"));
    });

    it("overwrites when requested", async () => {
      await adapter.write("/source.txt", Buffer.from("source"));
      await adapter.write("/target.txt", Buffer.from("target"));

      await adapter.copy("/source.txt", "/target.txt", { overwrite: true });

      expect(Buffer.from(await adapter.read("/target.txt"))).toEqual(Buffer.from("source"));
    });
  });

  describe("download", () => {
    it("streams a zip archive for a file", async () => {
      await adapter.write("/download.txt", Buffer.from("content"));

      const archive = await collect(await adapter.download("/download.txt"));

      expect(archive.subarray(0, 2).toString()).toBe("PK");
    });

    it("streams a zip archive for a directory", async () => {
      await adapter.createDirectory("/download", { recursive: true });
      await adapter.write("/download/file.txt", Buffer.from("content"));

      const archive = await collect(await adapter.download("/download"));

      expect(archive.subarray(0, 2).toString()).toBe("PK");
    });
  });

  describe("security", () => {
    it("rejects parent directory traversal", async () => {
      await expect(adapter.read("../../etc/passwd")).rejects.toThrow("Path escapes the file system root");
      await expect(adapter.write("/../../outside.txt", Buffer.from("content"))).rejects.toThrow("Path escapes the file system root");
    });

    it("treats absolute paths as root-relative", async () => {
      const external = await mkdtemp(join(tmpdir(), "aw-director-fs-external-"));
      const secret = join(external, "secret.txt");

      try {
        await writeFile(secret, "secret");

        await expect(adapter.read(secret)).rejects.toThrow();
        expect(await readFile(secret, "utf-8")).toBe("secret");
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });

    it("rejects paths containing null bytes", async () => {
      await expect(adapter.read("file\0.txt")).rejects.toThrow("Invalid file system path");
    });

    it("rejects symlinks that escape the root", async () => {
      const external = await mkdtemp(join(tmpdir(), "aw-director-fs-external-"));
      const secret = join(external, "secret.txt");

      try {
        await writeFile(secret, "secret");
        await symlink(secret, join(root, "escape.txt"));

        await expect(adapter.read("/escape.txt")).rejects.toThrow("Path escapes the file system root");
        expect(await readFile(secret, "utf-8")).toBe("secret");
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });

    it("rejects symlinked directories that escape the root", async () => {
      const external = await mkdtemp(join(tmpdir(), "aw-director-fs-external-"));
      const secret = join(external, "secret.txt");

      try {
        await writeFile(secret, "secret");
        await mkdir(join(external, "nested"));
        await symlink(external, join(root, "escape-dir"));

        await expect(adapter.readDirectory("/escape-dir")).rejects.toThrow("Path escapes the file system root");
        await expect(adapter.read("/escape-dir/nested/../secret.txt")).rejects.toThrow("Path escapes the file system root");
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });

    it("does not follow external symlinks when listing a directory", async () => {
      const external = await mkdtemp(join(tmpdir(), "aw-director-fs-external-"));
      const secret = join(external, "secret.txt");

      try {
        await writeFile(secret, "secret");
        await symlink(secret, join(root, "escape.txt"));

        const entries = await adapter.readDirectory("/");

        expect(entries).toContainEqual(
          expect.objectContaining({
            name: "escape.txt",
            symlink: true,
            kind: "file",
            fileType: "unknown",
          }),
        );
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });
});

describe("FileSystem", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-director-fs-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const createFileSystem = () => {
    const environment = { get: (key: string) => (key === "FS_ROOT" ? root : undefined) } as unknown as Environment;

    return new FileSystem(environment);
  };

  it("creates project and template directories", async () => {
    const fileSystem = createFileSystem();

    const projectPath = await fileSystem.createProjectDirectory("project-1");
    const templatePath = await fileSystem.createTemplateDirectory("template-1");

    expect((await stat(projectPath)).isDirectory()).toBe(true);
    expect((await stat(templatePath)).isDirectory()).toBe(true);
  });

  it("creates a project directory from a template", async () => {
    const fileSystem = createFileSystem();
    const templatePath = await fileSystem.createTemplateDirectory("template-1");

    await writeFile(join(templatePath, "index.ts"), "export {};");

    const projectPath = await fileSystem.createProjectDirectoryFromTemplate("project-1", "template-1");

    expect(await readFile(join(projectPath, "index.ts"), "utf8")).toBe("export {};");
  });

  it("uses staging when creating a project directory from a template", async () => {
    const fileSystem = createFileSystem();
    const templatePath = await fileSystem.createTemplateDirectory("template-1");

    await writeFile(join(templatePath, "index.ts"), "export {};");

    await fileSystem.createProjectDirectoryFromTemplate("project-1", "template-1");

    await expect(readdir(join(root, "projects", ".staging"))).resolves.toEqual([]);
  });

  it("does not overwrite an existing project directory", async () => {
    const fileSystem = createFileSystem();
    const templatePath = await fileSystem.createTemplateDirectory("template-1");
    const projectPath = await fileSystem.createProjectDirectory("project-1");

    await writeFile(join(templatePath, "template.ts"), "template");
    await writeFile(join(projectPath, "existing.ts"), "existing");

    await expect(fileSystem.createProjectDirectoryFromTemplate("project-1", "template-1")).rejects.toThrow("already exists");
    await expect(readFile(join(projectPath, "existing.ts"), "utf8")).resolves.toBe("existing");
  });

  it("cleans up staging when copying fails", async () => {
    const fileSystem = createFileSystem();

    await expect(fileSystem.createProjectDirectoryFromTemplate("project-1", "missing-template")).rejects.toThrow();

    await expect(readdir(join(root, "projects", ".staging"))).resolves.toEqual([]);
    await expect(stat(join(root, "projects", "project-1"))).rejects.toThrow();
  });

  it("creates a template directory from another template", async () => {
    const fileSystem = createFileSystem();
    const sourcePath = await fileSystem.createTemplateDirectory("template-1");

    await writeFile(join(sourcePath, "index.ts"), "export {};");

    const targetPath = await fileSystem.createTemplateDirectoryFromTemplate("template-2", "template-1");

    expect(await readFile(join(targetPath, "index.ts"), "utf8")).toBe("export {};");
  });

  it("removes project and template directories", async () => {
    const fileSystem = createFileSystem();
    const projectPath = await fileSystem.createProjectDirectory("project-1");
    const templatePath = await fileSystem.createTemplateDirectory("template-1");

    await fileSystem.removeProjectDirectory("project-1");
    await fileSystem.removeTemplateDirectory("template-1");

    await expect(stat(projectPath)).rejects.toThrow();
    await expect(stat(templatePath)).rejects.toThrow();
  });

  it("rejects unsafe identifiers", async () => {
    const fileSystem = createFileSystem();

    await expect(fileSystem.createProjectDirectory("..")).rejects.toThrow("Invalid file system identifier");
  });

  it("resolves local operators for projects and templates", async () => {
    const fileSystem = createFileSystem();

    const project = await fileSystem.resolveProjectOperators("project-1");
    const template = await fileSystem.resolveTemplateOperators("template-1");

    expect(project).toBeInstanceOf(FileSystem.Operators.LocalAdapter);
    expect(template).toBeInstanceOf(FileSystem.Operators.LocalAdapter);
  });
});
