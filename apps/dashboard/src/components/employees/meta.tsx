import type { EmployeeConfig, EmployeeStatus } from "@workforce/shared";
import {
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Headset,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const AVATAR_ICONS: Record<EmployeeConfig["avatar"], LucideIcon> = {
  bot: Bot,
  headset: Headset,
  briefcase: BriefcaseBusiness,
  sparkles: Sparkles,
  shield: ShieldCheck,
  cart: ShoppingCart,
  calendar: CalendarDays,
  wrench: Wrench,
};

export const AVATAR_LABELS: Record<EmployeeConfig["avatar"], string> = {
  bot: "Robot",
  headset: "Headset",
  briefcase: "Briefcase",
  sparkles: "Sparkles",
  shield: "Shield",
  cart: "Shopping cart",
  calendar: "Calendar",
  wrench: "Wrench",
};

export function EmployeeAvatar({ avatar, className }: { avatar: EmployeeConfig["avatar"]; className?: string }) {
  const Icon = AVATAR_ICONS[avatar];
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground", className)}>
      <Icon className="size-1/2" aria-hidden />
    </span>
  );
}

const STATUS: Record<EmployeeStatus, { label: string; dot: string }> = {
  DRAFT: { label: "Draft", dot: "bg-muted-foreground/50" },
  ACTIVE: { label: "Active", dot: "bg-emerald-500" },
  PAUSED: { label: "Paused", dot: "bg-amber-500" },
  ARCHIVED: { label: "Archived", dot: "bg-muted-foreground/30" },
};

export function StatusBadge({ status }: { status: EmployeeStatus }) {
  const { label, dot } = STATUS[status];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </Badge>
  );
}

/** "v3 · live v2", or says plainly that nothing is published. */
export function versionLabel(latest: number, published: number | null) {
  if (published === null) return `v${latest} · not published`;
  return published === latest ? `v${latest} · live` : `v${latest} · live v${published}`;
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export const DAY_LABELS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
} as const;
