# Employee pages redesign

Date: 2026-11-25. Size: small change (dashboard only, no API or schema changes).

## Why

The employee detail page (`/employees/[id]`) is one long two-column grid of 13 cards, so things are
hard to find. Secondary reasons: the pages should look more polished, and the detail page should show
at a glance whether the employee is working. Its Analytics card is a placeholder today.

## Goals

- Detail page: group the 13 sections behind tabs so each one is quick to reach.
- Detail page: an Overview tab that answers "is it working?" with real numbers.
- List page (`/employees`): a polish pass that makes employees quicker to scan and find.

## Non-goals

- No new API endpoints, no schema changes, no new metrics computed server-side.
- No rewrite of the section components in `components/employees/` (Knowledge, Tools, Phone,
  Channels, ChannelLog, Releases) or `ProviderOverridesForm`. They move, they do not change.
- No change to the edit, chat or compare pages.

## Anti-goals

- A tab that fetches data while hidden (each tab's sections mount only when the tab is open).
- Breaking the Skullet loading skeleton, or reintroducing the `asChild` Slot error inside it.
- Anything outside shadcn/ui, lucide icons and theme tokens (CLAUDE.md UI rule).

## Approaches considered

- **A. Tabs inside the page (picked).** Same route; shadcn `Tabs` under the header; active tab kept
  in the URL as `?tab=`. Smallest change, sections move as-is. Trade-off: Channels plus Message log
  is still a long tab.
- B. Settings-style side menu with one section at a time. Clear on desktop, but 13 entries is a lot
  and it collapses to a dropdown on phones.
- C. Separate sub-routes under a shared layout. Cleanest URLs and per-page loading, but the most work
  and the Skullet skeleton would be redone per route.

The owner picked A.

## Design

### Detail page `/employees/[id]`

Header stays as it is (back link, avatar, name, status, role, actions, the unpublished-changes alert).
Below it, `Tabs` with the value synced to `?tab=` (default `overview`, unknown values fall back to it):

| Tab | Contents |
|-----|----------|
| Overview | Stat tiles + "at a glance" facts (below) |
| Setup | Identity, Role (incl. system instructions), Personality, Goals, Providers |
| Knowledge & tools | Knowledge, Tools |
| Channels | Phone, Channels, Message log |
| Releases | Releases, Versions table |

Overview:
- `StatTile` row from existing endpoints, filtered to this employee:
  - `GET /workspaces/:ws/inbox?view=all&employeeId=` → `counts`: open conversations
    (`ai_active` + `human_active` + `waiting`), and handed to a human (`human_active`).
  - `GET /workspaces/:ws/quality?days=30&employeeId=` → `evaluations`, `averageScore`, `passRate`
    (formatted with `formatScore` / `formatRate` from `components/quality`).
- A facts card: live version vs latest, last published/changed date, language, working hours summary,
  escalation on/off. Links ("View conversations", "View quality") into the existing pages, filtered
  where those pages already support it.
- Empty states via `EmptyState` when there are no conversations or evaluations yet.

### List page `/employees`

- Search `Input` above the table, filtering by name and role on the client.
- A small summary line or tiles above the table: counts of active, paused and draft (never published)
  employees from the already-loaded list.
- Each row: a "Live vN" / "Draft" badge instead of the plain version text.
- Keep: Current/Archived tabs, pagination (`usePaged`), row actions menu, empty states.

## Left to the builder

- Exact tile set and order, and responsive breakpoints.
- Whether "draft" counts include employees whose latest version is ahead of the published one.
- Visual polish details within shadcn and theme tokens.
