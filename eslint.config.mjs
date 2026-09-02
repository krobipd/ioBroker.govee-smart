import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "vitest.config.mts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // Handler-modules + device-manager sub-files use a free-fn pattern with
    // adapter-context interfaces. Most parameters are obvious from name/type
    // (`adapter`, `device`, `caps`); enforcing a JSDoc @param/@return on
    // every helper produces noise without informational value.
    files: ["src/lib/handlers/**/*.ts", "src/lib/device-manager/**/*.ts"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns": "off",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      "test/**",
      "tools/**",
      "*.config.mjs",
      "vitest.config.mts",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      // Custom admin React component — its own toolchain (src-admin/eslint.config.mjs).
      "src-admin",
      // Root build script for the src-admin Module-Federation component (CommonJS).
      "tasks.js",
      "node_modules",
      // Catches macOS-Finder duplicate-on-restore artifacts like "node_modules 2/" —
      // without this, eslint scans every .ts file in the copy and the type-aware
      // rules run out of memory.
      "node_modules*/",
      "**/adapter-config.d.ts",
    ],
  },
];
