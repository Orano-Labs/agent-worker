import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./drizzle/migrations",
  schema: ["./src/supports/database/schema/tables.ts"],
});
