import { Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny Markdown subset rendered as React elements (never raw HTML):
 * fenced code, headings, bullet/numbered lists, blockquotes, paragraphs, and inline
 * `code`, **bold**, *italic*, and [links](http…).
 */
export function Markdown({ text }: { text: string }) {
  return <div className="flex flex-col gap-2 text-sm leading-relaxed">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key++} className="m-0 overflow-x-auto rounded-inset border border-line bg-well p-3 font-data text-xs">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <div key={key++} className={`font-semibold text-fg-strong ${h[1]!.length <= 2 ? "text-base" : "text-sm"}`}>
          {inline(h[2]!)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} className={`m-0 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(
        <blockquote key={key++} className="m-0 border-l-2 border-line-strong pl-3 text-muted">
          {inline(q.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push(
      <p key={key++} className="m-0 prose-text">
        {inline(para.join("\n"))}
      </p>,
    );
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (m[1]) parts.push(<code key={k++} className="rounded-inset bg-well px-1 font-data text-xs">{tok.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++} className="text-fg-strong">{tok.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = /^\[([^\]]+)\]/.exec(tok)![1];
      parts.push(
        <a key={k++} href={m[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return parts;
}
