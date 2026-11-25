"use client";

import { cn } from "cn";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";

/** An AI reply rendered as markdown (shadcn AI Elements Message pattern). Streamdown sanitizes raw HTML. */
export function Markdown({ className, ...props }: ComponentProps<typeof Streamdown>) {
  return <Streamdown className={cn("size-full text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)} {...props} />;
}
