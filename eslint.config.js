import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".aidocs/temp/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }]
    }
  }
);
