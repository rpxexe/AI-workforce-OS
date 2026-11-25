# Employee Pages Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the employee detail page into URL-synced tabs with a real Overview, and polish the employee list page.

**Architecture:** Dashboard-only. Pure helpers in one `.ts` file (tested with `node --test`), one new
`EmployeeOverview` component that reads two existing endpoints, and the two pages rearranged around
existing section components. No API or schema changes.

**Tech Stack:** Next.js 16 client components, shadcn/ui, lucide-react, Tailwind theme tokens, Skullet skeletons.

**Spec:** `docs/superpowers/specs/2026-11-25-employee-pages-redesign-design.md`

## Global Constraints

- Read `apps/dashboard/AGENTS.md` before writing Next.js code.
- UI from `apps/dashboard/src/components/ui/` only; reuse `EmptyState`, `ErrorState`, `StatTile` from `components/states.tsx`. No raw `<button>/<input>/<table>`, no hard-coded colors, icons from lucide-react.
- Section components in `components/employees/` and `ProviderOverridesForm` are moved, never edited.
- A section that fetches data mounts only when its tab is open, and only for the real employee (`real === true`), never for Skullet's `SAMPLE`.
- `useSearchParams` needs a `<Suspense>` boundary (pattern: `app/(app)/settings/page.tsx:585-631`).
- Overview numbers: last 30 days (`days=30`).
- Do not commit; the owner has uncommitted work on `main`. Leave changes in the working tree.

## Review Focus

- `?tab=` with an unknown or empty value: falls back to Overview, no crash. (Task 1 test)
- Search with surrounding spaces or different case ("  SUPPORT "): still matches role "Customer support agent". (Task 1 test)
- Search that matches nothing: shows an empty state, not an empty table; clearing the box brings rows back. (Task 4)
- Overview while one endpoint fails (e.g. quality 403/500): the other tiles still render; the failed block shows `ErrorState` with retry. (Task 2)
- Tab switch while a tab's section is mid-fetch, then back: no duplicate rows, no console error (sections remount via `TabsContent`, which unmounts hidden content). (Task 3 manual check)

---

### Task 1: Pure helpers

**Files:**
- Create: `apps/dashboard/src/components/employees/helpers.ts`
- Test: `apps/dashboard/src/components/employees/helpers.test.ts`

**Interfaces:**
- Produces:
  - `EMPLOYEE_TABS: readonly [{ id: "overview", label: "Overview" }, { id: "setup", label: "Setup" }, { id: "knowledge", label: "Knowledge & tools" }, { id: "channels", label: "Channels" }, { id: "releases", label: "Releases" }]`
  - `type EmployeeTab = (typeof EMPLOYEE_TABS)[number]["id"]`
  - `resolveTab(value: string | null): EmployeeTab`
  - `matchesSearch(e: { name: string; role: string }, query: string): boolean` (trimmed, case-insensitive substring on name or role; empty query matches)
  - `summarizeEmployees(list: { status: EmployeeStatus; publishedVersion: number | null }[]): { active: number; paused: number; draft: number }` (draft = `publishedVersion === null`, counted independently of status)
  - `openConversations(counts: Partial<Record<InboxView, number>>): number` = `ai_active + human_active + waiting`, missing keys as 0
- Only `import type` from `@workforce/shared`, relative imports end in `.ts`, so Node runs the test directly.

- [ ] **Step 1: Write the failing test** with `node:test` + `node:assert/strict`:
  - `resolveTab(null) === "overview"`, `resolveTab("bogus") === "overview"`, `resolveTab("") === "overview"`, `resolveTab("channels") === "channels"`
  - `matchesSearch({ name: "Asha", role: "Customer support agent" }, "  SUPPORT ")` is true; `(…, "billing")` false; `(…, "")` true
  - `summarizeEmployees([{status:"ACTIVE",publishedVersion:1},{status:"PAUSED",publishedVersion:null},{status:"ACTIVE",publishedVersion:null}])` deep-equals `{ active: 2, paused: 1, draft: 2 }`
  - `openConversations({ ai_active: 3, human_active: 2, waiting: 1, resolved: 9 }) === 6`; `openConversations({}) === 0`
- [ ] **Step 2: Run** `node --test apps/dashboard/src/components/employees/helpers.test.ts` from repo root. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the four exports above in `helpers.ts`.
- [ ] **Step 4: Run** the same command. Expected: all tests pass.

### Task 2: `EmployeeOverview` component

**Files:**
- Create: `apps/dashboard/src/components/employees/employee-overview.tsx`

**Interfaces:**
- Consumes: `openConversations` (Task 1); `useApiQuery` from `@/lib/api`; `formatScore`, `formatRate` from `@/components/quality/meta`; `formatDate`, `DAY_LABELS` from `./meta`; `StatTile`, `ErrorState`, `EmptyState` from `@/components/states`.
- Produces: `export function EmployeeOverview({ workspaceId, employee }: { workspaceId: string; employee: EmployeeDetail })`

Content:
- Tiles (grid, 2 cols on phones, 4 on `lg`):
  - from `useApiQuery<InboxResponse>(\`/workspaces/${workspaceId}/inbox?view=all&employeeId=${employee.id}\`)`: "Open conversations" = `openConversations(counts)`, "With a human" = `counts.human_active ?? 0`
  - from `useApiQuery<QualityOverview>(\`/workspaces/${workspaceId}/quality?days=30&employeeId=${employee.id}\`)`: "Quality score" = `formatScore(averageScore)` with hint `"${evaluations} evaluations, last 30 days"`, "Pass rate" = `formatRate(passRate)`
  - Each query handles its own loading (value `"—"` while loading) and its own error (`ErrorState` with `onRetry={reload}` in place of its tiles). One failing does not hide the other.
  - When inbox total is 0 and quality `evaluations` is 0, show one `EmptyState` (icon `ChartColumn`, "No conversations yet", "Numbers appear here once customers start talking to this employee.") under the tiles.
- "At a glance" `Card` with a `dl`: Live version (`v{publishedVersion}` or "Not published"), Latest version (`v{versions[0].number}`), Last changed (`formatDate(updatedAt)`), Created (`formatDate(createdAt)`), Language, Working hours (move the existing working-hours rendering from the detail page's Identity card here, unchanged), Escalation ("On" / "Off").
- Card footer: `Button variant="outline" size="sm" asChild` links to `/conversations` ("View conversations") and `/quality` ("View quality"). Neither page filters by employee today, so plain links.

- [ ] **Step 1: Implement** the component as above.
- [ ] **Step 2: Run** `pnpm typecheck` from repo root. Expected: no errors.

### Task 3: Detail page tabs

**Files:**
- Modify: `apps/dashboard/src/app/(app)/employees/[id]/page.tsx` (body at lines 278-467; header 174-276 stays)

**Interfaces:**
- Consumes: `EMPLOYEE_TABS`, `resolveTab`, `EmployeeTab` (Task 1); `EmployeeOverview` (Task 2).

Changes:
- Wrap the page's Skullet render in `<Suspense>`; read `useSearchParams()` inside it; `tab = resolveTab(params.get("tab"))`; `onValueChange={(t) => router.replace(\`/employees/${id}?tab=${t}\`, { scroll: false })}`.
- Replace the card grid with `Tabs` → `TabsList` (from `EMPLOYEE_TABS`, horizontally scrollable on phones via `overflow-x-auto`) and one `TabsContent` per tab:
  - `overview`: `{real && <EmployeeOverview workspaceId={workspace.id} employee={data} />}`
  - `setup`: Identity (Name, Language, Description, Escalation detail; working hours now live on Overview), Role, Personality, Goals, Providers — `grid gap-4 lg:grid-cols-2`
  - `knowledge`: Knowledge, Tools — `grid gap-4 lg:grid-cols-2`
  - `channels`: Phone, Channels, Message log — stacked full width
  - `releases`: Releases, Versions table — stacked full width
- Delete the old Analytics card and the now-unused `NotConnected` helper and imports (`ChartColumn` etc.) if nothing else uses them.

- [ ] **Step 1: Implement** the changes.
- [ ] **Step 2: Run** `pnpm typecheck` and `pnpm lint`. Expected: clean.
- [ ] **Step 3: Manual check** (`pnpm dev`, open `/employees/<id>`): each tab shows its sections; `?tab=channels` deep-links; `?tab=nope` shows Overview; reload keeps the tab; browser back works; switching away from Channels mid-load and back shows no console error; loading skeleton renders without the Slot error.

### Task 4: List page polish

**Files:**
- Modify: `apps/dashboard/src/app/(app)/employees/page.tsx`

**Interfaces:**
- Consumes: `matchesSearch`, `summarizeEmployees` (Task 1).

Changes:
- Above the table (inside `EmployeeList`, current tab only): a row with an `InputGroup` search (lucide `Search` icon, placeholder "Search by name or role", `aria-label` same) and three small `Badge`s: "{active} active", "{paused} paused", "{draft} draft" from `summarizeEmployees(data)`. Hide the badges on the Archived tab.
- Filter rows with `matchesSearch` before `usePaged`; pass the query as part of `usePaged`'s `resetKey` (e.g. `` `${archived}:${query}` ``) so a new search returns to page 1.
- Search with no match: `EmptyState` (icon `SearchX`, "No employees match "{query}"") with a "Clear search" button; keep the existing no-employees empty states for an empty list.
- Version column: `Badge` "Live v{publishedVersion}" (default variant) when published, plus `Badge variant="secondary"` "Draft v{latestVersion}" when `latestVersion !== publishedVersion` or never published. Keep `versionLabel` as the badge group's `title` for the full text.
- Keep search state in `useState` (not the URL); clear it when switching Current/Archived.

- [ ] **Step 1: Implement** the changes.
- [ ] **Step 2: Run** `pnpm typecheck` and `pnpm lint`. Expected: clean.
- [ ] **Step 3: Manual check** at `/employees`: search filters, "  SUPPORT " matches support roles, no-match empty state and Clear work, counts match the rows, badges show Live/Draft correctly, pager resets to page 1 on new search.
