"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { ErrorState } from "@/components/states";

// Production replaces server error messages with a digest, so only show a message we know is safe.
const messageOf = (error: unknown) =>
  error instanceof Error && error.message && !("digest" in error && error.digest)
    ? error.message
    : "This page failed to load. Try again, or come back in a moment.";

/** Catches a crashed page inside the app shell, so the sidebar and header stay usable. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ErrorState message={messageOf(error)} onRetry={retry} />;
}
