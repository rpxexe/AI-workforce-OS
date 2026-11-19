/**
 * Splits a reply into messages of at most `max` characters, at the latest paragraph, line,
 * sentence or word break in the second half of each piece. `max` null means no limit.
 */
export function splitText(text: string, max: number | null): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (max !== null && rest.length > max) {
    const window = rest.slice(0, max);
    let cut = max;
    for (const sep of ["\n\n", "\n", ". ", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= max / 2) {
        cut = at + sep.length;
        break;
      }
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
