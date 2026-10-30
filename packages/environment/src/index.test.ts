import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Environment } from "./index";

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "aw-environment-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("environment security", () => {
  it("keeps injected production mode and secrets ahead of dotenv files", () => {
    const root = createRoot();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AW_REVIEW_SECRET", "injected-value");
    writeFileSync(join(root, ".env"), "NODE_ENV=development\nAW_REVIEW_SECRET=file-value\n");
    writeFileSync(join(root, ".env.production"), "AW_REVIEW_SECRET=mode-file-value\n");

    const environment = new Environment({ root, prefix: "AW_REVIEW" });

    expect(environment.mode).toBe(Environment.Mode.Production);
    expect(environment.get("SECRET", true)).toBe("injected-value");
    expect(environment.messages).toHaveLength(2);
  });

  it("lets the mode file override the base file when no value was injected", () => {
    const root = createRoot();
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("AW_REVIEW_SECRET", undefined);
    writeFileSync(join(root, ".env"), "NODE_ENV=production\nAW_REVIEW_SECRET=base-value\n");
    writeFileSync(join(root, ".env.production"), "AW_REVIEW_SECRET=production-value\n");

    const environment = new Environment({ root, prefix: "AW_REVIEW" });

    expect(environment.mode).toBe(Environment.Mode.Production);
    expect(environment.get("SECRET", true)).toBe("production-value");
  });

  it("honors production mode with file loading disabled", () => {
    const root = createRoot();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AW_REVIEW_SECRET", undefined);
    writeFileSync(join(root, ".env"), "AW_REVIEW_SECRET=file-value\n");

    const environment = new Environment({ root, prefix: "AW_REVIEW", files: false });

    expect(environment.mode).toBe(Environment.Mode.Production);
    expect(environment.get("SECRET")).toBeUndefined();
    expect(environment.messages).toEqual([]);
  });

  it("does not echo invalid configuration values in errors", () => {
    vi.stubEnv("AW_REVIEW_SECRET", "private-value@invalid!");
    const environment = new Environment({ prefix: "AW_REVIEW", files: false });
    const getters = ["getBoolean", "getNumber", "getInteger", "getPort", "getHost", "getUrl", "getEmail"] satisfies (keyof Environment)[];

    for (const getter of getters) {
      expect(() => environment[getter]("SECRET", true)).toThrow(/AW_REVIEW_SECRET/);
      expect(() => environment[getter]("SECRET", true)).not.toThrow(/private-value/);
    }
  });
});
