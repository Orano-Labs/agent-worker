import "dotenv/config";

import { defineConfig } from "prisma/config";

export default defineConfig({
  migrations: {
    path: "./prisma/migrations",
  },
  datasource: {
    url: process.env.AW_DIRECTOR_MYSQL_URL,
    shadowDatabaseUrl: process.env.AW_DIRECTOR_MYSQL_SHADOW_URL,
  },
});
