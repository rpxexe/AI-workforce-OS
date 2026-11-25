import { CircleAlert, RotateCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton as Skullet } from "skullet/react";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * Generic fallback skeleton, drawn by Skullet. Pages that load data should instead wrap their real
 * content in Skullet's `<Skeleton data sample>` so the skeleton matches it; this is for the rest.
 */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <Skullet loading label="Loading">
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    </Skullet>
  );
}

// Same box as a Card, so empty and failed views sit in the page like the rest of its content.
const STATE_BOX = "border border-solid bg-card shadow-sm dark:shadow-none md:py-14";

/** A failed load (with retry) gets a centered state; a failed action without retry stays a compact alert. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!onRetry) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Empty className={STATE_BOX} role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <CircleAlert aria-hidden />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty className={STATE_BOX}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

/** A headline number with its label and an optional hint underneath. */
/** KPI tile laid out like the shadcn dashboard example: label and icon on top, big value, muted hint. */
export function StatTile({ label, value, hint, icon: Icon }: { label: string; value: ReactNode; hint?: string; icon?: LucideIcon }) {
  return (
    <Card className="gap-2 py-5">
      <CardContent className="flex items-center justify-between gap-2 px-5">
        <span className="text-sm font-medium">{label}</span>
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </CardContent>
      <CardContent className="flex flex-col gap-0.5 px-5">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}

/** Body of a section that exists in the navigation but is built in a later phase. */
export function ComingSoon({ icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <EmptyState icon={icon} title={`${title} is not available yet`} description={description} />
    </div>
  );
}
