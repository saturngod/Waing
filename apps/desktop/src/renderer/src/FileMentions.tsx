import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FileText } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import type { WorkspaceFile } from "@waing/domain";

/**
 * A mention is the `@` closest to the caret with no whitespace after it, and it only counts at the start of a
 * word — an email address or a decorator mid-word must not open the picker.
 */
const MENTION_PATTERN = /(?:^|\s)@([^\s@]*)$/u;
const MENTION_LIMIT = 8;
/** Long enough that a burst of keystrokes issues one lookup, short enough to feel like it tracks typing. */
const MENTION_DEBOUNCE_MS = 90;

interface MentionToken { start: number; query: string }

export interface FileMentions {
  open: boolean;
  matches: WorkspaceFile[];
  activeIndex: number;
  truncated: boolean;
  /** Recomputes the token from the live caret; call it whenever the caret or the text may have moved. */
  refresh: () => void;
  /** Closes the picker outright, for when focus leaves the composer. */
  dismiss: () => void;
  /** Returns true when the key was consumed, in which case the caller must not also act on it. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  accept: (entry: WorkspaceFile) => void;
  setActiveIndex: (index: number) => void;
}

/**
 * Drives the `@` file picker for a textarea. Matching happens in the main process against a cached workspace
 * index, so this only tracks which token is being typed and which row is highlighted.
 */
export function useFileMentions(projectId: string | undefined, inputRef: RefObject<HTMLTextAreaElement | null>,
  onChange: (next: string) => void): FileMentions {
  const [token, setToken] = useState<MentionToken>();
  const [matches, setMatches] = useState<WorkspaceFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape closes the picker for the mention being typed, not for every later one.
  const [dismissedStart, setDismissedStart] = useState<number>();
  const requestRef = useRef(0);
  const query = token?.query;

  const refresh = useCallback(() => {
    const element = inputRef.current;
    if (element === null) { setToken(undefined); return; }
    // Read the DOM rather than React state: during onChange the element already holds the new value.
    const caret = element.selectionStart;
    const match = MENTION_PATTERN.exec(element.value.slice(0, caret));
    if (match === null) { setToken(undefined); return; }
    const typed = match[1] ?? "";
    const start = caret - typed.length - 1;
    setToken((current) => current?.start === start && current.query === typed ? current : { start, query: typed });
  }, [inputRef]);

  useEffect(() => {
    if (projectId === undefined || query === undefined) { setMatches([]); setTruncated(false); return; }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const timer = window.setTimeout(() => {
      void window.waing.files.search(projectId, query, MENTION_LIMIT).then((result) => {
        // A slower earlier lookup must not overwrite the answer for what the user is typing now.
        if (requestRef.current !== requestId) return;
        setMatches(result.matches); setTruncated(result.truncated); setActiveIndex(0);
      }).catch(() => { if (requestRef.current === requestId) { setMatches([]); setTruncated(false); } });
    }, MENTION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [projectId, query]);

  const open = token !== undefined && matches.length > 0 && token.start !== dismissedStart;

  const accept = useCallback((entry: WorkspaceFile) => {
    const element = inputRef.current;
    if (element === null || token === undefined) return;
    const caret = element.selectionStart;
    const next = `${element.value.slice(0, token.start)}@${entry.path} ${element.value.slice(caret)}`;
    const cursor = token.start + entry.path.length + 2;
    onChange(next);
    setToken(undefined);
    // The value lands on the next render, so the caret can only be placed after React has written it.
    window.requestAnimationFrame(() => { element.focus(); element.setSelectionRange(cursor, cursor); });
  }, [inputRef, onChange, token]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown") { setActiveIndex((index) => (index + 1) % matches.length); return true; }
    if (event.key === "ArrowUp") { setActiveIndex((index) => (index - 1 + matches.length) % matches.length); return true; }
    if (event.key === "Escape") { setDismissedStart(token?.start); return true; }
    // Cmd/Ctrl+Enter is Send even with the picker open; a bare Enter or Tab completes the highlighted row.
    if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
      const entry = matches[activeIndex];
      if (entry === undefined) return false;
      accept(entry); return true;
    }
    return false;
  }, [accept, activeIndex, matches, open, token?.start]);

  const dismiss = useCallback(() => setToken(undefined), []);

  return { open, matches, activeIndex, truncated, refresh, dismiss, handleKeyDown, accept, setActiveIndex };
}

export function FileMentionList({ mentions }: { mentions: FileMentions }): React.JSX.Element | null {
  const listRef = useRef<HTMLUListElement>(null);
  const { open, matches, activeIndex, truncated, accept, setActiveIndex } = mentions;

  useEffect(() => {
    listRef.current?.querySelector("[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, matches]);

  if (!open) return null;
  return (
    <div className="mention-popover">
      <ul role="listbox" aria-label="Project files" ref={listRef}>
        {matches.map((entry, index) => (
          <li key={`${entry.kind}:${entry.path}`} role="option" aria-selected={index === activeIndex}
            className={index === activeIndex ? "active" : undefined}
            // mousedown, not click: the default would blur the composer before the insertion runs.
            onMouseDown={(event) => { event.preventDefault(); accept(entry); }}
            onMouseMove={() => setActiveIndex(index)}>
            {entry.kind === "directory" ? <Folder size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            <span className="mention-name">{entry.name}</span>
            <span className="mention-path">{entry.path}</span>
          </li>
        ))}
      </ul>
      {truncated && <p className="mention-note">This project is large — narrow the search to see more.</p>}
    </div>
  );
}
