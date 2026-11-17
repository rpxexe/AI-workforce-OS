# Decisions and traps

Why things are the way they are. Add an entry when a choice would otherwise be re-argued or a
problem re-discovered.

## Decisions

- **Versioning is append-only.** Saving an employee inserts a new `AiEmployeeVersion`; nothing
  updates a version. "Live" is a pointer (`publishedVersionId`) moved only by Publish. Rollback is
  publishing an older version. This is how "do not overwrite production configuration" is met.
- **Status is separate from versions.** DRAFT means never published. The status endpoint accepts
  ACTIVE, PAUSED, ARCHIVED; restoring an unpublished employee returns it to DRAFT.
- **Roles: members read, `org:admin` writes.** Our reading of "basic roles"; uses Clerk's built-in
  roles, no custom permissions. Change in `guards()` if members should edit.
- **Clerk is the source of truth for users, organizations, members, roles.** No user table and no
  webhooks. The UI shows "You" or "A teammate" for authors.
- **Workspaces partition an organization.** Employees carry both `organizationId` and
  `workspaceId`; routes are nested under `/workspaces/:workspaceId`.
- **Avatars are icon keys**, not uploads, because file storage (R2) is not wired yet.
- **No `tsx`.** The API runs on Node's native TypeScript support. Hence `erasableSyntaxOnly` and
  `.ts` import extensions in the root tsconfig.
- **Version pins.** TypeScript 6.0 (typescript-eslint does not support 7 yet). Prisma 7.10
  (npm "latest" was an 8.0 release candidate). ESLint 9 (eslint-config-next plugins).
- **Root tsconfig covers API, packages and workers**; the dashboard has its own. Stub packages
  need only `package.json` and `src/index.ts`.
- **Zod schemas live in `@workforce/shared`** so the form and the API validate identically.
- **OpenRouter is the default AI provider** (owner's choice), default model `openrouter/auto`, which
  lets OpenRouter choose per request; pin one with `AI_MODEL`. It is called with `fetch`, no SDK.
  Anthropic remains selectable with `AI_PROVIDER=anthropic` (default `claude-opus-5-5`); nothing
  outside `packages/ai-provider/src/anthropic.ts` imports its SDK.
- **The runtime writes to the database itself**, not through a storage interface, so every channel
  gets persistence by calling `runTurn`. The API route holds no conversation logic.
- **A failed turn saves nothing.** The user message and the reply are inserted together after the
  reply completes, so stored conversations contain only complete exchanges and a retry cannot
  duplicate a message. The chat page puts the unsent text back in the box.
- **Test chat talks to the latest version**, published or not, and only admins can send (it spends
  money and writes data); members can read conversations. Archived employees cannot be tested.
- **Knowledge is attached to the employee, not to a version.** Attaching or detaching a source
  takes effect on the next message, for every version. Versions stay immutable.
- **Embeddings are 1536 dimensions**, from `openai/text-embedding-3-small` through OpenRouter. The
  column is `vector(1536)`; a model with another size needs a migration and reprocessing every
  document. Searches only compare vectors made by the current `EMBEDDING_MODEL`.
- **Uploaded files are stored in Postgres** (`KnowledgeDocument.content`) so they can be
  reprocessed; object storage (R2) is not wired. Uploads are capped at 10 MB.
- **Uploads are a raw request body**, not multipart: one file per request, name in the query
  string. It avoids a multipart dependency.
- **Documents are processed inside the API process**, started after the upload responds. There is
  no queue yet; a restart mid-processing leaves a document PENDING until someone reprocesses it.
- **No vector index.** Search is exact, filtered by tenant first. A hand-written HNSW index would
  be dropped by the next `prisma migrate dev`, because Prisma does not know about it.
- **Retrieved passages go in the system prompt**, and the question is sent as the user wrote it,
  so stored conversations and later turns contain the real question.
- **If retrieval fails, the turn fails.** An employee with knowledge attached does not fall back
  to answering without it.
- **Refusal fallbacks are not enabled** on the Anthropic call: the parameter is a beta that some
  models reject, and `AI_MODEL` is free-form. A refusal is reported as an error instead.

## Traps already hit

- **`tsx watch` does not start under `pnpm --parallel` on Windows.** Fixed by using `node --watch`.
- **`pnpm add` inside a package crashes when the path has a lower-case drive letter** (`d:\`), which
  is what Git Bash and this VS Code workspace give. Use `--filter` from the root, or PowerShell at `D:\`.
- **Prisma 7 `migrate dev` does not regenerate the client.** The `migrate` script runs `generate` after.
- **Clerk 7 has no implicit keyless mode.** Without both keys the dashboard returns 500 and the API
  refuses to start, naming the missing variable.
- **Clerk middleware needs `signInUrl` passed explicitly**, or signed-out users go to Clerk's hosted
  page. `createRouteMatcher` is deprecated; `proxy.ts` checks the pathname itself.
- **Signed-out non-browser requests get 404 from Clerk, not a redirect.** Test with
  `Accept: text/html` and `Sec-Fetch-Dest: document`.
- **Next.js 16 keeps visited pages mounted but hidden.** Form state survives navigation, so forms
  reset `saving` in `finally` and are re-keyed after a successful save.
- **Next.js reports "dropped segment" if a layout withholds `children`.** The shell always renders
  the page; `withWorkspace` shows the loading state inside the page instead.
- **shadcn's `SidebarMenuSkeleton` uses `Math.random()`** and causes a hydration mismatch. Use `Skeleton`.
- **shadcn's generated `use-mobile.ts` failed lint**; rewritten with `useSyncExternalStore`.
- **`@fastify/cors` allows only GET, HEAD, POST by default.** Methods are listed explicitly.
- **Prisma `upsert` is not atomic**: it reads, then inserts, so simultaneous calls fail with P2002.
  First-request provisioning in `GET /workspaces` returned 500s on real Postgres because of it.
  Use `createMany({ skipDuplicates: true })` (`ON CONFLICT DO NOTHING`) for create-if-missing.
- **A `prisma dev` throwaway database cannot take the two API test files in parallel.** Test
  against the Docker Postgres instead.
- **The Anthropic SDK reports a missing API key as a plain `AnthropicError`**, not an `APIError`, and
  only when the first request is made. `anthropic.ts` maps that to the `auth` kind.
- **Prisma `migrate dev --create-only` then edit** is how the pgvector migration got its
  `CREATE EXTENSION IF NOT EXISTS vector` line; Prisma does not write it.
- **Do not type `\uFEFF` in a regex through an editor that expands escapes**: it became a literal
  invisible character and failed lint. `parse.ts` compares the char code instead.
- **A dev dependency named `cn`** is legitimate: shadcn publishes it and its registry requires it.

## Checking the signed-in UI without a login

Real sign-in needs a person. To exercise the UI automatically, temporarily alias `@clerk/nextjs`
and `@clerk/nextjs/server` to stubs via `turbopack.resolveAlias`, run the API through
`buildApp({ authenticate })` with a fixed identity, and drive headless Edge over the DevTools
protocol. Remove all of it afterwards; none of it is in the repo.
