import type { CustomerSummary } from "@workforce/shared";
import { formatDate } from "@/components/employees/meta";
import { timeAgo } from "@/components/inbox/meta";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Seen in the last seven days. */
export const seenThisWeek = (iso: string) => Date.now() - new Date(iso).getTime() < WEEK_MS;

/** "PS" for "Priya Sharma"; the channel id's first character when there is no name. */
export function initials(customer: Pick<CustomerSummary, "name" | "externalId">) {
  const words = (customer.name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? customer.externalId.replace(/^\+/, ""))[0];
  return (letters ?? "?").toUpperCase();
}

/** Initials are decoration; the name next to them carries who it is. */
export function CustomerAvatar({ customer, size }: { customer: Pick<CustomerSummary, "name" | "externalId">; size?: "sm" | "default" | "lg" }) {
  return (
    <Avatar size={size} aria-hidden>
      <AvatarFallback className="bg-primary/10 font-medium text-primary">{initials(customer)}</AvatarFallback>
    </Avatar>
  );
}

/** "3 h ago", with the full date on hover and focus. */
export function RelativeTime({ iso }: { iso: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} tabIndex={0} className="whitespace-nowrap">
          {timeAgo(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDate(iso)}</TooltipContent>
    </Tooltip>
  );
}
