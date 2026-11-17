"use client";

import { useAuth } from "@clerk/nextjs";
import type { ApiError } from "@workforce/shared";
import { useCallback, useEffect, useState } from "react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  status: number;
  issues: NonNullable<ApiError["issues"]>;

  constructor(status: number, body: ApiError | null) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.issues = body?.issues ?? [];
  }
}

/** `file` sends the file itself as the request body (uploads); otherwise `body` is sent as JSON. */
type Init = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; file?: File };

/** Calls the API as the signed-in user. The Clerk session token carries the active organization. */
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T>(path: string, { method = "GET", body, file }: Init = {}): Promise<T> => {
      const token = await getToken();
      let res: Response;
      try {
        res = await fetch(`${API_URL}${path}`, {
          method,
          headers: {
            ...(token && { authorization: `Bearer ${token}` }),
            ...(file ? { "content-type": "application/octet-stream" } : body !== undefined && { "content-type": "application/json" }),
          },
          body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
      } catch {
        throw new ApiRequestError(0, { error: "Cannot reach the server. Check your connection and try again." });
      }
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new ApiRequestError(res.status, data as ApiError | null);
      return data as T;
    },
    [getToken],
  );
}

/**
 * POSTs `body` to an endpoint that answers with server-sent events and calls `onEvent` for each
 * one until the stream ends. Requests refused before the stream opens throw `ApiRequestError`.
 */
export function useApiStream() {
  const { getToken } = useAuth();
  return useCallback(
    async <E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal) => {
      const token = await getToken();
      let res: Response;
      try {
        res = await fetch(`${API_URL}${path}`, {
          method: "POST",
          headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        throw new ApiRequestError(0, { error: "Cannot reach the server. Check your connection and try again." });
      }
      if (!res.ok || !res.body) throw new ApiRequestError(res.status, (await res.json().catch(() => null)) as ApiError | null);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        // Events are separated by a blank line; the last piece may be incomplete.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)) as E);
      }
    },
    [getToken],
  );
}

type Result<T> = { path: string; attempt: number; data?: T; error?: ApiRequestError };

/**
 * Loads `path` and reloads when it changes. `data` from the previous attempt stays visible while
 * a reload is in flight, so lists do not flash back to a skeleton after every action.
 */
export function useApiQuery<T>(path: string | null) {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result<T>>();

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    api<T>(path).then(
      (data) => !cancelled && setResult({ path, attempt, data }),
      (error: ApiRequestError) => !cancelled && setResult({ path, attempt, error }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, path, attempt]);

  const samePath = result?.path === path ? result : undefined;
  const settled = samePath?.attempt === attempt;
  return {
    data: samePath?.data,
    error: settled ? samePath?.error : undefined,
    loading: path !== null && !settled,
    reload: useCallback(() => setAttempt((n) => n + 1), []),
    /** Replace the cached value with one the server just returned from a mutation. */
    setData: useCallback((data: T) => path !== null && setResult({ path, attempt, data }), [path, attempt]),
  };
}
