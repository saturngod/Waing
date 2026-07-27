import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders agent output as Markdown. `react-markdown` builds React elements instead of HTML strings, and no
 * `rehype-raw` plugin is enabled, so raw HTML inside a model's answer stays inert text — the renderer never gets
 * near `dangerouslySetInnerHTML`. Only http(s) links become anchors; the main process opens those externally and
 * blocks in-window navigation, and every other scheme (`javascript:`, `file:`, …) is shown as plain text.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => isSafeLink(href)
        ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span className="md-inert-link">{children}</span>,
      // Tables can be far wider than the column; each one scrolls inside its own box instead of the page.
      table: ({ children }) => <div className="md-table-scroll"><table>{children}</table></div>,
      pre: ({ children }) => <pre className="md-code">{children}</pre>,
    }}>{text}</ReactMarkdown>
  </div>;
}

function isSafeLink(href: string | undefined): href is string {
  if (href === undefined) return false;
  try { return ["http:", "https:"].includes(new URL(href).protocol); } catch { return false; }
}
