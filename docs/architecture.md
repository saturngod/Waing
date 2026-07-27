# Architecture

Waing uses an Electron main/preload/renderer split. Privileged operations are owned by the main process. The sandboxed React renderer can call only the narrow `DesktopApi` exposed through context isolation. Shared domain and IPC packages prevent provider protocol details from entering renderer code.

Provider adapters, the agent runtime, router, workflow engine, security layer, and persistence will be added as isolated workspace packages in the phase order specified by `plan.md`.
