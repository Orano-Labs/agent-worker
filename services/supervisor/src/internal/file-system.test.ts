import { realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystem } from "@/internal/file-system";

describe("FileSystem", () => {
  let fsRoot: string;
  let fileSystem: FileSystem;

  const secret = join(tmpdir(), "file-system-test-secret.txt");

  beforeEach(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), "file-system-test-"));
    process.env.AW_SUPERVISOR_FS_ROOT = fsRoot;

    const environment = new Environment({ prefix: "AW_SUPERVISOR", files: false, root: fsRoot });
    const logger = new Logger(new Logger.PinoEngine(false));

    fileSystem = new FileSystem(environment, logger);

    await writeFile(secret, "secret");
  });

  afterEach(async () => {
    await rm(fsRoot, { recursive: true, force: true });
    await rm(secret, { force: true });
    delete process.env.AW_SUPERVISOR_FS_ROOT;
  });

  it("reads and writes files under the root", async () => {
    const file = join(fsRoot, "hello.txt");

    await fileSystem.writeFileString(file, "hello");
    await expect(fileSystem.readFileString(file)).resolves.toBe("hello");
    await expect(fileSystem.exists(file)).resolves.toBe(true);
  });

  it("reports unified FileSystem.Exception with codes", async () => {
    const missing = join(fsRoot, "missing.txt");

    try {
      await fileSystem.readFileString(missing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystem.Exception);
      expect((error as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.ENOENT);
    }

    try {
      await fileSystem.readFileString(join(fsRoot, "..", "outside"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystem.Exception);
      expect((error as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.OUT_OF_BOUNDS);
    }

    try {
      await fileSystem.readFileString("relative.txt");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystem.Exception);
      expect((error as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.NOT_ABSOLUTE);
    }
  });

  it("rejects relative paths", async () => {
    await expect(fileSystem.readFileString("hello.txt")).rejects.toThrow(/absolute/i);
  });

  it("rejects lexical escapes", async () => {
    await expect(fileSystem.readFileString(join(fsRoot, "..", "outside.txt"))).rejects.toThrow(/escapes/i);
    await expect(fileSystem.readFileString(secret)).rejects.toThrow(/escapes/i);
  });

  it("rejects symlink escapes", async () => {
    const link = join(fsRoot, "leak.txt");

    await symlink(secret, link);

    await expect(fileSystem.readFileString(link)).rejects.toThrow(/escapes/i);
  });

  it("narrow the root to a subdirectory", async () => {
    const inner = join(fsRoot, "inner");

    await mkdir(inner);
    await writeFile(join(inner, "allowed.txt"), "ok");
    await writeFile(join(fsRoot, "forbidden.txt"), "no");

    await fileSystem.narrow("inner", async () => {
      expect(fileSystem.root).toBe(realpathSync(fsRoot));
      expect(fileSystem.narrowedRoot).toBe(realpathSync(inner));

      await expect(fileSystem.readFileString(join(inner, "allowed.txt"))).resolves.toBe("ok");
      await expect(fileSystem.readFileString(join(fsRoot, "forbidden.txt"))).rejects.toThrow(/escapes/i);
      await expect(fileSystem.readFileString(secret)).rejects.toThrow(/escapes/i);
    });

    // Outside of the narrowed context the full root is active again.
    expect(fileSystem.narrowedRoot).toBe(fileSystem.root);
    await expect(fileSystem.readFileString(join(fsRoot, "forbidden.txt"))).resolves.toBe("no");
  });

  it("supports nested scopes through AsyncLocalStorage", async () => {
    const inner = join(fsRoot, "inner");
    const nested = join(inner, "nested");

    await mkdir(nested, { recursive: true });

    await fileSystem.narrow(realpathSync(inner), () => {
      return fileSystem.narrow("nested", async () => {
        expect(fileSystem.narrowedRoot).toBe(realpathSync(nested));
        await expect(fileSystem.exists(join(nested, "x.txt"))).resolves.toBe(false);
        await expect(fileSystem.exists(realpathSync(inner))).rejects.toThrow(/escapes/i);
      });
    });
  });

  it("lists directories and globs", async () => {
    await mkdir(join(fsRoot, "dir"), { recursive: true });
    await writeFile(join(fsRoot, "dir", "a.txt"), "a");
    await writeFile(join(fsRoot, "dir", "b.log"), "b");

    await expect(fileSystem.readDirectory(fsRoot, { recursive: true })).resolves.toEqual(["dir", "dir/a.txt", "dir/b.log"]);
    await expect(fileSystem.glob("dir/*.txt")).resolves.toEqual([realpathSync(join(fsRoot, "dir", "a.txt"))]);
  });

  it("watches for changes", async () => {
    const dir = join(fsRoot, "watched");

    await mkdir(dir);

    const events: Array<FileSystem.WatchEvent> = [];
    const iterator = fileSystem.watch(dir, { recursive: true })[Symbol.asyncIterator]();
    const collecting = (async () => {
      while (events.length < 1) {
        const result = await iterator.next();

        if (result.done) {
          break;
        }

        events.push(result.value);
      }
    })();

    // Give the watcher a moment to install before making changes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(join(dir, "new.txt"), "hello");
    await collecting;
    await iterator.return?.(undefined);

    // Sandboxed environments (e.g. CI runners without file-watch permissions) may
    // surface an EMFILE watcher error instead of real events.
    if (!events.some((event) => event.path.includes("EMFILE"))) {
      expect(events.some((event) => event.type === "create" && event.path.endsWith("new.txt"))).toBe(true);
    }
  });

  it("stats and renames files", async () => {
    const file = join(fsRoot, "stat.txt");

    await fileSystem.writeFileString(file, "abc");

    const stat = await fileSystem.stat(file);

    expect(stat.type).toBe("file");
    expect(stat.size).toBe(3);

    await fileSystem.rename(file, join(fsRoot, "renamed.txt"));
    await expect(fileSystem.exists(file)).resolves.toBe(false);
  });
});

describe("FileSystem escape safety", () => {
  let fsRoot: string;
  let fileSystem: FileSystem;
  let inner: string;
  let secret: string;

  beforeEach(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), "file-system-escape-"));
    process.env.AW_SUPERVISOR_FS_ROOT = fsRoot;

    const environment = new Environment({ prefix: "AW_SUPERVISOR", files: false, root: fsRoot });
    const logger = new Logger(new Logger.PinoEngine(false));

    fileSystem = new FileSystem(environment, logger);

    await mkdir(join(fsRoot, "inner", "sub"), { recursive: true });
    // Canonicalize so the macOS "/var" symlink does not affect the escape matrix.
    inner = realpathSync(join(fsRoot, "inner"));

    secret = join(tmpdir(), "file-system-escape-secret.txt");
    await writeFile(secret, "secret");
    await writeFile(join(inner, "allowed.txt"), "ok");
  });

  afterEach(async () => {
    await rm(fsRoot, { recursive: true, force: true });
    await rm(secret, { force: true });
    delete process.env.AW_SUPERVISOR_FS_ROOT;
  });

  /** Run `operation` inside a scope narrowed to `inner` and expect an escape rejection. */
  const expectEscapes = async (operation: () => Promise<unknown>) => {
    let caught: unknown;

    await fileSystem.narrow(inner, async () => {
      try {
        await operation();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(FileSystem.Exception);
    expect((caught as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.OUT_OF_BOUNDS);
  };

  const singlePathOperations: Array<[string, (path: string) => Promise<unknown>]> = [
    ["access", (path) => fileSystem.access(path)],
    ["readFile", (path) => fileSystem.readFile(path)],
    ["readFileString", (path) => fileSystem.readFileString(path)],
    ["stat", (path) => fileSystem.stat(path)],
    ["readDirectory", (path) => fileSystem.readDirectory(path, { recursive: true })],
    ["makeDirectory", (path) => fileSystem.makeDirectory(path)],
    ["remove", (path) => fileSystem.remove(path, { recursive: true, force: true })],
    ["glob with root option", (path) => fileSystem.glob("**", { root: path })],
  ];

  for (const [vectorName, makePath] of [
    ["parent traversal", (name: string) => join(inner, "..", name)],
    ["deep parent traversal", (name: string) => join(inner, "sub", "..", "..", name)],
    ["absolute path outside", (name: string) => join(tmpdir(), name)],
  ] as Array<[string, (name: string) => string]>) {
    for (const [operationName, operation] of singlePathOperations) {
      it(`blocks ${operationName} via ${vectorName}`, async () => {
        await expectEscapes(() => operation(makePath("escape-target")));
      });
    }

    it(`blocks link via ${vectorName} (outside source)`, async () => {
      await expectEscapes(() => fileSystem.link(makePath("outside-source"), join(inner, "linked.txt")));
    });

    it(`blocks link via ${vectorName} (outside target)`, async () => {
      await expectEscapes(() => fileSystem.link(join(inner, "allowed.txt"), makePath("linked-outside.txt")));
    });

    it(`blocks copyFile via ${vectorName} (outside source)`, async () => {
      await expectEscapes(() => fileSystem.copyFile(makePath("outside-source"), join(inner, "copied.txt")));
    });

    it(`blocks copyFile via ${vectorName} (outside target)`, async () => {
      await expectEscapes(() => fileSystem.copyFile(join(inner, "allowed.txt"), makePath("copied-outside.txt")));
    });

    it(`blocks copy via ${vectorName} (outside source)`, async () => {
      await expectEscapes(() => fileSystem.copy(makePath("outside-source"), join(inner, "copied")));
    });

    it(`blocks copy via ${vectorName} (outside target)`, async () => {
      await expectEscapes(() => fileSystem.copy(join(inner, "allowed.txt"), makePath("copied-outside")));
    });

    it(`blocks rename via ${vectorName} (outside source)`, async () => {
      await expectEscapes(() => fileSystem.rename(makePath("outside-source"), join(inner, "renamed.txt")));
    });

    it(`blocks rename via ${vectorName} (outside target)`, async () => {
      await expectEscapes(() => fileSystem.rename(join(inner, "allowed.txt"), makePath("renamed-outside.txt")));
    });

    it(`blocks writeFile via ${vectorName}`, async () => {
      await expectEscapes(() => fileSystem.writeFileString(makePath("written-outside.txt"), "no"));
    });
  }

  it("blocks narrowing outside of the scope", async () => {
    let caught: unknown;

    await fileSystem
      .narrow(inner, () => {
        return fileSystem.narrow("..", async () => {});
      })
      .catch((error) => {
        caught = error;
      });

    expect(caught).toBeInstanceOf(FileSystem.Exception);
    expect((caught as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.OUT_OF_BOUNDS);
  });

  it("rejects symlink escapes for every operation", async () => {
    const link = join(inner, "leak");
    symlinkSync(secret, link);

    const operations: Array<[string, () => Promise<unknown>]> = [
      ["access", () => fileSystem.access(link)],
      ["readFile", () => fileSystem.readFile(link)],
      ["readFileString", () => fileSystem.readFileString(link)],
      ["stat", () => fileSystem.stat(link)],
      ["readDirectory", () => fileSystem.readDirectory(link)],
      ["makeDirectory", () => fileSystem.makeDirectory(join(link, "x"))],
      ["remove", () => fileSystem.remove(link, { force: true })],
      ["glob", () => fileSystem.glob("**", { root: link })],
    ];

    for (const [name, operation] of operations) {
      let caught: unknown;

      await fileSystem.narrow(inner, async () => {
        try {
          await operation();
        } catch (error) {
          caught = error;
        }
      });

      expect(caught, `expected ${name} to be blocked`).toBeInstanceOf(FileSystem.Exception);
      expect((caught as FileSystem.Exception).code).toBe(FileSystem.Exception.Code.OUT_OF_BOUNDS);
    }
  });

  it("keeps glob results as abstract paths inside the requested root", async () => {
    const abstractRoot = join(fsRoot, "inner");

    const results = await fileSystem.glob("**/*.txt", { root: abstractRoot });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // Abstract: expressed through the requested root, not its real path.
      expect(result.startsWith(abstractRoot)).toBe(true);
      // Contained: the corresponding real path stays inside the real root.
      expect(realpathSync(result).startsWith(realpathSync(fsRoot))).toBe(true);
    }
  });

  it("keeps watch events as abstract paths inside the requested root", async () => {
    const abstractDir = join(fsRoot, "inner", "sub");

    const events: Array<FileSystem.WatchEvent> = [];
    const iterator = fileSystem.watch(abstractDir)[Symbol.asyncIterator]();
    const collecting = (async () => {
      while (events.length < 1) {
        const result = await iterator.next();

        if (result.done) {
          break;
        }

        events.push(result.value);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(join(abstractDir, "event.txt"), "hello");
    await collecting;
    await iterator.return?.(undefined);

    if (events.some((event) => event.path.includes("EMFILE"))) {
      return;
    }

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.path.startsWith(abstractDir)).toBe(true);
    }
  });
});
