import type { StepSummaryEntry, TestRecord, WorkflowStepResult } from "@waing/domain";

/**
 * Every packet the engine hands to an agent is a projection of `WorkflowContext.stepResults`, and a step summary is the
 * executing agent's entire final message. Forwarding all of them verbatim makes each step cost more than the last, so
 * the projections are compacted the way a long-session coding CLI compacts its transcript: a protected tail of recent
 * steps stays readable, everything older collapses to a headline, and bulky evidence (diffs, passing test noise,
 * repeated file paths) is dropped in favour of paths the receiving agent can re-read from the workspace itself.
 *
 * The stored context is never compacted — only what crosses into a prompt.
 */
export interface CompactionBudget {
  /** Newest steps whose summary survives at `summaryChars`; older steps collapse to `collapsedChars`. */
  tailSteps: number;
  /** Character ceiling for a protected step summary. */
  summaryChars: number;
  /** Character ceiling for a collapsed step headline. */
  collapsedChars: number;
  /** Oldest steps beyond this count are dropped entirely and only counted. */
  maxSteps: number;
  /** Character ceiling for a diff that a step genuinely cannot work without. */
  diffChars: number;
  /** Ceiling on the deduplicated changed-file list carried at packet level. */
  maxChangedFiles: number;
}

export const DEFAULT_COMPACTION_BUDGET: CompactionBudget = {
  tailSteps: 2, summaryChars: 1_200, collapsedChars: 240, maxSteps: 8, diffChars: 24_000, maxChangedFiles: 60,
};

export function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

/** The first non-empty line carries the verdict of a step; the rest is reasoning the next agent does not need. */
function headline(summary: string, limit: number): string {
  const first = summary.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return clip(first, limit);
}

/** A passing test is only noise once it is in the past; a failing one is the reason the next step exists. */
function failingTests(tests: TestRecord[]): TestRecord[] { return tests.filter((test) => !test.passed); }

export interface CompactedHistory {
  summaries: StepSummaryEntry[];
  /** Deduplicated across the whole run so no path is ever repeated per entry. */
  changedFiles: string[];
  omittedStepCount: number;
}

/**
 * `results` is oldest-first. `skipCount` drops the newest N steps, which the caller is already sending in full
 * elsewhere (the router checkpoint carries `latestStepResult`, so repeating it in the history would double its cost).
 */
export function compactHistory(results: WorkflowStepResult[], budget: CompactionBudget = DEFAULT_COMPACTION_BUDGET,
  skipCount = 0): CompactedHistory {
  const considered = skipCount > 0 ? results.slice(0, Math.max(0, results.length - skipCount)) : results;
  const kept = considered.slice(-budget.maxSteps);
  const omittedStepCount = considered.length - kept.length;
  const protectedFrom = Math.max(0, kept.length - budget.tailSteps);
  const summaries = kept.map((result, index) => {
    if (index >= protectedFrom) {
      return { role: result.role, summary: clip(result.summary, budget.summaryChars),
        filesChanged: result.filesChanged, testsRun: result.testsRun };
    }
    // Collapsed steps surrender their file list to the packet-level `changedFiles` set rather than repeating it.
    return { role: result.role, summary: headline(result.summary, budget.collapsedChars), filesChanged: [],
      testsRun: failingTests(result.testsRun), collapsed: true };
  });
  const changedFiles = [...new Set(considered.flatMap((result) => result.filesChanged))].slice(-budget.maxChangedFiles);
  return { summaries, changedFiles, omittedStepCount };
}

/**
 * A stored step result keeps its diff for the timeline and for replay, but a diff is the single largest thing in a
 * packet and every role except a reviewer can recover it from the workspace. This drops it on the way into a prompt.
 */
export function withoutDiff(result: WorkflowStepResult, budget: CompactionBudget = DEFAULT_COMPACTION_BUDGET): WorkflowStepResult {
  const stripped = { ...result, summary: clip(result.summary, budget.summaryChars) };
  delete stripped.diff;
  return stripped;
}

/** Only a reviewer needs the literal diff; every other role is in the workspace and can read the files directly. */
export function compactDiff(diff: string | undefined, budget: CompactionBudget = DEFAULT_COMPACTION_BUDGET): string | undefined {
  return diff === undefined ? undefined : clip(diff, budget.diffChars);
}

/** Loops re-report the same blockers every iteration, so the same string is never sent twice. */
export function dedupe(values: string[]): string[] { return [...new Set(values)]; }

/** A loop reruns the same suite each pass; only the latest outcome per command is informative. */
export function latestTestPerCommand(tests: TestRecord[]): TestRecord[] {
  const byCommand = new Map<string, TestRecord>();
  for (const test of tests) byCommand.set(test.command, test);
  return [...byCommand.values()];
}

/**
 * `JSON.stringify` spends a surprising share of a packet's tokens on braces, quotes and repeated keys. Rendering the
 * same data as headed plain text costs roughly half for identical content, and reads better to a model besides.
 */
export function renderPacket(label: string, value: unknown, indent = ""): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const entries = value as unknown[];
    if (entries.length === 0) return "";
    const items = entries.map((item) => typeof item === "object" && item !== null
      ? renderPacket("", item, `${indent}  `).replace(/^\s*/u, `${indent}  - `)
      : `${indent}  - ${scalar(item)}`).filter((line) => line.trim().length > 0);
    return `${indent}${label}:\n${items.join("\n")}`;
  }
  if (typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => renderPacket(key, entry, label === "" ? indent : `${indent}  `))
      .filter((line) => line.length > 0);
    if (lines.length === 0) return "";
    return label === "" ? lines.join("\n") : `${indent}${label}:\n${lines.join("\n")}`;
  }
  const text = scalar(value);
  if (text.length === 0) return "";
  return text.includes("\n") ? `${indent}${label}:\n${text}` : `${indent}${label}: ${text}`;
}

/** Anything that is not a plain scalar carries no meaning in a packet, so it renders to nothing rather than to noise. */
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
