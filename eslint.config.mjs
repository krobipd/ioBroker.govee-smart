import config from "@iobroker/eslint-config";

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ["*.mjs"] },
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
        ignores: [
            ".dev-server/",
            ".vscode/",
            "*.test.js",
            "test/**",
            "*.config.mjs",
            "build",
            "admin",
            "node_modules",
            "**/adapter-config.d.ts",
        ],
    },
];
