"use client";

import { OrganizationList, OrganizationSwitcher, UserButton, useAuth } from "@clerk/nextjs";
import {
  BookOpen,
  Bot,
  ChartColumn,
  Check,
  ChevronsUpDown,
  Laptop,
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
import type { ReactNode } from "react";
import { ErrorState } from "@/components/states";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider, useWorkspaces } from "@/lib/workspace";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/analytics", label: "Analytics", icon: ChartColumn },
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
const NAV = [...NAV_GROUPS.flatMap((group) => group.items), SETTINGS];

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
] as const;

const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

function NavLink({ href, label, icon: Icon }: NavItem) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive(pathname, href)} tooltip={label}>
        <Link href={href} onClick={() => setOpenMobile(false)}>
          <Icon aria-hidden />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <>
      <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
        <Bot className="size-4" aria-hidden />
      </span>
      <span className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-semibold">AI Workforce OS</span>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </>
  );
}

function WorkspaceSwitcher() {
  const state = useWorkspaces();
  const { isMobile } = useSidebar();
  if (!state.workspace) {
    if (state.loading) return <Skeleton className="h-12 w-full" />;
    return (
      <SidebarMenuButton size="lg" asChild>
        <Link href="/">
          <Brand subtitle="No workspace" />
        </Link>
      </SidebarMenuButton>
    );
  }
  const { workspace, workspaces = [], select } = state;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          aria-label={`Workspace: ${workspace.name}. Switch workspace`}
        >
          <Brand subtitle={workspace.name} />
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
            <span className="flex size-6 items-center justify-center rounded-md border text-xs font-medium" aria-hidden>
              {w.name.charAt(0).toUpperCase()}
            </span>
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

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const { isMobile } = useSidebar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton tooltip="Theme">
          {/* Picked by the html class, not by `theme`, so the server render already shows the right icon. */}
          <Sun className="dark:hidden" aria-hidden />
          <Moon className="hidden dark:block" aria-hidden />
          <span>Theme</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={isMobile ? "top" : "right"} sideOffset={4} className="min-w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar() {
  const { state, isMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-0.5">
            {/* -mt-7 matches h-7 so the hidden label takes no space when collapsed. */}
            <SidebarGroupLabel className="h-7 group-data-[collapsible=icon]:-mt-7">{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavLink key={item.href} {...item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <NavLink {...SETTINGS} />
          <SidebarMenuItem>
            <ThemeMenu />
          </SidebarMenuItem>
          <SidebarMenuItem className="flex h-10 items-center px-1.5 group-data-[collapsible=icon]:px-0">
            <UserButton showName={state === "expanded" || isMobile} />
          </SidebarMenuItem>
        </SidebarMenu>
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

export function AppShell({ children, defaultOpen }: { children: ReactNode; defaultOpen: boolean }) {
  const { isLoaded, orgId } = useAuth();
  const pathname = usePathname();
  const title = NAV.find(({ href }) => isActive(pathname, href))?.label;

  // Keyed by organization: switching it discards every piece of the previous tenant's data.
  return (
    <WorkspaceProvider key={orgId ?? ""} orgId={orgId ?? null}>
      <TooltipProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar />
          {/* min-w-0: lets truncated text shrink instead of widening the page past the viewport. */}
          <SidebarInset className="min-w-0">
            <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:rounded-t-xl">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
              <span className="text-sm font-medium">{title}</span>
              <div className="ml-auto">
                <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
              </div>
            </header>
            <div className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
              {isLoaded && !orgId ? <ChooseOrganization /> : <WorkspaceGate>{children}</WorkspaceGate>}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </WorkspaceProvider>
  );
}
