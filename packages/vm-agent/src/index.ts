import { Container } from "@/helpers/container";
import { CommandLine } from "@/internal/command-line";
import { Database } from "@/internal/database";
import { Environment } from "@/internal/environment";
import { Logger } from "@/internal/logger";
import { Project } from "@/internal/project";
import { Variables } from "@/internal/variables";
import { Worktree } from "@/internal/worktree";

Container.singleton(CommandLine, () => new CommandLine());
Container.singleton(Logger, () => new Logger());
Container.singleton(Environment, () => new Environment());
Container.singleton(Project, () => new Project());
Container.singleton(Worktree, () => new Worktree());
Container.singleton(Variables, () => new Variables());
Container.singleton(Database, () => new Database());

const main = async () => {
  const cli = Container.inject(CommandLine);
  const logger = Container.inject(Logger).scope("Main");
  const environment = Container.inject(Environment);
  const project = Container.inject(Project);
  const worktree = Container.inject(Worktree);
  const variables = Container.inject(Variables);
  const db = Container.inject(Database);

  logger.info("Command line arguments", {
    cwd: cli.cwd,
    logLevel: cli.logLevel,
    logColorize: cli.logColorize,
    envFiles: cli.envFiles,
  });
  logger.info("Initializing...");

  await variables.init();
  // await environment.reset();
  await environment.init();
  await db.init();
  await project.init();
  await worktree.init();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
