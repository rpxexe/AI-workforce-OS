import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Same cookie the sidebar writes when it is toggled, so a reload keeps it collapsed or expanded.
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return <AppShell defaultOpen={sidebarOpen}>{children}</AppShell>;
}
