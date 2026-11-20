// No database needed: fake fetch functions stand in for the speech providers, and a local
// WebSocket server for AssemblyAI's live transcription.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ProviderError } from "@workforce/shared";
import { assemblyAIProvider, azureTranscriber, googleTranscriber, openAITranscriber, type STTEvent, type STTProvider } from "@workforce/stt";
import { azureTTSProvider, cartesiaProvider, googleTTSProvider, muLawEncode, openAISpeechProvider, playHTProvider, wavToMulaw, type TTSProvider } from "@workforce/tts";
import type { WebSocket as Socket, WebSocketServer as Server } from "ws";

// ws is a dependency of the stt package, not of the API.
const { WebSocketServer } = createRequire(import.meta.resolve("@workforce/stt"))("ws") as { WebSocketServer: typeof Server };

const KEY = "secret-key-123";

type Call = { url: string; init: RequestInit };
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const headersOf = (call: Call | undefined) => new Headers(call?.init.headers);
const jsonOf = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const streamed = (chunks: Uint8Array[], status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status },
  );

async function collect(audio: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const part of audio) parts.push(part);
  return Buffer.concat(parts);
}
async function* pieces(bytes: Buffer, cuts: number[]) {
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    yield bytes.subarray(from, cut);
    from = cut;
  }
}
const split = (bytes: Buffer, cuts: number[]) =>
  cuts.map((cut, i) => bytes.subarray(cuts[i - 1] ?? 0, cut)).concat(bytes.subarray(cuts.at(-1) ?? 0));

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
/** A streamed-style WAV (sizes 0xFFFFFFFF, a LIST chunk before the data) of interleaved 16-bit samples. */
function wav(samples: number[], { rate = 24000, channels = 1, bits = 16, format = 1 } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const list = Buffer.concat([Buffer.from("LIST"), u32(4), Buffer.from("INFO")]);
  return Buffer.concat([Buffer.from("RIFF"), u32(0xffffffff), Buffer.from("WAVE"), fmt, list, Buffer.from("data"), u32(0xffffffff), data]);
}
const HEADER = 56; // RIFF 12 + fmt 24 + LIST 12 + data 8

// 300 samples at 24 kHz: 99 silent, 99 full-scale positive, 102 full-scale negative.
const SAMPLES = [...Array<number>(99).fill(0), ...Array<number>(99).fill(32767), ...Array<number>(102).fill(-32768)];
const EXPECTED = Buffer.from([...Array<number>(33).fill(0xff), ...Array<number>(33).fill(0x80), ...Array<number>(34).fill(0x00)]);

const isKind = (kind: string) => (err: unknown) => {
  assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`);
  assert.equal(err.kind, kind);
  assert.ok(!err.message.includes(KEY), "the key leaked into the error");
  return true;
};
const signal = () => new AbortController().signal;

test("wavToMulaw resamples 24 kHz to 8 kHz across awkward chunk boundaries", async () => {
  // Cuts inside the RIFF header, inside the LIST chunk, and on odd bytes inside the samples.
  const out = await collect(wavToMulaw(pieces(wav(SAMPLES), [3, 30, 50, HEADER + 3, HEADER + 104, HEADER + 105])));
  assert.equal(out.length, 100);
  assert.deepEqual(out, EXPECTED);
  assert.equal(muLawEncode(0), 0xff);
  assert.equal(muLawEncode(32767), 0x80);
  assert.equal(muLawEncode(-32768), 0x00);
});

test("wavToMulaw mixes stereo, passes mu-law through and rejects other formats", async () => {
  const stereo = await collect(wavToMulaw(pieces(wav([20000, 0, -32768, -32768], { rate: 8000, channels: 2 }), [HEADER + 1])));
  assert.deepEqual(stereo, Buffer.from([muLawEncode(10000), 0x00]));

  const mulaw = wav([], { rate: 8000, bits: 8, format: 7 });
  const passed = await collect(wavToMulaw(pieces(Buffer.concat([mulaw, Buffer.from([1, 2, 3])]), [HEADER + 1])));
  assert.deepEqual(passed, Buffer.from([1, 2, 3]));

  await assert.rejects(collect(wavToMulaw(pieces(wav([0, 0], { bits: 8 }), []))), isKind("invalid"));
  await assert.rejects(collect(wavToMulaw(pieces(Buffer.from("not a wav file"), []))), isKind("invalid"));
});

test("OpenAI-compatible speech posts JSON, starts at once and converts the WAV", async () => {
  const fake = fakeFetch(streamed(split(wav(SAMPLES), [HEADER - 5, HEADER + 7])));
  const tts = openAISpeechProvider({ name: "openai_tts", baseUrl: "https://api.openai.com/v1", apiKey: KEY, model: "gpt-4o-mini-tts", voice: "alloy", fetch: fake.fetch });
  const audio = tts.synthesize("Hello there.", { language: "en", signal: signal() });
  assert.equal(fake.calls.length, 1, "the request starts before the audio is read");
  assert.deepEqual(await collect(audio), EXPECTED);
  assert.equal(fake.calls[0]?.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(headersOf(fake.calls[0]).get("authorization"), `Bearer ${KEY}`);
  assert.deepEqual(jsonOf(fake.calls[0]), { model: "gpt-4o-mini-tts", voice: "alloy", input: "Hello there.", response_format: "wav" });

  // A local server without a key; its FastAPI errors carry `detail`.
  const local = fakeFetch(json({ detail: "GPU queue full" }, 429));
  const studio = openAISpeechProvider({ name: "voicestudio", baseUrl: "http://gpu.local:8000/v1", model: "m", voice: "v", fetch: local.fetch });
  await assert.rejects(collect(studio.synthesize("Hi", { language: "en", signal: signal() })), (err: unknown) => {
    isKind("rate_limit")(err);
    assert.match((err as Error).message, /GPU queue full/);
    return true;
  });
  assert.equal(headersOf(local.calls[0]).get("authorization"), null);
});

test("Google speech asks for 8 kHz MULAW and strips its WAV header", async () => {
  const body = Buffer.concat([wav([], { rate: 8000, bits: 8, format: 7 }), Buffer.from([7, 8, 9])]);
  const fake = fakeFetch(json({ audioContent: body.toString("base64") }), json({ error: { message: "API key not valid" } }, 400), new TypeError("fetch failed"));
  const tts = googleTTSProvider({ apiKey: KEY, voice: "fr-FR-Neural2-A", fetch: fake.fetch });
  assert.deepEqual(await collect(tts.synthesize("Bonjour", { language: "fr", signal: signal() })), Buffer.from([7, 8, 9]));
  assert.equal(fake.calls[0]?.url, `https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY}`);
  assert.deepEqual(jsonOf(fake.calls[0]), {
    input: { text: "Bonjour" },
    voice: { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
    audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
  });
  await assert.rejects(collect(tts.synthesize("x", { language: "en", signal: signal() })), isKind("invalid"));
  await assert.rejects(collect(tts.synthesize("x", { language: "en", signal: signal() })), isKind("unavailable"));
});

test("Azure speech sends escaped SSML and streams the mu-law as is", async () => {
  const fake = fakeFetch(streamed([Buffer.from([1, 2]), Buffer.from([3])]), new Response("", { status: 401 }));
  const tts = azureTTSProvider({ apiKey: KEY, region: "eastus", fetch: fake.fetch });
  assert.deepEqual(await collect(tts.synthesize(`Tom & "Jerry" <3`, { language: "en", signal: signal() })), Buffer.from([1, 2, 3]));
  const call = fake.calls[0];
  assert.equal(call?.url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
  const headers = headersOf(call);
  assert.equal(headers.get("ocp-apim-subscription-key"), KEY);
  assert.equal(headers.get("content-type"), "application/ssml+xml");
  assert.equal(headers.get("x-microsoft-outputformat"), "raw-8khz-8bit-mono-mulaw");
  assert.equal(headers.get("user-agent"), "ai-workforce-os");
  assert.equal(
    call?.init.body,
    `<speak version="1.0" xml:lang="en-US"><voice name="en-US-AvaMultilingualNeural">Tom &amp; &quot;Jerry&quot; &lt;3</voice></speak>`,
  );
  await assert.rejects(collect(tts.synthesize("x", { language: "en", signal: signal() })), isKind("auth"));
});

test("Cartesia posts raw mu-law output format", async () => {
  const fake = fakeFetch(streamed([Buffer.from([4, 5])]), new Response("busy", { status: 500 }));
  const tts = cartesiaProvider({ apiKey: KEY, voice: "voice-1", fetch: fake.fetch });
  const audio = tts.synthesize("Hola", { language: "es", signal: signal() });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(await collect(audio), Buffer.from([4, 5]));
  assert.equal(fake.calls[0]?.url, "https://api.cartesia.ai/tts/bytes");
  assert.equal(headersOf(fake.calls[0]).get("authorization"), `Bearer ${KEY}`);
  assert.equal(headersOf(fake.calls[0]).get("cartesia-version"), "2025-04-16");
  assert.deepEqual(jsonOf(fake.calls[0]), {
    model_id: "sonic-2",
    transcript: "Hola",
    voice: { mode: "id", id: "voice-1" },
    output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
    language: "es",
  });
  await assert.rejects(collect(tts.synthesize("x", { language: "en", signal: signal() })), isKind("unavailable"));
});

test("PlayHT posts the stream request and strips a WAV header", async () => {
  const body = Buffer.concat([wav([], { rate: 8000, bits: 8, format: 7 }), Buffer.from([6])]);
  const fake = fakeFetch(streamed([body, Buffer.from([7])]));
  const tts = playHTProvider({ apiKey: KEY, userId: "user-1", voice: "s3://voice/manifest.json", fetch: fake.fetch });
  assert.deepEqual(await collect(tts.synthesize("Hi", { language: "en", signal: signal() })), Buffer.from([6, 7]));
  assert.equal(fake.calls[0]?.url, "https://api.play.ht/api/v2/tts/stream");
  const headers = headersOf(fake.calls[0]);
  assert.equal(headers.get("authorization"), KEY);
  assert.equal(headers.get("x-user-id"), "user-1");
  assert.equal(headers.get("accept"), "audio/basic");
  assert.deepEqual(jsonOf(fake.calls[0]), {
    text: "Hi",
    voice: "s3://voice/manifest.json",
    voice_engine: "Play3.0-mini",
    output_format: "mulaw",
    sample_rate: 8000,
    language: "english",
  });
});

test("an aborted speech request rejects with the abort, not a provider error", async () => {
  const controller = new AbortController();
  const abortError = new DOMException("aborted", "AbortError");
  controller.abort(abortError);
  const tts: TTSProvider = cartesiaProvider({ apiKey: KEY, voice: "v", fetch: fakeFetch(abortError).fetch });
  await assert.rejects(collect(tts.synthesize("x", { language: "en", signal: controller.signal })), (err: unknown) => err === abortError);
});

/** Each status a transcriber can meet maps to the right kind, without the key in the message. */
async function assertErrorKinds(make: (fetch: typeof globalThis.fetch) => STTProvider, mimeType = "audio/ogg") {
  for (const [status, kind] of [
    [401, "auth"],
    [429, "rate_limit"],
    [500, "unavailable"],
  ] as const) {
    const stt = make(fakeFetch(new Response("no", { status })).fetch);
    await assert.rejects(stt.transcribe!(Buffer.from([1]), { mimeType, language: "en" }), isKind(kind));
  }
  const offline = make(fakeFetch(new TypeError("fetch failed")).fetch);
  await assert.rejects(offline.transcribe!(Buffer.from([1]), { mimeType, language: "en" }), isKind("unavailable"));
}

test("OpenAI-compatible transcription posts multipart and reads the text", async () => {
  const fake = fakeFetch(json({ text: " hello there " }));
  const stt = openAITranscriber({ name: "openai_stt", baseUrl: "https://api.openai.com/v1", apiKey: KEY, model: "whisper-1", fetch: fake.fetch });
  assert.equal(stt.open, undefined);
  assert.equal(await stt.transcribe!(Buffer.from([1, 2, 3]), { mimeType: "audio/ogg; codecs=opus", language: "en" }), "hello there");
  assert.equal(fake.calls[0]?.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(headersOf(fake.calls[0]).get("authorization"), `Bearer ${KEY}`);
  const form = fake.calls[0]?.init.body as FormData;
  assert.equal(form.get("model"), "whisper-1");
  assert.equal(form.get("language"), "en");
  const file = form.get("file") as File;
  assert.equal(file.name, "audio.ogg");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from([1, 2, 3]));

  const local = fakeFetch(json({ text: "hi" }));
  const custom = openAITranscriber({ name: "custom", baseUrl: "http://localhost:9000/v1", model: "m", fetch: local.fetch });
  await custom.transcribe!(Buffer.from([1]), { mimeType: "audio/mpeg", language: "en" });
  assert.equal(headersOf(local.calls[0]).get("authorization"), null);
  assert.equal(((local.calls[0]?.init.body as FormData).get("file") as File).name, "audio.mp3");

  await assertErrorKinds((fetch) => openAITranscriber({ name: "openai_stt", baseUrl: "https://api.openai.com/v1", apiKey: KEY, model: "whisper-1", fetch }));
});

test("Google transcription reads the Opus rate, maps formats and joins results", async () => {
  // An Ogg page whose OpusHead says the input was 16 kHz.
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "latin1");
  opusHead.writeUInt32LE(16000, 12);
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), opusHead]);
  const fake = fakeFetch(json({ results: [{ alternatives: [{ transcript: "hello" }] }, { alternatives: [{ transcript: " world" }] }] }), json({}), json({}));
  const stt = googleTranscriber({ apiKey: KEY, model: "latest_short", fetch: fake.fetch });
  assert.equal(await stt.transcribe!(ogg, { mimeType: "audio/ogg; codecs=opus", language: "en" }), "hello world");
  assert.equal(fake.calls[0]?.url, `https://speech.googleapis.com/v1/speech:recognize?key=${KEY}`);
  assert.deepEqual(jsonOf(fake.calls[0]), {
    config: { encoding: "OGG_OPUS", sampleRateHertz: 16000, languageCode: "en-US", model: "latest_short" },
    audio: { content: ogg.toString("base64") },
  });

  opusHead.writeUInt32LE(44100, 12);
  await stt.transcribe!(Buffer.concat([Buffer.from("OggS"), opusHead]), { mimeType: "audio/ogg", language: "hi" });
  assert.deepEqual(jsonOf(fake.calls[1]).config, { encoding: "OGG_OPUS", sampleRateHertz: 48000, languageCode: "hi-IN", model: "latest_short" });

  assert.equal(await stt.transcribe!(Buffer.from([1]), { mimeType: "audio/wav", language: "en" }), "");
  assert.deepEqual(jsonOf(fake.calls[2]).config, { encoding: "LINEAR16", languageCode: "en-US", model: "latest_short" });

  await assert.rejects(stt.transcribe!(Buffer.from([1]), { mimeType: "audio/aac", language: "en" }), isKind("invalid"));
  await assertErrorKinds((fetch) => googleTranscriber({ apiKey: KEY, fetch }));
});

test("Azure transcription sends the locale and reads the recognition status", async () => {
  const fake = fakeFetch(
    json({ RecognitionStatus: "Success", DisplayText: "Hello there." }),
    json({ RecognitionStatus: "NoMatch" }),
    json({ RecognitionStatus: "BabbleTimeout" }),
  );
  const stt = azureTranscriber({ apiKey: KEY, region: "westeurope", fetch: fake.fetch });
  assert.equal(await stt.transcribe!(Buffer.from([1, 2]), { mimeType: "audio/ogg; codecs=opus", language: "de" }), "Hello there.");
  assert.equal(fake.calls[0]?.url, "https://westeurope.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=de-DE&format=simple");
  assert.equal(headersOf(fake.calls[0]).get("ocp-apim-subscription-key"), KEY);
  assert.equal(headersOf(fake.calls[0]).get("content-type"), "audio/ogg; codecs=opus");
  assert.equal(await stt.transcribe!(Buffer.from([1]), { mimeType: "audio/wav", language: "en" }), "");
  assert.equal(headersOf(fake.calls[1]).get("content-type"), "audio/wav; codecs=audio/pcm; samplerate=16000");
  await assert.rejects(stt.transcribe!(Buffer.from([1]), { mimeType: "audio/wav", language: "en" }), isKind("invalid"));
  await assertErrorKinds((fetch) => azureTranscriber({ apiKey: KEY, region: "westeurope", fetch }));
});

test("AssemblyAI transcription uploads, creates a transcript and polls it", async () => {
  const fake = fakeFetch(
    json({ upload_url: "https://cdn.assemblyai.com/upload/abc" }),
    json({ id: "t1", status: "queued" }),
    json({ id: "t1", status: "processing" }),
    json({ id: "t1", status: "completed", text: "Hello there." }),
  );
  const stt = assemblyAIProvider({ apiKey: KEY, fetch: fake.fetch });
  assert.equal(await stt.transcribe!(Buffer.from([9, 9]), { mimeType: "audio/ogg", language: "en" }), "Hello there.");
  assert.deepEqual(
    fake.calls.map((c) => [c.init.method ?? "GET", c.url]),
    [
      ["POST", "https://api.assemblyai.com/v2/upload"],
      ["POST", "https://api.assemblyai.com/v2/transcript"],
      ["GET", "https://api.assemblyai.com/v2/transcript/t1"],
      ["GET", "https://api.assemblyai.com/v2/transcript/t1"],
    ],
  );
  assert.ok(fake.calls.every((c) => headersOf(c).get("authorization") === KEY));
  assert.deepEqual(Buffer.from(fake.calls[0]?.init.body as Uint8Array), Buffer.from([9, 9]));
  assert.deepEqual(jsonOf(fake.calls[1]), { audio_url: "https://cdn.assemblyai.com/upload/abc", language_code: "en" });

  const failed = fakeFetch(json({ upload_url: "u" }), json({ id: "t2" }), json({ status: "error", error: "Audio file is empty" }));
  await assert.rejects(assemblyAIProvider({ apiKey: KEY, fetch: failed.fetch }).transcribe!(Buffer.from([1]), { mimeType: "audio/ogg", language: "en" }), (err: unknown) => {
    isKind("invalid")(err);
    assert.match((err as Error).message, /Audio file is empty/);
    return true;
  });
  await assertErrorKinds((fetch) => assemblyAIProvider({ apiKey: KEY, fetch }));
});

async function waitFor(condition: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !condition(); await sleep(10)) if (Date.now() > end) throw new Error("timed out waiting");
}

test("AssemblyAI live batches 20 ms frames and emits one turn per turn", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const chunks: Buffer[] = [];
  const texts: string[] = [];
  const connected = new Promise<{ socket: Socket; url: string; auth: string | undefined }>((resolve) =>
    server.on("connection", (socket, req) => {
      socket.on("message", (data, isBinary) => (isBinary ? chunks.push(Buffer.from(data as Buffer)) : texts.push(data.toString())));
      resolve({ socket, url: req.url ?? "", auth: req.headers.authorization });
    }),
  );
  const events: STTEvent[] = [];
  const stt = assemblyAIProvider({ apiKey: KEY, streamingUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v3/ws` });
  const stream = stt.open!({ language: "en", onEvent: (event) => events.push(event) });

  for (let i = 0; i < 10; i++) stream.send(Buffer.alloc(160, i)); // 200 ms, sent while connecting
  const { socket, url, auth } = await connected;
  assert.equal(auth, KEY);
  assert.equal(url, "/v3/ws?sample_rate=8000&encoding=pcm_mulaw&format_turns=true");
  for (let i = 0; i < 6; i++) stream.send(Buffer.alloc(160, 10 + i)); // 120 ms more once open
  await waitFor(() => chunks.length === 3);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [800, 800, 800],
  );
  assert.equal(chunks[0]?.[0], 0);
  assert.equal(chunks[2]?.[799], 14);

  const turn = (turn_order: number, transcript: string, end_of_turn: boolean, turn_is_formatted: boolean) =>
    socket.send(JSON.stringify({ type: "Turn", turn_order, transcript, end_of_turn, turn_is_formatted }));
  socket.send(JSON.stringify({ type: "Begin", id: "session-1" }));
  turn(0, "hello", false, false);
  turn(0, "hello there", true, false);
  turn(0, "Hello there.", true, true);
  turn(1, "bye now", true, false); // its formatted copy never comes
  await waitFor(() => events.length === 3);
  assert.deepEqual(events, [
    { type: "partial", text: "hello" },
    { type: "turn", text: "Hello there." },
    { type: "turn", text: "bye now" },
  ]);

  stream.close();
  await waitFor(() => texts.includes(JSON.stringify({ type: "Terminate" })));
  // The 20 ms left over is under AssemblyAI's 50 ms minimum, so it is dropped rather than sent.
  assert.equal(chunks.length, 3);
  server.close();
});
