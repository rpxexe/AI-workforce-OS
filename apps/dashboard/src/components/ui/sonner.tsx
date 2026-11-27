"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // A raised card: the type's icon in a tinted tile (like the dashboard's attention rows), title over a muted
      // description, an outline action button, and the close button on the top-right corner.
      toastOptions={{
        classNames: {
          toast: "group/toast font-sans gap-3! p-3! pr-4! shadow-lg! items-center!",
          icon: "m-0! size-8! shrink-0 rounded-md border bg-muted/40 flex! items-center justify-center text-muted-foreground group-data-[type=success]/toast:text-success group-data-[type=success]/toast:bg-success/10 group-data-[type=success]/toast:border-success/20 group-data-[type=error]/toast:text-destructive group-data-[type=error]/toast:bg-destructive/10 group-data-[type=error]/toast:border-destructive/20 group-data-[type=warning]/toast:text-warning group-data-[type=warning]/toast:bg-warning/10 group-data-[type=warning]/toast:border-warning/20 group-data-[type=info]/toast:text-info group-data-[type=info]/toast:bg-info/10 group-data-[type=info]/toast:border-info/20",
          content: "gap-0.5!",
          title: "text-sm! font-medium! leading-snug!",
          description: "text-xs! leading-snug! text-muted-foreground!",
          actionButton:
            "h-7! rounded-md! border! border-border! bg-background! px-2.5! text-xs! font-medium! text-foreground! hover:bg-muted!",
          cancelButton: "h-7! rounded-md! bg-transparent! px-2.5! text-xs! text-muted-foreground! hover:text-foreground!",
          closeButton: "bg-popover! border-border! text-muted-foreground! hover:text-foreground!",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--width": "380px",
          // Close button on the top-right corner instead of sonner's top-left.
          "--toast-close-button-start": "unset",
          "--toast-close-button-end": "0",
          "--toast-close-button-transform": "translate(35%, -35%)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
