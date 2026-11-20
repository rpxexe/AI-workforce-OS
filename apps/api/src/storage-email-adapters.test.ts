// Phase 14 storage and email adapters against fake fetch / a fake SMTP transport: no network, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError } from "@workforce/channels";
import { ProviderError } from "@workforce/shared";

// @workforce/providers reaches @workforce/database (through @workforce/tools), which refuses to load without a
// URL; the client never connects here.
process.env.DATABASE_URL ??= "postgresql://unused@127.0.0.1:1/unused";
const { awsS3, azureBlobStorage, gcs, r2, s3Compatible, s3Storage, sendGridEmail, sesEmail, signV4, smtpEmail } = await import("@workforce/providers");

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fetch that records calls and answers with the given responses in turn (the last repeats); an Error is thrown. */
function fakeFetch(...responses: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: body === undefined ? undefined : typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString(),
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  }) as typeof fetch;
  return { http, calls };
}

const xmlError = (status: number, code: string, message: string) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status });
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const keys = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET };
const retry = { attempts: 3, backoffMs: 1 };
const mail = { address: "support@acme.com", to: "jo@example.com", text: "Hello", subject: "Re: order", fromName: "Ava", replyTo: "support+c1@acme.com", inReplyTo: "<m1@example.com>" };

async function rejects<T extends Error>(p: Promise<unknown>, type: new (...a: never[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof type, `expected ${type.name}, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a rejection");
}

test("signV4 matches AWS's documented example", () => {
  const headers = signV4({
    method: "GET",
    url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "",
    region: "us-east-1",
    service: "iam",
    ...keys,
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(headers["x-amz-content-sha256"], undefined);
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

test("S3 virtual-hosted: put, get, delete, check request shapes", async () => {
  const { http, calls } = fakeFetch(new Response(null, { status: 200 }), new Response("data"), new Response(null, { status: 204 }), new Response("<ListBucketResult/>"));
  const store = awsS3({ region: "eu-west-1", bucket: "kb", keys, fetch: http });
  assert.equal(store.name, "s3");
  await store.put("org 1/a(b).txt", Buffer.from("hi"), "text/plain");
  assert.equal((await store.get("org 1/a(b).txt")).toString(), "data");
  await store.delete("org 1/a(b).txt");
  await store.check();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "PUT https://kb.s3.eu-west-1.amazonaws.com/org%201/a%28b%29.txt",
      "GET https://kb.s3.eu-west-1.amazonaws.com/org%201/a%28b%29.txt",
      "DELETE https://kb.s3.eu-west-1.amazonaws.com/org%201/a%28b%29.txt",
      "GET https://kb.s3.eu-west-1.amazonaws.com/?list-type=2&max-keys=1",
    ],
  );
  const put = calls[0]!;
  assert.equal(put.body, "hi");
  assert.equal(put.headers["content-type"], "text/plain");
  assert.equal(put.headers["x-amz-content-sha256"], "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
  assert.match(put.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(calls[1]!.headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.ok(calls.every((c) => !JSON.stringify(c.headers).includes(SECRET)));
});

test("S3 path-style flavours: R2, GCS, S3-compatible", async () => {
  const { http, calls } = fakeFetch(new Response(null, { status: 200 }));
  await r2({ accountId: "acc1", bucket: "kb", keys, fetch: http }).check();
  await gcs({ bucket: "kb", keys, fetch: http }).put("a/b.pdf", Buffer.from("x"), "application/pdf");
  await s3Compatible({ endpoint: "https://minio.example.com:9000", region: "us-east-1", bucket: "kb", keys, fetch: http }).get("k");
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://acc1.r2.cloudflarestorage.com/kb/?list-type=2&max-keys=1", "https://storage.googleapis.com/kb/a/b.pdf", "https://minio.example.com:9000/kb/k"],
  );
  assert.match(calls[0]!.headers.authorization!, /\/auto\/s3\/aws4_request/);
  assert.match(calls[1]!.headers.authorization!, /\/auto\/s3\/aws4_request/);
  assert.match(calls[2]!.headers.authorization!, /\/us-east-1\/s3\/aws4_request/);
});

test("S3 errors map to kinds and never carry the secret", async () => {
  const store = (r: Response | Error) => s3Storage({ name: "s3", endpoint: "https://s3.example.com", region: "x", bucket: "b", pathStyle: true, ...keys, fetch: fakeFetch(r).http });
  const denied = await rejects(store(xmlError(403, "SignatureDoesNotMatch", "The request signature we calculated does not match")).put("k", Buffer.from("x"), "text/plain"), ProviderError);
  assert.equal(denied.kind, "auth");
  assert.match(denied.message, /SignatureDoesNotMatch/);
  const missing = await rejects(store(xmlError(404, "NoSuchKey", "The specified key does not exist.")).get("a/b"), ProviderError);
  assert.equal(missing.kind, "config");
  assert.match(missing.message, /not found/);
  await store(xmlError(404, "NoSuchKey", "gone")).delete("a/b");
  assert.equal((await rejects(store(xmlError(503, "SlowDown", "Reduce your request rate.")).check(), ProviderError)).kind, "unavailable");
  const down = await rejects(store(new TypeError("fetch failed")).get("k"), ProviderError);
  assert.equal(down.kind, "unavailable");
  for (const err of [denied, missing, down]) assert.ok(!err.message.includes(SECRET));
});

test("Azure Blob: SAS URLs and headers, errors without the token", async () => {
  const sas = "sv=2023-11-03&sp=racwdl&sig=SECRETSIG%3D";
  const { http, calls } = fakeFetch(new Response(null, { status: 201 }), new Response("data"), new Response(null, { status: 404 }), new Response("<EnumerationResults/>"));
  const store = azureBlobStorage({ account: "acct", container: "kb", sasToken: `?${sas}`, fetch: http });
  assert.equal(store.name, "azure_blob");
  await store.put("org 1/doc.pdf", Buffer.from("x"), "application/pdf");
  assert.equal((await store.get("org 1/doc.pdf")).toString(), "data");
  await store.delete("org 1/doc.pdf");
  await store.check();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      `PUT https://acct.blob.core.windows.net/kb/org%201/doc.pdf?${sas}`,
      `GET https://acct.blob.core.windows.net/kb/org%201/doc.pdf?${sas}`,
      `DELETE https://acct.blob.core.windows.net/kb/org%201/doc.pdf?${sas}`,
      `GET https://acct.blob.core.windows.net/kb?restype=container&comp=list&maxresults=1&${sas}`,
    ],
  );
  assert.deepEqual(calls[0]!.headers, { "x-ms-version": "2023-11-03", "x-ms-blob-type": "BlockBlob", "content-type": "application/pdf" });

  const echo = xmlError(403, "AuthenticationFailed", `Signature did not match: ${sas}`);
  const err = await rejects(azureBlobStorage({ account: "acct", container: "kb", sasToken: sas, fetch: fakeFetch(echo).http }).check(), ProviderError);
  assert.equal(err.kind, "auth");
  assert.ok(!err.message.includes("SECRETSIG"));
  const missing = await rejects(azureBlobStorage({ account: "acct", container: "kb", sasToken: sas, fetch: fakeFetch(xmlError(404, "BlobNotFound", "x")).http }).get("k"), ProviderError);
  assert.equal(missing.kind, "config");
});

test("SendGrid: request body, message id, retries 429 only", async () => {
  const ok = () => new Response(null, { status: 202, headers: { "x-message-id": "sg-1" } });
  const { http, calls } = fakeFetch(new Response('{"errors":[{"message":"too many"}]}', { status: 429 }), ok);
  const sender = sendGridEmail({ apiKey: "SG.secret", fetch: http, retry });
  assert.deepEqual(await sender.send(mail), { providerMessageId: "sg-1", attempts: 2 });
  assert.equal(calls[1]!.url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(calls[1]!.headers.authorization, "Bearer SG.secret");
  assert.deepEqual(JSON.parse(calls[1]!.body!), {
    personalizations: [{ to: [{ email: "jo@example.com" }] }],
    from: { email: "support@acme.com", name: "Ava" },
    reply_to: { email: "support+c1@acme.com" },
    subject: "Re: order",
    content: [{ type: "text/plain", value: "Hello" }],
    headers: { "In-Reply-To": "<m1@example.com>", References: "<m1@example.com>" },
  });

  const unauthorized = fakeFetch(new Response('{"errors":[{"message":"The provided authorization grant is invalid"}]}', { status: 401 }));
  const err = await rejects(sendGridEmail({ apiKey: "SG.secret", fetch: unauthorized.http, retry }).send(mail), ChannelError);
  assert.equal(err.kind, "auth");
  assert.equal(err.retryable, false);
  assert.equal(unauthorized.calls.length, 1);
  assert.ok(!err.message.includes("SG.secret"));

  const offline = fakeFetch(new TypeError("fetch failed"));
  const down = await rejects(sendGridEmail({ apiKey: "k", fetch: offline.http, retry }).send(mail), ChannelError);
  assert.equal(down.kind, "unavailable");
  assert.equal(offline.calls.length, 1);

  const scopes = fakeFetch(new Response('{"scopes":[]}'));
  await sendGridEmail({ apiKey: "k", fetch: scopes.http }).check();
  assert.equal(scopes.calls[0]!.url, "https://api.sendgrid.com/v3/scopes");
});

test("SES: signed v2 request, message id, throttling retried, auth not", async () => {
  const throttled = new Response('{"message":"Rate exceeded"}', { status: 400, headers: { "x-amzn-ErrorType": "ThrottlingException:http://internal" } });
  const { http, calls } = fakeFetch(throttled, () => Response.json({ MessageId: "ses-1" }));
  const sender = sesEmail({ ...keys, region: "eu-west-1", fetch: http, retry });
  assert.deepEqual(await sender.send(mail), { providerMessageId: "ses-1", attempts: 2 });
  const call = calls[1]!;
  assert.equal(call.url, "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
  assert.match(call.headers.authorization!, /Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date,/);
  assert.deepEqual(JSON.parse(call.body!), {
    FromEmailAddress: '"Ava" <support@acme.com>',
    Destination: { ToAddresses: ["jo@example.com"] },
    ReplyToAddresses: ["support+c1@acme.com"],
    Content: {
      Simple: {
        Subject: { Data: "Re: order" },
        Body: { Text: { Data: "Hello" } },
        Headers: [
          { Name: "In-Reply-To", Value: "<m1@example.com>" },
          { Name: "References", Value: "<m1@example.com>" },
        ],
      },
    },
  });

  const denied = fakeFetch(new Response('{"message":"The security token included in the request is invalid."}', { status: 403 }));
  const err = await rejects(sesEmail({ ...keys, region: "eu-west-1", fetch: denied.http, retry }).send(mail), ChannelError);
  assert.equal(err.kind, "auth");
  assert.equal(denied.calls.length, 1);
  assert.ok(!err.message.includes(SECRET));

  const offline = fakeFetch(new TypeError("fetch failed"));
  assert.equal((await rejects(sesEmail({ ...keys, region: "eu-west-1", fetch: offline.http, retry }).send(mail), ChannelError)).kind, "unavailable");
  assert.equal(offline.calls.length, 1);

  const account = fakeFetch(Response.json({ SendingEnabled: true }));
  await sesEmail({ ...keys, region: "us-east-1", fetch: account.http }).check();
  assert.equal(account.calls[0]!.url, "https://email.us-east-1.amazonaws.com/v2/email/account");
  assert.equal(account.calls[0]!.method, "GET");
});

test("SMTP: private hosts refused, public host pinned to its resolved address", async () => {
  const options: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const transport = (o: object) => {
    options.push(o as Record<string, unknown>);
    return { sendMail: async (m: object) => (sent.push(m as Record<string, unknown>), { messageId: "<smtp-1@acme.com>" }), verify: async () => true };
  };
  const smtp = (host: string, resolve: (h: string) => Promise<string[]>) =>
    smtpEmail({ host, port: 587, security: "starttls", username: "u", password: "hunter2", resolve, transport, retry });

  assert.equal((await rejects(smtp("mail.evil.com", async () => ["10.0.0.5"]).send(mail), ChannelError)).kind, "config");
  assert.equal((await rejects(smtp("localhost", async () => ["93.184.216.34"]).check(), ChannelError)).kind, "config");
  assert.equal(options.length, 0);

  assert.deepEqual(await smtp("smtp.acme.com", async () => ["93.184.216.34"]).send(mail), { providerMessageId: "<smtp-1@acme.com>", attempts: 1 });
  assert.equal(options[0]!.host, "93.184.216.34");
  assert.deepEqual(options[0]!.tls, { servername: "smtp.acme.com" });
  assert.equal(options[0]!.secure, false);
  assert.equal(options[0]!.requireTLS, true);
  assert.deepEqual(sent[0], {
    from: { name: "Ava", address: "support@acme.com" },
    to: "jo@example.com",
    subject: "Re: order",
    text: "Hello",
    replyTo: "support+c1@acme.com",
    inReplyTo: "<m1@example.com>",
    references: "<m1@example.com>",
  });
});

test("SMTP: error kinds and retries", async () => {
  const failing = (...errors: object[]) => {
    let n = 0;
    const sender = smtpEmail({
      host: "smtp.acme.com",
      port: 465,
      security: "tls",
      username: "u",
      password: "hunter2",
      resolve: async () => ["93.184.216.34"],
      retry,
      transport: () => ({
        sendMail: async () => {
          const err = errors[n++];
          if (err) throw Object.assign(new Error((err as { message?: string }).message ?? "smtp error"), err);
          return { messageId: "<ok>" };
        },
        verify: async () => {
          throw Object.assign(new Error("Invalid login: 535 bad credentials for hunter2"), { code: "EAUTH", responseCode: 535 });
        },
      }),
    });
    return { sender, tries: () => n };
  };

  const auth = await rejects(failing().sender.check(), ChannelError);
  assert.equal(auth.kind, "auth");
  assert.ok(!auth.message.includes("hunter2"));

  const busy = failing({ responseCode: 451, message: "try later" });
  assert.equal((await busy.sender.send(mail)).attempts, 2);

  const timeout = failing({ code: "ETIMEDOUT", message: "Connection timeout" });
  const err = await rejects(timeout.sender.send(mail), ChannelError);
  assert.equal(err.kind, "unavailable");
  assert.equal(timeout.tries(), 1);
});
