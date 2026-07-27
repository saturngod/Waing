# Provider contract

Every provider adapter implements the normalized `CodingAgent` contract described in `plan.md`. Raw provider protocol payloads stay inside adapters. Capabilities are discovered at runtime, and unsupported operations fail with typed capability errors.

## Integration paths and compatibility

| Provider | Transport | Tested compatibility | Session recovery |
| --- | --- | --- | --- |
| Codex | `codex app-server --stdio`, JSON-RPC/JSONL | 0.145.x | provider thread resume |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | 0.3.x SDK | SDK resume identifier |
| Antigravity | `agy --print` non-interactive process, stdout text | 1.1.x | none (one process per run) |
| OpenCode | loopback HTTP/SSE with process-scoped basic auth | 1.x | provider session load |

Discovery resolves executables only from explicit `PATH` entries, probes versions without a shell, publishes provider warnings outside tested ranges, and records capability/health snapshots locally. The runtime blocks unsupported plan, effort, cancellation, or persistence controls before a provider run starts.

OpenCode binds only to `127.0.0.1` on a random port with a random process-lifetime password. SSE reconnects use bounded exponential backoff. JSON-RPC operations have explicit timeouts; retries are opt-in for operations the caller knows are safe to repeat.

Antigravity's print mode approves its own tool calls, so Waing cannot prompt before its file writes or commands. That limitation is published as a descriptor warning and shown in Settings rather than hidden behind a permission profile it cannot enforce.

Provider CLIs retain responsibility for vendor authentication. Waing never copies their credentials into workflow definitions or routing decisions.
