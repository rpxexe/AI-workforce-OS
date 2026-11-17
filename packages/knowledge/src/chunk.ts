import type { Section } from "./parse.ts";

/** Characters, not tokens: roughly 300 tokens of English, small enough to stay on one topic. */
const SIZE = 1200;
/** Repeated from the end of one chunk at the start of the next, so a fact split by a cut survives. */
const OVERLAP = 150;

export type Chunk = { content: string; page: number | null };

/** Breaks text into pieces no longer than SIZE, preferring paragraph, then sentence, boundaries. */
const units = (text: string) =>
  text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => (paragraph.length <= SIZE ? [paragraph] : (paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph])))
    .flatMap((unit) => (unit.length <= SIZE ? [unit] : (unit.match(new RegExp(`[^]{1,${SIZE}}`, "g")) ?? [])))
    .map((unit) => unit.trim())
    .filter(Boolean);

/** Packs units into chunks of up to SIZE characters. */
function pack(pieces: string[], separator: string, overlap: boolean) {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + separator.length + piece.length > SIZE) {
      chunks.push(current);
      // Start the next chunk with the tail of this one, from a word boundary.
      current = overlap ? current.slice(-OVERLAP).replace(/^\S*\s+/, "") : "";
    }
    current += (current ? separator : "") + piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function chunkSections(sections: Section[]): Chunk[] {
  return sections.flatMap(({ text, page, header }) => {
    const contents =
      header === undefined
        ? pack(units(text), "\n\n", true)
        : // Table rows: whole rows only, each chunk led by the column names.
          pack(text.split("\n").filter((row) => row.trim()), "\n", false).map((rows) => `${header}\n${rows}`);
    return contents.map((content) => ({ content, page: page ?? null }));
  });
}
