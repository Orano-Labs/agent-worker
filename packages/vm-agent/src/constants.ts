import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = homedir();
export const ROOT_DIR = join(HOME_DIR, ".agent-worker");
