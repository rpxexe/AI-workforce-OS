"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { ErrorState } from "@/components/states";
import "./globals.css";

// global-error replaces the root layout, so next-themes is not running: read its saved choice directly.
const applyTheme = `try{var t=localStorage.getItem("theme");if(t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

/** Last resort when the root layout itself fails. It renders its own document. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Something went wrong · AI Workforce OS</title>
        <script dangerouslySetInnerHTML={{ __html: applyTheme }} />
      </head>
      <body className="flex min-h-svh items-center justify-center bg-background p-4 font-sans text-foreground antialiased">
        <main className="w-full max-w-md">
          <ErrorState message="The app failed to load. Try again, or reload the page." onRetry={retry} />
        </main>
      </body>
    </html>
  );
}
