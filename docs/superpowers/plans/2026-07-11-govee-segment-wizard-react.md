# Segment-Wizard React Admin Component — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the jsonConfig `sendTo`-button segment-detection wizard with a custom React admin component that renders a live, correctable visual segment map, driven by the existing tested wizard backend.

**Architecture:** New `src-admin/` Vite + Module-Federation project (public-holidays pattern) builds `admin/custom/customComponents.js`. The govee "Segment-Erkennung" jsonConfig tab becomes a single `type:"custom"` field. The React component talks to the **existing** onMessage handlers (`getSegmentDevices`, `segmentWizard`) via `socket.sendTo`. Backend changes are small and additive: the wizard response carries a grid snapshot, and a new `apply` action applies the review-corrected map.

**Tech Stack:** TypeScript, React 18, `@iobroker/adapter-react-v5`, `@iobroker/json-config`, `@module-federation/vite`, Vite, MUI, vitest + jsdom + @testing-library/react (frontend tests), existing vitest backend suite.

## Global Constraints

- **Reference adapter (copy patterns verbatim, adjust names only):** `iobroker.public-holidays` — `src-admin/` (`package.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.mjs`, `index.html`, `src/{index.tsx,App.tsx,Components.tsx}`), root `tasks.js`, `.gitignore` lines 33-37, `package.json` scripts `build:admin`/`prepublishOnly: node tasks`, `files: ["admin"]`. NEVER invent Vite/MF config — adapt the real file. [feedback_govee_pattern_first, feedback_version_specific_source_verification]
- **Bundled dependency versions = public-holidays' exact versions** (read `iobroker.public-holidays/src-admin/package.json` and match, do not use `latest`/`main`).
- **`admin/custom/` is gitignored**, built by `node tasks` at `build:admin`/`prepublishOnly`, published via `files: ["admin"]`.
- **Node ≥ 22**, TypeScript `~6.0.x`, lint 0 errors AND 0 warnings (HARDCORE).
- **Existing onMessage commands are the contract:** `getSegmentDevices` → device list; `segmentWizard {action, device}` with actions `start|yes|no|done|abort` (add `apply`). Routed in `src/lib/message-router.ts:108-114` → `runWizardStep(action, device)`.
- **Version:** v2.21.0 (Minor). Do NOT bump version in these tasks — the release script does it.
- Frequent commits (one per task minimum). `npm run lint` before every commit.

---

## File Structure

**Backend (existing files, modified):**
- `src/lib/segment-wizard.ts` — add `apply(indices)`; make `runStep` fold the session snapshot into every `WizardResponse`; export the response/snapshot types.
- `src/lib/handlers/wizard-handler.ts` — route `apply` (reuses `applyWizardResult`).
- `src/lib/message-router.ts` — pass `indices` through for `segmentWizard`.
- `src/lib/state-manager.ts` (or the info-state owner) — drop `info.wizardStatus`; add one-shot `delObject` cleanup.
- `admin/jsonConfig.json` — replace the "Segment-Erkennung" tab body with one `type:"custom"` field.

**Frontend (new `src-admin/`):**
- `src-admin/package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `eslint.config.mjs`, `index.html` — scaffolding (adapt from public-holidays).
- `src-admin/src/index.tsx` — entry (adapt).
- `src-admin/src/Components.tsx` — Module-Federation export (adapt).
- `src-admin/src/App.tsx` — `GenericApp` wrapper, passes `socket`+`namespace`.
- `src-admin/src/useWizardApi.ts` — `sendTo` wrapper (pure, testable).
- `src-admin/src/SegmentGrid.tsx` — pure visual grid (props only).
- `src-admin/src/SegmentWizard.tsx` — 3-screen state machine.
- `src-admin/src/*.test.tsx` — vitest + jsdom tests.

**Root wiring:**
- `tasks.js` (adapt from public-holidays), `package.json` (`build:admin`, `prepublishOnly`, `files`), `.gitignore`, `.github/workflows/test-and-release.yml` (src-admin build step).

---

## Task 1: Backend — session snapshot in every response + `apply` action

> ✅ **DONE** (commit below). Real method names differed from the drafted snippets: the "done" handler is `finish()` (private); session fields are `current`/`visible`/`total` (mapped `current→currentIndex`, `visible→confirmed`); `compactIndices` already exists. `apply` reuses a shared `finalize()` extracted from `finish`. 8 new tests (snapshot fold, idle snapshot, apply happy/contiguous/finalize-releases-lock, no-session + empty-map guards, router indices-forward). 1210 unit ✓, tsc ✓, lint 0/0.

**Files:**
- Modify: `src/lib/segment-wizard.ts`
- Modify: `src/lib/handlers/wizard-handler.ts`
- Modify: `src/lib/message-router.ts:108-120`
- Test: `src/lib/segment-wizard.test.ts`

**Interfaces:**
- Produces: `WizardSnapshot = { phase: "idle"|"measuring"|"review"; total: number; currentIndex: number; confirmed: number[] }`. Every `WizardResponse` returned by `runStep` spreads a `snapshot: WizardSnapshot`; the `done` response additionally has `segmentCount: number; hasGaps: boolean; manualList: string; gaps: number[]`.
- Produces: action `"apply"` → `runStep("apply", deviceKey, { indices })` builds `segmentCount`/`hasGaps`/`manualList` from `indices` and routes through the existing `applyWizardResult`, returning `{ applied: true, snapshot }`.
- Consumes: existing `SegmentWizard.getSessionSnapshot()` (already returns session state — read it and shape it into `WizardSnapshot`).

- [ ] **Step 1: Read the current `getSessionSnapshot()` + `runStep`/`answer`/`done` return shapes**

Run: `grep -n "getSessionSnapshot\|runStep\|private async answer\|private async done\|private async finish" src/lib/segment-wizard.ts`
Read those methods so the snapshot shaping and the `apply` branch reuse the real session fields (confirmed indices, current index, total). Note the exact field names.

- [ ] **Step 2: Write the failing test for the snapshot in the response**

```ts
// src/lib/segment-wizard.test.ts — add to the existing suite
it("runStep folds a grid snapshot into every response", async () => {
  const wiz = new SegmentWizard(makeTestHost()); // reuse the suite's host factory
  await wiz.runStep("start", TEST_DEVICE_KEY);
  const res = await wiz.runStep("yes", TEST_DEVICE_KEY);
  expect(res.snapshot).toMatchObject({ phase: "measuring", confirmed: [0] });
  expect(typeof (res.snapshot as { currentIndex: number }).currentIndex).toBe("number");
});
```

- [ ] **Step 3: Run it — expect FAIL** (`res.snapshot` is undefined)

Run: `npx vitest run src/lib/segment-wizard.test.ts -t "grid snapshot"`
Expected: FAIL.

- [ ] **Step 4: Implement — shape `WizardSnapshot` from `getSessionSnapshot()` and spread it in `runStep`**

In `segment-wizard.ts`: add the `WizardSnapshot` type; add a private `snapshot(): WizardSnapshot` mapping the session (confirmed indices, current index, total, phase). In `runStep`, after routing to start/yes/no/done/abort, spread `{ ...response, snapshot: this.snapshot() }` before returning. (Keep existing fields intact.)

- [ ] **Step 5: Run — expect PASS.** Run: `npx vitest run src/lib/segment-wizard.test.ts -t "grid snapshot"` → PASS.

- [ ] **Step 6: Write the failing test for `apply`**

```ts
it("apply(indices) routes the corrected map through applyWizardResult", async () => {
  const applied: WizardResult[] = [];
  const host = makeTestHost({ applyWizardResult: async (_d, r) => void applied.push(r) });
  const wiz = new SegmentWizard(host);
  await wiz.runStep("start", TEST_DEVICE_KEY);
  const res = await wiz.runStep("apply", TEST_DEVICE_KEY, { indices: [0, 1, 2, 4] }); // gap at 3
  expect(res.applied).toBe(true);
  expect(applied[0]).toMatchObject({ segmentCount: 5, hasGaps: true, manualList: "0-2,4" });
});
```

- [ ] **Step 7: Run — expect FAIL.**

- [ ] **Step 8: Implement `apply`**

In `segment-wizard.ts` add `private async apply(indices: number[]): Promise<WizardResponse>`: guard session active + device present (same guards as `done`); compute `segmentCount = Math.max(...indices)+1`, `hasGaps = indices.length < segmentCount`, `manualList = compressIndices(indices)` (reuse/add a small helper that renders `[0,1,2,4] → "0-2,4"`); call `this.host.applyWizardResult(device, { segmentCount, hasGaps, manualList })`; return `{ applied: true }`. Add `case "apply": return this.apply(payload.indices ?? [])` to `runStep`'s switch. Thread `payload` (the 3rd arg) through `runStep`.

- [ ] **Step 9: Route `apply` payload through the handler + message-router**

`wizard-handler.ts:runWizardStep` — add an optional `payload?: { indices?: number[] }` param, forward to `segmentWizard.runStep(action, deviceKey, payload)`. `message-router.ts:112` — pass `{ indices: payload.indices }` to `runWizardStep`.

- [ ] **Step 10: Run the full wizard suite — expect PASS.** Run: `npx vitest run src/lib/segment-wizard.test.ts` → all PASS.

- [ ] **Step 11: Lint + commit**

```bash
npm run lint && npm run check
git add src/lib/segment-wizard.ts src/lib/segment-wizard.test.ts src/lib/handlers/wizard-handler.ts src/lib/message-router.ts
git commit -m "feat(wizard): grid snapshot in responses + apply action for corrected map"
```

---

## Task 2: Scaffold `src-admin/` — empty custom component builds + renders

> ✅ **DONE** (commit below). Verified against the real public-holidays scaffold — several drafted details were corrected:
> - **Federation name** kept as the plan's `ConfigCustomGoveeSegmentSet` (a valid convention; PH uses `<Name>ComponentSet` — either works as long as it's byte-identical in vite.config `name` + jsonConfig `name` + manifest). jsonConfig field: `name: "ConfigCustomGoveeSegmentSet/Components/SegmentWizardConfig"` + **`bundlerType: "module"`** (both were missing/wrong in the draft — verified from PH's live jsonConfig).
> - **Added `SegmentWizardConfig.tsx`** (not in the plan's file list): the MF-exposed component MUST extend `ConfigGeneric` (mirrors PH `ExcludeSelector`) — jsonConfig `type:custom` instantiates it and drives `renderItem`. It hosts the plain `<SegmentWizard>` (Task 5), wired to `oContext.socket` + `adapterName.instance`. `Components.tsx` exposes `{ SegmentWizardConfig }`.
> - **`@iobroker/build-tools` (^3.0.1) added at ROOT** (not just src-admin) — `node tasks` runs at repo root and `require`s it from root node_modules (PH declares it at root too). Root eslint now ignores `src-admin` + `tasks.js`; root tsconfig/vitest already scope to `src/**` so they don't pick up src-admin.
> - **Test target = the shell `SegmentWizard` component**, not `<App>` — the full `GenericApp` App can't boot in jsdom (renders a Loader until socket-connected). The shell test proves the jsdom/testing-library toolchain (vitest 4 + jsdom + @testing-library, own `src-admin/vitest.config.ts`); the real scaffold verification is the artifact + `npm pack`.
> - `tsconfig.node.json` copied **verbatim** (phantom `vite-importmap-shim.ts` include and all — harmless glob, matches PH; not "corrected").
>
> **Verified:** `node tasks` builds `admin/custom/customComponents.js` (mf-manifest `name=ConfigCustomGoveeSegmentSet`, exposes `./Components`, 29 assets, i18n); `npm pack --dry-run` packs customComponents.js + mf-manifest.json + 29 assets + i18n; src-admin shell test 1/1 + lint 0/0; root tsc + lint + 1210 tests still green.

**Files (all adapted verbatim from `iobroker.public-holidays`, names changed):**
- Create: `src-admin/package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `eslint.config.mjs`, `index.html`
- Create: `src-admin/src/index.tsx`, `src-admin/src/Components.tsx`, `src-admin/src/App.tsx` (shell)
- Create: `tasks.js` (root)
- Modify: `package.json` (add `build:admin`, `prepublishOnly`, extend `files`), `.gitignore`
- Modify: `admin/jsonConfig.json` (Segment-Erkennung tab → `type:"custom"`)
- Test: `src-admin/src/App.test.tsx`

**Interfaces:**
- Produces: a Module-Federation remote exposing the component set under the name used in `Components.tsx` (match public-holidays' `ConfigCustomXxxSet` naming → `ConfigCustomGoveeSegmentSet`), referenced by jsonConfig `url: "custom/customComponents.js"`, `name: "ConfigCustomGoveeSegmentSet/Components"`.
- Produces: `App` mounts a `GenericApp` and renders `<SegmentWizard socket={this.socket} namespace={...} />` (SegmentWizard is a shell in this task).

- [ ] **Step 1: Copy the scaffolding from public-holidays**

```bash
cp iobroker.public-holidays/src-admin/vite.config.ts iobroker.govee-smart/src-admin/vite.config.ts
cp iobroker.public-holidays/src-admin/tsconfig.json iobroker.govee-smart/src-admin/tsconfig.json
cp iobroker.public-holidays/src-admin/tsconfig.node.json iobroker.govee-smart/src-admin/tsconfig.node.json
cp iobroker.public-holidays/src-admin/eslint.config.mjs iobroker.govee-smart/src-admin/eslint.config.mjs
cp iobroker.public-holidays/src-admin/index.html iobroker.govee-smart/src-admin/index.html
cp iobroker.public-holidays/tasks.js iobroker.govee-smart/tasks.js
```
Then edit each: replace the public-holidays exposed component name (`ConfigCustom<PublicHolidays>Set`) with `ConfigCustomGoveeSegmentSet`, and any `publicHolidays`/adapter-name string with `govee-smart`. Read each copied file and grep for the old adapter name; change every occurrence.

- [ ] **Step 2: Create `src-admin/package.json`** — copy public-holidays' `src-admin/package.json`, keep the same devDeps (exact versions), drop the `date-holidays` runtime dep (govee needs none), keep `scripts: { start, lint, build: "tsc && vite build" }`. Run `cd src-admin && npm install`.

- [ ] **Step 3: Create the shell React files**

`src-admin/src/index.tsx` + `src-admin/src/Components.tsx` — copy public-holidays' verbatim, rename the exposed set to `ConfigCustomGoveeSegmentSet`. `src-admin/src/App.tsx` — copy the public-holidays `GenericApp` structure but render a placeholder `<div>Segment wizard</div>` (real component in later tasks).

- [ ] **Step 4: Write the failing shell render test**

```tsx
// src-admin/src/App.test.tsx
import { render, screen } from "@testing-library/react";
import App from "./App";
it("renders the wizard shell", () => {
  render(<App socket={{} as never} adapterName="govee-smart" instance={0} />);
  expect(screen.getByText(/segment/i)).toBeInTheDocument();
});
```
(Add `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` to `src-admin` devDeps; configure `vitest.config.ts` in src-admin with `environment: "jsdom"`.)

- [ ] **Step 5: Run it — expect it to pass once the shell renders.** Run: `cd src-admin && npx vitest run src/App.test.tsx`. Iterate on the shell until PASS.

- [ ] **Step 6: Wire the build** — root `package.json`: add `"build:admin": "node tasks"`, `"prepublishOnly": "node tasks"`, extend `"files"` with `admin/custom/**` if not covered by `admin`. `.gitignore`: add the 4 lines (`/admin/custom`, `/src-admin/build`, `/src-admin/node_modules`, `/src-admin/package-lock.json`). Run `npm run build:admin` from the adapter root.
Expected: `admin/custom/customComponents.js` exists.

- [ ] **Step 7: Wire jsonConfig** — in `admin/jsonConfig.json`, replace the "Segment-Erkennung" tab's body (the `_wizard` panel's `sendTo`/`staticText` items) with a single item:
```json
{ "type": "custom", "i18n": true, "url": "custom/customComponents.js", "name": "ConfigCustomGoveeSegmentSet/Components", "_id": "_segmentWizard" }
```
Keep the tab header. Validate JSON: `python3 -c "import json; json.load(open('admin/jsonConfig.json'))"`.

- [ ] **Step 8: Verify + commit**

```bash
npm run build:admin && test -f admin/custom/customComponents.js && echo OK
cd src-admin && npm run lint && cd ..
git add src-admin tasks.js package.json .gitignore admin/jsonConfig.json
git commit -m "feat(admin): scaffold src-admin custom component + wire segment wizard tab"
```

---

## Task 3: `useWizardApi` — typed sendTo wrapper

> ✅ **DONE** (commit below). `makeWizardApi(socket, namespace)` → `{ listDevices, start, yes, no, done, abort, apply }`. Verified the real signature `socket.sendTo(instance, command, data)` against the **bundled** `@iobroker/socket-client` 5.0.2 (adapter-react-v5 7.7.5) + live json-config usage — the plan's assumption held. `start(device)` records the device for the follow-up steps; `apply(device, indices)` sends the corrected map. `WizardSocket` is a narrow injectable seam (just `sendTo`) so the factory is pure/testable. Frontend `WizardSnapshot`/`WizardResponse`/`DeviceOption` types re-declared locally (src-admin can't import from `../src`) with a comment pinning them to the backend contract. 6 tests (yes-payload, start-remembers-device, done/abort, apply, listDevices happy + non-array→[]). src-admin 7/7 tests, lint 0/0.

**Files:** Create `src-admin/src/useWizardApi.ts`; Test `src-admin/src/useWizardApi.test.ts`

**Interfaces:**
- Produces: `makeWizardApi(socket, namespace)` → `{ listDevices(): Promise<{label:string;value:string}[]>, start(device), yes(), no(), done(), abort(), apply(device, indices) }`. Each wizard call resolves the `WizardResponse` (incl. `snapshot`). Internally calls `socket.sendTo(namespace, "segmentWizard", {action, device, indices?})` and `socket.sendTo(namespace, "getSegmentDevices", {})`.

- [ ] **Step 1: Failing test with a socket mock**

```ts
import { makeWizardApi } from "./useWizardApi";
it("yes() sends the segmentWizard action", async () => {
  const calls: any[] = [];
  const socket = { sendTo: (ns:string, cmd:string, data:any) => (calls.push({ns,cmd,data}), Promise.resolve({ snapshot:{phase:"measuring",confirmed:[0],currentIndex:1,total:5} })) };
  const api = makeWizardApi(socket as never, "govee-smart.0");
  const res = await api.yes();
  expect(calls[0]).toEqual({ ns:"govee-smart.0", cmd:"segmentWizard", data:{ action:"yes", device:"" } });
  expect(res.snapshot.confirmed).toEqual([0]);
});
```

- [ ] **Step 2: Run — FAIL.** `cd src-admin && npx vitest run src/useWizardApi.test.ts`.

- [ ] **Step 3: Implement `useWizardApi.ts`** — a factory holding the current `device`, each method a thin `socket.sendTo` returning the response. `apply(device, indices)` sends `{action:"apply", device, indices}`.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Lint + commit**
```bash
cd src-admin && npm run lint && cd ..
git add src-admin/src/useWizardApi.ts src-admin/src/useWizardApi.test.ts
git commit -m "feat(admin): useWizardApi sendTo wrapper"
```

---

## Task 4: `SegmentGrid` — pure visual map

> ✅ **DONE** (commit below). Pure props-only grid: `<SegmentGrid total confirmed flashing gaps editable onToggle? />`. Each cell `data-testid="seg-cell-{i}"` + `className="seg-cell {state}"`; state precedence **flashing → confirmed → gap → open**; theme-aware MUI `sx` colors; clicks fire `onToggle(idx)` only when `editable`. No socket/network knowledge. 6 tests (states, gap, flashing-wins, toggle, no-toggle-when-readonly, total=0). **Plan-test fix:** the drafted `getAllByTestId("seg-cell")` (exact) can't coexist with per-cell `seg-cell-{i}` testids — used a `/^seg-cell-\d+$/` regex matcher for the count. **Test-infra fix (Task 2 gap surfaced here):** `setupTests.ts` now runs `afterEach(cleanup)` — with `globals:false`, testing-library's auto-cleanup never registered, so multi-render suites piled up duplicate testids. src-admin 13/13 tests, lint 0/0.

**Files:** Create `src-admin/src/SegmentGrid.tsx`; Test `src-admin/src/SegmentGrid.test.tsx`

**Interfaces:**
- Produces: `<SegmentGrid total={number} confirmed={number[]} flashing={number|null} gaps={number[]} editable={boolean} onToggle?={(idx:number)=>void} />`. Renders `total` cells; each cell class = `confirmed`|`flashing`|`gap`|`open`. When `editable`, clicking a cell calls `onToggle(idx)`.

- [ ] **Step 1: Failing test — cell states**

```tsx
render(<SegmentGrid total={5} confirmed={[0,1]} flashing={2} gaps={[]} editable={false} />);
expect(screen.getAllByTestId("seg-cell")).toHaveLength(5);
expect(screen.getByTestId("seg-cell-2")).toHaveClass("flashing");
```

- [ ] **Step 2: Failing test — review toggle**

```tsx
const onToggle = vi.fn();
render(<SegmentGrid total={3} confirmed={[0]} flashing={null} gaps={[1]} editable onToggle={onToggle} />);
fireEvent.click(screen.getByTestId("seg-cell-1"));
expect(onToggle).toHaveBeenCalledWith(1);
```

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement `SegmentGrid.tsx`** — map `Array.from({length: total})`, per-cell `data-testid={`seg-cell-${i}`}`, class from the sets, `onClick={editable ? () => onToggle?.(i) : undefined}`. Style with MUI `Box`/`sx` (flex-wrap grid). No socket/network knowledge.

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Lint + commit**
```bash
cd src-admin && npm run lint && cd ..
git add src-admin/src/SegmentGrid.tsx src-admin/src/SegmentGrid.test.tsx
git commit -m "feat(admin): SegmentGrid visual map component"
```

---

## Task 5: `SegmentWizard` — 3-screen state machine

> ✅ **DONE** (commit below). Screens `select → measure → review → success`. **Applies the Task-1 flow resolution, NOT the plan's stale "done→review":** "Finished" moves to review **locally** from the last snapshot (session stays open); Übernehmen → `api.apply(device, confirmed)` finalizes. Test asserts `api.done` is **never** called.
> - **Uniform response reducer** (advisor): every `api.*` result funnels through `reduce()` — `error → reset+banner`, `aborted → select`, `applied||done → success`, else → snapshot update. This handles the backend **auto-finalize at `SEGMENT_HARD_MAX`** (a `yes`/`no` can come back `{done:true}` with the session already applied+closed → success screen, no editable review) and device-gone/idle-timeout errors, not just the happy path.
> - Measure grid `total=currentIndex+1` (fills as you go), `flashing=currentIndex`, gaps derived. Review grid `total=currentIndex`, editable, local `confirmed` edits. First device auto-selected; "Finished" gated on `currentIndex≥1`; "Übernehmen" disabled on empty set (backend also guards it).
> - **i18n:** `I18n.t` verified at source — uses `%s` args (not `{}`) and `loadI18n` falls back to `en.json` for missing langs (loads en content into the active lang → readable). So en + de shipped now; **the other 9 langs are pending (Task 6)** and render English until then. 19 src-admin tests (7 wizard: happy/never-done, review-toggle, HARD_MAX→success, abort→select, error→reset, finish-disabled, no-devices), lint 0/0, MF build green (SegmentWizard chunk 235 B shell → 5.83 kB real).

**Files:** Create `src-admin/src/SegmentWizard.tsx`; Test `src-admin/src/SegmentWizard.test.tsx`; Modify `src-admin/src/App.tsx` (render the real component)

**Interfaces:**
- Consumes: `makeWizardApi` (Task 3), `SegmentGrid` (Task 4).
- Produces: `<SegmentWizard socket namespace />`. Internal state `screen: "select"|"measure"|"review"`; on mount loads devices; `select`→`start`→`measure`; yes/no update from `snapshot`; done→`review` (loads full map + result text); review toggles edit `confirmed` locally; Übernehmen→`apply(device, confirmed)`→success screen; abort/re-measure reset.

- [ ] **Step 1: Failing test — happy path** (mock `makeWizardApi` via `vi.mock("./useWizardApi")`)

```tsx
// select device → start → yes → done → review shows result → apply calls api.apply
```
Write the test asserting: after selecting a device and starting, `SegmentGrid` shows; clicking "Leuchtet" calls `api.yes`; "Fertig" moves to review; "Übernehmen" calls `api.apply` with the confirmed indices.

- [ ] **Step 2: Failing test — abort path** resets to `select`.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement `SegmentWizard.tsx`** — `useState` for screen/device/snapshot/confirmed/error; `useEffect` loads devices; buttons wired to `api.*`; render `SegmentGrid` with the snapshot; review screen uses `editable` grid + local `confirmed` edits; i18n via `@iobroker/adapter-react-v5` `I18n.t` (labels: wizardStart/yes/no/done/abort/apply/remeasure — reuse existing `admin/i18n` keys where present, add the few new ones).

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Wire into App** — `App.tsx` renders `<SegmentWizard socket={this.socket} namespace={`${this.adapterName}.${this.instance}`} />`. Update `App.test.tsx` if the shell text changed.

- [ ] **Step 7: Build the real component** — `npm run build:admin` from root; confirm `admin/custom/customComponents.js` rebuilds.

- [ ] **Step 8: Lint + commit**
```bash
cd src-admin && npm run lint && cd .. && npm run build:admin
git add src-admin/src/SegmentWizard.tsx src-admin/src/SegmentWizard.test.tsx src-admin/src/App.tsx src-admin/src/App.test.tsx
git commit -m "feat(admin): SegmentWizard 3-screen state machine"
```

---

## Task 6: Remove `info.wizardStatus` + old UI remnants

**Files:** Modify `src/lib/handlers/wizard-handler.ts` (drop the `setState("info.wizardStatus", …)` mirror), the info-state owner (drop the state definition), add one-shot `delObject` cleanup; `admin/i18n/*.json` (drop dead `wizardStatus`/old-button keys, add new component keys); verify `admin/jsonConfig.json` has no leftover `_wizard` sendTo items.

> **⚠️ Carry-over from Task 5 — complete the component i18n here:** `src-admin/src/i18n/` currently has **en + de only** (18 `gsw_*` keys). The other **9 languages (es, fr, it, nl, pl, pt, ru, uk, zh-cn) are pending** — add `src-admin/src/i18n/<lang>.json` for each so non-en/de admins get their own language instead of the English fallback. This is the component's OWN i18n (copied to `admin/custom/i18n/` by `tasks.js`), separate from the adapter's `admin/i18n/`. The dead adapter keys to drop here are the old jsonConfig wizard keys: `wizardHeader/wizardInfo/wizardDeviceLabel/wizardBtnStart/wizardStatusLabel/wizardBtnYes/wizardBtnNo/wizardBtnDone/wizardBtnAbort/wizardHelp/tabWizard` — confirm none are still referenced after the jsonConfig `_wizard` panel became a single `type:custom` field. Rebuild the MF component (`npm run build:admin`) after adding langs.

**Interfaces:** Consumes nothing new. Produces: no `info.wizardStatus` object; existing installs get it removed once on start.

- [ ] **Step 1: Grep for all `wizardStatus` references** — `grep -rn "wizardStatus" src/ admin/`. List them.

- [ ] **Step 2: Failing test — cleanup fires once**

```ts
// state-manager (or wherever info-states are created) test:
it("removes the legacy info.wizardStatus object once", async () => {
  // arrange an existing info.wizardStatus object in the mock; run the one-shot cleanup;
  // assert delObjectAsync("info.wizardStatus") was called.
});
```
(Follow the existing one-shot-orphan-cleanup pattern already in the codebase, e.g. `info.appVersionDrift` / `info.refresh_cloud_data`.)

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** — remove the `info.wizardStatus` state creation + the `setState` mirror in `runWizardStep`; add `delObjectAsync("info.wizardStatus").catch(()=>undefined)` to the existing one-shot cleanup spot in `onReady`. Remove dead i18n keys.

- [ ] **Step 5: Run — PASS**; then full backend suite: `npx vitest run` → all PASS.

- [ ] **Step 6: Lint + commit**
```bash
npm run lint && npm run check
git add src/ admin/
git commit -m "refactor(wizard): drop info.wizardStatus state (React component owns status now)"
```

---

## Task 7: CI + release wiring for `src-admin`

**Files:** Modify `.github/workflows/test-and-release.yml`; verify `package.json` `files`/`prepublishOnly`; verify io-package custom-support (repochecker W5053).

**Interfaces:** Produces a CI that builds `admin/custom/` before package tests and includes it in the npm tarball.

- [ ] **Step 1: Read public-holidays' `test-and-release.yml`** — `grep -n "src-admin\|build:admin\|custom" ../iobroker.public-holidays/.github/workflows/test-and-release.yml`. Copy the exact src-admin build step(s) (npm ci in src-admin + `npm run build:admin`) into govee's workflow at the same positions.

- [ ] **Step 2: Local publish dry-run** — `npm pack --dry-run | grep custom` → `admin/custom/customComponents.js` is listed. If not, fix `files`/`prepublishOnly`.

- [ ] **Step 3: repochecker** — `rm -rf coverage; npx @iobroker/repochecker` (or run the pre-release step). Ensure no `W5053`/custom-support finding; if one appears, add the custom-support declaration exactly as public-holidays declares it.

- [ ] **Step 4: Commit**
```bash
git add .github/workflows/test-and-release.yml package.json io-package.json
git commit -m "ci: build src-admin custom component in CI + publish"
```

---

## Task 8: Full green + docs

- [ ] **Step 1:** `npm run check && npm run lint && npm run test:unit && npm run build && npm run test:integration` — all green. Fix anything red.
- [ ] **Step 2:** Update `CLAUDE.md` (Pattern 42 → note the React component; add `src-admin/` to the Architektur block) and `README` "Segment detection" wording. Add the README `### **WORK IN PROGRESS**` bullet: "The segment-detection wizard now has a visual admin interface — a live map of the strip that fills in as you measure and can be corrected before you apply it."
- [ ] **Step 3:** Commit `docs: React segment wizard`. (Release itself is a separate step: `pre-release.py` → `npm run release minor` → CI-watch, per the release workflow — NOT part of this plan.)

---

## Notes for the implementer

- The wizard **backend** (`segment-wizard.ts`) is tested and must stay behavior-identical except for the additive snapshot + `apply`. Do not touch the flash/measure mechanics.
- The React component is **admin-only** — no adapter-runtime impact. The integration "adapter starts" test still covers startup.
- Match **exact** bundled dep versions from public-holidays' `src-admin/package.json`. Reading `main` of any lib is wrong.
- Do not add the custom-support/exception to any gate yourself — if a gate complains, mirror public-holidays or ask.
- **Task 1 flow decision (done):** `apply` is an alternative **finalizer** to `finish` — routed only after the session-active guard, it reuses a shared `finalize()` (applyWizardResult → restore baseline → close session). So the React flow is measure(yes/no) → "Fertig" moves to review **locally from the last measuring snapshot** (session stays open) → `apply(corrected)` finalizes. Backend `done`/`finish` is unchanged (existing tests pin apply+close) and is **not** used by the React component. **Tension to revisit in Task 5:** spec §7 describes a `done` response carrying `{segmentCount,hasGaps,manualList,gaps}`, which fits a done→review→apply flow this decision rules out. If Task 5's frontend actually needs done→review→apply, the thing to revise is Task 1's apply session-guard (and add those fields to `finish`). Left off for now — untested, same open question, and keeping the session open through review means the 5-min idle timer runs during review (one more reason review→apply needs a deliberate call, decided in Task 5).
