import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/**
 * Renders agent output as Markdown. `react-markdown` builds React elements instead of HTML strings, and no
 * `rehype-raw` plugin is enabled, so raw HTML inside a model's answer stays inert text — the renderer never gets
 * near `dangerouslySetInnerHTML`. Safe web links and project-scoped local paths are handed to a narrow preload API;
 * the main process opens them with the system default app and blocks in-window navigation.
 *
 * `rehype-highlight` tokenizes fenced code with lowlight, which emits the same hast the rest of the tree is built
 * from — highlighting stays inside the React element pipeline. `detect` is off so only fences that name a language
 * are colored: guessing on plain command output paints it in convincing but meaningless colors.
 *
 * Memoized because parsing is the single most expensive thing the renderer does, and every keystroke in the
 * composer re-renders the whole app. Settled turns never change their text, so they must not be re-parsed.
 */
export const Markdown = memo(function Markdown({ text, projectId }: { text: string; projectId?: string }) {
  return <div className="markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={{
      a: ({ href, children }) => isSafeLink(href, projectId)
        ? <a href={href} onClick={(event) => { event.preventDefault();
          void window.waing.system.openLink(href, projectId).catch(() => undefined); }}>{children}</a>
        : <span className="md-inert-link">{children}</span>,
      // Tables can be far wider than the column; each one scrolls inside its own box instead of the page.
      table: ({ children }) => <div className="md-table-scroll"><table>{children}</table></div>,
      pre: ({ children }) => <pre className="md-code">{children}</pre>,
    }}>{text}</ReactMarkdown>
  </div>;
});

function isSafeLink(href: string | undefined, projectId: string | undefined): href is string {
  if (href === undefined) return false;
  try { return ["http:", "https:", "mailto:"].includes(new URL(href).protocol) || new URL(href).protocol === "file:" && projectId !== undefined; }
  catch { return projectId !== undefined && !href.startsWith("#"); }
}
