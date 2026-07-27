# Development

## Prerequisites

- Node.js 22 or newer
- npm 11

Install with `npm install`, run the desktop app with `npm run dev`, and run all non-E2E checks with `npm run check`. Run the Electron smoke test with `npm run test:e2e`; create an unpacked local application with `npm run package`.

Release artifacts and native validation are documented in `docs/release.md`. Do not use another workspace package manager; the lockfile and CI contract are npm-based.

## Phase workflow and debugging procedure

For each phase, orient against the current tree and `plan.md`, convert the phase into atomic tasks, implement the smallest vertical slice, run the narrowest relevant test continuously, perform a requirement-by-requirement acceptance review, and only then update the progress tracker. Capture architecture deviations in the tracker rather than allowing silent drift.
