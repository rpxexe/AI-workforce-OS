# @workforce/sdk

TypeScript client for the AI Workforce public API (`/v1`). No dependencies (fetch and Web Crypto): Node 18+, Deno, Bun,
edge runtimes.

```ts
import { createClient, verifyWebhook } from "@workforce/sdk";

const wf = createClient({ apiKey: process.env.WORKFORCE_API_KEY!, baseUrl: "https://api.example.com" });

const { reply } = await wf.employees.sendMessage("EMPLOYEE_ID", { message: "What are your hours?", customer: "rahul@example.com" });

for await (const event of wf.employees.streamMessage("EMPLOYEE_ID", { message: "Hi" }))
  if (event.type === "text") process.stdout.write(event.text);

for await (const conversation of wf.paginate(wf.conversations.list, { employeeId: "EMPLOYEE_ID" })) console.log(conversation.title);

// In your webhook handler: the raw body text, the headers, the endpoint's signing secret.
const event = await verifyWebhook(rawBody, request.headers, process.env.WORKFORCE_WEBHOOK_SECRET!);
```

Errors throw `WorkforceError` (`status`, `type`, `issues`, `requestId`). Reads, and writes that carry an idempotency key
(the SDK adds one), are retried after network errors, 429 (honouring Retry-After) and 5xx. Types are generated from the
API's contract; the full description is `GET /v1/openapi.json`.

## Publishing

1. Choose the npm name (a scope you own, e.g. `@yourcompany/workforce-sdk`) and set it as `name` in package.json; remove
   `"private": true`.
2. `pnpm --filter <name> publish --access public` (runs `generate` and `build` first; publishes `dist/` with the
   `publishConfig` exports).
