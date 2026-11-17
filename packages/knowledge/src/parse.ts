import type { KnowledgeKind } from "@workforce/shared";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** A stretch of a document's text. `header` (CSV column names) is repeated on every chunk cut from it. */
export type Section = { text: string; page?: number; header?: string };

/** UTF-8 text, without the byte-order mark some editors put first. */
const decode = (bytes: Uint8Array) => {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/** Extracts the text of an uploaded file. Throws if the file cannot be read as its kind. */
export async function parseDocument(kind: KnowledgeKind, bytes: Uint8Array): Promise<Section[]> {
  switch (kind) {
    case "txt":
      return [{ text: decode(bytes) }];
    case "csv": {
      // Each row only makes sense next to the column names, so they travel with every chunk.
      const [header = "", ...rows] = decode(bytes).split(/\r?\n/);
      return [{ text: rows.join("\n"), header }];
    }
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return [{ text: value }];
    }
    case "pdf": {
      // unpdf takes ownership of the array it is given, so it gets a copy.
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      return text.map((pageText, i) => ({ text: pageText, page: i + 1 }));
    }
  }
}
