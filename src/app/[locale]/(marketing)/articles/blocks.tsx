import type { ReactNode } from "react";

import styles from "./page.module.css";

/** The three block kinds an article is written in. */
export type Block =
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] };

/** `**bold**` — the only inline markup an article may use. */
function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={key++}>{m[1]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "h3":
      return (
        <h3 key={key} className={styles.heading}>
          {block.text}
        </h3>
      );
    case "ul":
      return (
        <ul key={key} className={styles.list}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "p":
    default:
      return (
        <p key={key} className={styles.paragraph}>
          {renderInline(block.text)}
        </p>
      );
  }
}
