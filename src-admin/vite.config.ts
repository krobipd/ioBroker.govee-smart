import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/gui-components/modulefederation.admin.config";
import { readFileSync } from "node:fs";

const config = {
  plugins: [
    federation({
      manifest: true,
      name: "ConfigCustomGoveeSegmentSet",
      filename: "customComponents.js",
      exposes: {
        "./Components": "./src/Components.tsx",
      },
      remotes: {},
      shared: moduleFederationShared(JSON.parse(readFileSync("./package.json").toString())),
      // The admin loads this remote at runtime; nobody consumes it as a typed
      // module. Without this the plugin runs its own `tsc` over the exposed
      // files with `rootDir: src` — and the shared `../../src/lib/err-message`
      // module lies outside it (TS6059), which fails the type step and drops a
      // stray `.d.ts` next to the shared source.
      dts: false,
    }),
    react(),
    commonjs(),
  ],
  // Vite 8 resolves tsconfig paths natively — replaces the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  base: "./",
  build: {
    target: "chrome89",
    outDir: "./build",
  },
};

export default config;
