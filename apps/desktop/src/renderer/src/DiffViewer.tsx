import { ChevronDown, FileDiff } from "lucide-react";

export type DiffLineKind = "context" | "addition" | "deletion" | "metadata";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedDiffHunk {
  header: string;
  omittedBefore: number;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  oldPath: string | undefined;
  newPath: string | undefined;
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
}

function cleanPath(path: string): string | undefined {
  const trimmed = path.trim().split("\t", 1)[0] ?? "";
  if (trimmed === "/dev/null") return undefined;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? (() => { try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); } })()
    : trimmed;
  return unquoted.replace(/^[ab]\//, "");
}

function pathFromGitHeader(line: string): string | undefined {
  const match = /^diff --git (?:"a\/(.*)"|a\/(.*?)) (?:"b\/(.*)"|b\/(.*))$/.exec(line);
  return match === null ? undefined : match[3] ?? match[4] ?? match[1] ?? match[2];
}

/** Parse the provider-neutral unified diff carried by `diff.updated` into display rows. */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let file: ParsedDiffFile | undefined;
  let hunk: ParsedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let previousOldEnd = 1;
  let previousNewEnd = 1;

  const ensureFile = (path = "Changed file"): ParsedDiffFile => {
    if (file === undefined) {
      file = { path, oldPath: undefined, newPath: undefined, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
    }
    return file;
  };

  for (const line of diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = pathFromGitHeader(line) ?? "Changed file";
      file = { path, oldPath: undefined, newPath: undefined, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = undefined;
      previousOldEnd = 1;
      previousNewEnd = 1;
      continue;
    }
    if (line.startsWith("--- ")) {
      const current = ensureFile();
      current.oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const current = ensureFile();
      current.newPath = cleanPath(line.slice(4));
      current.path = current.newPath ?? current.oldPath ?? current.path;
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunkMatch !== null) {
      const oldStart = Number(hunkMatch[1] ?? 0);
      const newStart = Number(hunkMatch[3] ?? 0);
      hunk = {
        header: (hunkMatch[5] ?? "").trim(),
        omittedBefore: Math.max(0, oldStart - previousOldEnd, newStart - previousNewEnd),
        lines: [],
      };
      ensureFile().hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (hunk === undefined) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "addition", content: line.slice(1), newLine });
      ensureFile().additions += 1;
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "deletion", content: line.slice(1), oldLine });
      ensureFile().deletions += 1;
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "metadata", content: line });
    } else {
      hunk.lines.push({ kind: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
    previousOldEnd = oldLine;
    previousNewEnd = newLine;
  }
  return files.filter((item) => item.hunks.length > 0 || item.oldPath !== undefined || item.newPath !== undefined);
}

function DiffRows({ file }: { file: ParsedDiffFile }) {
  return <div className="diff-code" role="table" aria-label={`Changes in ${file.path}`}>
    {file.hunks.flatMap((hunk, hunkIndex) => {
      const rows = [];
      if (hunk.omittedBefore > 0) rows.push(<div className="diff-gap" role="row" key={`gap-${String(hunkIndex)}`}>
        <span className="diff-gutter" /><span>{hunk.omittedBefore.toLocaleString()} unmodified lines</span>
      </div>);
      if (hunk.header.length > 0) rows.push(<div className="diff-hunk-heading" role="row" key={`heading-${String(hunkIndex)}`}>
        <span className="diff-gutter" /><span>{hunk.header}</span>
      </div>);
      rows.push(...hunk.lines.map((line, lineIndex) => <div className={`diff-line ${line.kind}`} role="row"
        key={`${String(hunkIndex)}-${String(lineIndex)}`}>
        <span className="diff-line-number old" aria-label={line.oldLine === undefined ? undefined : `Old line ${String(line.oldLine)}`}>
          {line.oldLine}</span>
        <span className="diff-line-number new" aria-label={line.newLine === undefined ? undefined : `New line ${String(line.newLine)}`}>
          {line.newLine}</span>
        <span className="diff-marker" aria-hidden="true">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
        <code>{line.content || " "}</code>
      </div>));
      return rows;
    })}
  </div>;
}

export function DiffViewer({ diff }: { diff: string | undefined }) {
  const files = diff === undefined ? [] : parseUnifiedDiff(diff);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return <section className="diff-view">
    <p className="eyebrow">Latest diff{files.length > 0 && ` · ${String(files.length)} ${files.length === 1 ? "file" : "files"}`}</p>
    {diff === undefined ? <p>No file changes yet.</p> : files.length === 0 ? <p>The provider reported a change without a unified diff.</p> : <>
      <div className="diff-summary" aria-label={`${String(additions)} additions and ${String(deletions)} deletions`}>
        <span className="additions">+{additions.toLocaleString()}</span><span className="deletions">−{deletions.toLocaleString()}</span>
      </div>
      <div className="diff-files">{files.map((file, index) => <details open className="diff-file" key={`${file.path}-${String(index)}`}>
        <summary title={file.path}><ChevronDown className="diff-chevron" size={14} aria-hidden="true" />
          <FileDiff size={15} aria-hidden="true" /><strong>{file.path}</strong>
          <span className="diff-file-stats"><b>+{file.additions.toLocaleString()}</b><i>−{file.deletions.toLocaleString()}</i></span>
        </summary>
        <DiffRows file={file} />
      </details>)}</div>
    </>}
  </section>;
}
