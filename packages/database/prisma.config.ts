import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma does not load .env on its own; the single env file lives at the repo root.
const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Empty when unset so `prisma generate` (run on install) works without a database.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
