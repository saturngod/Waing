# Waing contributor guide

## Source of truth

- `plan.md` defines product scope, architecture, phase order, acceptance criteria, and the MVP definition of done.
- Implement phases in order and update the plan's progress tracker only after the phase acceptance criteria are demonstrated.

## Architecture boundaries

- Provider-specific protocol types stay inside their adapter package.
- Renderer code communicates with privileged code only through the typed preload API in `@waing/ipc-contracts`.
- The renderer must remain sandboxed, with Node integration disabled and context isolation enabled.
- Validate every IPC request and response at runtime.
- Never expose generic filesystem, process, or shell execution IPC.

## Development workflow

Run `npm run check` before declaring a phase complete. Use `npm run test:e2e` for Electron changes and `npm run package` before packaging milestones. npm is the only package manager used by this repository.

Never commit credentials, weaken permissions to make tests pass, or automatically commit/push/release changes.
