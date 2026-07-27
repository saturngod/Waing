# Waing — Cross-Platform AI Coding Agent Desktop App — Detailed Implementation Plan

**Project name:** Waing  
**Target stack:** Electron + TypeScript + React  
**Primary agents:** OpenAI Codex, Anthropic Claude Code, Google Gemini CLI, OpenCode  
**Core product idea:** one desktop client with a normalized UI, user-controlled routing, user-controlled permissions, and provider-specific adapters behind a common agent runtime.  
**Platforms:** macOS, Windows, Linux  
**Planning baseline:** July 27, 2026
**Last architecture review:** July 27, 2026

---

## 0. Executive Summary

Build a cross-platform desktop application that acts as a **coding-agent orchestrator**, not as another single-provider chat client.

The app must let a user:

1. Open a local software project.
2. Choose an execution agent directly, or choose **Auto / Workflow** orchestration.
3. Use a **user-selected router agent/model** as a re-entrant control-plane step that can run at the beginning and again after new artifacts/results change what should happen next.
4. Let the Router choose only a logical next action/role such as:
   - Low Level Task
   - Medium Level Task
   - High Level Task
   - Review Level Task
   - Bug Fixing Task
   - Document Task / Create PRD / Update PRD
   - Ask User / Complete
5. Let the user configure **agent + model + effort + mode + permission profile for every workflow role**, including the Router itself.
6. Execute reusable workflow graphs with re-routing checkpoints such as:
   - `Router → Low/Medium/High → Router → Review ⇄ Fix → Router → Document → Router → Complete`
   - `Router → Create PRD → Router → Low/Medium/High → Router → Review ⇄ Fix → Router → Update PRD → Router → Complete`
7. Before each executable step, show a chat/activity message identifying the actual resolved worker, for example `Opus 4.8 is fixing the bugs`.
8. Start or resume the selected coding agent for each workflow step.
9. Stream the agent's activity into one common timeline.
10. Show file reads, file edits, diffs, commands, tool calls, messages, plans, errors, usage, router decisions, and permission requests.
11. Let the user approve or deny sensitive actions from the desktop UI.
12. Maintain provider-specific sessions while exposing one provider-neutral session/workflow model to the UI.
13. Allow the user to switch agents without coupling the entire application to any single vendor.

### Recommended provider integration paths

- **Codex:** `codex app-server` over long-lived JSON-RPC/JSONL stdio.
- **Claude:** `@anthropic-ai/claude-agent-sdk` in the Electron main process.
- **Gemini:** Gemini CLI **ACP mode** as the preferred rich-client integration; keep `stream-json` and the Gemini CLI SDK as fallback/experimental paths.
- **OpenCode:** `opencode serve` over localhost HTTP + SSE, using its OpenAPI-described API.

### Core architectural principle

**The Router repeatedly decides what logical work should happen next from the current workflow state. The user's role profile decides which agent, model, effort, mode, and permissions actually perform that work.**

A new artifact can cause a new route. For example: issue → Router → PRD → Router → implementation → Router → review → Router → fix → Router → documentation → Router → complete.

The Router must not silently change providers, permission levels, credentials, or workspace scope. It may provide the activity intent used for the next chat status message, but Waing injects the actual resolved agent/model identity.

---

# 1. Product Vision

## 1.1 Problem

Developers increasingly have multiple capable coding agents installed or available:

- Codex
- Claude Code
- Gemini CLI
- OpenCode
- potentially more in the future

Each agent has a different:

- protocol
- event model
- permission model
- session model
- reasoning/effort control
- plan mode
- tool model
- authentication story
- installation path
- upgrade cadence

Users should not need four separate desktop experiences to use them effectively.

## 1.2 Solution

Create a desktop application that provides:

- one project selector
- one conversation interface
- one activity timeline
- one permission UI
- one diff viewer
- one session manager
- one task router
- multiple interchangeable coding-agent backends

The product becomes a **provider-neutral agent cockpit**.

## 1.3 Product identity

**Product name: Waing**

Waing is a cross-platform, provider-neutral desktop orchestration layer for coding agents.

The app is not primarily:

- a code editor
- a terminal emulator
- a model API playground
- a wrapper around one LLM

It is primarily:

> A local orchestration and UX layer for coding agents.

---

# 2. Goals

## 2.1 Target MVP release gates

The first production-capable release should support the following. This is the
**target MVP**, not a single implementation milestone: the phased delivery and
beta slices in Sections 35, 36, and 42 remain the required order of work.

- Electron desktop application
- React renderer
- TypeScript everywhere
- local project selection
- Codex integration
- Claude integration
- Gemini integration
- OpenCode integration
- agent capability detection
- direct agent selection
- Auto routing
- user-selectable router model
- route rules by task class
- reusable workflow definitions
- graph-backed workflow editor (an ordered card/form editor is sufficient)
- per-role agent/model/effort configuration
- review/fix loops with explicit pass/fail gates
- document/PRD create and update steps
- normalized streaming events
- normalized approval requests
- permission profiles
- per-project conversations
- session persistence
- process lifecycle management
- diff display
- shell activity display
- cancellation
- error recovery
- provider health/version status
- Windows/macOS/Linux packaging

## 2.2 Post-MVP goals

Later versions can add:

- simultaneous/parallel agents collaborating on one task (the MVP may run
  different providers sequentially in one workflow)
- freeform visual workflow canvas
- reviewer/executor workflows
- planner/executor workflows
- agent handoff
- parallel solutions
- automatic code review after execution
- git worktree isolation
- PR creation
- issue tracker integrations
- remote agents
- team policies
- enterprise policy packs
- custom ACP-compatible agents
- custom OpenAI-compatible router endpoints
- local Ollama/LM Studio router models

---

# 3. Non-Goals for MVP

Do not attempt these in the first implementation:

- building a complete IDE
- replacing VS Code/JetBrains
- implementing a custom shell
- implementing Git itself
- implementing our own coding agent loop
- sharing one provider's hidden chain of thought
- parsing undocumented internal provider protocols when a supported interface exists
- silently bypassing provider safety systems
- automatically enabling unrestricted permissions
- automatically scraping authentication tokens from other apps
- sending the project to a different provider without explicit configuration
- automatically committing or pushing code unless the user enables that behavior

---

# 4. Core Design Principles

## 4.1 Provider-neutral domain model

UI code must not contain provider-specific event names such as `turn/started` or Claude SDK message shapes.

All provider events must first pass through an adapter.

## 4.2 Capability-driven UI

Do not assume all agents support the same features.

Each adapter exposes capabilities at runtime.

Example:

```ts
export interface AgentCapabilities {
  streaming: boolean;
  persistentSessions: boolean;
  cancellation: boolean;
  concurrentRuns: boolean;
  nativeStructuredOutput: boolean;
  planMode: boolean;
  effortControl: boolean;
  interactivePermissions: boolean;
  diffEvents: boolean;
  shellEvents: boolean;
  fileEvents: boolean;
  modelSelection: boolean;
  mcp: boolean;
  customTools: boolean;
  additionalDirectories: boolean;
}
```

The UI disables unsupported controls rather than pretending every agent behaves identically.

## 4.3 Explicit user authority

The user controls:

- selected project
- router model
- direct agent selection
- routing rules
- permission profile
- model where supported
- effort where supported
- plan/execute mode
- whether decisions may persist

## 4.4 Safe defaults

Default settings should favor:

- workspace-only access
- approvals enabled
- no automatic `git push`
- no automatic deployment
- no unrestricted shell
- no arbitrary external directories
- no router-triggered provider switching outside configured rules

## 4.5 Main process owns privileged operations

The Electron renderer must never directly:

- spawn child processes
- access arbitrary filesystem paths
- open agent local servers
- handle provider secrets
- call Node APIs directly

All privileged behavior lives in the Electron main process.

---

# 5. Technology Stack

## 5.1 Recommended stack

### Desktop

- Electron
- TypeScript
- Node.js runtime provided by Electron

### UI

- React
- Vite/electron-vite or equivalent maintained Electron build setup
- a small predictable state library such as Zustand
- TanStack Query only where request caching actually helps

### Validation

- Zod for runtime validation of:
  - IPC payloads
  - router output
  - configuration
  - normalized provider events
  - persisted JSON structures

### Persistence

- SQLite for application metadata
- migrations from day one
- JSON only for provider-specific opaque payload snapshots where necessary

Possible SQLite implementation:

- `better-sqlite3` if native module packaging is acceptable
- otherwise a maintained Electron-compatible SQLite package

The exact package should be selected during the bootstrap spike and tested on all three operating systems before committing to it.

### Testing

- Vitest for unit/integration tests
- Playwright for Electron end-to-end testing
- provider fake servers/processes for deterministic adapter contract tests

### Logging

- structured local logs
- provider stdout/stderr captured with redaction
- rolling log files
- optional diagnostic export

### Packaging

Choose one packaging path and standardize it early:

- electron-builder, or
- Electron Forge

Do not maintain two packaging systems.

---

# 6. Top-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                       Electron Renderer                      │
│                                                              │
│  Project UI   Chat UI   Activity   Diffs   Permissions       │
│  Settings     Routing   Workflows  Sessions   Diagnostics     │
└──────────────────────────────┬───────────────────────────────┘
                               │ typed IPC only
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                        Electron Main                         │
│                                                              │
│  IPC Controllers                                             │
│  Project Manager                                             │
│  Agent Manager                                               │
│  Router Manager                                              │
│  Workflow Engine + Workflow Run Coordinator                  │
│  Role/Profile Resolver                                       │
│  Permission Manager                                          │
│  Session Repository                                          │
│  Process Supervisor                                          │
│  Credential Manager                                          │
│  Diagnostics                                                 │
│                                                              │
│               Normalized CodingAgent Interface               │
│            ┌──────────┬──────────┬────────────┐              │
│            ▼          ▼          ▼            ▼              │
│          Codex      Claude     Gemini      OpenCode           │
│          Adapter     Adapter    Adapter      Adapter           │
└────────────┬──────────┬──────────┬────────────┬──────────────┘
             │          │          │            │
             ▼          ▼          ▼            ▼
     codex app-server   Agent SDK  gemini --acp opencode serve
       JSON-RPC/stdio   TypeScript JSON-RPC     HTTP + SSE
```

---

# 7. Repository / Monorepo Structure

Use a structure that prevents provider logic from leaking into UI code.

```text
waing/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/
│     │  ├─ preload/
│     │  └─ renderer/
│     └─ package.json
│
├─ packages/
│  ├─ domain/
│  │  ├─ agent.ts
│  │  ├─ events.ts
│  │  ├─ permissions.ts
│  │  ├─ routing.ts
│  │  ├─ workflows.ts
│  │  ├─ artifacts.ts
│  │  ├─ sessions.ts
│  │  └─ errors.ts
│  │
│  ├─ agent-core/
│  │  ├─ AgentManager.ts
│  │  ├─ ProcessSupervisor.ts
│  │  ├─ SessionCoordinator.ts
│  │  ├─ EventBus.ts
│  │  └─ CapabilityRegistry.ts
│  │
│  ├─ router-core/
│  │  ├─ RouterManager.ts
│  │  ├─ RouterProvider.ts
│  │  ├─ RoutingPolicy.ts
│  │  └─ schemas.ts
│  │
│  ├─ workflow-core/
│  │  ├─ WorkflowEngine.ts
│  │  ├─ WorkflowCompiler.ts
│  │  ├─ WorkflowValidator.ts
│  │  ├─ WorkflowRunCoordinator.ts
│  │  ├─ StepExecutor.ts
│  │  ├─ LoopController.ts
│  │  ├─ ContextStore.ts
│  │  └─ schemas.ts
│  │
│  ├─ adapter-codex/
│  ├─ adapter-claude/
│  ├─ adapter-gemini/
│  ├─ adapter-opencode/
│  │
│  ├─ persistence/
│  ├─ security/
│  ├─ ipc-contracts/
│  └─ test-kit/
│
├─ docs/
│  ├─ architecture.md
│  ├─ provider-contract.md
│  ├─ security.md
│  └─ development.md
│
├─ scripts/
├─ tests/
├─ AGENTS.md
├─ plan.md
├─ package.json
└─ pnpm-workspace.yaml
```

### Why packages per provider?

Because provider adapters will evolve independently.

A Codex update should not require editing Claude UI code.

A Gemini protocol change should be isolated to `adapter-gemini` plus contract tests.

---

# 8. Core Domain Types

## 8.1 Agent identifier

```ts
export type AgentId =
  | "codex"
  | "claude"
  | "gemini"
  | "opencode";
```

Do not use this union in storage if plugins will be added soon. In that case use branded strings and a registry.

## 8.2 Agent descriptor

```ts
export interface AgentDescriptor {
  id: string;
  displayName: string;
  installed: boolean;
  available: boolean;
  version?: string;
  executablePath?: string;
  capabilities: AgentCapabilities;
  authState: "unknown" | "ready" | "missing" | "error";
  warnings: string[];
}
```

## 8.3 Agent model descriptor

Model selection must be dynamic and provider-owned. The workflow UI asks the selected adapter for currently available/configurable models rather than maintaining a global hardcoded list.

```ts
export interface AgentModelDescriptor {
  agentId: string;
  modelId: string;
  displayName: string;
  available: boolean;
  isDefault?: boolean;
  effortLevels?: Array<"low" | "medium" | "high" | "max">;
  modes?: Array<"execute" | "plan" | "review" | "investigate">;
  warnings?: string[];
}
```

If an integration cannot enumerate models, expose a provider-specific validated/manual model input only when that integration supports passing model IDs.

## 8.4 Conversation, provider session, and run identity

These IDs are distinct and must never be used interchangeably:

- `conversationId`: the user-visible Waing conversation;
- `sessionId`: Waing's record for one provider session attached to a conversation;
- `providerSessionId`: the provider's opaque thread/session identifier;
- `runId`: one invocation/turn within a provider session;
- `workflowRunId` and `stepRunId`: orchestration-level execution identity.

A provider session belongs to exactly one provider. A conversation can own
multiple provider sessions over its lifetime.

```ts
export interface AppConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
```

```ts
export interface AgentSession {
  id: string;               // Waing provider-session record ID
  conversationId: string;
  providerSessionId?: string;
  agentId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "idle"
    | "starting"
    | "running"
    | "waiting_permission"
    | "cancelling"
    | "completed"
    | "failed";
}
```

```ts
export interface AgentRun {
  id: string;               // runId used by every event from this invocation
  sessionId: string;
  startedAt: string;
}
```

## 8.5 Request

```ts
export interface AgentRequest {
  text: string;
  projectRoot: string;
  mode: "execute" | "plan" | "review" | "investigate";
  effort?: "low" | "medium" | "high" | "max";
  model?: string;
  attachments?: AgentAttachment[];
  additionalDirectories?: string[];
  responseFormat?: AgentResponseFormat;
}

export interface AgentResponseFormat {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>; // provider-neutral JSON Schema
}
```

If `nativeStructuredOutput` is false, the adapter may use a strict JSON-only
prompt fallback, but the result must still pass the same Zod schema. Invalid
structured output is a typed retryable failure; Waing must never infer a Review
PASS or Router action from unvalidated prose.

## 8.6 Normalized event

```ts
export type AgentEvent =
  | AgentRunStartedEvent
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent
  | AgentPlanEvent
  | AgentToolStartedEvent
  | AgentToolProgressEvent
  | AgentToolCompletedEvent
  | AgentFileReadEvent
  | AgentFileChangeEvent
  | AgentDiffUpdatedEvent
  | AgentCommandStartedEvent
  | AgentCommandOutputEvent
  | AgentCommandCompletedEvent
  | AgentPermissionRequestedEvent
  | AgentPermissionResolvedEvent
  | AgentUsageUpdatedEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent;
```

Every event should contain:

```ts
interface EventBase {
  id: string;
  sessionId: string;
  runId: string;
  agentId: string;
  timestamp: string;
  sequence: number;         // monotonic within runId
  workflowRunId?: string;
  stepRunId?: string;
  providerEventType?: string;
}
```

`sequence` is assigned by the adapter boundary, even when the provider has no
native sequence number. Event consumers deduplicate by `id`, order within a run
by `sequence`, and never infer ordering from timestamps alone.

Keep provider raw payload optional and excluded from normal renderer state unless debugging is enabled.

---

# 9. Unified CodingAgent Interface

```ts
export interface CodingAgent {
  readonly id: string;

  discover(): Promise<AgentDescriptor>;

  listModels(): Promise<AgentModelDescriptor[]>;

  startSession(input: StartSessionInput): Promise<AgentSession>;

  resumeSession(input: ResumeSessionInput): Promise<AgentSession>;

  send(sessionId: string, request: AgentRequest): Promise<AgentRun>;

  cancel(sessionId: string): Promise<void>;

  respondToPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;

  closeSession(sessionId: string): Promise<void>;

  shutdown(): Promise<void>;

  events(sessionId: string): AsyncIterable<AgentEvent>;
}
```

### Important

Do not force every provider into methods it cannot support.

The `capabilities` object decides what behavior is available.

Unsupported operations should fail with a typed error such as:

```ts
new AgentCapabilityError("gemini", "persistent_permission_rule")
```

The caller must begin consuming `events(sessionId)` before calling `send` so
early events cannot be lost. `AgentManager` serializes runs within a provider
session unless an adapter explicitly advertises concurrent-run support. The
`AgentRun.id` returned by `send` correlates all events for that invocation.

---

# 10. Capability Registry

Maintain a runtime capability registry.

Example:

```ts
const capabilityRegistry = {
  codex: {
    streaming: true,
    persistentSessions: true,
    cancellation: true,
    interactivePermissions: true,
    diffEvents: true,
  },
  claude: {
    streaming: true,
    persistentSessions: true,
    cancellation: true,
    interactivePermissions: true,
    effortControl: true,
    planMode: true,
  },
};
```

But do not hardcode this forever.

At startup:

1. discover provider version
2. determine supported integration mode
3. run a lightweight compatibility check
4. create effective capabilities
5. show warnings if a provider version is outside tested ranges

---

# 11. Process Supervisor

Create one component responsible for every agent-related child process.

## 11.1 Responsibilities

- find executable
- verify executable
- launch process
- attach stdout
- attach stderr
- attach stdin
- line-buffer JSONL safely
- restart where appropriate
- terminate cleanly
- force-kill after timeout
- collect exit code
- capture diagnostics
- prevent orphan processes

## 11.2 Process state

```ts
type ProcessState =
  | "not_started"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "crashed";
```

## 11.3 Do not use shell interpolation

Never build:

```ts
exec(`codex app-server ${userValue}`)
```

Use `spawn(executable, args, { shell: false })`.

This prevents command injection through settings or paths.

## 11.4 Executable discovery

Support:

1. user-configured path
2. app-managed binary/path if supported
3. PATH lookup
4. common install locations

Display the final resolved executable in Settings.

Never silently execute a binary from the current project directory just because its name matches `codex`, `claude`, `gemini`, or `opencode`.

---

# 12. Shared JSON-RPC Transport

Codex App Server and Gemini ACP both use JSON-RPC-style bidirectional communication over stdio.

Build a reusable internal transport package.

## 12.1 Responsibilities

```ts
interface JsonRpcTransport {
  start(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: NotificationHandler): Unsubscribe;
  onServerRequest(handler: ServerRequestHandler): Unsubscribe;
  close(): Promise<void>;
}
```

## 12.2 Required behavior

- monotonically increasing request IDs
- pending request map
- configurable timeout
- server-initiated requests
- structured protocol errors
- malformed line isolation
- stdout line buffering
- stderr separate from protocol stream
- shutdown rejection of pending requests
- backpressure handling
- debug trace with secret redaction

## 12.3 Never assume stdout contains only valid JSON until handshake succeeds

Some CLI versions or wrappers may emit unexpected lines.

Parser strategy:

- strict protocol mode after successful initialization
- before initialization, capture non-JSON lines as diagnostics
- if protocol corruption happens after ready state, mark adapter unhealthy

---

# 13. Provider Adapter — Codex

## 13.1 Primary integration

Use:

```text
codex app-server
```

with long-lived bidirectional JSON-RPC over stdio.

## 13.2 Why

The App Server is intended for rich clients and exposes:

- threads
- turns
- streamed items
- diffs
- token usage
- server-initiated approvals
- generated TypeScript schemas

## 13.3 Startup sequence

1. discover `codex` executable
2. read version
3. run/generate a schema during development for the tested version
4. launch app server
5. send `initialize`
6. send `initialized`
7. mark adapter ready
8. create or resume thread
9. start turn
10. map notifications to normalized events

## 13.4 Schema strategy

During development/CI, generate types using the installed/pinned Codex version:

```text
codex app-server generate-ts --out generated/codex
```

Do not hand-maintain the entire protocol.

Commit generated types only if the project's update policy requires reproducible builds. Otherwise generate from a pinned test binary in CI.

## 13.5 Codex lifecycle mapping

Normalize concepts approximately as:

```text
Codex thread      → app providerSessionId
Codex turn        → one user execution turn
item/started      → tool/message/file/command started
item/*/delta      → streaming progress
item/completed    → activity completed
turn/diff/updated → diff.updated
turn/completed    → run.completed / run.failed
```

## 13.6 Approval flow

When App Server sends a server-initiated approval request:

1. pause UI state as `waiting_permission`
2. normalize request
3. display command/diff/context
4. user selects decision
5. map normalized decision to Codex decision
6. reply using original JSON-RPC request ID
7. emit permission resolved
8. return state to running

## 13.7 Codex permission decision mapping

Normalized decisions:

- deny
- allow once
- allow session
- allow with policy update if exposed safely

Do not expose provider-specific advanced amendment options until they are understood and covered by tests.

## 13.8 Codex compatibility tests

Test:

- initialize
- thread creation
- user prompt
- streaming message
- command event
- file edit event
- diff update
- approval requested
- approval accepted
- approval declined
- cancellation
- process crash
- invalid JSON
- provider upgrade incompatibility

---

# 14. Provider Adapter — Claude

## 14.1 Primary integration

Use:

```text
@anthropic-ai/claude-agent-sdk
```

inside the Electron main process.

Do not run the SDK in the renderer.

## 14.2 Important authentication/product constraint

The application must not assume that because a user can run Claude Code interactively, a third-party distributed app is automatically allowed to reuse Claude.ai subscription authentication or rate limits.

Design the adapter so authentication can be supplied through supported methods such as:

- Anthropic API credentials
- supported enterprise/cloud provider credentials
- future explicitly supported third-party auth flows

Keep authentication strategy separate from the UI conversation model.

## 14.3 Session lifecycle

Adapter responsibilities:

1. validate auth readiness
2. instantiate/query SDK session
3. set cwd
4. apply model/effort selection
5. apply permission mode
6. register `canUseTool`
7. stream SDK messages
8. normalize events
9. save provider session ID
10. support continuation/resume where available

## 14.4 Permission modes to normalize

Claude currently exposes modes such as:

- default
- acceptEdits
- plan
- dontAsk
- auto
- bypassPermissions

The app should expose product-level permission profiles, then map them to these modes.

Do not show `bypassPermissions` as a casual default option.

## 14.5 `canUseTool` integration

The permission callback should:

1. receive tool name/input
2. classify action type
3. check app-level user policy
4. if policy allows automatically, return allow
5. if denied, return deny
6. if user decision required:
   - create normalized permission request
   - wait on a Promise controlled by PermissionManager
   - resolve from renderer decision
7. optionally return supported provider permission updates only after explicit user action

Do not treat `canUseTool` as an unconditional interception point. Claude's
permission evaluation can auto-approve a call before that callback (for example,
through a bare allow rule or permissive mode). For app-level hard denies, combine
scoped `disallowedTools` rules with a `PreToolUse` hook and avoid configuration
that shadows the callback. Treat SDK warnings about a shadowed callback as an
adapter health failure for interactive profiles.

## 14.6 Claude effort mapping

If router output says:

```json
{ "effort": "high" }
```

map to SDK effort if supported by selected model.

If the provider/model does not support requested effort:

- use nearest supported level
- record the effective value
- show it in the run details

## 14.7 Claude plan mode

For planning tasks:

- use plan mode
- show plan separately from execution activity
- require explicit transition to execution if product UX is configured for plan-first workflow

## 14.8 Claude tests

Test:

- SDK initialization
- missing credential
- streaming
- cancel via AbortController/session mechanism
- permission allow
- permission deny
- accept edits profile
- plan mode
- effort mapping
- session continuation
- SDK error normalization

---

# 15. Provider Adapter — Gemini

## 15.1 Preferred integration for rich desktop client

Use Gemini CLI ACP mode:

```text
gemini --acp
```

ACP is designed for IDE/developer tool integrations and communicates over JSON-RPC/stdio.

## 15.2 Why ACP first

The rich client needs:

- long-lived sessions
- prompt/cancel
- model changes
- approval/session mode control
- client-controlled filesystem boundaries

Gemini's ACP documentation exposes these client-oriented concepts.

## 15.3 Gemini CLI SDK status caution

The TypeScript SDK provides a useful programmatic agent/session API and streaming, but its own current design/status document still marks some advanced features such as approvals/ACP wrapper as incomplete.

Therefore:

- **MVP rich integration:** ACP
- **Fallback automation:** `gemini -p --output-format stream-json`
- **Experimental future adapter:** direct `@google/gemini-cli-sdk`

Do not make the app dependent on not-yet-implemented SDK approval APIs.

## 15.4 ACP lifecycle

Design adapter around:

1. spawn `gemini --acp`
2. initialize
3. authenticate if required by protocol
4. create/load session
5. set session mode
6. optionally select model
7. send prompt
8. receive updates
9. proxy/authorize filesystem operations according to ACP model
10. cancel when requested

## 15.5 Gemini permission modes

Provider concepts include:

- default
- auto_edit
- yolo
- plan

Normalize these into app permission profiles.

Never map the app's standard mode to `yolo`.

## 15.6 Gemini fallback mode

If ACP is unavailable on an installed version:

```text
gemini -p "..." --output-format stream-json
```

Fallback capabilities must reflect limitations.

For example:

```ts
interactivePermissions = false;
```

if the headless mode cannot pause for the app's approval UI.

The UI should say:

> Interactive approvals are unavailable with this Gemini integration mode. Choose ACP-compatible Gemini CLI or a non-interactive permission profile.

## 15.7 Gemini tests

Test:

- ACP handshake
- new session
- load session
- prompt
- cancel
- set mode
- model change where available
- filesystem proxy boundary
- CLI exit
- fallback stream-json parser
- unsupported version downgrade

---

# 16. Provider Adapter — OpenCode

## 16.1 Primary integration

Run:

```text
opencode serve --hostname 127.0.0.1 --port <managed-port>
```

and communicate using localhost HTTP + SSE.

## 16.2 Security

Generate a random per-process server password and pass it using the supported environment variable.

Bind only to loopback.

Never bind to `0.0.0.0` by default.

Do not expose CORS broadly.

## 16.3 Port strategy

Do not hardcode 4096 for application-managed instances.

Use:

- random free local port
- reserve/start carefully to avoid races
- validate `/global/health`
- persist only for active process lifetime

## 16.4 OpenAPI strategy

The OpenCode server exposes an OpenAPI specification.

During development:

1. start tested OpenCode version
2. fetch `/doc`
3. generate TypeScript client/types if practical
4. pin generated API contract to tested version
5. add version compatibility tests

## 16.5 SSE

Implement resilient SSE handling:

- reconnect only when safe
- last-known event handling if supported
- detect server disposal
- distinguish network error from agent error
- cancel subscriptions on session close

## 16.6 Permission versioning caution

OpenCode permission configuration has evolved.

Do not assume a legacy config shape works with a newer server.

The adapter must:

- detect OpenCode version
- choose the correct permission contract
- isolate version mapping inside adapter code
- never let renderer construct raw OpenCode permission objects

## 16.7 OpenCode router role

OpenCode is useful as both:

- coding agent
- router-model host

For routing, create a **separate routing-only session/profile** with:

- no shell access
- no editing
- no external directory access
- minimal/no tools
- strict structured output prompt

Example:

```text
Router: OpenCode / Big Pickle
Executor: Codex
```

The routing request must not mutate the project.

---

# 17. Router Architecture

## 17.1 Router is separate from coding agent

Create a separate interface. Initial classification and re-entrant workflow
decisions are related operations, but they have different validated contracts:

```ts
export interface TaskRouter {
  id: string;
  classify(input: RoutingInput): Promise<RoutingDecision>;
  decideNext(input: RouterCheckpointInput): Promise<RouterOrchestrationDecision>;
}
```

`classify` is sufficient for Auto + Single Task. `decideNext` is used only by
workflow Router nodes. `RouterManager` owns prompting, validation, timeouts, and
decision persistence for both operations; provider-specific router clients only
return candidate structured output.

## 17.2 Routing input

```ts
export interface RoutingInput {
  task: string;
  project?: {
    languageHints?: string[];
    frameworkHints?: string[];
    repoSizeClass?: "small" | "medium" | "large";
  };
}
```

Do not send the entire repo to the router by default.

## 17.3 Routing output

```ts
export interface RoutingDecision {
  complexity: "low" | "medium" | "high";
  taskType:
    | "question"
    | "bugfix"
    | "feature"
    | "refactor"
    | "investigation"
    | "planning"
    | "review"
    | "testing"
    | "documentation";
  mode: "execute" | "plan" | "investigate" | "review";
  effort: "low" | "medium" | "high";
  confidence: number;
  rationale: string;
}
```

## 17.4 Router output validation

Use Zod.

Reject:

- unknown enum values
- confidence outside 0..1
- missing fields
- extra instructions that attempt to change permissions
- unrecognized agent IDs in model output

The router should not return an agent ID in MVP.

## 17.5 Why router should not select provider directly

Bad:

```json
{
  "agent": "some-provider-the-user-did-not-authorize"
}
```

Better:

```json
{
  "complexity": "high",
  "mode": "investigate",
  "effort": "high"
}
```

Then deterministic user policy resolves the classification into a **workflow role**:

```text
BUGFIX task        → Bug Fixing Task
DOCUMENTATION task → Document Task
REVIEW task        → Review Level Task
LOW complexity     → Low Level Task
MEDIUM complexity  → Medium Level Task
HIGH complexity    → High Level Task
```

The resolved role profile then chooses agent/model/effort. The router model itself never chooses a provider.

## 17.6 Routing policy

```ts
export interface RoutingPolicy {
  defaultRole: Exclude<WorkflowRole, "router">;
  rules: RoutingRule[];
}

export interface RoutingRule {
  id: string;
  enabled: boolean;
  match: {
    complexity?: RoutingDecision["complexity"];
    taskType?: RoutingDecision["taskType"];
    mode?: RoutingDecision["mode"];
  };
  targetRole: Exclude<WorkflowRole, "router">;
  priority: number;
}

export interface RouteResolution {
  routingDecision: RoutingDecision;
  role: Exclude<WorkflowRole, "router">;
  matchedRuleId?: string;
}
```

## 17.7 Deterministic rule resolution

1. filter enabled rules
2. match the validated `RoutingDecision`
3. sort by priority
4. first matching rule wins
5. resolve `targetRole`
6. if no rule matches, use `defaultRole`
7. resolve that role through the workflow/global role profile
8. never let router output override agent, model, permissions, or workspace scope

## 17.8 Low-confidence behavior

User setting:

```text
If router confidence < 0.65:
  [Ask me] / [Use default role] / [Use safest route]
```

Recommended default: **Use the configured default workflow role**, not a random provider/model guess.

## 17.9 Router bypass

If user selects:

```text
Agent: Codex
```

skip router entirely.

Only run router for:

```text
Agent: Auto
```

---

# 18. Router Prompt Design

Use a stable system prompt.

Example conceptual prompt:

```text
You classify software engineering tasks for routing.

You do NOT execute the task.
You do NOT request tools.
You do NOT select a vendor.
You do NOT change permission settings.

Judge complexity from scope, uncertainty, architecture impact,
risk, testing requirements, migration concerns, and number of
likely components affected.

Return the required JSON schema only.
```

## 18.1 Complexity rubric

### Low

Examples:

- small text/UI change
- obvious one-file fix
- add simple validation
- straightforward test update

Characteristics:

- narrow scope
- low architectural risk
- low uncertainty
- easy validation

### Medium

Examples:

- feature across multiple files
- moderate bug investigation
- API integration
- non-trivial refactor
- database query change requiring tests

Characteristics:

- multiple components
- moderate uncertainty
- meaningful tests
- moderate regression risk

### High

Examples:

- architecture migration
- auth/security redesign
- distributed-system issue
- major data migration
- cross-platform refactor
- unclear production bug spanning subsystems

Characteristics:

- broad scope
- high uncertainty
- high blast radius
- difficult validation
- design decisions needed

## 18.2 Planning classification

Planning is a work mode, not a complexity value.

A task can be:

```text
complexity = high
mode = plan
```

Do not mix `planning` into the low/medium/high enum.

---


# 19. Workflow Orchestration Architecture

Waing must support **multi-step agent workflows**, not only one router decision followed by one agent run.

The workflow engine is a first-class subsystem between routing and provider execution.

The core idea is:

```text
Workflow definition
      │
      ▼
Workflow Engine
      │
      ├─ resolve role configuration
      ├─ select agent
      ├─ select model
      ├─ select effort
      ├─ select mode
      ├─ select permission profile
      ├─ prepare step context
      ├─ execute step
      ├─ inspect structured result
      └─ choose next edge / loop / completion action
              │
              ▼
        AgentManager + adapters
```

The workflow engine owns **orchestration**. Provider adapters own **communication with the coding agents**.

A provider adapter must never decide which workflow step runs next.

## 19.1 Required workflow roles

Waing must ship with these built-in logical roles:

```ts
export type WorkflowRole =
  | "router"
  | "low"
  | "medium"
  | "high"
  | "review"
  | "bugfix"
  | "document";
```

User-facing names:

| Role | UI label | Purpose |
|---|---|---|
| `router` | Router | Classify the incoming task and choose the configured route |
| `low` | Low Level Task | Small, narrow, low-risk execution |
| `medium` | Medium Level Task | Moderate multi-file work or investigation |
| `high` | High Level Task | Complex/high-risk implementation or architecture work |
| `review` | Review Level Task | Review current work and return a structured pass/fail result |
| `bugfix` | Bug Fixing Task | Fix issues found by the user, tests, or a review step |
| `document` | Document Task | Create or update PRD, docs, changelog, architecture notes, etc. |

These are **logical workflow roles**, not hardcoded providers.

The user can assign any supported agent to each role.

## 19.2 Per-role execution profile

Every role must be independently configurable.

```ts
export interface RoleExecutionProfile {
  role: WorkflowRole;
  enabled: boolean;

  agentId: "codex" | "claude" | "gemini" | "opencode" | string;
  modelId?: string;
  effort?: "low" | "medium" | "high" | "max";
  mode?: "execute" | "plan" | "review" | "investigate";
  permissionProfileId?: string;

  timeoutMs?: number;
  maxRetries?: number;

  // Optional role-level prompt added before the workflow step prompt.
  instructions?: string;
}
```

Example configuration:

```json
{
  "router": {
    "agentId": "opencode",
    "modelId": "big-pickle",
    "effort": "low",
    "mode": "execute"
  },
  "low": {
    "agentId": "codex",
    "modelId": "gpt-5.6-codex",
    "effort": "low"
  },
  "medium": {
    "agentId": "codex",
    "modelId": "gpt-5.6-codex",
    "effort": "medium"
  },
  "high": {
    "agentId": "claude",
    "modelId": "opus",
    "effort": "high"
  },
  "review": {
    "agentId": "gemini",
    "modelId": "gemini-pro",
    "effort": "high",
    "mode": "review"
  },
  "bugfix": {
    "agentId": "codex",
    "modelId": "gpt-5.6-codex",
    "effort": "high"
  },
  "document": {
    "agentId": "opencode",
    "modelId": "configured-writing-model",
    "effort": "medium"
  }
}
```

Model IDs in examples are illustrative configuration values. Waing must populate actual selectable models from each integration's current capabilities rather than hardcoding example names.

## 19.3 User can choose agent, model, and effort at every step

The workflow editor must make these controls visible on every executable step:

```text
Review Level Task
────────────────────────────────────
Agent       [ Gemini          ▼ ]
Model       [ <available>     ▼ ]
Effort      [ High            ▼ ]
Mode        [ Review          ▼ ]
Permissions [ Ask changes     ▼ ]

[Use role default ✓]
```

A step may either:

1. inherit its role profile; or
2. override the role profile for that workflow only.

Example:

```ts
export interface StepExecutionOverride {
  agentId?: string;
  modelId?: string;
  effort?: "low" | "medium" | "high" | "max";
  mode?: "execute" | "plan" | "review" | "investigate";
  permissionProfileId?: string;
}
```

Resolution order:

```text
step override
    ↓ fallback
workflow role override
    ↓ fallback
global role profile
    ↓ fallback
agent default
```

This resolution must be deterministic and visible in the run details.

## 19.4 Workflows are graphs, not fixed pipelines

Do not implement workflow configuration as a single array of strings.

Waing needs branching, loops, conditional gates, and completion actions.

Use a directed graph model.

```ts
export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  description?: string;

  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];

  roleOverrides?: Partial<Record<WorkflowRole, Partial<RoleExecutionProfile>>>;

  createdAt: string;
  updatedAt: string;
}
```

## 19.5 Workflow node types

```ts
export type WorkflowNode =
  | RouterNode
  | RoleTaskNode
  | DocumentNode
  | ReviewGateNode
  | LoopNode
  | CompleteNode;
```

Branching conditions live on edges; there is no separate `ConditionNode` in the
MVP. This keeps the executable graph explicit and avoids an untyped expression
language.

Base node:

```ts
export interface WorkflowNodeBase {
  id: string;
  label: string;
  enabled: boolean;
}
```

### Router node

```ts
export interface RouterNode extends WorkflowNodeBase {
  type: "router";
  role: "router";

  // Router nodes are reusable checkpoints, not entry-only nodes.
  checkpoint:
    | "initial"
    | "after_document"
    | "after_execution"
    | "after_review"
    | "after_fix"
    | "before_completion"
    | "custom";

  // The router can choose only among explicitly allowed logical actions.
  // It never chooses a provider, credential, permission profile, or filesystem scope.
  allowedActions: WorkflowNextActionKind[];

  // Optional extra instruction for this checkpoint, e.g.
  // "Decide whether this PRD is detailed enough to implement."
  instructions?: string;
}
```

### Role task node

```ts
export interface RoleTaskNode extends WorkflowNodeBase {
  type: "role_task";
  role: "low" | "medium" | "high" | "review" | "bugfix";
  instructions?: string;
  execution?: StepExecutionOverride;
}
```

### Document node

```ts
export interface DocumentNode extends WorkflowNodeBase {
  type: "document";
  role: "document";
  operation: "create" | "update";
  documentKind: "prd" | "readme" | "architecture" | "changelog" | "custom";
  path?: string;
  instructions?: string;
  execution?: StepExecutionOverride;
}
```

### Review gate node

A review must return a machine-readable verdict.

```ts
export interface ReviewGateNode extends WorkflowNodeBase {
  type: "review_gate";
  role: "review";
  passEdge: string;
  failEdge: string;
  requireTests?: boolean;
  execution?: StepExecutionOverride;
}
```

`ReviewGateNode` is both an executable Review-role step and a gate. `passEdge`
and `failEdge` are edge IDs, not node IDs. Validation must confirm that both
edges originate at this node and have the matching `review_result` condition.
Do not add a separate `role_task(role = "review")` immediately before it.

### Loop node

```ts
export interface LoopNode extends WorkflowNodeBase {
  type: "loop";
  loopId: string;
  bodyEntryNodeId: string;
  exitNodeId: string;
  maxIterations: number;
  stopCondition: "review_passed" | "condition_true";
  onExhausted: "ask_user" | "fail_workflow" | "continue_with_warning";
}
```

`LoopNode` is a compiler-generated control node, not an agent step. The friendly
builder may display a Review/Fix loop, but persisted graphs contain this guard
and explicit cyclic edges. Every back-edge must name the guarding `loopId`;
validation rejects an unguarded executable cycle.

### Complete node

```ts
export interface CompleteNode extends WorkflowNodeBase {
  type: "complete";
}
```

## 19.6 Workflow edge model

```ts
export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  loopId?: string; // required on a back-edge controlled by a LoopNode
  condition?:
    | { type: "always" }
    | { type: "router_role"; role: "low" | "medium" | "high" | "review" | "bugfix" | "document" }
    | { type: "router_action"; action: WorkflowNextActionKind }
    | { type: "document_operation"; operation: "create" | "update" }
    | { type: "review_result"; result: "pass" | "fail" }
    | { type: "loop_remaining" }
    | { type: "loop_exhausted" };
}
```

Workflow validation must reject ambiguous graphs where multiple outgoing edge
conditions can match the same result.

Edges do not currently have a `priority` field, so MVP validation must instead
prove outgoing conditions are mutually exclusive. If ordered fallback routing
is later required, add an explicit numeric `priority` to the schema before using
"first match wins" semantics.

## 19.7 Core workflow example — route, execute, review/fix loop, document

User requirement:

```text
Router -> Low,Medium,High, loop(Review, Fix, Review), When complete, write Doc.
```

Waing should represent this conceptually as:

**`Low/Medium/High` means one routed branch by default, not running all three agents sequentially.** A future workflow node may explicitly support fan-out/parallel execution, but the built-in routed task chooses exactly one role.

```text
                         ┌────────────┐
                         │   Router   │
                         └─────┬──────┘
                 ┌─────────────┼─────────────┐
                 ▼             ▼             ▼
              [LOW]         [MEDIUM]       [HIGH]
                 └─────────────┼─────────────┘
                               ▼
                         ┌────────────┐
                         │   Review   │◄───────────────┐
                         └─────┬──────┘                │
                        PASS   │   FAIL                │
                         │     ▼                       │
                         │  ┌────────────┐              │
                         │  │  Bug Fix   │──────────────┘
                         │  └────────────┘
                         ▼
                    ┌────────────┐
                    │ Write Docs │
                    └─────┬──────┘
                          ▼
                      COMPLETE
```

Execution semantics:

1. Router classifies initial task.
2. Exactly one of Low/Medium/High executes.
3. Review inspects the resulting work.
4. If Review = FAIL, run Bug Fix.
5. Bug Fix receives the review findings as mandatory input.
6. Run Review again.
7. Continue until Review = PASS or loop maximum is reached.
8. On PASS, run Document Task.
9. Document Task writes/updates configured documentation.
10. Mark workflow complete only after required document step succeeds.

Default review loop maximum: **3 review attempts**.

This value must be user-configurable.

Never allow an unbounded review/fix loop.

## 19.8 PRD-first workflow example

User requirement:

```text
Router -> Create PRD -> Low,Medium,High -> loop(Review, Fix, Review) -> Update PRD
```

Recommended semantics:

```text
Router
   │
   ▼
Create PRD
   │
   ├── receives original user task
   ├── receives router classification
   └── creates implementation requirements + acceptance criteria
   │
   ▼
Routed Execution
   ├── LOW
   ├── MEDIUM
   └── HIGH
   │
   ▼
Review
   │
   ├── PASS ──────────────────────────────┐
   │                                     │
   └── FAIL → Bug Fix → Review ──────────┘
                                         │
                                         ▼
                                   Update PRD
                                         │
                                         ▼
                                     COMPLETE
```

The PRD created before implementation becomes a workflow artifact and must remain available to later nodes.

The final Update PRD step should add, at minimum:

- implementation summary
- actual files/components changed
- deviations from original PRD
- tests performed
- review findings resolved
- unresolved known limitations
- final completion state

## 19.9 Router placement and semantics

The Router is a **re-entrant control-plane step**, not a one-time classifier that must run only at the beginning.

A workflow may route back into a Router node after any meaningful state change, including:

- initial task intake;
- fetching or understanding an issue/ticket;
- creating a PRD or implementation plan;
- completing implementation;
- completing review;
- completing a bug-fix pass;
- generating/updating documentation;
- receiving a new user instruction;
- recovering from a failed/fallback step;
- before final completion.

This enables orchestration such as:

```text
User task
   ↓
Router #1
   ↓
Create PRD
   ↓
Router #2   ← route again using the newly-created PRD
   ↓
High Task
   ↓
Router #3   ← route again using implementation result/diff/tests
   ↓
Review
   ↓
Router #4   ← decide fix / re-review / document / complete
```

The Router therefore has three responsibilities:

1. classify the **current orchestration state**, not only the original user sentence;
2. choose the next **logical workflow action/role** from an explicitly allowed set; and
3. provide a short structured user-facing activity intent that Waing can render before the selected step begins.

It still does **not** choose the provider/model directly.

Router configuration itself supports:

```text
Agent  [ OpenCode ▼ ]
Model  [ Big Pickle ▼ ]
Effort [ Low ▼ ]
```

After each router checkpoint, Waing resolves the selected logical action through user configuration:

```text
Router decision: execute_high
              │
              ▼
        High role profile
              │
              ▼
   Claude + chosen model + high effort
```

or:

```text
Router decision: create_prd
              │
              ▼
       Document role profile
              │
              ▼
 OpenCode + writing model + medium effort
```

The same workflow may invoke the Router many times. Each invocation is a separate persisted `RouterDecisionRecord`.

## 19.10 Role precedence

Complexity and task type are separate dimensions.

Recommended default routing rules when mapping a validated router decision into a workflow role:

```text
if taskType == documentation → document
else if taskType == review   → review
else if taskType == bugfix AND user policy prefers dedicated bugfix role → bugfix
else complexity == low       → low
else complexity == medium    → medium
else                         → high
```

These rules belong to `RoutingPolicy`; they are not generated by the router model. Users can reorder/override them.

This lets a user choose, for example:

```text
Low Level Task       → Codex / Model A / low effort
Medium Level Task    → Codex / Model A / medium effort
High Level Task      → Claude / Model B / high effort
Review Level Task    → Gemini / Model C / high effort
Bug Fixing Task      → Codex / Model A / high effort
Document Task        → OpenCode / Model D / medium effort
```

## 19.11 Re-entrant orchestration decision contract

The initial `RoutingDecision` remains useful for complexity/task-type classification, but workflow orchestration needs a richer checkpoint contract.

```ts
export type RouterCheckpointReason =
  | "initial"
  | "after_document"
  | "after_execution"
  | "after_review"
  | "after_fix"
  | "before_completion"
  | "manual_reroute"
  | "recovery";

export type WorkflowNextActionKind =
  | "execute_low"
  | "execute_medium"
  | "execute_high"
  | "create_prd"
  | "update_prd"
  | "write_documentation"
  | "review"
  | "fix"
  | "ask_user"
  | "complete";

export interface RouterCheckpointInput {
  checkpointReason: RouterCheckpointReason;
  originalUserTask: string;

  // State produced since the last router decision.
  latestStepResult?: WorkflowStepResult;
  latestReview?: ReviewResult;
  latestArtifact?: WorkflowArtifactRef;

  // Provider-neutral summaries only. Do not forward hidden reasoning.
  priorStepSummaries: Array<{
    role: WorkflowRole;
    summary: string;
    filesChanged: string[];
    testsRun: TestRecord[];
  }>;

  artifacts: WorkflowArtifactRef[];
  unresolvedIssues: string[];
  reviewIteration?: number;

  // Restrict what the model is allowed to choose at this checkpoint.
  allowedActions: WorkflowNextActionKind[];
}

export interface RouterOrchestrationDecision {
  action: WorkflowNextActionKind;

  // Classification can be recalculated because a PRD, diff, test result,
  // or review result may materially change the appropriate route.
  complexity?: "low" | "medium" | "high";
  taskType?: RoutingDecision["taskType"];
  effortHint?: "low" | "medium" | "high" | "max";

  document?: {
    operation: "create" | "update";
    kind: "prd" | "readme" | "architecture" | "changelog" | "custom";
    targetPath?: string;
  };

  statusIntent: StepAnnouncementIntent;
  rationale: string;
  confidence: number;
}
```

`effortHint` is advisory metadata for explanation and future policy rules. It
does not override the step/workflow/global role profile resolution order.

Validation rules:

- `action` must exist in the Router node's `allowedActions`;
- `create_prd`/`update_prd` must include a valid document directive;
- `complete` is forbidden when required review/document gates remain unsatisfied;
- the router cannot return `agentId`, `modelId`, permission overrides, credentials, workspace paths, or arbitrary shell commands;
- `confidence` must be in `0...1`;
- the engine resolves `action → workflow role/node → configured agent/model/effort` after validation.

This gives the router authority over **orchestration**, but not over provider/security policy.

## 19.12 Router checkpoint loop and oscillation safety

Re-routing is powerful, so it must be bounded and observable.

```ts
export interface RouterLoopPolicy {
  maxRouterDecisions: number;          // recommended default: 12
  maxSameActionWithoutStateChange: number; // recommended default: 2
  onExhausted: "ask_user" | "fail_workflow";
}

export interface RouterDecisionRecord {
  id: string;
  workflowRunId: string;
  routerNodeId: string;
  checkpointReason: RouterCheckpointReason;
  inputStateVersion: number;
  decision: RouterOrchestrationDecision;
  resolvedNodeId?: string;
  resolvedRole?: WorkflowRole;
  resolvedAgentId?: string;
  resolvedModelId?: string;
  createdAt: string;
}
```

The engine must increment a `stateVersion` whenever a meaningful workflow result/artifact changes.

Reject or stop these patterns:

```text
Router → Router → Router
```

with no state change, or:

```text
Router → Create PRD → Router → Create PRD → Router → Create PRD ...
```

when the PRD already exists and no new requirement justifies recreation.

Recommended safety algorithm:

1. execute Router checkpoint;
2. validate decision against allowed actions;
3. compare with recent decision history;
4. require a state change before repeatedly choosing the same mutating action;
5. increment router decision counter;
6. if limit/oscillation rule is hit, pause and ask the user instead of guessing;
7. persist every checkpoint decision for run-history/debugging.

Router loops and Review/Fix loops are separate counters. A workflow can have both.

## 19.13 Example — GitHub issue → PRD → implementation → review/fix → PRD update

User request:

```text
Check GitHub issue #123, create a PRD, and execute it.
```

The important behavior is that Waing does **not** assume the initial routing decision remains correct after the PRD exists.

Recommended flow:

```text
User
 │
 │ "Check GitHub issue #123, create a PRD, and execute it"
 ▼
Router #1
 │  action = create_prd
 │
 ▼
Document Task
 │  selected profile: <Document agent/model/effort>
 │  output: PRD artifact + acceptance criteria
 ▼
Router #2
 │  input now includes the PRD
 │  re-evaluates scope/complexity
 │  action = execute_high   (example)
 ▼
High Level Task
 │  selected profile: <High agent/model/effort>
 │  output: implementation + tests + diff summary
 ▼
Router #3
 │  action = review
 ▼
Review Level Task
 │
 ├── PASS ───────────────────────────────────┐
 │                                           ▼
 │                                      Router #4
 │                                           │ action = update_prd
 │                                           ▼
 │                                      Document Task
 │                                           │ update PRD with reality
 │                                           ▼
 │                                      Router #5
 │                                           │ action = complete
 │                                           ▼
 │                                       COMPLETE
 │
 └── FAIL
      │ findings
      ▼
   Router #4
      │ action = fix
      ▼
   Bug Fix Task
      │
      ▼
   Router #5
      │ action = review
      └──────────────→ Review again
```

The same design supports other recursive workflows:

```text
Router → Research → Router → PRD → Router → Execute → Router → Review → Router
```

or:

```text
Router → Review → Router → Fix → Router → Review → Router → Complete
```

A workflow graph may have explicit Router nodes at these checkpoints, or a node may declare `rerouteAfterCompletion = true` and compile to an explicit Router checkpoint. Persisted/executable graphs must still contain explicit nodes/edges after compilation.

For GitHub issues specifically, fetching issue content and repository context should produce a provider-neutral input artifact before PRD creation. The Document agent should receive that artifact instead of being asked to rediscover the issue from an unrelated provider session.

## 19.14 User-visible step announcements in chat

Before any agent/model begins a workflow step, Waing must show the user **who is about to do what**.

Examples:

```text
Big Pickle is routing GitHub issue #123.
Claude Opus is creating the PRD.
Codex is implementing the high-complexity task.
Gemini is reviewing the changes.
Opus 4.8 is fixing the bugs.
OpenCode is updating the PRD.
```

The user example `"Opus 4.8 is fixing the bugs"` is the desired UX pattern; actual displayed names must always come from the resolved provider/model configuration.

Do not let the router hallucinate the selected model name. The router provides a structured **status intent**; Waing injects the real agent/model after role resolution.

```ts
export type StepActivityKind =
  | "routing"
  | "creating_prd"
  | "updating_prd"
  | "implementing"
  | "planning"
  | "investigating"
  | "reviewing"
  | "fixing_bugs"
  | "writing_docs"
  | "testing"
  | "waiting_for_user";

export interface StepAnnouncementIntent {
  activity: StepActivityKind;
  subject?: string; // e.g. "GitHub issue #123", "authentication changes"

  // Optional router-written wording. If present it must use placeholders;
  // it cannot hardcode an unverified provider/model identity.
  template?: string; // e.g. "{model} is fixing the bugs."
}

export interface StepAnnouncement {
  workflowRunId: string;
  stepRunId: string;
  nodeId: string;
  role: WorkflowRole;

  agentId: string;
  agentDisplayName: string;
  modelId?: string;
  modelDisplayName?: string;
  effort?: string;

  activity: StepActivityKind;
  message: string;
  createdAt: string;
}
```

Announcement resolution order:

```text
router status intent
        ↓
resolved workflow node/role
        ↓
resolved agent/model/effort
        ↓
Waing renders validated message
        ↓
append chat activity message
        ↓
ONLY THEN start provider execution
```

Default deterministic templates:

```text
routing       → "{modelOrAgent} is routing {subject}."
creating_prd  → "{modelOrAgent} is creating the PRD."
updating_prd  → "{modelOrAgent} is updating the PRD."
implementing  → "{modelOrAgent} is implementing the task."
reviewing     → "{modelOrAgent} is reviewing the changes."
fixing_bugs   → "{modelOrAgent} is fixing the bugs."
writing_docs  → "{modelOrAgent} is writing the documentation."
```

UI requirements:

- render the announcement as an activity/chat message before streaming provider output;
- show agent, model, effort, and workflow role in expandable metadata;
- keep the text short (recommended <= 160 characters);
- never claim a step started before `StepExecutor` has successfully resolved a runnable profile;
- if provider launch immediately fails, update the activity item to `Failed to start` rather than leaving a false running state;
- provider reasoning/private chain-of-thought is never used as the status message;
- status messages are persisted so reopening a workflow reconstructs the visible timeline.

The Router may manage **what action wording is appropriate**, while Waing remains authoritative about **which agent/model is actually running**.

## 19.15 Structured output contracts between steps

Do not pass only raw chat text from one step to another.

Every completed step should publish a structured result envelope.

```ts
export interface WorkflowStepResult {
  stepRunId: string;
  nodeId: string;
  role: WorkflowRole;
  agentId: string;
  modelId?: string;
  effort?: string;

  status: "completed" | "failed" | "cancelled";
  summary: string;

  filesRead: string[];
  filesChanged: string[];
  commandsRun: CommandRecord[];
  testsRun: TestRecord[];
  artifacts: WorkflowArtifactRef[];

  findings?: ReviewFinding[];
  reviewVerdict?: "pass" | "fail";
  unresolvedIssues?: string[];
}
```

`StepExecutor` assembles this envelope from Waing-observed normalized events and
process results. Agent-authored structured output may supply `summary`, review
findings, or unresolved issues, but it is not authoritative for commands run,
files changed, permission decisions, test exit status, or usage. Preserve
provenance when a provider cannot expose an observed field; do not present a
model claim as audited fact.

## 19.16 Review result contract

The Review role must finish with structured output that Waing can validate.

```ts
export interface ReviewResult {
  verdict: "pass" | "fail";
  summary: string;
  findings: ReviewFinding[];
  testsObserved: string[];
  confidence: number;
}

export interface ReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "correctness"
    | "security"
    | "regression"
    | "performance"
    | "maintainability"
    | "testing"
    | "documentation";
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
}
```

A review step must not be considered PASS if a configured blocking severity remains unresolved.

Default blocking severities:

```text
critical
high
```

User may configure medium as blocking.

## 19.17 Bug Fix step contract

Bug Fix should receive a fix packet, not an ambiguous message.

```ts
export interface FixPacket {
  originalTask: string;
  implementationSummary: string;
  reviewIteration: number;
  findings: ReviewFinding[];
  currentChangedFiles: string[];
  testsAlreadyRun: TestRecord[];
  prdArtifact?: WorkflowArtifactRef;
}
```

The Bug Fix agent should be instructed to:

1. address blocking findings first;
2. avoid unrelated refactoring;
3. preserve already-correct implementation;
4. add/update tests when a finding demonstrates missing coverage;
5. return which finding IDs were addressed;
6. explicitly identify any finding it could not resolve.

## 19.18 Document Task contract

Document tasks are executable workflow steps with a document operation.

```ts
export interface DocumentTaskInput {
  operation: "create" | "update";
  kind: "prd" | "readme" | "architecture" | "changelog" | "custom";
  targetPath?: string;

  originalTask: string;
  routingDecision?: RoutingDecision;
  stepResults: WorkflowStepResult[];
  finalReview?: ReviewResult;
}
```

For PRD creation, require sections such as:

- problem
- goal
- non-goals
- functional requirements
- technical constraints
- implementation plan
- acceptance criteria
- testing expectations
- risk/open questions

For PRD update, preserve the original intent and append/update implementation reality rather than replacing the whole PRD with a generic summary.

## 19.19 Workflow context store

Each workflow run owns a context store.

```ts
export interface WorkflowContext {
  workflowRunId: string;
  projectId: string;
  projectRoot: string;

  originalUserTask: string;
  routingDecision?: RoutingDecision;

  // Re-entrant orchestration state.
  stateVersion: number;
  routerDecisionCount: number;
  routerDecisionHistory: RouterDecisionRecord[];
  latestRouterDecision?: RouterOrchestrationDecision;

  activeNodeId: string;
  completedNodeIds: string[];
  stepResults: WorkflowStepResult[];
  artifacts: WorkflowArtifactRef[];

  loopState: Record<string, {
    iteration: number;
    maxIterations: number;
  }>;
}
```

Provider sessions can be reused within a role when safe, but the workflow context is provider-neutral.

## 19.20 Cross-agent handoff context

When one workflow changes agent—for example Codex implementation → Gemini review—the next agent needs sufficient context without blindly forwarding every provider transcript.

Create a provider-neutral handoff packet:

```ts
export interface WorkflowHandoffPacket {
  originalTask: string;
  currentGoal: string;
  routingDecision?: RoutingDecision;
  prd?: WorkflowArtifactRef;

  priorStepSummaries: Array<{
    role: WorkflowRole;
    summary: string;
    filesChanged: string[];
    testsRun: TestRecord[];
  }>;

  currentDiff?: string;
  reviewFindings?: ReviewFinding[];
  unresolvedIssues: string[];
}
```

Do not send hidden reasoning or undocumented provider internals.

## 19.21 Workflow run state machine

```text
CREATED
  │
  ▼
VALIDATING
  │
  ▼
READY
  │ start
  ▼
RUNNING_NODE
  ├──> WAITING_PERMISSION ───────┐
  │          │ decision          │
  │          └───────────────────┘
  │
  ├──> NODE_COMPLETED
  │       │
  │       ├── next edge → RUNNING_NODE
  │       ├── loop gate → RUNNING_NODE / LOOP_EXHAUSTED
  │       └── complete  → COMPLETED
  │
  ├──> PAUSED
  ├──> CANCELLED
  └──> FAILED
```

Persist every transition.

## 19.22 Loop safety

Every loop must have:

- a maximum iteration count
- a typed exit condition
- a typed exhaustion behavior
- a user-visible iteration counter

Example:

```ts
export interface ReviewFixLoopPolicy {
  maxReviewAttempts: number; // default 3
  onExhausted: "stop_and_ask_user" | "fail_workflow" | "continue_to_document_with_warning";
  blockingSeverities: Array<"critical" | "high" | "medium" | "low">;
}
```

Recommended default:

```text
maxReviewAttempts = 3
onExhausted = stop_and_ask_user
blockingSeverities = [critical, high]
```

Never automatically run forever because Review and Fix disagree.

## 19.23 Failure policy per node

Every executable node can define:

```ts
export interface StepFailurePolicy {
  retryCount: number;
  onFailure: "stop" | "ask_user" | "skip" | "fallback_agent";
  fallbackProfile?: StepExecutionOverride;
}
```

Fallback agents must be explicitly configured by the user.

Waing must never silently move source code to a different provider because one provider failed.

## 19.24 Model/effort capability validation

Because providers expose different model and effort controls:

1. adapter advertises model-selection capability;
2. adapter advertises supported effort values;
3. settings UI only presents valid values;
4. workflow validation rejects stale/unsupported values before execution when possible;
5. compatibility error includes a suggested replacement but never changes configuration silently.

```ts
export interface AgentModelCapability {
  modelId: string;
  displayName: string;
  effortLevels?: string[];
  modes?: string[];
}
```

## 19.25 Workflow presets

Ship with editable presets.

### Preset A — Standard

```text
Router
  ↓
Low / Medium / High
  ↓
Complete
```

### Preset B — Review Loop

```text
Router
  ↓
Low / Medium / High
  ↓
Review
  ├─ PASS → Complete
  └─ FAIL → Bug Fix → Review
```

### Preset C — Review + Documentation

```text
Router
  ↓
Low / Medium / High
  ↓
Review ⇄ Bug Fix
  ↓ PASS
Write Documentation
  ↓
Complete
```

### Preset D — Re-entrant PRD Driven

```text
Router
  ↓ create_prd
Create PRD
  ↓
Router                 ← route again using PRD artifact
  ↓ execute_low / execute_medium / execute_high
Low / Medium / High
  ↓
Router                 ← route again using implementation/tests/diff
  ↓ review
Review
  ↓
Router
  ├─ PASS → update_prd
  └─ FAIL → fix → Router → review
  ↓
Update PRD
  ↓
Router
  ↓ complete
Complete
```

Users can clone a preset and modify any step.

## 19.26 Workflow Builder UI

Add a Workflow section to settings and a workflow picker to the composer.

Example builder:

```text
Workflow: PRD Driven Development
────────────────────────────────────────────────────────

[Router]
 OpenCode • Big Pickle • Low
        │
        ▼
[Create PRD]
 OpenCode • Writing Model • Medium
        │
        ▼
[Auto Routed Task]
 ├ Low    → Codex  • Model A • Low
 ├ Medium → Codex  • Model A • Medium
 └ High   → Claude • Model B • High
        │
        ▼
[Review]
 Gemini • Model C • High
   │ PASS                │ FAIL
   ▼                     ▼
[Update PRD] ◄──── [Bug Fix]
                    Codex • Model A • High
                         │
                         └────────────→ Review

Loop limit: [3]
On exhaustion: [Ask me ▼]

[Validate Workflow] [Save]
```

The MVP builder can be form/ordered-card based if a freeform canvas would delay delivery, but the persisted model must already be graph-based.

## 19.27 Run UI

While a workflow is running, show both workflow-level and agent-level state.

```text
PRD Driven Development                          Running
──────────────────────────────────────────────────────
✓ Router                 OpenCode / Big Pickle / Low
✓ Create PRD             OpenCode / Model D / Medium
✓ Medium Level Task      Codex / Model A / Medium
● Review #1              Gemini / Model C / High
○ Bug Fix
○ Review #2
○ Update PRD

Review loop: 1 / 3
```

Clicking a step opens:

- prompt/input packet
- selected agent/model/effort
- permission profile
- streamed events
- files changed
- commands
- tests
- token/usage information if available
- final structured step result

## 19.28 Composer workflow selection

The main composer should expose:

```text
Workflow [ Auto Route + Review + Docs ▼ ]
Agent    [ Controlled by workflow       ]
```

For a single-agent ad hoc run:

```text
Workflow [ Single Task ▼ ]
Agent    [ Codex       ▼ ]
Model    [ ...         ▼ ]
Effort   [ Medium      ▼ ]
```

This preserves the simple use case while enabling orchestration.

## 19.29 Workflow validation rules

Before Save:

- one entry node exactly
- at least one reachable Complete node
- all referenced node IDs exist
- no unreachable executable nodes unless explicitly disabled
- Router conditional targets exist
- every role used has a resolvable execution profile
- selected agent is installed/configured or marked as expected-unavailable
- selected model is valid when capability metadata is available
- effort is supported by target agent/model
- all loops have finite maximums
- review loop has PASS and FAIL paths
- document target path stays inside permitted workspace unless user explicitly grants external access
- no duplicate node IDs
- no ambiguous same-condition edges

Before Run, validate again against live provider capabilities.

## 19.30 Workflow persistence

Persist separately:

```text
workflow_definitions
workflow_role_profiles
workflow_runs
workflow_step_runs
workflow_edges_taken
workflow_artifacts
workflow_loop_state
workflow_reviews
workflow_findings
```

A historical run must reference the workflow version actually executed.

Editing a workflow creates a new version; do not mutate history.

## 19.31 Workflow events

Add normalized workflow events above agent events:

```ts
export type WorkflowEvent =
  | { type: "workflow.started"; workflowRunId: string }
  | { type: "workflow.router.started"; nodeId: string; checkpointReason: RouterCheckpointReason }
  | { type: "workflow.router.decided"; record: RouterDecisionRecord }
  | { type: "workflow.step.announced"; announcement: StepAnnouncement }
  | { type: "workflow.node.started"; nodeId: string; stepRunId: string }
  | { type: "workflow.node.completed"; nodeId: string; stepRunId: string }
  | { type: "workflow.route.selected"; role: WorkflowRole }
  | { type: "workflow.review.completed"; verdict: "pass" | "fail" }
  | { type: "workflow.loop.iteration"; loopId: string; iteration: number }
  | { type: "workflow.loop.exhausted"; loopId: string }
  | { type: "workflow.artifact.created"; artifactId: string }
  | { type: "workflow.completed"; workflowRunId: string }
  | { type: "workflow.failed"; workflowRunId: string; error: AppError };
```

React listens to workflow events for orchestration state and to AgentEvents for detailed provider activity.

## 19.32 WorkflowEngine responsibilities

`WorkflowEngine` must:

1. load a specific workflow version;
2. validate graph structure;
3. create `WorkflowRun`;
4. initialize `WorkflowContext` and `stateVersion`;
5. execute the entry node;
6. when the active node is a Router checkpoint, build `RouterCheckpointInput` from current provider-neutral state;
7. execute and validate `RouterOrchestrationDecision`;
8. persist the `RouterDecisionRecord` and enforce router-loop/oscillation limits;
9. resolve the logical action/role to the next executable node;
10. resolve role execution profile → agent/model/effort/mode/permissions;
11. build and emit `StepAnnouncement` **before** provider execution;
12. call `AgentManager`;
13. consume normalized result;
14. persist result/artifacts and increment `stateVersion` when workflow state changes;
15. evaluate outgoing edge, including edges that return to another Router checkpoint;
16. update Review/Fix loop state independently from Router decision state;
17. dispatch next node;
18. stop safely on failure/cancel/pause/oscillation;
19. before completion, enforce required review/document gates;
20. create final workflow summary.

It must not contain provider-specific code.

## 19.33 WorkflowCompiler responsibilities

The builder edits a friendly configuration. `WorkflowCompiler` converts it to a validated executable graph.

For preset-like syntax such as:

```text
Router -> RoutedTask -> Loop(Review -> Fix -> Review) -> Document
```

compile into explicit nodes/edges before execution.

Do not interpret workflow DSL dynamically during an agent run.

## 19.34 Acceptance examples

### Example 1

Configuration:

```text
Router     = OpenCode / Big Pickle / low
Low        = Codex / model A / low
Medium     = Codex / model A / medium
High       = Claude / model B / high
Review     = Gemini / model C / high
Bug Fix    = Codex / model A / high
Document   = OpenCode / model D / medium
```

Task:

```text
Change the login button label.
```

Expected flow:

```text
Router → Low → Review
Review PASS → Document → Complete
```

### Example 2

Task:

```text
Refactor authentication and migrate refresh-token handling.
```

Expected flow:

```text
Router → High → Review
Review FAIL → Bug Fix → Review
Review PASS → Document → Complete
```

### Example 3 — PRD preset

Task:

```text
Add team workspaces with invitations and role-based permissions.
```

Expected flow:

```text
Router
→ Create PRD
→ High
→ Review
→ Bug Fix if needed
→ Review until pass/max
→ Update PRD
→ Complete
```

The run history must show the exact agent/model/effort used for every step.

---

# 20. Permission Architecture

## 20.1 Product-level permission profiles

Define app-owned profiles, for example:

### Read Only

- read workspace: allow
- search workspace: allow
- write: deny
- shell mutations: deny
- network: deny by default
- external directory: deny

### Ask Before Changes

- reads: allow
- writes: ask
- shell: ask
- network: ask
- external directory: ask

### Auto Edit

- reads: allow
- workspace edits: allow
- safe tests/build commands: configurable
- destructive shell: ask
- network: ask
- external directory: ask

### Autonomous

- broad workspace operations allowed
- still honor hard deny policies
- must show strong warning before enabling
- should remain project-scoped where possible

## 20.2 Never pretend provider modes are identical

A product-level profile maps differently per adapter.

```text
Ask Before Changes
  Codex  → approval policy + workspace sandbox
  Claude → default + canUseTool
  Gemini → ACP/default mode
  OpenCode → ask/allow/deny rules
```

## 20.2.1 Enforcement levels and fail-closed behavior

A normalized permission card is not itself a security boundary. Waing must
record how each effective rule is enforced:

1. **Waing-controlled:** the operation is performed through a Waing-owned file,
   tool, or process proxy.
2. **Provider-enforced:** a documented provider callback/protocol pauses before
   the operation and accepts Waing's decision.
3. **Sandbox-enforced:** the provider process is constrained by an OS/provider
   sandbox that independently prevents the operation.
4. **Display-only:** Waing can observe the operation but cannot reliably stop it.

Read Only, Ask Before Changes, and hard-deny rules must never rely on
display-only enforcement. If an installed provider/version cannot enforce a
requested profile, capability validation must block the run or require the user
to select an honestly labeled weaker profile. Provider subprocess environment,
configuration, and startup flags must be built from the resolved profile; do
not assume the renderer approval UI can intercept tools executed internally by
a CLI.

## 20.3 Normalized permission request

```ts
export interface PermissionRequest {
  id: string;
  sessionId: string;
  agentId: string;
  kind:
    | "command"
    | "file_write"
    | "file_delete"
    | "network"
    | "external_directory"
    | "tool"
    | "other";
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  paths?: string[];
  diff?: string;
  riskHints?: string[];
  providerRawType?: string;
}
```

## 20.4 Decisions

```ts
export type PermissionDecision =
  | { type: "deny" }
  | { type: "allow_once" }
  | { type: "allow_session" }
  | { type: "allow_always"; scope: PermissionScope };
```

Only show `allow_always` if the adapter/app can implement it predictably.

## 20.5 App-level remembered permissions

If provider does not support persistent rules, the app may remember a rule and auto-answer equivalent future provider requests.

But the rule must be explicit.

Example:

```text
Allow during this project:
command prefix = npm test
cwd inside project root
```

Never persist a vague rule like:

```text
Allow Bash forever
```

without a very explicit user choice.

---

# 21. Security Model

## 21.1 Electron security

Renderer BrowserWindow:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true` where compatible
- preload exposes a minimal typed API
- deny unexpected navigation
- deny unexpected window creation
- strict Content Security Policy
- no remote code in renderer

## 21.2 IPC security

Every IPC channel:

- defined in shared contract package
- runtime validated with Zod
- checks requesting window identity if necessary
- validates project/session ownership
- returns typed errors

Never expose a generic IPC method such as:

```ts
window.api.exec(command)
```

## 21.3 Workspace boundary

When a user opens a project:

1. resolve canonical path
2. check existence
3. check directory
4. record project root
5. show root in UI
6. initialize agent with root
7. treat additional paths as separate grants

Be careful with symlinks.

When enforcing app-owned path rules, compare real paths rather than naive string prefixes.

## 21.4 Secrets

Never store plaintext API keys in normal config JSON.

Use an OS-backed secret strategy.

Possible implementation:

- Electron `safeStorage` for encrypted local values
- or a maintained OS keychain abstraction

Store only secret references in SQLite/config.

## 21.5 Logs

Redact:

- API keys
- bearer tokens
- cookies
- authorization headers
- common secret environment variables

Do not automatically include full source files in diagnostic exports.

## 21.6 Local servers

OpenCode server:

- loopback only
- random port
- random password
- process lifetime only

Any future local HTTP provider must follow the same pattern.

---

# 22. Authentication Strategy

Create a provider authentication abstraction.

```ts
export interface ProviderAuthStatus {
  providerId: string;
  state: "ready" | "missing" | "expired" | "error" | "unknown";
  method?: string;
  message?: string;
}
```

## 22.1 Principles

- do not scrape credentials
- do not copy tokens from another app's private storage
- do not assume interactive CLI subscription auth is allowed for third-party embedding
- prefer supported SDK/CLI authentication paths
- allow user to choose system-installed-agent mode where supported
- display exactly which provider will receive project/task data

---

# 23. Project Model

```ts
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  realPath: string;
  createdAt: string;
  lastOpenedAt: string;
  preferredAgentId?: string;
  preferredRouterId?: string;
  permissionProfileId?: string;
}
```

## 23.1 Project detection

Optional metadata detection:

- git repository
- package manager
- languages
- frameworks
- test commands
- build commands

Do not automatically run arbitrary repository scripts during detection.

Read manifests only.

---

# 24. Persistence Model

Recommended SQLite tables:

```text
projects
conversations
provider_sessions
messages
agent_events
permission_decisions
routing_decisions
routing_rules
workflow_definitions
workflow_role_profiles
workflow_runs
workflow_step_runs
workflow_edges_taken
workflow_artifacts
workflow_loop_state
workflow_reviews
workflow_findings
settings
provider_installations
provider_health
```

## 24.1 Event persistence

Do not necessarily persist every token delta forever.

Recommended:

- persist completed messages
- persist significant activity events
- coalesce high-frequency deltas
- persist final diffs
- persist permission decisions
- optionally persist raw provider trace only in diagnostic mode

## 24.2 Database migration rules

- numbered migrations
- backup before destructive migration
- migration tests
- no ad hoc schema changes on startup

---

# 25. Session Coordinator

This component owns the user-visible conversation.

## 25.1 Responsibilities

- create user-visible conversation
- attach provider session
- route request
- start/continue workflow run
- resolve workflow role to agent + model + effort
- send step to selected adapter
- collect normalized events
- persist messages/events
- track permission waits
- cancel
- resume
- close

## 25.2 State machine

```text
IDLE
  │ send
  ▼
ROUTING (Auto only)
  │
  ▼
WORKFLOW_RESOLUTION
  │
  ▼
STARTING_AGENT
  │
  ▼
RUNNING_STEP
  ├──> WAITING_PERMISSION ──> RUNNING_STEP
  ├──> CANCELLING ─────────> IDLE/FAILED
  ├──> STEP_COMPLETED ─────> NEXT_STEP / LOOP_GATE / WORKFLOW_COMPLETED
  ├──> WORKFLOW_COMPLETED ─> IDLE
  └──> FAILED ─────────────> IDLE
```

State transitions must be centralized.

Do not let random React components mutate session state.

---

# 26. Switching Agents

## 26.1 MVP rule

A provider session belongs to one agent.

If user switches agents mid-conversation:

- create a new provider session
- preserve the same app conversation if user chooses
- provide an explicit handoff summary/context

Do not pretend Codex thread IDs can become Claude session IDs.

## 26.2 Handoff packet

Future/MVP-light version:

```ts
interface AgentHandoff {
  task: string;
  userRequirements: string[];
  completedWork: string[];
  modifiedFiles: string[];
  currentDiff?: string;
  testsRun: string[];
  unresolvedIssues: string[];
}
```

User must see when another provider is about to receive the handoff.

---

# 27. UI Information Architecture

## 27.1 Main workspace

```text
┌────────────────────────────────────────────────────────────┐
│ Project ▼        Agent: Auto ▼       Mode: Auto ▼         │
├───────────────┬────────────────────────────────────────────┤
│ Conversations │ Chat / Agent Activity                      │
│               │                                            │
│ Session A     │ User: Fix auth refresh issue               │
│ Session B     │                                            │
│               │ Router                                    │
│               │ High · Investigation · High effort         │
│               │ → Codex                                    │
│               │                                            │
│               │ Codex                                      │
│               │ ✓ Read AuthService.ts                      │
│               │ ✓ Read TokenManager.ts                     │
│               │ ▶ Running npm test                         │
│               │                                            │
├───────────────┴────────────────────────────────────────────┤
│ message...                              [Send] [Stop]       │
└────────────────────────────────────────────────────────────┘
```

## 27.2 Activity cards

Render cards for:

- message
- plan
- file read
- file edit
- command
- command output
- tool call
- permission
- error
- completed

## 27.3 Permission card

Always show:

- provider
- requested action
- command/path/diff
- reason when available
- scope of approval

Buttons:

- Deny
- Allow once
- Allow for session
- Always allow only when safe and supported

## 27.4 Diff viewer

Must support:

- unified diff
- side-by-side later
- file list
- changed lines count
- open in external editor

Provider-specific diffs normalize into one model.

---

# 28. Settings UI

Sections:

## General

- theme
- update behavior
- diagnostics
- default project behavior

## Agents

For each:

- installed state
- executable/source
- version
- auth state
- tested/untested warning
- integration mode

Example:

```text
Codex
Installed: Yes
Version: x.y.z
Integration: App Server
Path: /...
Status: Ready
```

## Router

- enabled
- agent/provider
- model
- effort
- timeout
- low confidence policy

## Workflow role profiles

Every role exposes Agent, Model, Effort, Mode, and Permission Profile. Changing Agent refreshes the Model list; changing Model refreshes valid Effort/Mode values. Unsupported combinations must be rejected before Save/Run.

```text
Router              → OpenCode / Big Pickle / Low
Low Level Task      → Codex    / Model A    / Low
Medium Level Task   → Codex    / Model A    / Medium
High Level Task     → Claude   / Model B    / High
Review Level Task   → Gemini   / Model C    / High
Bug Fixing Task     → Codex    / Model A    / High
Document Task       → OpenCode / Model D    / Medium
```

## Workflows

- workflow preset picker
- create workflow
- clone workflow
- version workflow
- role step configuration
- per-step agent/model/effort override
- conditional routing
- review/fix loop
- loop max iterations
- loop exhaustion behavior
- create/update document steps
- workflow validation

Built-in presets:

```text
Standard
Review Loop
Review + Documentation
PRD Driven
```

## Routing rules

Routing rules resolve classification into workflow roles. Provider selection comes from the resolved role profile.

## Permissions

- default profile
- per-agent overrides
- remembered project permissions
- clear remembered permissions

---

# 29. IPC Contract

Expose a narrow preload API.

Example:

```ts
interface DesktopApi {
  projects: {
    choose(): Promise<Project | null>;
    list(): Promise<Project[]>;
  };

  agents: {
    list(): Promise<AgentDescriptor[]>;
    refresh(): Promise<AgentDescriptor[]>;
  };

  sessions: {
    create(input: CreateConversationInput): Promise<AppConversation>;
    send(input: SendMessageInput): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };

  workflows: {
    list(): Promise<WorkflowDefinitionSummary[]>;
    get(workflowId: string, version?: number): Promise<WorkflowDefinition>;
    save(input: SaveWorkflowInput): Promise<WorkflowDefinition>;
    validate(input: WorkflowDefinition): Promise<WorkflowValidationResult>;
    clone(workflowId: string): Promise<WorkflowDefinition>;
    run(input: StartWorkflowRunInput): Promise<WorkflowRun>;
    pause(workflowRunId: string): Promise<void>;
    resume(workflowRunId: string): Promise<void>;
    cancel(workflowRunId: string): Promise<void>;
    getRun(workflowRunId: string): Promise<WorkflowRunDetails>;
    onEvent(callback: (event: WorkflowEvent) => void): () => void;
  };

  roleProfiles: {
    getAll(): Promise<RoleExecutionProfile[]>;
    update(profile: RoleExecutionProfile): Promise<RoleExecutionProfile>;
  };

  permissions: {
    respond(input: PermissionResponseInput): Promise<void>;
  };
}
```

No generic file or process API.

---

# 30. Error Taxonomy

Create typed errors.

```ts
type AgentErrorCode =
  | "NOT_INSTALLED"
  | "UNSUPPORTED_VERSION"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "PROCESS_FAILED"
  | "PROTOCOL_ERROR"
  | "SESSION_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "CAPABILITY_UNSUPPORTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "ROUTER_FAILED"
  | "ROUTER_INVALID_OUTPUT"
  | "WORKFLOW_INVALID"
  | "WORKFLOW_OSCILLATION"
  | "WORKFLOW_LOOP_EXHAUSTED"
  | "PROFILE_UNENFORCEABLE"
  | "LOCAL_SERVER_FAILED";
```

User-facing errors should include:

- what failed
- provider
- whether work may have partially completed
- retry action
- diagnostics action

Do not show giant raw stack traces by default.

---

# 31. Version Compatibility Strategy

Coding-agent CLIs change quickly.

Implement a compatibility manifest.

```ts
interface AdapterCompatibility {
  adapterVersion: string;
  testedProviderVersions: string[];
  minSupportedVersion?: string;
  knownUnsupportedVersions?: string[];
}
```

On discovery:

```text
Installed Codex: 0.x
Adapter tested: 0.x–0.y
Result: supported / warning / blocked
```

Prefer warning + capability probe over unnecessary hard blocking.

---

# 32. Observability

## 32.1 Structured logs

Fields:

- timestamp
- app version
- adapter
- provider version
- session ID
- operation
- duration
- status
- error code

## 32.2 Protocol trace mode

Off by default.

When enabled:

- record JSON-RPC/HTTP event metadata
- redact secrets
- consider omitting model text/source content
- auto-expire logs

## 32.3 Diagnostics page

Show:

- app version
- OS
- Electron/Node version
- provider installations
- provider health
- integration modes
- last failures

Allow exporting a sanitized diagnostic bundle.

---

# 33. Testing Strategy

## 33.1 Unit tests

Test:

- router schema validation
- routing rules
- permission rule matching
- event normalization
- path boundary functions
- error mapping
- JSONL buffering
- JSON-RPC request matching
- workflow graph validation
- role profile resolution precedence
- route branch selection
- review PASS/FAIL edge selection
- bounded loop semantics
- loop exhaustion policy
- document create/update input construction
- workflow version immutability

## 33.2 Adapter contract test suite

Create reusable tests that every adapter should satisfy when capability exists.

```ts
agentContract(adapterFactory, {
  expectedCapabilities: {...}
});
```

Contract examples:

- discover
- start
- send
- receive message
- cancel
- permission
- close

## 33.3 Fake agents

Create fake processes/servers.

### Fake JSON-RPC agent

Supports:

- notifications
- server requests
- malformed JSON
- delayed response
- crash

### Fake SSE server

Supports:

- reconnect
- invalid event
- dropped connection
- permission event

## 33.4 Workflow integration tests

Use fake agents to test complete multi-agent workflows without paid model calls.

Required scenarios:

1. Router → Low → Complete.
2. Router → Medium → Review PASS → Document → Complete.
3. Router → High → Review FAIL → Bug Fix → Review PASS → Complete.
4. Review fails until max iterations → exhaustion policy fires.
5. Router → Create PRD → High → Review → Update PRD.
6. Low, Medium, High, Review, Bug Fix, and Document each use different configured agents/models/efforts.
7. Step override precedence is deterministic.
8. Cancel during Review prevents Bug Fix from starting.
9. Restart/recovery reconstructs workflow run state without replaying completed steps.

## 33.5 Provider integration tests

Run against real provider tools in optional CI jobs where credentials/licensing permit.

Never make normal PR validation depend on paid model calls.

## 33.6 Electron E2E

Playwright scenarios:

1. open app
2. choose fixture project
3. select fake agent
4. send task
5. show streaming activity
6. receive permission
7. approve
8. show diff
9. complete
10. restart app
11. session still visible
12. open Workflow settings
13. assign different fake agents/models/efforts to roles
14. run Review + Documentation preset
15. force review failure
16. observe Bug Fix then second Review
17. observe Document step after PASS
18. restart app
19. workflow history still shows exact step configurations
20. event ordering remains correct when two conversations stream concurrently
21. a profile that the selected adapter cannot enforce is blocked before run

## 33.7 Security tests

- malicious project path
- symlink escape
- IPC invalid payload
- command injection attempt
- rogue executable in project folder
- OpenCode non-loopback protection
- secret redaction
- renderer XSS payload in model output

Treat all model output as untrusted text.

---

# 34. Release Strategy

## 34.1 Platforms

- macOS Apple Silicon first
- macOS Intel if required
- Windows x64
- Linux x64

Add ARM variants based on demand.

## 34.2 Provider dependency policy

For each agent choose one or both modes:

### System installation

Use user's installed CLI.

Pros:

- no bundling complexity
- user controls version/auth

Cons:

- compatibility variability

### App-managed integration

Bundle/fetch dependency only when vendor terms and technical architecture make it appropriate.

Pros:

- reproducible version

Cons:

- licensing, size, updates, auth, platform packaging complexity

MVP recommendation:

- support system-installed tools first where practical
- use SDK-managed Claude runtime according to SDK-supported distribution/auth rules
- add app-managed binaries only after legal/licensing/security review

---

# 35. Detailed Implementation Phases

---

## Phase 0 — Repository Bootstrap

### Tasks

- [x] create npm workspace
- [x] create Electron app
- [x] configure TypeScript strict mode
- [x] configure React renderer
- [x] configure preload
- [x] configure ESLint
- [x] configure formatting
- [x] configure Vitest
- [x] configure Playwright Electron test
- [x] add CI
- [x] add basic packaging build
- [x] create `packages/domain`
- [x] create `packages/ipc-contracts`
- [x] create `AGENTS.md`

### Acceptance criteria

- app launches on development machine
- renderer has no Node access
- typed preload method works
- unit tests run
- one Electron E2E smoke test runs
- production package can be built locally

---

## Phase 1 — Domain Model + Core Runtime

### Tasks

- [x] implement AgentDescriptor
- [x] implement AgentCapabilities
- [x] implement AgentSession
- [x] implement AgentRequest
- [x] implement AgentEvent union
- [x] implement permission domain
- [x] implement error taxonomy
- [x] implement EventBus
- [x] implement AgentRegistry
- [x] implement AgentManager
- [x] implement basic SessionCoordinator

### Acceptance criteria

- fake adapter can register
- fake session can start
- fake streamed events reach renderer
- fake completion updates state

---

## Phase 2 — Process + Protocol Infrastructure

### Tasks

- [x] ProcessSupervisor
- [x] executable resolver
- [x] version probe
- [x] JSONL parser
- [x] JSON-RPC transport
- [x] server-request handling
- [x] cancellation
- [x] process cleanup on app exit
- [x] structured stderr capture

### Acceptance criteria

- fake JSON-RPC process passes contract tests
- malformed JSON is isolated
- crash generates typed error
- no orphan process after app quit

---

## Phase 3 — Codex Adapter

### Tasks

- [x] detect Codex
- [x] detect version
- [x] launch app-server
- [x] initialize
- [x] create/resume thread
- [x] start turn
- [x] normalize streamed items
- [x] normalize diff
- [x] usage events
- [x] approvals
- [x] cancellation
- [x] session close
- [x] generated protocol types strategy

### Acceptance criteria

A fixture repository can be used to:

- ask Codex to inspect file
- display streaming response
- show command/file activity
- show approval request
- approve/deny
- show final diff
- stop a turn

---

## Phase 4 — Permission Manager

### Tasks

- [x] normalized requests
- [x] pending decision promises
- [x] renderer permission cards
- [x] allow once
- [x] allow session
- [x] deny
- [x] app remembered-rule engine
- [x] audit history
- [x] risk display

### Acceptance criteria

- adapter can await UI decision
- closing window denies/cancels pending prompts safely
- remembered session rule does not leak across projects

---

## Phase 5 — Claude Adapter

### Tasks

- [x] install Agent SDK
- [x] SDK wrapper isolated in adapter
- [x] auth status
- [x] query/session lifecycle
- [x] event normalization
- [x] `canUseTool`
- [x] plan mode
- [x] effort
- [x] cancellation
- [x] session continuation

### Acceptance criteria

Same contract-style user experience as Codex where Claude capabilities support it.

---

## Phase 6 — Gemini Adapter

### Tasks

- [x] CLI detection
- [x] version detection
- [x] ACP startup
- [x] JSON-RPC transport reuse
- [x] initialize/auth
- [x] new/load session
- [x] prompt
- [x] cancel
- [x] set session mode
- [x] model control where available
- [x] filesystem proxy/security behavior
- [x] stream-json fallback
- [x] capability downgrade UI

### Acceptance criteria

- ACP mode provides interactive desktop session
- fallback mode still streams useful progress
- unsupported interactive features are clearly disabled

---

## Phase 7 — OpenCode Adapter

### Tasks

- [x] discover executable
- [x] spawn local server
- [x] random port
- [x] random password
- [x] health check
- [x] API client
- [x] SSE client
- [x] sessions
- [x] prompts
- [x] cancellation
- [x] permission mapping
- [x] server shutdown
- [x] OpenCode version compatibility

### Acceptance criteria

OpenCode experience uses the same main activity/permission/session UI.

---

## Phase 8 — Router

### Tasks

- [x] routing domain types
- [x] Zod decision schema
- [x] RouterManager
- [x] routing prompt
- [x] OpenCode router implementation
- [x] no-tools router profile
- [x] routing rule engine resolving to WorkflowRole
- [x] `RouteResolution` result
- [x] Auto selector
- [x] confidence fallback
- [x] routing decision card

### Acceptance criteria

User can configure:

```text
Router = OpenCode / Big Pickle
Low = Codex low
Medium = Codex medium
High = Claude high
Document = OpenCode writing profile
```

and Auto executes deterministic **role selection**, after which the role profile selects the configured agent/model/effort.

---


## Phase 9 — Workflow Orchestrator

Phase 9 defines repository interfaces and proves recovery with a deterministic
test repository/snapshot. Phase 10 supplies the durable SQLite implementation.
The minimal Phase 9 builder/run UI is functional scaffolding; Phase 11 completes
the production information architecture and polish.

### Tasks

- [x] `WorkflowRole` domain type
- [x] `RoleExecutionProfile` schema
- [x] global role profile settings
- [x] per-workflow role overrides
- [x] per-step execution overrides
- [x] workflow graph domain model
- [x] workflow graph Zod schemas
- [x] `WorkflowValidator`
- [x] `WorkflowCompiler`
- [x] `WorkflowEngine`
- [x] `WorkflowRunCoordinator`
- [x] `StepExecutor`
- [x] `ContextStore`
- [x] structured `WorkflowStepResult`
- [x] `WorkflowHandoffPacket`
- [x] Router node execution
- [x] re-entrant Router checkpoints (initial/after document/after execution/after review/after fix/before complete)
- [x] `RouterCheckpointInput` schema
- [x] `RouterOrchestrationDecision` schema
- [x] `RouterDecisionRecord` persistence
- [x] router action allowlist validation
- [x] router decision budget + oscillation detection
- [x] workflow `stateVersion` tracking
- [x] Router → Document → Router → Execute flow
- [x] Router → Review/Fix → Router flow
- [x] pre-step `StepAnnouncementIntent`
- [x] deterministic agent/model announcement renderer
- [x] `workflow.step.announced` event
- [x] chat timeline activity message before provider start
- [x] Low/Medium/High routed branches
- [x] Review node
- [x] typed PASS/FAIL review result
- [x] Bug Fix node
- [x] review findings → fix packet handoff
- [x] review/fix loop controller
- [x] finite loop iteration limit
- [x] loop exhaustion policy
- [x] Document create step
- [x] Document update step
- [x] PRD create/update artifact handling
- [x] workflow pause/cancel/failure behavior
- [x] normalized workflow events
- [x] workflow run persistence interfaces
- [x] workflow versioning interfaces
- [x] standard workflow preset
- [x] review loop preset
- [x] review + documentation preset
- [x] PRD-driven preset
- [x] workflow builder UI (form/card MVP acceptable)
- [x] per-step Agent selector
- [x] per-step Model selector
- [x] per-step Effort selector
- [x] per-step Mode selector
- [x] per-step Permission selector
- [x] workflow run progress UI
- [x] loop iteration UI
- [x] structured workflow summary
- [x] unit tests for graph validation
- [x] unit tests for profile resolution precedence
- [x] unit tests for route branching
- [x] unit tests for review PASS path
- [x] unit tests for review FAIL → Fix → Review path
- [x] unit tests for loop exhaustion
- [x] integration test using fake agents across different roles
- [x] integration test for PRD create → execute → update flow

### Acceptance criteria

A user can configure at minimum:

```text
Router            = OpenCode / model / low
Low               = Codex / model / low
Medium            = Codex / model / medium
High              = Claude / model / high
Review            = Gemini / model / high
Bug Fix           = Codex / model / high
Document          = OpenCode / model / medium
```

and save/run workflows such as:

```text
Router → Low/Medium/High → Review ⇄ Bug Fix → Document → Complete
```

```text
Router → Create PRD → Router → Low/Medium/High → Router → Review ⇄ Bug Fix → Router → Update PRD → Router → Complete
```

and the concrete issue-driven orchestration:

```text
"Check GitHub issue #123 and execute it"
    → Router
    → Create PRD
    → Router (using PRD)
    → Execute selected Low/Medium/High role
    → Router (using implementation/tests/diff)
    → Review
    → Router
    → Fix/Review as needed
    → Update PRD
    → Router
    → Complete
```

The workflow must:

- branch using router result;
- allow the Router to run again after a state-changing step;
- allow later Router decisions to use generated PRDs, review results, diffs/tests summaries, and unresolved issues;
- guard against Router oscillation/infinite re-routing;
- emit a user-visible `"<model> is <action>"` activity message before every executable step;
- preserve exact agent/model/effort selection per step;
- pass structured context between different agents;
- stop the review/fix loop on PASS;
- enforce a finite loop maximum;
- show the active node and loop iteration in UI;
- persist enough state to reconstruct run history;
- never silently change providers or permissions.

---

## Phase 10 — Persistence

### Tasks

- [x] SQLite
- [x] migrations
- [x] projects
- [x] conversations
- [x] provider sessions
- [x] messages
- [x] significant events
- [x] permissions
- [x] routing decisions
- [x] workflow definitions + versions
- [x] workflow role profiles
- [x] workflow runs + step runs
- [x] workflow artifacts + review findings
- [x] loop state
- [x] settings

### Acceptance criteria

Restart app and see:

- projects
- conversations
- route used
- final results
- permission history
- workflow definition/version used
- active or completed workflow run, step results, router decisions, edges taken,
  loop counters, announcements, and artifacts without replaying completed steps

---

## Phase 11 — Production UI

### Tasks

- [x] project sidebar
- [x] conversation sidebar
- [x] chat composer
- [x] agent selector
- [x] Auto selector
- [x] mode selector
- [x] effort selector
- [x] activity timeline
- [x] diff viewer
- [x] permission cards
- [x] run details
- [x] settings
- [x] provider status
- [x] diagnostics

### Acceptance criteria

No provider-specific raw protocol JSON is required for normal use.

---

## Phase 12 — Security Hardening

### Tasks

- [x] Electron CSP
- [x] IPC audit
- [x] workspace path canonicalization
- [x] symlink tests
- [x] secret storage
- [x] secret redaction
- [x] local server restrictions
- [x] XSS rendering audit
- [x] permission escape tests
- [x] destructive command UX

---

## Phase 13 — Reliability + Compatibility

### Tasks

- [x] compatibility manifest
- [x] provider version warnings
- [x] capability probes
- [x] process restart strategy
- [x] crash recovery
- [x] SSE reconnect logic
- [x] JSON-RPC timeout/retry rules
- [x] session recovery

---

## Phase 14 — Packaging + Beta

### Tasks

- [ ] macOS packaging/signing
- [ ] Windows installer
- [ ] Linux package
- [ ] auto-update decision
- [ ] crash reporting decision
- [ ] privacy statement
- [ ] license notices
- [ ] provider integration documentation
- [ ] beta feedback flow

---

# 36. MVP Priority Order

If development capacity is limited, build in this order:

```text
1. Electron shell
2. normalized agent interface
3. fake adapter
4. Codex
5. unified permissions
6. Claude
7. Gemini ACP
8. OpenCode
9. router
10. workflow engine + role profiles
11. review/fix loop + document/PRD nodes
12. persistence
13. workflow builder + production UI polish
14. cross-platform packaging
```

Do **not** build the router first.

The router is valuable only after at least one execution agent works reliably.

---

# 37. Codex Implementation Playbook

This section is intentionally written so Codex can execute the project from this file.

## 37.1 Codex operating contract

When Codex is told to implement **Waing** from this plan, it must follow these rules:

1. Read this entire `plan.md` before editing code.
2. Read `AGENTS.md` if it exists.
3. Inspect the repository before assuming structure.
4. Determine the **current phase** from the progress section.
5. Work on only one phase unless explicitly instructed otherwise.
6. Do not silently change architectural decisions in this plan.
7. If a decision is impossible because an upstream API changed, document the mismatch before replacing the approach.
8. Prefer supported provider interfaces over reverse engineering.
9. Keep provider-specific code isolated in adapter packages.
10. Do not introduce provider-specific types into renderer domain state.
11. Run the relevant tests after each meaningful implementation slice.
12. Fix regressions before continuing.
13. Update progress checkboxes only after acceptance criteria pass.
14. Add notes under the phase if implementation differs from the plan.
15. Do not automatically commit, push, publish, or release unless explicitly asked.
16. Never enable dangerous permission modes merely to make tests pass.
17. Never put credentials into the repository.
18. Never weaken Electron security to simplify development.

## 37.2 Required Codex workflow for every phase

### Step A — Orient

Codex should run/read enough to answer:

- What files exist?
- What package manager is used?
- What phase is complete?
- What tests exist?
- What architecture already exists?

Output a short implementation summary before major changes.

### Step B — Convert phase into atomic tasks

Create an internal checklist from the selected phase.

Example for Phase 2:

```text
[ ] ProcessSupervisor interface
[ ] ProcessSupervisor implementation
[ ] executable resolver
[ ] JSONL parser
[ ] JSON-RPC request map
[ ] notification handlers
[ ] server request handlers
[ ] timeout behavior
[ ] tests
```

### Step C — Implement smallest vertical slice

Do not create 30 empty files first.

Example:

1. JSONL parser + tests
2. process wrapper + tests
3. JSON-RPC request/response + tests
4. server request support + tests
5. lifecycle cleanup

### Step D — Validate continuously

After each slice run the narrowest relevant command.

Examples:

```text
pnpm test <package>
pnpm typecheck
pnpm lint <package>
```

At phase end run broader checks.

### Step E — Acceptance review

Compare implementation against every acceptance criterion in this plan.

Do not mark phase complete if one is not demonstrated.

### Step F — Update documentation

Update:

- progress section
- architecture docs if implementation changed
- provider-specific notes
- test commands if changed

## 37.3 Prompt to start Codex on the repository

Use this as the initial instruction:

```text
You are implementing **Waing**, a cross-platform desktop coding-agent orchestrator.

Read plan.md completely, then inspect the repository and AGENTS.md.

Your job is to implement Waing phase-by-phase.
Do not skip ahead.
Do not rewrite the architecture without a concrete incompatibility.
Keep all provider-specific behavior behind adapters.
Keep the renderer provider-neutral.
Preserve Electron security boundaries.

First:
1. identify the current incomplete phase,
2. summarize the existing repository state,
3. list the atomic tasks for that phase,
4. implement the first vertical slice,
5. run relevant tests,
6. continue until that phase's acceptance criteria pass,
7. update plan.md progress.

Do not commit, push, publish, or enable unrestricted permissions unless I explicitly request it.
```

## 37.4 Prompt for resuming later

```text
Resume implementation using plan.md as the source of truth.
Read the progress section and recent git diff first.
Verify previously completed acceptance criteria still pass.
Continue only the current incomplete phase.
Run tests as you go and update plan.md only after validation.
```

## 37.5 Prompt for Codex provider adapter phase

```text
Implement only the Codex adapter phase from plan.md.
Use codex app-server as the integration surface.
Keep transport logic reusable and separate from Codex event normalization.
Use generated protocol definitions when appropriate.
Support long-lived process lifecycle, thread/turn lifecycle, streaming events,
server-initiated approvals, diffs, cancellation, and typed errors.

Do not expose raw Codex protocol types to React.
Add fake protocol tests before relying on real Codex calls.
At the end, demonstrate every Phase 3 acceptance criterion.
```

## 37.6 Prompt for Claude phase

```text
Implement only the Claude adapter phase from plan.md.
Use @anthropic-ai/claude-agent-sdk in the Electron main process.
Keep authentication concerns isolated.
Normalize streaming events and permissions into the shared domain.
Use canUseTool for interactive approvals.
Implement plan mode, effort mapping, cancellation, and session continuation where supported.
Do not leak SDK types into renderer state.
```

## 37.7 Prompt for Gemini phase

```text
Implement only the Gemini adapter phase from plan.md.
Prefer Gemini CLI ACP mode for the rich interactive integration.
Reuse the shared JSON-RPC infrastructure where protocol behavior permits,
but keep ACP semantics isolated in adapter-gemini.
Implement session lifecycle, prompt, cancel, mode changes, and safe filesystem boundaries.
Add stream-json headless mode only as a fallback with downgraded capabilities.
Do not assume unfinished Gemini CLI SDK approval APIs exist.
```

## 37.8 Prompt for OpenCode phase

```text
Implement only the OpenCode adapter phase from plan.md.
Run an application-managed localhost opencode server process.
Bind to loopback, use a random port and random password, health-check it,
and consume events through SSE.
Keep OpenCode version/config differences inside the adapter.
Normalize sessions, activity, permissions, cancellation, and errors.
Do not expose the server to the LAN.
```

## 37.9 Prompt for Router phase

```text
Implement only the router phase from plan.md.
The router classifies work; it must not choose an arbitrary provider.
Validate router output using the strict RoutingDecision schema.
Apply deterministic user routing rules after classification to produce a WorkflowRole.
Do not let router output select an agent/model/permission profile.
Resolve provider/model/effort only after role selection.
Support Router = OpenCode model with a routing-only no-tools profile.
If Agent != Auto, bypass the router completely.
Add tests for low/medium/high, planning, low confidence, malformed output,
and deterministic rule priority.
```

---


## 37.10 Prompt for Workflow Orchestrator phase

```text
Implement only Phase 9 — Workflow Orchestrator from plan.md.

The goal is to make Waing execute reusable multi-agent workflows where every logical role
has a user-configurable agent, model, effort, mode, and permission profile.

Required built-in roles:
- Router
- Low Level Task
- Medium Level Task
- High Level Task
- Review Level Task
- Bug Fixing Task
- Document Task

Implement the domain and engine first, then UI.

Required workflow semantics:
1. Treat Router as a re-entrant orchestration checkpoint, not a one-time classifier.
2. Initial Router classifies the incoming task and chooses only an allowed logical action.
3. Router can choose actions such as create_prd, execute_low/medium/high, review, fix, update_prd, write_documentation, ask_user, or complete.
4. Router MUST NOT choose provider/model/permissions directly; resolve logical action → role/node → user-configured agent/model/effort/mode/permission deterministically.
5. After any configured state-changing step, the graph may return to Router with the new WorkflowStepResult/artifact/review result.
6. Re-routing must use provider-neutral structured context and may recalculate complexity after a PRD, implementation, or review changes understanding of the task.
7. Persist every router checkpoint as RouterDecisionRecord and maintain WorkflowContext.stateVersion.
8. Enforce maxRouterDecisions and same-action-without-state-change oscillation protection.
9. Before starting every executable agent step, emit a StepAnnouncement chat/activity message such as "Opus 4.8 is fixing the bugs". The router supplies activity intent; Waing injects the actual resolved agent/model identity.
10. Only after the announcement has been resolved/persisted should AgentManager start the provider step.
11. Convert provider completion into WorkflowStepResult.
12. Run Review when configured.
13. Review MUST return validated PASS/FAIL plus structured findings.
14. FAIL can route through Router to Bug Fix, then return through Router to Review again.
15. Repeat only until PASS or configured max review attempts.
16. Never implement an unbounded Router loop or Review/Fix loop.
17. On PASS, Router may choose a completion step such as Document/Update PRD, then route again before Complete.
18. Persist exact agent/model/effort, announcement, router decision, and edge taken for every step.
19. Keep workflow-core provider-neutral.

Must support these acceptance workflows:

A)
Router → Low/Medium/High → Review ⇄ Bug Fix → Document → Complete

B)
Router → Create PRD → Router → Low/Medium/High → Router → Review ⇄ Bug Fix → Router → Update PRD → Router → Complete

C) GitHub issue orchestration
"Check GitHub issue #123 and execute it"
→ Router
→ Create PRD
→ Router using the PRD artifact
→ Low/Medium/High execution
→ Router using implementation/test/diff results
→ Review
→ Router
→ Fix/Review loop if needed
→ Update PRD
→ Router
→ Complete

Implementation order:
A. Define workflow roles and execution profile schemas.
B. Define graph nodes, edges, conditions, and Zod validation.
C. Implement profile resolution precedence.
D. Implement WorkflowCompiler and WorkflowValidator.
E. Implement WorkflowContext and structured step results.
F. Implement WorkflowEngine for a simple linear fake-agent workflow.
G. Add Router conditional branches.
H. Add RouterCheckpointInput + RouterOrchestrationDecision + RouterDecisionRecord.
I. Add stateVersion, re-entry edges, router budgets, and oscillation detection.
J. Add StepAnnouncementIntent + deterministic announcement rendering + chat timeline event before provider launch.
K. Prove Router → Document → Router → Execute using fake agents.
L. Add Review PASS/FAIL gate.
M. Add Bug Fix handoff packet.
N. Add bounded review/fix loop.
O. Add Document create/update nodes and artifact references.
P. Add persistence interfaces and workflow events.
Q. Add the four built-in presets.
R. Add builder/configuration UI.
S. Add run progress UI.
T. Run all Phase 9 tests and demonstrate acceptance criteria.

Tests must prove:
- Router can choose Low, Medium, and High paths.
- Router can choose Create PRD, then be invoked again using that PRD and choose an execution role.
- Router can run after execution and choose Review.
- Router can run after Review FAIL and choose Fix, then later choose Review again.
- Router can run after final documentation and choose Complete.
- Router decisions never directly override agent/model/permission configuration.
- Router decision budget stops infinite routing.
- Same mutating decision without state change triggers oscillation protection.
- Step announcement is emitted before the provider start event and uses the actually resolved model display name.
- If provider launch fails, the announcement/activity state is marked failed rather than left running.
- Each role resolves a different agent/model/effort configuration.
- Step override wins over workflow override; workflow override wins over global role default.
- Review PASS exits the loop immediately.
- Review FAIL triggers Bug Fix and then Review again.
- Review/fix cannot exceed the configured maximum.
- Exhaustion follows configured behavior.
- PRD artifact created before execution is available to implementation/review/fix nodes.
- Update PRD receives all prior structured step results.
- Provider-specific protocol types never enter workflow-core or renderer domain state.

Do not integrate real provider-specific behavior directly into WorkflowEngine.
Use fake CodingAgent implementations for engine tests.
Only use AgentManager/CodingAgent abstractions to execute steps.
```

## 37.11 Codex step-by-step implementation rule for workflows

When implementing a workflow feature, Codex must complete one vertical capability at a time:

```text
schema
→ validation
→ engine behavior
→ fake-agent test
→ IPC/domain exposure
→ UI
→ E2E validation
```

For **re-entrant routing**, use this exact implementation sequence:

```text
1. RouterCheckpointInput/RouterOrchestrationDecision schemas
2. allowed-action validation
3. RouterDecisionRecord persistence contract
4. WorkflowContext.stateVersion
5. Router → step → Router re-entry using fake agents
6. router decision budget
7. same-action/no-state-change oscillation guard
8. action → role/node resolution
9. StepAnnouncementIntent
10. resolved agent/model announcement formatter
11. announcement event persisted before AgentManager start
12. GitHub issue → PRD → Router → execute integration test
13. execution → Router → review → Router → fix/review integration test
14. final document → Router → complete integration test
15. UI timeline showing every router/agent handoff
```

Do not skip directly from an agent completion to another agent when the workflow definition requires a Router checkpoint. The new artifact/result is the reason for re-routing.

Do not begin with the visual workflow canvas.
The executable graph, deterministic profile resolution, loop safety, and tests are higher priority.

For every workflow run bug, inspect in this order:

```text
WorkflowDefinition
→ compiled graph
→ WorkflowContext
→ active node
→ resolved RoleExecutionProfile
→ AgentRequest
→ WorkflowStepResult
→ selected outgoing edge
→ loop state
```

This sequence should be documented in `docs/development.md` as the workflow debugging procedure.

---

# 38. Progress Tracker

Codex should maintain this section rather than inventing another progress file unless needed.

## Overall

- [x] Phase 0 — Repository Bootstrap
- [x] Phase 1 — Domain Model + Core Runtime
- [x] Phase 2 — Process + Protocol Infrastructure
- [x] Phase 3 — Codex Adapter
- [x] Phase 4 — Permission Manager
- [x] Phase 5 — Claude Adapter
- [x] Phase 6 — Gemini Adapter
- [x] Phase 7 — OpenCode Adapter
- [x] Phase 8 — Router
- [x] Phase 9 — Workflow Orchestrator
- [x] Phase 10 — Persistence
- [x] Phase 11 — Production UI
- [x] Phase 12 — Security Hardening
- [x] Phase 13 — Reliability + Compatibility
- [ ] Phase 14 — Packaging + Beta

### Current phase

`Phase 14 — Packaging + Beta`

### Last validated commit

`No Git repository; Phase 0 validated in current worktree on July 27, 2026`

### Known blockers

`Phase 0 uses npm workspaces instead of pnpm at user direction. The unpacked local macOS package disables signing; release signing remains Phase 14 work.`

### Architecture deviations

`None recorded`

---

# 39. Definition of Done for MVP

The MVP is done only when all of these are true:

## Product

- [ ] user can open a repository
- [ ] user can choose Codex
- [ ] user can choose Claude
- [ ] user can choose Gemini
- [ ] user can choose OpenCode
- [ ] user can choose Auto
- [ ] router model can be configured
- [ ] deterministic routing rules work
- [ ] routing decision is visible
- [ ] user can select a workflow preset
- [ ] user can configure agent/model/effort per workflow role

## Streaming

- [ ] messages stream
- [ ] commands appear
- [ ] file changes appear
- [ ] diffs appear when available
- [ ] errors appear clearly

## Permissions

- [ ] requests pause safely
- [ ] deny works
- [ ] allow once works
- [ ] session approval works where supported
- [ ] capability differences are shown honestly

## Sessions

- [ ] conversations persist
- [ ] provider session IDs persist where useful
- [ ] cancel works
- [ ] app restart does not corrupt history

## Workflows

- [ ] Router, Low, Medium, High, Review, Bug Fix, and Document roles are independently configurable.
- [ ] Every workflow step records selected agent, model, effort, mode, and permission profile.
- [ ] Router can branch into Low/Medium/High execution.
- [ ] Router can re-enter after state-changing steps and is bounded by decision/oscillation limits.
- [ ] Every executable step is announced with the actually resolved agent/model before provider start.
- [ ] Review can gate completion with structured PASS/FAIL.
- [ ] Review FAIL can execute Bug Fix and return to Review.
- [ ] Review/fix loops are bounded and user-visible.
- [ ] Document nodes can create/update PRD or other configured documents.
- [ ] PRD-driven workflow can create before implementation and update after successful review.
- [ ] Workflow run history can be reconstructed after restart.
- [ ] Unsupported permission-profile mappings fail closed before a provider run starts.

## Security

- [x] no Node in renderer
- [x] IPC is validated
- [x] no plaintext secrets in config
- [x] workspace boundary is tested
- [x] OpenCode is loopback-only
- [x] model output cannot execute renderer JS

## Reliability

- [ ] child processes terminate with app
- [ ] provider crashes produce recoverable UI
- [ ] unsupported versions produce warnings
- [ ] fake adapter contract suite passes

## Cross-platform

- [ ] packaged macOS build works
- [ ] packaged Windows build works
- [ ] packaged Linux build works

---

# 40. Future Architecture Extensions

Once MVP is stable, the architecture should naturally support:

## Planner → Executor

```text
Router
  ↓
Claude Plan
  ↓ approved plan
Codex Execute
```

## Advanced Executor → Reviewer

```text
Codex Execute
  ↓ diff
Gemini Review
  ↓ findings
Codex Fix
```

## Parallel agents

```text
Task
 ├─ Codex
 ├─ Claude
 └─ Gemini
      ↓
comparison/reviewer
```

## Custom agent plugin

Eventually define:

```ts
interface AgentPluginManifest {
  id: string;
  protocol: "acp" | "jsonrpc" | "http" | "custom";
  executable?: string;
  capabilities: Partial<AgentCapabilities>;
}
```

But do not build a generic plugin system before the four built-in adapters are stable.

---

# 41. Major Risks

## Risk: review/fix loops consume excessive time or cost

Mitigation:

- hard maximum iteration count
- visible loop counter
- configurable exhaustion behavior
- per-workflow usage limits later
- require explicit user configuration for high-cost agents

## Risk: cross-agent context becomes inconsistent

Mitigation:

- structured WorkflowStepResult
- provider-neutral handoff packet
- workflow artifacts
- never rely only on free-form transcript forwarding
- persist exact workflow version and step inputs


## Risk: provider APIs change quickly

Mitigation:

- adapter isolation
- capability probes
- compatibility manifest
- generated schemas where available
- integration contract tests

## Risk: permissions are not semantically identical

Mitigation:

- normalized product-level profiles
- adapter-specific mapping
- capability-driven UI
- never promise unavailable guarantees

## Risk: credentials/auth restrictions

Mitigation:

- supported auth only
- provider-specific documentation
- no token scraping
- separate auth architecture

## Risk: Electron attack surface

Mitigation:

- strict renderer isolation
- narrow IPC
- no arbitrary execution API
- output escaping
- main-process privilege boundary

## Risk: agent modifies more than expected

Mitigation:

- project scope
- permissions
- diffs
- git status integration
- future worktree mode

## Risk: router gives bad classification

Mitigation:

- deterministic route policy
- confidence threshold
- manual agent override
- router bypass
- schema validation

---

# 42. Recommended First Beta Scope

Do not expose every option immediately. "First beta" here means the first
external beta after the required adapter, permission, persistence, and UI
acceptance gates pass; it is not permission to skip the phase order.

First beta UX:

```text
Agent:
  Auto
  <only installed, healthy adapters that passed their contract tests>

Mode:
  Auto
  Build
  Plan

Permissions:
  Read Only
  Ask Before Changes
  Auto Edit
```

Hide advanced provider-specific switches behind an Advanced section.

The freeform workflow canvas, parallel execution, custom plugins, and automatic
provider fallback remain hidden. Sequential cross-provider workflow presets may
be enabled only after their fake-agent recovery and persistence tests pass.

This makes the product understandable while keeping the architecture powerful.

---

# 43. Official Integration References

These references should be re-checked during implementation because coding-agent interfaces evolve quickly.

## OpenAI Codex

- Codex App Server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI engineering overview of App Server: https://openai.com/index/unlocking-the-codex-harness/

Key implementation assumptions used by this plan:

- long-lived App Server
- bidirectional JSON-RPC/JSONL
- server-initiated approvals
- streamed turn/item lifecycle
- TypeScript schema generation

## Anthropic Claude

- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Permissions: https://code.claude.com/docs/en/agent-sdk/permissions

Key implementation assumptions:

- TypeScript Agent SDK
- streaming SDK messages
- `canUseTool`
- permission modes
- effort control
- sessions/cancellation

## Google Gemini CLI

- Gemini CLI ACP mode: https://geminicli.com/docs/cli/acp-mode/
- Gemini CLI configuration/reference: https://geminicli.com/docs/reference/configuration/
- Gemini CLI SDK README: https://github.com/google-gemini/gemini-cli/blob/main/packages/sdk/README.md
- Gemini CLI SDK design/status: https://github.com/google-gemini/gemini-cli/blob/main/packages/sdk/SDK_DESIGN.md

Key implementation assumptions:

- ACP is intended for IDE/developer-tool programmatic control
- JSON-RPC over stdio
- session lifecycle and cancellation
- session mode/model controls
- SDK core loop exists but some advanced integration features remain in progress

## OpenCode

- Server API: https://opencode.ai/docs/server/
- Permissions: https://opencode.ai/docs/permissions/

Key implementation assumptions:

- headless HTTP server
- loopback hosting
- OpenAPI spec
- SSE event stream
- evolving permission schema requiring adapter/version isolation

---

# 44. Final Architectural Rule

When future contributors are uncertain where code belongs, use this rule:

```text
If it is about Codex/Claude/Gemini/OpenCode protocol → provider adapter.
If it is about what every agent means to the product → domain/agent-core.
If it is about deciding task class → router-core.
If it is about deciding which agent is allowed to receive that class → routing policy.
If it is privileged OS/process/filesystem work → Electron main.
If it is presentation → renderer.
```

The application should remain functional even if one provider adapter is removed.

That is the test that this is truly a multi-agent orchestrator rather than a wrapper around one vendor.
