// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Both models are faked: these tests cover parsing, storage, retrieval and authorization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { EMBEDDING_DIMENSIONS, type AIProvider, type CompletionRequest, type EmbeddingProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type ConversationDetail,
  type EmployeeDetail,
  type KnowledgeDocument,
  type KnowledgeMatch,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * A stand-in embedder with the one property retrieval depends on: texts that share words get
 * similar vectors. Each word adds to a position chosen by its hash.
 */
const fakeEmbedder: EmbeddingProvider = {
  name: "fake",
  model: "fake-embed-1",
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
        vector[hash] = (vector[hash] ?? 0) + 1;
      }
      return vector;
    });
  },
};

let requests: CompletionRequest[] = [];
const fakeModel: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(request) {
    requests.push(request);
    yield { type: "text", text: "ok" };
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let wsA2: string;
let wsB: string;
let employeeId: string;
let sourceId: string;

type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, headers: Headers, payload?: object) => app.inject({ method, url, headers, payload });
const knowledge = (ws = wsA) => `/workspaces/${ws}/knowledge`;
const createSource = async (name: string, ws = wsA, org = orgA) =>
  (await call("POST", `${knowledge(ws)}/sources`, adminOf(org), { name })).json<KnowledgeSource>();
const upload = (name: string, body: Buffer, headers = adminOf(orgA), source = sourceId, ws = wsA) =>
  app.inject({
    method: "POST",
    url: `${knowledge(ws)}/sources/${source}/documents?name=${encodeURIComponent(name)}`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: body,
  });
const documents = async (source = sourceId) =>
  (await call("GET", `${knowledge()}/sources/${source}`, memberOf(orgA))).json<KnowledgeSourceDetail>().documents;
/** Processing runs in the background; wait for every document in the source to settle. */
const settled = async (source = sourceId) => {
  for (let i = 0; i < 100; i++) {
    const docs = await documents(source);
    if (docs.every((d) => d.status === "READY" || d.status === "FAILED")) return docs;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Documents did not finish processing");
};
const search = async (query: string, headers = memberOf(orgA), ws = wsA, sourceIds?: string[]) =>
  (await call("POST", `${knowledge(ws)}/search`, headers, { query, sourceIds })).json<KnowledgeMatch[]>();
const ask = async (message: string) => {
  const res = await call("POST", `/workspaces/${wsA}/employees/${employeeId}/messages`, adminOf(orgA), { message });
  const last = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", res.payload);
  return last;
};

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: fakeModel, embedder: fakeEmbedder, logger: false });
  const defaultOf = async (org: string) => {
    const [first] = (await call("GET", "/workspaces", adminOf(org))).json<Workspace[]>();
    assert.ok(first);
    return first.id;
  };
  wsA = await defaultOf(orgA);
  wsB = await defaultOf(orgB);
  wsA2 = (await call("POST", "/workspaces", adminOf(orgA), { name: "Second" })).json<Workspace>().id;
  employeeId = (
    await call("POST", `/workspaces/${wsA}/employees`, adminOf(orgA), {
      ...defaultEmployeeConfig(),
      name: "Ava",
      role: "Sales assistant",
    })
  ).json<EmployeeDetail>().id;
  sourceId = (await createSource("Company handbook")).id;
});
beforeEach(() => {
  requests = [];
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("PDF, DOCX, TXT and CSV uploads are processed, and search finds the passage that answers a question", async () => {
  for (const name of ["pricing.pdf", "pricing.docx", "pricing.txt", "pricing.csv"]) {
    const res = await upload(name, fixture(name));
    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(res.json<KnowledgeDocument>().status, "PENDING");
  }
  const holidays = "The office is closed on public holidays. Staff get 25 days of annual leave. Parking is free for visitors.";
  await upload("holidays.txt", Buffer.from(holidays));

  const docs = await settled();
  assert.deepEqual(
    docs.map((d) => [d.name, d.status, d.error]).sort(),
    ["holidays.txt", "pricing.csv", "pricing.docx", "pricing.pdf", "pricing.txt"].map((n) => [n, "READY", null]),
  );
  // The two-page PDF becomes one chunk per page; the others fit in one.
  assert.equal(docs.find((d) => d.name === "pricing.pdf")?.chunkCount, 2);

  const matches = await search("What is the enterprise plan price?");
  assert.ok(matches.length > 0);
  const [best] = matches;
  assert.ok(best);
  assert.match(best.content, /Enterprise.*499/s);
  assert.match(best.documentName, /^pricing\./);
  assert.equal(best.sourceName, "Company handbook");
  assert.deepEqual(
    matches.map((m) => m.score),
    matches.map((m) => m.score).sort((a, b) => b - a),
  );
  // Each match can be traced to a stored document, and a PDF match to its page.
  const pdfMatch = matches.find((m) => m.documentName === "pricing.pdf" && m.content.includes("499"));
  assert.equal(pdfMatch?.page, 2);
  assert.ok(docs.some((d) => d.id === best.documentId));

  const leave = await search("How many days of annual leave do staff get?");
  assert.equal(leave[0]?.documentName, "holidays.txt");
});

test("an employee answers from attached knowledge, and the reply records its sources", async () => {
  const employeeKnowledge = `/workspaces/${wsA}/employees/${employeeId}/knowledge`;

  // Not attached yet: the model is told it has no documents.
  await ask("What is the enterprise plan price?");
  assert.doesNotMatch(requests[0]?.system ?? "", /499/);

  const attached = await call("PUT", employeeKnowledge, adminOf(orgA), { sourceIds: [sourceId] });
  assert.deepEqual(
    attached.json<KnowledgeSource[]>().map((s) => s.name),
    ["Company handbook"],
  );
  assert.equal((await call("GET", employeeKnowledge, memberOf(orgA))).json<KnowledgeSource[]>().length, 1);

  const done = await ask("What is the enterprise plan price?");
  assert.match(requests[1]?.system ?? "", /The Enterprise plan costs \$499 per month/);
  assert.match(requests[1]?.system ?? "", /From "pricing\.\w+"/);
  // The question itself is sent as written, not stuffed with the excerpts.
  assert.deepEqual(requests[1]?.messages.at(-1), { role: "user", content: "What is the enterprise plan price?" });

  const reply = done.messages[1];
  assert.ok(reply.sources.length > 0);
  assert.ok(reply.sources.every((s) => s.sourceName === "Company handbook"));
  assert.ok(reply.sources.some((s) => s.documentName.startsWith("pricing.")));
  // The sources are stored with the message, not just streamed.
  const stored = (
    await call("GET", `/workspaces/${wsA}/employees/${employeeId}/conversations/${done.conversation.id}`, memberOf(orgA))
  ).json<ConversationDetail>();
  assert.deepEqual(stored.messages[1]?.sources, reply.sources);
  assert.deepEqual(stored.messages[0]?.sources, []);

  // Detaching takes effect on the next message.
  await call("PUT", employeeKnowledge, adminOf(orgA), { sourceIds: [] });
  const after = await ask("What is the enterprise plan price?");
  assert.doesNotMatch(requests[2]?.system ?? "", /499/);
  assert.deepEqual(after.messages[1].sources, []);
});

test("bad uploads are refused or marked failed, and reprocessing replaces chunks instead of adding to them", async () => {
  const scratch = (await createSource("Scratch")).id;

  assert.equal((await upload("notes.exe", Buffer.from("x"), adminOf(orgA), scratch)).statusCode, 400);
  assert.equal((await upload("empty.txt", Buffer.alloc(0), adminOf(orgA), scratch)).statusCode, 400);
  assert.equal((await upload("big.txt", Buffer.alloc(10 * 1024 * 1024 + 1, "a"), adminOf(orgA), scratch)).statusCode, 413);

  // A file that is not what its name says is stored, then fails with a reason a person can act on.
  await upload("broken.pdf", Buffer.from("this is not a pdf"), adminOf(orgA), scratch);
  await upload("blank.txt", Buffer.from("   \n\n  "), adminOf(orgA), scratch);
  const good = (await upload("pricing.txt", fixture("pricing.txt"), adminOf(orgA), scratch)).json<KnowledgeDocument>();
  const docs = await settled(scratch);
  const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
  assert.equal(byName["broken.pdf"]?.status, "FAILED");
  assert.match(byName["broken.pdf"]?.error ?? "", /could not be read/);
  assert.match(byName["blank.txt"]?.error ?? "", /No text was found/);
  assert.equal(byName["pricing.txt"]?.status, "READY");

  const chunks = () => prisma.knowledgeChunk.count({ where: { documentId: good.id } });
  const embeddings = () => prisma.embedding.count({ where: { chunk: { documentId: good.id } } });
  assert.deepEqual([await chunks(), await embeddings()], [1, 1]);
  const again = await call("POST", `${knowledge()}/documents/${good.id}/reprocess`, adminOf(orgA));
  assert.equal(again.json<KnowledgeDocument>().status, "PENDING");
  await settled(scratch);
  assert.deepEqual([await chunks(), await embeddings()], [1, 1]);

  // Deleting a document removes it from search; deleting the source removes the rest.
  assert.ok((await search("enterprise plan", memberOf(orgA), wsA, [scratch])).length > 0);
  assert.equal((await call("DELETE", `${knowledge()}/documents/${good.id}`, adminOf(orgA))).statusCode, 204);
  assert.deepEqual(await search("enterprise plan", memberOf(orgA), wsA, [scratch]), []);
  assert.equal((await call("DELETE", `${knowledge()}/sources/${scratch}`, adminOf(orgA))).statusCode, 204);
  assert.equal(await prisma.knowledgeDocument.count({ where: { sourceId: scratch } }), 0);
});

test("authorization: members read and search, only admins change knowledge", async () => {
  const member = memberOf(orgA);
  assert.equal((await call("GET", `${knowledge()}/sources`, member)).statusCode, 200);
  assert.equal((await call("POST", `${knowledge()}/search`, member, { query: "price" })).statusCode, 200);

  assert.equal((await call("GET", `${knowledge()}/sources`, {})).statusCode, 401);
  assert.equal((await call("POST", `${knowledge()}/sources`, member, { name: "Mine" })).statusCode, 403);
  assert.equal((await upload("a.txt", Buffer.from("hello"), member)).statusCode, 403);
  assert.equal((await call("DELETE", `${knowledge()}/sources/${sourceId}`, member)).statusCode, 403);
  const [doc] = await documents();
  assert.ok(doc);
  assert.equal((await call("DELETE", `${knowledge()}/documents/${doc.id}`, member)).statusCode, 403);
  assert.equal((await call("POST", `${knowledge()}/documents/${doc.id}/reprocess`, member)).statusCode, 403);
  const attach = `/workspaces/${wsA}/employees/${employeeId}/knowledge`;
  assert.equal((await call("PUT", attach, member, { sourceIds: [sourceId] })).statusCode, 403);
});

test("isolation: another organization or workspace cannot read, search, change or attach knowledge", async () => {
  const [doc] = await documents();
  assert.ok(doc);
  const outsider = adminOf(orgB);

  // Using our workspace id: the workspace itself is not found.
  for (const [method, url] of [
    ["GET", `${knowledge()}/sources`],
    ["GET", `${knowledge()}/sources/${sourceId}`],
    ["DELETE", `${knowledge()}/sources/${sourceId}`],
    ["DELETE", `${knowledge()}/documents/${doc.id}`],
    ["POST", `${knowledge()}/documents/${doc.id}/reprocess`],
  ] as const)
    assert.equal((await call(method, url, outsider)).statusCode, 404, `${method} ${url}`);
  assert.equal((await call("POST", `${knowledge()}/search`, outsider, { query: "enterprise" })).statusCode, 404);
  assert.equal((await upload("a.txt", Buffer.from("hello"), outsider)).statusCode, 404);

  // Using their own workspace, or our second workspace, with our ids: nothing is found there.
  for (const [headers, ws] of [
    [outsider, wsB],
    [adminOf(orgA), wsA2],
  ] as const) {
    assert.deepEqual((await call("GET", `${knowledge(ws)}/sources`, headers)).json(), []);
    assert.equal((await call("GET", `${knowledge(ws)}/sources/${sourceId}`, headers)).statusCode, 404);
    assert.equal((await call("DELETE", `${knowledge(ws)}/sources/${sourceId}`, headers)).statusCode, 404);
    assert.equal((await call("DELETE", `${knowledge(ws)}/documents/${doc.id}`, headers)).statusCode, 404);
    assert.equal((await upload("a.txt", Buffer.from("hello"), headers, sourceId, ws)).statusCode, 404);
    // Naming our source in a search from elsewhere returns nothing.
    assert.deepEqual(await search("enterprise plan price", headers, ws, [sourceId]), []);
    assert.deepEqual(await search("enterprise plan price", headers, ws), []);
  }

  // A source in another workspace cannot be attached to an employee here.
  const elsewhere = (await createSource("Other workspace", wsA2)).id;
  const attach = `/workspaces/${wsA}/employees/${employeeId}/knowledge`;
  assert.equal((await call("PUT", attach, adminOf(orgA), { sourceIds: [elsewhere] })).statusCode, 404);
  assert.deepEqual((await call("GET", attach, adminOf(orgA))).json(), []);

  // Everything is still there for its owner.
  assert.equal((await documents()).length, 5);
});
