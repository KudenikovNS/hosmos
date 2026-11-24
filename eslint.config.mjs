import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // React Compiler rules newly enabled by eslint-config-next 16 (react-hooks
      // v6). They flag existing, behaviour-correct patterns (derived-state sync
      // in effects, a memo referenced before its declaration). Kept as warnings
      // to unblock the toolchain upgrade; addressed as separate follow-up.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  {
    // Size guardrails (10.09.2026 code-quality pass). Warnings, not errors:
    // the files that still exceed them are listed in docs/plan-2026-09.md
    // партия 12 and shrink with each refactor; new code should not join them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "src/server/db/seed-data/**"],
    rules: {
      "max-lines": [
        "warn",
        { max: 600, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
    },
  },
];

export default config;
