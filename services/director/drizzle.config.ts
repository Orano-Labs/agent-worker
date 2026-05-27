import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  out: "./drizzle/migrations",
  schema: ["./src/supports/database/schema/tables.ts"],
});
