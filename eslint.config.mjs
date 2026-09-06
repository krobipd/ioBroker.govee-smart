import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        // `tools/` carries its own tsconfig, which projectService discovers on
        // its own — the folder used to be excluded from the linter entirely,
        // although it holds a CI gate that decides whether a release goes out.
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
      // Release-Werkzeug wie bei public-holidays: laeuft unter node, nicht Teil des
      // Adapter-Typprojekts (sonst „not found by the project service").
      "scripts/**",
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
