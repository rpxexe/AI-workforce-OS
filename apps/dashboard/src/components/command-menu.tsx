"use client";

import type { EmployeeSummary } from "@workforce/shared";
import { Bot, Check, Moon, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { PAGE_TABS, switchTabInPlace, type TabbedPage } from "@/lib/tabs";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin, useWorkspaces } from "@/lib/workspace";

export type CommandPage = { href: string; label: string; icon: LucideIcon; group: string; key?: string };

/** Settings sections and account tabs, reachable from the menu. */
const SETTINGS_PLACES = [
  { href: "/settings?tab=workspaces", label: "Workspaces" },
  { href: "/settings?tab=organization", label: "Organization" },
  { href: "/settings?tab=profile", label: "Profile" },
  { href: "/settings?section=ai-providers", label: "AI providers" },
  { href: "/settings?section=voice", label: "Voice & telephony" },
  { href: "/settings?section=messaging", label: "Messaging" },
  { href: "/settings?section=email", label: "Email" },
  { href: "/settings?section=storage", label: "Storage" },
  { href: "/settings?section=tools", label: "Employee tools" },
  { href: "/settings?section=api-keys", label: "API keys" },
  { href: "/settings?section=webhooks", label: "Webhooks" },
  { href: "/settings?section=audit", label: "Credentials & audit" },
  { href: "/settings?section=developer", label: "Developer" },
];

/** Typing in a field must never trigger a page shortcut. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The header's search box: ⌘K / Ctrl+K opens a palette to jump to any page or employee, switch workspace,
 * start common actions and change the theme. Employees load only while the palette is open.
 */
export function CommandMenu({ pages }: { pages: CommandPage[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const { resolvedTheme, setTheme } = useTheme();
  const { workspace, workspaces = [], select } = useWorkspaces();
  const employees = useApiQuery<EmployeeSummary[]>(open && workspace ? `/workspaces/${workspace.id}/employees` : null);

  /** Opens a page, or only switches the tab when that page is already open. */
  const go = (href: string) => {
    if (!switchTabInPlace(href)) router.push(href);
  };

  useEffect(() => {
    let gAt = 0; // when G was pressed, for "G then a letter"
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (Date.now() - gAt < 1500) {
        gAt = 0;
        const page = pages.find((p) => p.key === key);
        if (page) {
          e.preventDefault();
          router.push(page.href);
        }
      } else if (key === "g") gAt = Date.now();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pages, router]);

  /** Closes the palette, then runs the choice. */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const groups = [...new Set(pages.map((p) => p.group))];

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-9 w-full max-w-sm justify-start gap-2 bg-muted/40 px-3 font-normal text-muted-foreground shadow-none"
        aria-label="Search and jump to (Ctrl+K)"
      >
        <Search aria-hidden />
        <span className="hidden truncate sm:inline">Search pages, employees, actions…</span>
        <KbdGroup className="ml-auto hidden sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen} title="Search and jump to" description="Find a page, an employee or an action.">
        <CommandInput placeholder="Type a page, an employee or an action…" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>

          {groups.map((group) => (
            <CommandGroup key={group} heading={group}>
              {pages
                .filter((p) => p.group === group)
                .map((p) => (
                  <CommandItem key={p.href} value={`${p.label} ${group}`} onSelect={run(() => router.push(p.href))}>
                    <p.icon aria-hidden />
                    {p.label}
                    {p.key && <CommandShortcut>G {p.key.toUpperCase()}</CommandShortcut>}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}

          <CommandSeparator />
          <CommandGroup heading="Tabs">
            {(Object.keys(PAGE_TABS) as TabbedPage[]).flatMap((page) => {
              const owner = pages.find((p) => p.href === page);
              return PAGE_TABS[page].map((t, i) => (
                <CommandItem key={`${page}:${t.value}`} value={`${owner?.label ?? page} ${t.label} tab`} onSelect={run(() => go(`${page}?tab=${t.value}`))}>
                  {owner && <owner.icon aria-hidden />}
                  {owner?.label} › {t.label}
                  <CommandShortcut>Alt {i + 1}</CommandShortcut>
                </CommandItem>
              ));
            })}
            {SETTINGS_PLACES.map((s) => (
              <CommandItem key={s.href} value={`Settings ${s.label}`} onSelect={run(() => router.push(s.href))}>
                <Settings aria-hidden />
                Settings › {s.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading="Actions">
            {isAdmin && (
              <CommandItem value="New employee create" onSelect={run(() => router.push("/employees/new"))}>
                <Plus aria-hidden />
                New employee
              </CommandItem>
            )}
            <CommandItem value="Manage workspaces settings" onSelect={run(() => router.push("/settings?tab=workspaces"))}>
              <Settings aria-hidden />
              Manage workspaces
            </CommandItem>
            <CommandItem value="Toggle theme dark light mode" onSelect={run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}>
              <Moon aria-hidden />
              Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
            </CommandItem>
          </CommandGroup>

          {workspaces.length > 1 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Switch workspace">
                {workspaces.map((w) => (
                  <CommandItem key={w.id} value={`workspace ${w.name}`} onSelect={run(() => select(w.id))}>
                    {w.id === workspace?.id ? <Check aria-hidden /> : <span className="size-4" aria-hidden />}
                    {w.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {(employees.data?.length ?? 0) > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Employees">
                {employees.data!.slice(0, 50).map((e) => (
                  <CommandItem key={e.id} value={`employee ${e.name} ${e.role}`} onSelect={run(() => router.push(`/employees/${e.id}`))}>
                    <Bot aria-hidden />
                    <span className="truncate">{e.name}</span>
                    <CommandShortcut className="truncate tracking-normal">{e.role}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
