"use client";

import { format, parseISO } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useRef, useState, type ComponentProps, type PointerEvent } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

const iso = (d: Date) => format(d, "yyyy-MM-dd");

/** Tags each day with its date, so a drag can find the day under the pointer in either month. */
function TaggedDayButton(props: ComponentProps<typeof CalendarDayButton>) {
  return (
    <CalendarDayButton
      {...props}
      // A short fade so days shade in and out as a drag passes over them, instead of snapping.
      className={cn("transition-[background-color,color,border-radius] duration-150 ease-out", props.className)}
      data-range-day={iso(props.day.date)}
      data-range-disabled={props.modifiers.disabled || undefined}
    />
  );
}

/** The enabled day under a point, as "yyyy-MM-dd". Works across both months and under a finger. */
const dayAt = (x: number, y: number) => {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-range-day]");
  return el && !el.hasAttribute("data-range-disabled") ? el.dataset.rangeDay! : null;
};

const ordered = (a: string, b: string): DateRange => (a <= b ? { from: parseISO(a), to: parseISO(b) } : { from: parseISO(b), to: parseISO(a) });

/**
 * Two-month range picker from the shadcn date-picker-with-range example (one month on phones). Days are
 * "yyyy-MM-dd"; parseISO/format read and write them in local time, so a picked day never shifts.
 * Pick by clicking a start and an end day, or by dragging from one to the other; picking again starts a
 * new range. Nothing is applied while the picker is open: closing it (a click outside, or Escape) hands the
 * picked range to `onChange` once, so the caller fetches once. A lone start day applies as a one-day range.
 * react-day-picker 10 returns a complete range (from === to) on the first click, so clicks are counted.
 */
export function DateRangePicker({
  id,
  from,
  to,
  onChange,
  disableFuture = true,
}: {
  id?: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  disableFuture?: boolean;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // The first clicked day, while waiting for the second.
  const [start, setStart] = useState<Date>();
  // The range picked since opening, applied when the picker closes.
  const [picked, setPicked] = useState<DateRange>();
  // The range under the pointer while dragging.
  const [preview, setPreview] = useState<DateRange>();
  const drag = useRef<{ anchor: string; last: string; moved: boolean; frame: number } | null>(null);
  // A drag that ends on a day can still fire a click there; that click must not count as a pick.
  const skipClick = useRef(false);
  const applied: DateRange = { from: parseISO(from), to: parseISO(to) };
  const chosen = picked ?? (start ? { from: start, to: start } : undefined);
  const shown = chosen ?? applied;

  const reset = () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
    setPreview(undefined);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const day = dayAt(e.clientX, e.clientY);
    skipClick.current = false;
    if (!day) return void (drag.current = null);
    // Grabbing an end of the shown range moves that end: the other end stays put as the anchor.
    let anchor = day;
    const [a, b] = [iso(shown.from!), iso(shown.to!)];
    if (a !== b && day === b) anchor = a;
    else if (a !== b && day === a) anchor = b;
    drag.current = { anchor, last: day, moved: false, frame: 0 };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const day = dayAt(e.clientX, e.clientY);
    if (!day || day === g.last) return; // only redraw when the day under the pointer changes
    g.last = day;
    if (!g.moved) {
      g.moved = true;
      // Capture only once it is a drag, so a plain click still reaches the day button.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    cancelAnimationFrame(g.frame);
    g.frame = requestAnimationFrame(() => setPreview(ordered(g.anchor, g.last)));
  };

  const onPointerUp = () => {
    const g = drag.current;
    if (!g) return;
    const moved = g.moved;
    const range = ordered(g.anchor, g.last);
    reset();
    if (!moved) return; // a click: onSelect handles it
    skipClick.current = true;
    setStart(undefined);
    setPicked(range);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        reset();
        // Closing applies what was picked; a range equal to the applied one changes nothing, so no refetch.
        if (!next && chosen?.from && chosen.to && (iso(chosen.from) !== from || iso(chosen.to) !== to)) onChange(iso(chosen.from), iso(chosen.to));
        if (!next) {
          setStart(undefined);
          setPicked(undefined);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" className="w-64 justify-start font-normal">
          <CalendarIcon aria-hidden />
          {format(shown.from!, "d MMM yyyy")} – {format(shown.to!, "d MMM yyyy")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        {/* touch-none: a finger drag selects days instead of scrolling; select-none: no text highlight while dragging.
            The cell transitions let the range band ease across days as a drag moves, instead of jumping. */}
        <div
          className="touch-none select-none [&_td]:transition-[background-color,border-radius] [&_td]:duration-150 [&_td]:ease-out"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={reset}
        >
          <Calendar
            mode="range"
            required
            numberOfMonths={isMobile ? 1 : 2}
            defaultMonth={isMobile ? applied.to : applied.from}
            selected={preview ?? shown}
            disabled={disableFuture ? { after: new Date() } : undefined}
            components={{ DayButton: TaggedDayButton }}
            onSelect={(range, day) => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              // First click (or a click after a finished pick) starts a new range; the second completes it.
              if (!start) {
                setPicked(undefined);
                return setStart(day);
              }
              setStart(undefined);
              if (range) setPicked(range);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
