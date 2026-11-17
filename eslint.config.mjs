import js from "@eslint/js";
import tseslint from "typescript-eslint";

// The dashboard lints itself with eslint-config-next (apps/dashboard/eslint.config.mjs).
export default tseslint.config(
  { ignores: ["apps/dashboard/**", "**/node_modules/**", "**/generated/**", "**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
