import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "worker-configuration.d.ts"] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
