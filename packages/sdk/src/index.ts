// The TypeScript SDK for the AI Workforce public API (/v1). No dependencies: fetch and Web Crypto only, so it runs on
// Node 18+, Deno, Bun, edge runtimes and browsers (keys belong on servers, though). Types are generated from the API's
// contract into ./types.ts.
//
//   const wf = createClient({ apiKey: process.env.WORKFORCE_API_KEY!, baseUrl: "https://api.example.com" });
//   const { reply } = await wf.employees.sendMessage(employeeId, { message: "Hi", customer: "rahul@example.com" });
//   for await (const event of wf.employees.streamMessage(employeeId, { message: "Hi" })) if (event.type === "text") process.stdout.write(event.text);
//   for await (const c of wf.paginate(wf.conversations.list, { employeeId })) console.log(c.title);
import type * as T from "./types.ts";

export type * from "./types.ts";

export type ClientOptions = {
  /** An API key from Settings > API Keys (`wfk_...`). */
  apiKey: string;
  /** The API's address; default http://localhost:4000. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries after a network error, 429 or 5xx (reads, and writes that carry an idempotency key). Default 2. */
  maxRetries?: number;
};

export class WorkforceError extends Error {
  status: number;
  type: string;
  issues: { path: string; message: string }[];
  requestId: string | null;

  constructor(status: number, body: Partial<T.PublicErrorBody> | null, requestId: string | null) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = "WorkforceError";
    this.status = status;
    this.type = body?.error?.type ?? "server_error";
    this.issues = body?.error?.issues ?? [];
    this.requestId = requestId;
  }
}

type Page<Item> = { data: Item[]; nextCursor: string | null };
export type RequestOptions = { idempotencyKey?: string; signal?: AbortSignal };
type Method = "GET" | "POST" | "PUT" | "DELETE";
type Init = { query?: object; body?: unknown; idempotent?: boolean } & RequestOptions;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits as the server asks (Retry-After) or backs off: 0.5 s, 1 s, 2 s... */
const backoff = (attempt: number, res?: Response) => {
  const after = Number(res?.headers.get("retry-after"));
  return sleep(after > 0 ? Math.min(after, 60) * 1000 : 500 * 2 ** attempt);
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export function createClient(options: ClientOptions) {
  const base = (options.baseUrl ?? "http://localhost:4000").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;

  /** Sends one request, retrying what is safe to retry; returns the successful response. */
  async function send(method: Method, path: string, init: Init, accept: string): Promise<Response> {
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    // Writes that may be retried get a key, so a retry after a lost answer does not act twice.
    const idempotencyKey = init.idempotencyKey ?? (init.idempotent ? crypto.randomUUID() : undefined);
    const retryable = method === "GET" || idempotencyKey !== undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            accept,
            ...(init.body !== undefined && { "content-type": "application/json" }),
            ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: init.signal,
        });
      } catch (err) {
        if (!retryable || attempt >= maxRetries || init.signal?.aborted) throw err;
        await backoff(attempt);
        continue;
      }
      if (res.ok) return res;
      if (retryable && attempt < maxRetries && (res.status === 429 || res.status >= 500)) {
        await backoff(attempt, res);
        continue;
      }
      const body = (await res.json().catch(() => null)) as T.PublicErrorBody | null;
      throw new WorkforceError(res.status, body, res.headers.get("request-id"));
    }
  }

  const request = async <Result>(method: Method, path: string, init: Init = {}) =>
    (await (await send(method, path, init, "application/json")).json()) as Result;

  /** Reads server-sent events: one JSON object per `data:` line. */
  async function* events<Event>(method: Method, path: string, init: Init): AsyncGenerator<Event> {
    const res = await send(method, path, init, "text/event-stream");
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as Event;
    }
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    employees: {
      list: (query: T.ListEmployeesQuery = {}, opts?: RequestOptions) => request<T.ListEmployeesResult>("GET", "/v1/employees", { query, ...opts }),
      get: (employeeId: string, opts?: RequestOptions) => request<T.GetEmployeeResult>("GET", `/v1/employees/${id(employeeId)}`, opts),
      /** Version 1, not published. */
      create: (body: T.CreateEmployeeBody, opts?: RequestOptions) => request<T.CreateEmployeeResult>("POST", "/v1/employees", { body, idempotent: true, ...opts }),
      /** A new version with these fields changed; customers keep talking to the published one until `publish`. */
      saveVersion: (employeeId: string, body: T.SaveEmployeeVersionBody, opts?: RequestOptions) =>
        request<T.SaveEmployeeVersionResult>("POST", `/v1/employees/${id(employeeId)}/versions`, { body, idempotent: true, ...opts }),
      /** Makes a version live (default: the latest). */
      publish: (employeeId: string, body: T.PublishEmployeeBody = {}, opts?: RequestOptions) =>
        request<T.PublishEmployeeResult>("POST", `/v1/employees/${id(employeeId)}/publish`, { body, ...opts }),
      /** The employee's published version answers; the reply comes back whole. */
      sendMessage: (employeeId: string, body: T.SendMessageBody, opts?: RequestOptions) =>
        request<T.SendMessageResult>("POST", `/v1/employees/${id(employeeId)}/messages`, { body, idempotent: true, ...opts }),
      /** The reply as it is written: `text` pieces, then `done` (or `error`). Not retried: a turn that started may have acted. */
      streamMessage: (employeeId: string, body: T.StreamMessageBody, opts?: Omit<RequestOptions, "idempotencyKey">) =>
        events<T.StreamEvent>("POST", `/v1/employees/${id(employeeId)}/messages/stream`, { body, ...opts }),
    },
    conversations: {
      list: (query: T.ListConversationsQuery = {}, opts?: RequestOptions) => request<T.ListConversationsResult>("GET", "/v1/conversations", { query, ...opts }),
      get: (conversationId: string, opts?: RequestOptions) => request<T.GetConversationResult>("GET", `/v1/conversations/${id(conversationId)}`, opts),
      resolve: (conversationId: string, opts?: RequestOptions) =>
        request<T.ResolveConversationResult>("POST", `/v1/conversations/${id(conversationId)}/resolve`, { idempotent: true, ...opts }),
    },
    customers: {
      list: (query: T.ListCustomersQuery = {}, opts?: RequestOptions) => request<T.ListCustomersResult>("GET", "/v1/customers", { query, ...opts }),
      get: (customerId: string, opts?: RequestOptions) => request<T.GetCustomerResult>("GET", `/v1/customers/${id(customerId)}`, opts),
      /** Sets one remembered fact (snake_case key). */
      setMemory: (customerId: string, key: string, body: T.SetCustomerMemoryBody, opts?: RequestOptions) =>
        request<T.SetCustomerMemoryResult>("PUT", `/v1/customers/${id(customerId)}/memories/${id(key)}`, { body, idempotent: true, ...opts }),
      deleteMemory: (customerId: string, key: string, opts?: RequestOptions) =>
        request<T.DeleteCustomerMemoryResult>("DELETE", `/v1/customers/${id(customerId)}/memories/${id(key)}`, { idempotent: true, ...opts }),
    },
    knowledge: {
      listSources: (query: T.ListKnowledgeSourcesQuery = {}, opts?: RequestOptions) =>
        request<T.ListKnowledgeSourcesResult>("GET", "/v1/knowledge/sources", { query, ...opts }),
      getSource: (sourceId: string, opts?: RequestOptions) => request<T.GetKnowledgeSourceResult>("GET", `/v1/knowledge/sources/${id(sourceId)}`, opts),
      createSource: (body: T.CreateKnowledgeSourceBody, opts?: RequestOptions) =>
        request<T.CreateKnowledgeSourceResult>("POST", "/v1/knowledge/sources", { body, idempotent: true, ...opts }),
      /** Uploads a PDF, DOCX, TXT or CSV file (up to 10 MB); processing continues in the background. */
      uploadDocument: (sourceId: string, file: { name: string; content: Uint8Array | ArrayBuffer }, opts?: RequestOptions) =>
        request<T.UploadDocumentResult>("POST", `/v1/knowledge/sources/${id(sourceId)}/documents`, {
          body: { name: file.name, contentBase64: toBase64(file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content)) },
          idempotent: true,
          ...opts,
        }),
      search: (body: T.SearchKnowledgeBody, opts?: RequestOptions) => request<T.SearchKnowledgeResult>("POST", "/v1/knowledge/search", { body, ...opts }),
    },
    workflows: {
      list: (query: T.ListWorkflowsQuery = {}, opts?: RequestOptions) => request<T.ListWorkflowsResult>("GET", "/v1/workflows", { query, ...opts }),
      get: (workflowId: string, opts?: RequestOptions) => request<T.GetWorkflowResult>("GET", `/v1/workflows/${id(workflowId)}`, opts),
      /** Starts a run of the published version; `input` is what the workflow's {{trigger.*}} templates read. */
      start: (workflowId: string, input: Record<string, unknown> = {}, opts?: RequestOptions) =>
        request<T.StartExecutionResult>("POST", `/v1/workflows/${id(workflowId)}/executions`, { body: { input }, idempotent: true, ...opts }),
    },
    executions: {
      list: (query: T.ListExecutionsQuery = {}, opts?: RequestOptions) => request<T.ListExecutionsResult>("GET", "/v1/executions", { query, ...opts }),
      get: (executionId: string, opts?: RequestOptions) => request<T.GetExecutionResult>("GET", `/v1/executions/${id(executionId)}`, opts),
    },
    tools: {
      list: (opts?: RequestOptions) => request<T.ListToolsResult>("GET", "/v1/tools", opts),
      listExecutions: (query: T.ListToolExecutionsQuery = {}, opts?: RequestOptions) =>
        request<T.ListToolExecutionsResult>("GET", "/v1/tools/executions", { query, ...opts }),
    },
    analytics: {
      get: (query: T.GetAnalyticsQuery, opts?: RequestOptions) => request<T.GetAnalyticsResult>("GET", "/v1/analytics", { query, ...opts }),
    },
    /** Every item of a list, page after page: `for await (const c of client.paginate(client.conversations.list, { employeeId }))`. */
    async *paginate<F extends (query: never) => Promise<Page<unknown>>>(
      list: F,
      query: NonNullable<Parameters<F>[0]> = {} as NonNullable<Parameters<F>[0]>,
    ): AsyncGenerator<Awaited<ReturnType<F>>["data"][number]> {
      const next = list as unknown as (q: object) => Promise<Page<Awaited<ReturnType<F>>["data"][number]>>;
      let cursor = (query as { cursor?: string }).cursor;
      do {
        const page = await next({ ...(query as object), cursor });
        yield* page.data;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    },
  };
}
export type WorkforceClient = ReturnType<typeof createClient>;

// ---- Webhooks ----

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;
const header = (headers: HeaderBag, name: string) => {
  const value = headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()]);
  return Array.isArray(value) ? value[0] : (value ?? undefined);
};
const base64 = (bytes: ArrayBuffer) => toBase64(new Uint8Array(bytes));
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Checks a webhook request and returns its event. Pass the raw body text exactly as received (not re-serialized JSON),
 * the request's headers and the endpoint's signing secret (`whsec_...`). Throws WebhookVerificationError when no
 * signature matches or the timestamp is older (or newer) than `toleranceSec`, which stops replays. While a secret is
 * being rotated, requests carry two signatures, so the old and the new secret both verify.
 * Deduplicate on `event.id`: retries of one event carry the same id.
 */
export async function verifyWebhook(
  payload: string,
  headers: HeaderBag,
  secret: string,
  { toleranceSec = 300, now = Date.now() }: { toleranceSec?: number; now?: number } = {},
): Promise<T.WebhookEvent> {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature");
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > toleranceSec) throw new WebhookVerificationError("The timestamp is too old or in the future");
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = base64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`)));
  const valid = signatures.split(" ").some((s) => s.startsWith("v1,") && sameText(s.slice(3), expected));
  if (!valid) throw new WebhookVerificationError("The signature does not match");
  return JSON.parse(payload) as T.WebhookEvent;
}
