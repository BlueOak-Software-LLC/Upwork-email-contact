import React from "react";

/** Render the email draft's safe formatting subset without injecting HTML. */
export function EmailBodyPreview({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<{ type: "paragraph"; lines: string[] } | { type: "list"; items: string[] }> = [];

  for (const line of lines) {
    const bullet = line.match(/^\s*[•*-]\s+(.+)$/);
    if (bullet) {
      const last = blocks.at(-1);
      if (last?.type === "list") last.items.push(bullet[1] ?? "");
      else blocks.push({ type: "list", items: [bullet[1] ?? ""] });
    } else if (line.trim()) {
      const last = blocks.at(-1);
      if (last?.type === "paragraph") last.lines.push(line.trim());
      else blocks.push({ type: "paragraph", lines: [line.trim()] });
    }
  }

  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted">
      {blocks.map((block, index) =>
        block.type === "list" ? (
          <ul key={index} className="list-disc space-y-1 pl-6">
            {block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineContent(item)}</li>)}
          </ul>
        ) : (
          <p key={index} className="whitespace-pre-wrap">{block.lines.map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>{lineIndex > 0 ? " " : ""}{inlineContent(line)}</React.Fragment>
          ))}</p>
        ),
      )}
    </div>
  );
}

function inlineContent(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      parts.push(<strong key={match.index}>{match[1]}</strong>);
    } else {
      const markdown = match[2] !== undefined;
      const raw = markdown ? match[3] ?? "" : match[4] ?? "";
      const url = raw.replace(/[.,;:!?]+$/, "");
      const trailing = raw.slice(url.length);
      if (/^https?:\/\//i.test(url)) {
        parts.push(
          <React.Fragment key={match.index}>
            <a href={url} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2">
              {markdown ? match[2] : url}
            </a>
            {trailing}
          </React.Fragment>,
        );
      } else {
        parts.push(match[0]);
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
