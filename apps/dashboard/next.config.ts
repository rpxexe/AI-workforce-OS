import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// The single env file lives at the repo root; Next.js only reads its own directory.
const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Workspace packages ship TypeScript source, so Next.js must compile them.
  transpilePackages: ["@workforce/shared"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
