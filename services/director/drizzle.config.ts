import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  out: "./drizzle/migrations",
  schema: ["./src/internal/database-schema.ts"],
});
