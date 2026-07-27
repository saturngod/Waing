# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth

`plan.md` (~135KB) defines product scope, the full type surface, phase order, acceptance criteria, and the MVP definition of done. Section 38 is the progress tracker — update it only after a phase's acceptance criteria are demonstrated. `AGENTS.md` holds the contributor rules; they apply here too.

## Commands

```bash
npm install                 # npm only — never pnpm/yarn; the lockfile and CI are npm-based
npm run dev                 # electron-vite dev (Electron + React renderer)
npm run check               # typecheck + lint + test + build — run before declaring a phase complete
npm run test:e2e            # Playwright Electron smoke test (requires a build first)
npm run package             # unpacked local app via electron-builder --dir
```

Single test / focused runs (root `vitest.config.ts` collects `packages/**/*.test.ts` and `apps/**/*.test.{ts,tsx}`):

```bash
npx vitest run packages/workflow/src/Workflow.test.ts
npx vitest run -t "router repeats"
npm run typecheck --workspace @waing/agent-core
```

Opt-in live provider tests (skipped by default, need the real CLI installed):

```bash
WAING_CODEX_INTEGRATION=1 npx vitest run packages/adapter-codex
WAING_OPENCODE_INTEGRATION=1 npx vitest run packages/adapter-opencode
WAING_ANTIGRAVITY_INTEGRATION=1 npx vitest run packages/adapter-antigravity
```

Regenerate Codex protocol types after a Codex CLI upgrade: `npm run generate --workspace @waing/adapter-codex` (writes `packages/adapter-codex/generated/`, which is lint-ignored).

## Architecture

Electron main / preload / sandboxed renderer, with all logic in npm-workspace packages under `packages/` consumed by `apps/desktop`.

**Packages are TypeScript source, not build output.** Each `package.json` exports `./src/index.ts` and its `build` script is `tsc --noEmit`. Nothing is compiled to `dist/`; electron-vite bundles the sources directly. So `npm run build` in a package is a typecheck, and there is no build step to run before importing across packages.

Dependency direction: `domain` → `agent-core` → adapters → (`router`, `workflow`, `persistence`) → `apps/desktop`. `ipc-contracts` sits between main and preload only.

- **`@waing/domain`** — zod schemas + inferred types for everything crossing a boundary (agent, events, sessions, permissions, routing, workflow) plus `AgentError` / `AGENT_ERROR_CODES`. Every new cross-boundary shape starts here as a schema.
- **`@waing/agent-core`** — the `CodingAgent` interface all adapters implement, `AgentManager` (registry + event pump + capability gating), `PermissionManager`, `SessionCoordinator`, and the shared process/protocol layer (`ProcessSupervisor`, `JsonRpcTransport`, `JsonlParser`, `ExecutableResolver`, `VersionProbe`, `CompatibilityManifest`, `Redaction`, `WorkspacePathGuard`).
- **adapters** (`adapter-codex` JSON-RPC stdio, `adapter-claude` Agent SDK, `adapter-antigravity` `agy --print` process, `adapter-opencode` loopback HTTP/SSE) — each normalizes its provider into `AgentEvent`s. Raw provider protocol types never leave the adapter package.
- **`@waing/router`** — `RouterManager` (`classify` for task routing, `decideNext` for workflow checkpoints) over a `RouterClient`; `AutoSelector` handles the auto-vs-explicit agent choice. Router output is always re-validated against a zod schema and checked against `allowedActions`.
- **`@waing/workflow`** — `WorkflowEngine` runs a node/edge graph (`role_task`, `router`, `review_gate`, `loop`, `document`, `complete`) with oscillation guards, loop budgets, and completion gates. `WorkflowCompiler` builds the four presets; `StepExecutor` bridges to `AgentManager`.
- **`@waing/persistence`** — `node:sqlite` (`DatabaseSync`), forward-only numbered migrations in `migrations.ts`. Never edit an applied migration; append a new one.

### Contract rules that constrain edits

- Renderer talks to main **only** through the frozen `DesktopApi` in `apps/desktop/src/preload/index.ts`, backed by `IPC_CHANNELS` in `@waing/ipc-contracts`. Adding a feature means: channel constant → zod input schema → `DesktopApi` method → `ipcMain.handle` with `assertTrustedIpc(event)` + `schema.parse(input)`. There is deliberately no generic filesystem, process, or shell channel.
- Every normalized event passes through `redactSensitiveData` before persistence or renderer delivery (`apps/desktop/src/main/index.ts` event bus subscriber).
- Provider capabilities are discovered at runtime; unsupported plan mode, effort, cancellation, or resume must fail with `AgentCapabilityError` **before** the provider run starts (see `AgentManager.send`/`cancel`).
- Workspace paths are canonicalized with symlink resolution (`canonicalizeWorkspaceRoot`, `resolveWorkspacePath`). Executables resolve only from explicit `PATH` entries, never through a shell.
- Renderer stays `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, with the CSP set in `configureContentSecurityPolicy`.

### `WAING_E2E=1`

The main process branches on this env var in several handlers: it registers `FakeAgent`, seeds an `e2e-project`, uses an in-memory SQLite database, and returns canned router/workflow results so the Playwright smoke test runs without any provider CLI. When changing `sessionsSend`, `routerPreview`, or `workflowsRun`, keep the E2E branch consistent with the real path or `npm run test:e2e` will drift.

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. Optional properties are set with spread guards (`...(x === undefined ? {} : { x })`), not `x: undefined` — `exactOptionalPropertyTypes` rejects the latter.
- `@typescript-eslint/consistent-type-imports` and `no-floating-promises` are errors; use `import type` and `void` on intentionally unawaited promises.
- Prettier: double quotes, semicolons, trailing commas, 100 columns. Existing code packs multiple statements per line to stay under it — match the surrounding density rather than reformatting.
- Node 22+ (`node:sqlite` requires it); CI runs Node 24 on ubuntu/windows/macOS.
