"use client";

import { OrganizationList, OrganizationSwitcher, useAuth } from "@clerk/nextjs";
import {
  BookOpen,
  Bot,
  ChartColumn,
  Check,
  ChevronsUpDown,
  CreditCard,
  FileChartColumn,
  LayoutDashboard,
  Lightbulb,
  MessagesSquare,
  Moon,
  Route,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, type ReactNode } from "react";
import { CommandMenu } from "@/components/command-menu";
import { NavUser } from "@/components/nav-user";
import { ErrorState } from "@/components/states";
import { Spinner } from "@/components/ui/spinner";
import { clearApiCache, useRefreshing } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveNotifications, useWaitingCount } from "@/lib/live";
import { WorkspaceProvider, useWorkspaces } from "@/lib/workspace";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/analytics", label: "Analytics", icon: ChartColumn },
      { href: "/reports", label: "Reports", icon: FileChartColumn },
    ],
  },
  {
    label: "Workforce",
    items: [
      { href: "/employees", label: "Employees", icon: Bot },
      { href: "/conversations", label: "Conversations", icon: MessagesSquare },
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/knowledge", label: "Knowledge", icon: BookOpen },
      { href: "/workflows", label: "Workflows", icon: Workflow },
    ],
  },
  {
    label: "Optimize",
    items: [
      { href: "/quality", label: "Quality", icon: ShieldCheck },
      { href: "/improvements", label: "Improvements", icon: Lightbulb },
      { href: "/model-routing", label: "Model routing", icon: Route },
    ],
  },
];

const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings };
const BILLING: NavItem = { href: "/billing", label: "Billing", icon: CreditCard };
const NAV = [...NAV_GROUPS.flatMap((group) => group.items), BILLING, SETTINGS];


const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

// Active item is solid primary in light mode and a gray fill in dark mode, as in the shadcn Mail example.
const NAV_ITEM_CLASS =
  "h-8 font-medium data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:hover:bg-primary/90 data-[active=true]:hover:text-primary-foreground dark:data-[active=true]:bg-sidebar-accent dark:data-[active=true]:text-sidebar-accent-foreground dark:data-[active=true]:hover:bg-sidebar-accent";

function NavLink({ href, label, icon: Icon }: NavItem) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive(pathname, href)} tooltip={label} className={NAV_ITEM_CLASS}>
        <Link href={href} onClick={() => setOpenMobile(false)}>
          <Icon aria-hidden />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {href === "/conversations" && <WaitingBadge />}
    </SidebarMenuItem>
  );
}

/** Conversations waiting for a person, unassigned; updated live. */
function WaitingBadge() {
  const waiting = useWaitingCount();
  if (waiting === 0) return null;
  return (
    <SidebarMenuBadge className="bg-warning/20 text-foreground peer-data-[active=true]/menu-button:text-foreground" aria-label={`${waiting} waiting for a person`}>
      {waiting > 99 ? "99+" : waiting}
    </SidebarMenuBadge>
  );
}

// Single-line select-style box, like the account picker at the top of the shadcn Mail example.
function Brand({ name }: { name: string }) {
  return (
    <>
      <Bot aria-hidden />
      <span className="truncate font-medium">{name}</span>
    </>
  );
}

const SWITCHER_CLASS = "h-9 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground";

function WorkspaceSwitcher() {
  const state = useWorkspaces();
  const { isMobile } = useSidebar();
  if (!state.workspace) {
    if (state.loading) return <Skeleton className="h-9 w-full" />;
    return (
      <SidebarMenuButton variant="outline" className={SWITCHER_CLASS} tooltip="AI Workforce OS" asChild>
        <Link href="/">
          <Brand name="No workspace" />
        </Link>
      </SidebarMenuButton>
    );
  }
  const { workspace, workspaces = [], select } = state;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          variant="outline"
          className={SWITCHER_CLASS}
          aria-label={`Workspace: ${workspace.name}. Switch workspace`}
        >
          <Brand name={workspace.name} />
          <ChevronsUpDown className="ml-auto" aria-hidden />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={isMobile ? "bottom" : "right"}
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => select(w.id)}>
            <Avatar size="sm" className="rounded-md after:rounded-md" aria-hidden>
              <AvatarFallback className="rounded-md bg-transparent font-medium text-foreground">{w.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>

            <span className="truncate">{w.name}</span>
            {w.id === workspace.id && <Check className="ml-auto" aria-label="Current" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings?tab=workspaces">Manage workspaces</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One click flips light and dark. The label is fixed: resolvedTheme is unknown on the server, so a label built from it would not hydrate. */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label="Toggle light and dark mode"
      className="[&_svg]:transition-transform hover:[&_svg]:rotate-12"
    >
      {/* Picked by the html class, not by `resolvedTheme`, so the server render already shows the right icon. */}
      <Moon className="dark:hidden" aria-hidden />
      <Sun className="hidden dark:block" aria-hidden />
    </Button>
  );
}

function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      {/* h-14 matches the page header, so both bottom borders form one line. */}
      <SidebarHeader className="h-14 justify-center border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-0.5">
            {/* -mt-6 matches h-6 so the hidden label takes no space when collapsed. */}
            <SidebarGroupLabel className="h-6 group-data-[collapsible=icon]:-mt-6">{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.href} {...item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <NavLink {...BILLING} />
          <NavLink {...SETTINGS} />
        </SidebarMenu>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Pages always render (each shows its own loading state); only a failed workspace load replaces them. */
function WorkspaceGate({ children }: { children: ReactNode }) {
  const state = useWorkspaces();
  if (state.error && !state.workspace) return <ErrorState message={state.error.message} onRetry={state.reload} />;
  return children;
}

function ChooseOrganization() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Choose an organization</h1>
      <p className="text-sm text-muted-foreground">
        Everything in AI Workforce OS belongs to an organization. Create one, or pick one you have been invited to.
      </p>
      <OrganizationList hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
    </div>
  );
}

/** G then this letter opens the page (shown in the command menu). */
const GO_KEYS: Record<string, string> = {
  "/": "d",
  "/analytics": "a",
  "/reports": "r",
  "/employees": "e",
  "/conversations": "c",
  "/customers": "u",
  "/knowledge": "k",
  "/workflows": "w",
  "/quality": "q",
  "/improvements": "i",
  "/model-routing": "m",
  "/billing": "b",
  "/settings": "s",
};
const COMMAND_PAGES = [
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label }))),
  { ...BILLING, group: "Account" },
  { ...SETTINGS, group: "Account" },
].map((page) => ({ ...page, key: GO_KEYS[page.href] }));

export function AppShell({ children, defaultOpen }: { children: ReactNode; defaultOpen: boolean }) {
  const { isLoaded, orgId, userId } = useAuth();
  const pathname = usePathname();
  const title = NAV.find(({ href }) => isActive(pathname, href))?.label;
  const refreshing = useRefreshing();
  // Cached responses belong to one user in one organization: drop them when either changes or the user signs out.
  useEffect(() => clearApiCache, [userId, orgId]);

  // Keyed by organization: switching it discards every piece of the previous tenant's data.
  return (
    <WorkspaceProvider key={orgId ?? ""} orgId={orgId ?? null}>
      <LiveNotifications>
      <TooltipProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar />
          {/* min-w-0: lets truncated text shrink instead of widening the page past the viewport. Exactly the window's
              height: the header stays put and only the content under it scrolls, so its scrollbar starts below the header. */}
          <SidebarInset className="h-svh min-w-0 overflow-hidden">
            {/* Three columns: the page title, the search box centred, the account controls. */}
            <header className="z-10 grid h-14 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:grid-cols-[1fr_minmax(0,24rem)_1fr]">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
                <span className="truncate text-sm font-medium">{title}</span>
              </div>
              <div className="flex justify-center">{orgId && <CommandMenu pages={COMMAND_PAGES} />}</div>
              <div className="flex items-center justify-end gap-2">
                {refreshing && <Spinner className="text-muted-foreground" aria-label="Refreshing" />}
                <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
                <ThemeToggle />
              </div>
            </header>
            {/* The page's scroll area. The gutter stays reserved when a page is short (a skeleton), so content doesn't
                jump sideways when it loads. */}
            <div data-slot="page-scroll" className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
                {isLoaded && !orgId ? <ChooseOrganization /> : <WorkspaceGate>{children}</WorkspaceGate>}
              </div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
      </LiveNotifications>
    </WorkspaceProvider>
  );
}
