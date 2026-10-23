import { randomBytes } from "node:crypto";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeploymentTable, SupervisorStatusEnum } from "@/internal/database-schema";
import { Projects } from "@/internal/projects";
import { Supervisors } from "@/internal/supervisors";
import { Users } from "@/internal/users";
import { TestingUtils } from "@/utils/testing-utils";

describe("Supervisors", () => {
  let signal: AbortSignal;
  let logger: Logger;
  let database: TestingUtils.MemoryDatabase;
  let users: Users;
  let projects: Projects;
  let supervisors: Supervisors;

  beforeAll(async () => {
    await TestingUtils.MemoryDatabase.warmup();
  }, 120_000);

  beforeEach(async () => {
    signal = new AbortController().signal;
    logger = new Logger();
    database = new TestingUtils.MemoryDatabase(new Environment({ files: false }), logger);
    users = new Users(database, logger);
    projects = new Projects(database, logger);
    supervisors = new Supervisors(database, logger);

    await database.initialize(signal);
  }, 120_000);

  afterEach(async () => {
    await database.dispose();
  });

  afterAll(async () => {
    await TestingUtils.MemoryDatabase.stop();
  }, 120_000);

  it("defaults to active and updates status", async () => {
    const supervisor = await supervisors.create({ publicKey: randomBytes(32) });

    expect(supervisor.status).toBe(SupervisorStatusEnum.active);

    const updated = await supervisors.update(supervisor.id, { status: SupervisorStatusEnum.draining });

    expect(updated?.status).toBe(SupervisorStatusEnum.draining);
  });

  it("rejects deletion while deployments exist", async () => {
    const user = await users.create({ publicKey: randomBytes(32) });
    const supervisor = await supervisors.create({ publicKey: randomBytes(32) });
    const project = await projects.create({ ownerId: user.id, supervisorId: supervisor.id });

    await database.client.insert(DeploymentTable).values({
      projectId: project.id,
      supervisorId: supervisor.id,
      confirmed: true,
    });

    await expect(supervisors.delete(supervisor.id)).rejects.toBeInstanceOf(Supervisors.DeleteConflictError);
    await expect(supervisors.get(supervisor.id)).resolves.not.toBeNull();

    await database.client.delete(DeploymentTable).where(eq(DeploymentTable.supervisorId, supervisor.id));

    await expect(supervisors.delete(supervisor.id)).resolves.toBe(true);
    await expect(supervisors.get(supervisor.id)).resolves.toBeNull();
  });
});
