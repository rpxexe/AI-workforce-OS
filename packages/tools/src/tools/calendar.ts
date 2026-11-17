import { prisma } from "@workforce/database";
import { toolConfigSchemas } from "@workforce/shared";
import { z } from "zod";
import { defineTool, ToolError } from "../types.ts";

/** Milliseconds between `timeZone`'s wall clock and UTC at instant `at`. */
const offsetMs = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - at.getTime();
};

/** "2026-11-18 15:00" in `timeZone`. */
export const localTime = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(at);

/** The instant a wall-clock date and time in `timeZone` refers to, or null if that time does not exist there. */
export function zonedTime(date: string, time: string, timeZone: string) {
  const wall = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(wall.getTime())) return null;
  // Twice, so a guess on the wrong side of a daylight-saving change corrects itself.
  let at = new Date(wall.getTime() - offsetMs(wall, timeZone));
  at = new Date(wall.getTime() - offsetMs(at, timeZone));
  // Rejects dates like 2026-02-30 and times skipped by daylight saving.
  return localTime(at, timeZone) === `${date} ${time}` ? at : null;
}

const slot = z.object({ start: z.string(), end: z.string() });

export const calendarTool = defineTool({
  name: "calendar_book_meeting",
  title: "Calendar: book meetings",
  description:
    "Book a meeting with the customer in the company calendar. Use it when the customer asks to book, schedule or set up a meeting or call. Give the date and time in the company's local time, worked out from the current date in your instructions (\"tomorrow at 3 PM\" is tomorrow's date and 15:00). If the time is taken, the result lists the busy slots: offer the customer another time.",
  input: z.object({
    title: z.string().trim().min(1).max(200).describe("Short title, e.g. 'Enterprise plan demo with Rahul'"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Local date, YYYY-MM-DD"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour").describe("Local start time, HH:MM, 24-hour"),
    durationMinutes: z.number().int().min(15).max(240).default(30),
    attendeeName: z.string().trim().max(200).optional(),
    attendeeEmail: z.email().optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("booked"), eventId: z.string(), start: z.string(), end: z.string(), timezone: z.string() }),
    z.object({ status: z.literal("conflict"), busy: z.array(slot), timezone: z.string() }),
  ]),
  config: toolConfigSchemas.calendar_book_meeting,
  permissions: ["calendar:write"],
  timeoutMs: 5_000,
  // Not repeated: a retry after a timeout could book twice.
  retry: { attempts: 1, backoffMs: 0 },

  async execute(input, ctx) {
    const { timezone } = ctx;
    const startsAt = zonedTime(input.date, input.time, timezone);
    if (!startsAt) throw new ToolError(`${input.date} ${input.time} is not a valid time in ${timezone}`);
    if (startsAt.getTime() < Date.now()) throw new ToolError(`${input.date} ${input.time} (${timezone}) is in the past`);
    const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);

    // shortcut: two bookings for the same slot at the same instant can both pass this check; add an exclusion constraint when a real calendar is not used instead
    const busy = await prisma.calendarEvent.findMany({
      where: { workspaceId: ctx.workspaceId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true, endsAt: true },
    });
    if (busy.length > 0)
      return {
        status: "conflict" as const,
        busy: busy.map((b) => ({ start: localTime(b.startsAt, timezone), end: localTime(b.endsAt, timezone) })),
        timezone,
      };

    const event = await prisma.calendarEvent.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        employeeId: ctx.employeeId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        title: input.title,
        startsAt,
        endsAt,
        timezone,
        attendeeName: input.attendeeName,
        attendeeEmail: input.attendeeEmail,
        notes: input.notes,
      },
    });
    return {
      status: "booked" as const,
      eventId: event.id,
      start: localTime(startsAt, timezone),
      end: localTime(endsAt, timezone),
      timezone,
    };
  },
});
