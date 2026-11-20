"use client";

import { OrganizationList, OrganizationSwitcher, UserButton, useAuth } from "@clerk/nextjs";
import {
  BookOpen,
  Bot,
  ChartColumn,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  Lightbulb,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/states";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider, useWorkspaces } from "@/lib/workspace";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employees", label: "Employees", icon: Bot },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/analytics", label: "Analytics", icon: ChartColumn },
  { href: "/quality", label: "Quality", icon: ShieldCheck },
  { href: "/improvements", label: "Improvements", icon: Lightbulb },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

function WorkspaceSwitcher() {
  const state = useWorkspaces();
  if (!state.workspace) return state.loading ? <Skeleton className="h-10 w-full" /> : null;
  const { workspace, workspaces = [], select } = state;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton className="border bg-background" aria-label={`Workspace: ${workspace.name}. Switch workspace`}>
          <span className="flex min-w-0 flex-col text-left leading-tight">
            <span className="text-xs text-muted-foreground">Workspace</span>
            <span className="truncate font-medium">{workspace.name}</span>
          </span>
          <ChevronsUpDown className="ml-auto" aria-hidden />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => select(w.id)}>
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

function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <Link href="/" className="flex items-center gap-2 px-2 pt-1 font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" aria-hidden />
          </span>
          AI Workforce OS
        </Link>
        <div className="px-1">
          <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ href, label, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton asChild isActive={isActive(pathname, href)}>
                    <Link href={href} onClick={() => setOpenMobile(false)}>
                      <Icon aria-hidden />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-2 py-1">
          <UserButton showName />
        </div>
      </SidebarFooter>
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

export function AppShell({ children }: { children: ReactNode }) {
  const { isLoaded, orgId } = useAuth();
  const pathname = usePathname();
  const title = NAV.find(({ href }) => isActive(pathname, href))?.label;

  // Keyed by organization: switching it discards every piece of the previous tenant's data.
  return (
    <WorkspaceProvider key={orgId ?? ""} orgId={orgId ?? null}>
      <TooltipProvider>
        <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <span className="text-sm text-muted-foreground">{title}</span>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
            {isLoaded && !orgId ? <ChooseOrganization /> : <WorkspaceGate>{children}</WorkspaceGate>}
          </main>
        </SidebarInset>
      </SidebarProvider>
      </TooltipProvider>
    </WorkspaceProvider>
  );
}
