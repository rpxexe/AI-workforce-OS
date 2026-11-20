import { ProviderError } from "@workforce/shared";

/** G.711 mu-law for one 16-bit sample (bias 0x84, clipped at 32635). */
export function muLawEncode(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(s, 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(s & mask); mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((s >> (exponent + 3)) & 0x0f)) & 0xff;
}

/** Skips a WAV header if one is sent: the phone needs bare mu-law bytes. */
export function stripWavHeader(first: Buffer) {
  if (first.subarray(0, 4).toString("latin1") !== "RIFF") return first;
  const data = first.indexOf("data", 12, "latin1");
  return data === -1 ? first : first.subarray(data + 8);
}

type Format = { format: number; channels: number; rate: number; bits: number };

// A header bigger than this is not a speech WAV; stops an endpoint from making us buffer forever.
const MAX_HEADER_BYTES = 1 << 20;

/** The format and where the samples start, or undefined until enough of the header has arrived. */
function parseHeader(head: Buffer): { format: Format; offset: number } | undefined {
  if (head.length < 12) return;
  if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw new ProviderError("invalid", "The speech audio is not a WAV file");
  let format: Format | undefined;
  for (let at = 12; at + 8 <= head.length; ) {
    const id = head.toString("latin1", at, at + 4);
    const size = head.readUInt32LE(at + 4);
    // The data size is ignored: streamed WAVs often say 0 or 0xFFFFFFFF.
    if (id === "data") {
      if (!format) throw new ProviderError("invalid", "The WAV audio has no format chunk");
      return { format, offset: at + 8 };
    }
    const end = at + 8 + size + (size % 2);
    if (end > head.length) break;
    if (id === "fmt ") {
      if (size < 16) throw new ProviderError("invalid", "The WAV format chunk is too short");
      const tag = head.readUInt16LE(at + 8);
      format = {
        // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
        format: tag === 0xfffe && size >= 26 ? head.readUInt16LE(at + 32) : tag,
        channels: head.readUInt16LE(at + 10),
        rate: head.readUInt32LE(at + 12),
        bits: head.readUInt16LE(at + 22),
      };
    }
    at = end;
  }
  if (head.length > MAX_HEADER_BYTES) throw new ProviderError("invalid", "The WAV header is too large");
  return;
}

/** Turns a stream of WAV bytes into mu-law, keeping partial frames and the resampling position between chunks. */
function converter({ format, channels, rate, bits }: Format): (bytes: Buffer) => Buffer {
  if (format === 7 && rate === 8000 && channels === 1) return (bytes) => bytes;
  if (format !== 1 || bits !== 16 || channels < 1 || rate < 1)
    throw new ProviderError("invalid", `Speech audio must be 16-bit PCM WAV, not format ${format} with ${bits} bits`);
  const frame = 2 * channels;
  const step = rate / 8000; // source samples per output sample
  let rest = Buffer.alloc(0);
  let read = 0;
  let made = 0;
  let sum = 0;
  let count = 0;
  let last = 0;
  return (bytes) => {
    const all = rest.length ? Buffer.concat([rest, bytes]) : bytes;
    const whole = all.length - (all.length % frame);
    rest = Buffer.from(all.subarray(whole));
    const out: number[] = [];
    for (let at = 0; at < whole; at += frame) {
      let mixed = 0;
      for (let c = 0; c < channels; c++) mixed += all.readInt16LE(at + 2 * c);
      sum += mixed / channels;
      count++;
      read++;
      // Box filter: each output sample is the mean of the source samples in its window.
      while (read >= step * (made + 1)) {
        if (count) last = sum / count;
        out.push(muLawEncode(last));
        sum = 0;
        count = 0;
        made++;
      }
    }
    return Buffer.from(out);
  };
}

/** 8 kHz mono mu-law from a streamed 16-bit PCM WAV (any rate, any channel count), as it arrives. */
export async function* wavToMulaw(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0);
  let convert: ((bytes: Buffer) => Buffer) | undefined;
  for await (const chunk of chunks) {
    let bytes = Buffer.from(chunk);
    if (!convert) {
      head = Buffer.concat([head, bytes]);
      const parsed = parseHeader(head);
      if (!parsed) continue;
      convert = converter(parsed.format);
      bytes = head.subarray(parsed.offset);
    }
    const audio = convert(bytes);
    if (audio.length) yield audio;
  }
  if (!convert) throw new ProviderError("invalid", "The speech audio ended before its WAV header did");
}
