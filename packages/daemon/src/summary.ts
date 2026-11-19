/**
 * A short, faithful list title for a question: the user's own text, cut at a
 * word/sentence boundary when too long, with an explicit ellipsis.
 */
export function summarize(body: string, max = 160): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = Math.max(
    cut.lastIndexOf(" "),
    cut.lastIndexOf("。"),
    cut.lastIndexOf("，"),
    cut.lastIndexOf("；"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("\n"),
  );
  const head = (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s,;:，；：-]+$/, "");
  return `${head}…`;
}
