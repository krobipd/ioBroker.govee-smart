import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "test/standards/*.test.ts"],
    watch: false,
    pool: "forks",
    forks: {
      singleFork: false,
    },
    coverage: {
      // Explicit include so files that no test imports still show up as 0 %
      // — without this the v8 provider silently omits them and the headline
      // number overstates real coverage (found in the v2.16.1 audit: the
      // handler modules were invisible at "81 %" while true src coverage
      // was 66 %).
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        // Test scaffolding, not production code.
        "src/lib/test-helpers.ts",
      ],
      // NOTE: `src/main.ts` used to be excluded here as "covered by
      // test/integration.js". Measured in the 2026-08-22 test audit: it was at
      // 0 % — the integration harness asserts exactly one thing ("the adapter
      // starts") and runs under mocha, so it never reaches this report. The
      // exclusion also overstated the headline number by 7 points (87.4 vs
      // 80.5 %). main.ts is now unit-tested through the factory seams like every
      // other adapter in the fleet; do not re-add it here.
    },
  },
});
