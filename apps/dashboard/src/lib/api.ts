"use client";

import { useAuth } from "@clerk/nextjs";
import type { ApiError } from "@workforce/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

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

/**
 * What a change announces as a toast. A string is the success message; `loading` also shows a spinner
 * toast while the request runs, which then turns into the success or error. `false` stays silent,
 * for changes the page already shows as they happen (a chat message appearing, a toggle flipping).
 */
export type ToastOption = string | { loading?: string; success: string } | false;

/**
 * `file` sends the file itself as the request body (uploads); otherwise `body` is sent as JSON.
 * Changes (anything but GET) show a toast when they fail, and a success toast when `toast` names one.
 */
type Init = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; file?: File; toast?: ToastOption };

/** Calls the API as the signed-in user. The Clerk session token carries the active organization. */
export function useApi() {
  const request = useRequest();
  return useCallback(
    async <T>(path: string, init: Init = {}): Promise<T> => {
      const { method = "GET", toast: option } = init;
      if (method === "GET" || option === false) return request<T>(path, init);
      const { loading, success } = typeof option === "string" ? { loading: undefined, success: option } : (option ?? {});
      const id = loading ? toast.loading(loading) : undefined;
      try {
        const data = await request<T>(path, init);
        if (success) toast.success(success, { id });
        else if (id !== undefined) toast.dismiss(id);
        return data;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong. Try again.", { id });
        throw err;
      }
    },
    [request],
  );
}

function useRequest() {
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

type Result<T> = { key: string; attempt: number; data?: T; error?: ApiRequestError };

/**
 * The last good response per user, organization and path, kept in memory only (never in browser storage), so a page
 * opened again shows its data at once while it reloads. Keys carry the user and the organization, so a response is
 * never shown to another account or in another organization. Entries older than CACHE_MS are not shown, and the
 * app shell empties the cache when the user signs out or switches account.
 */
const cache = new Map<string, { data: unknown; at: number }>();
const CACHE_ENTRIES = 100;
const CACHE_MS = 5 * 60_000;
function remember(key: string, data: unknown) {
  cache.delete(key);
  cache.set(key, { data, at: Date.now() });
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
}
function recall<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.data as T;
}
/** Forgets every cached response; called when the signed-in user or the organization changes. */
export function clearApiCache() {
  cache.clear();
}

// How many loads are refreshing data already on screen, for the app shell's busy indicator.
let refreshing = 0;
const listeners = new Set<() => void>();
const bump = (by: number) => {
  refreshing += by;
  for (const l of listeners) l();
};
/** True while any page is refreshing data it already shows (cached or from before a reload). */
export function useRefreshing() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => refreshing > 0,
    () => false,
  );
}

/**
 * Loads `path` and reloads when it changes. `data` from the previous attempt stays visible while
 * a reload is in flight, so lists do not flash back to a skeleton after every action. A path loaded
 * before in this session shows its cached data straight away while the fresh copy loads.
 *
 * `keepPrevious`: while a new path with nothing cached loads, keep returning the last path's data, so a chart can
 * morph to the new numbers instead of being rebuilt. A failed load still returns no data, so the error shows.
 */
export function useApiQuery<T>(path: string | null, { keepPrevious = false }: { keepPrevious?: boolean } = {}) {
  const api = useApi();
  const { userId, orgId } = useAuth();
  const key = path === null ? null : `${userId ?? ""}|${orgId ?? ""}|${path}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result<T>>();

  useEffect(() => {
    if (path === null || key === null) return;
    let cancelled = false;
    // Something is already on screen (cached or the last load): this is a refresh, shown by the app shell.
    const background = recall(key) !== undefined || attempt > 0;
    if (background) bump(1);
    let counted = background;
    const done = () => {
      if (counted) bump(-1);
      counted = false;
    };
    api<T>(path).then(
      (data) => {
        done();
        if (cancelled) return;
        remember(key, data);
        setResult({ key, attempt, data });
      },
      (error: ApiRequestError) => {
        done();
        if (cancelled) return;
        // A failed refresh keeps what was shown and says so, instead of swapping it for an error box.
        if (recall(key) !== undefined) toast.error(`Could not refresh: ${error.message} Showing what was loaded before.`, { id: `refresh:${path}` });
        setResult({ key, attempt, error });
      },
    );
    return () => {
      cancelled = true;
      done();
    };
  }, [api, path, key, attempt]);

  const sameKey = result?.key === key ? result : undefined;
  const settled = sameKey?.attempt === attempt;
  const cached = key !== null ? recall<T>(key) : undefined;
  const failed = settled ? sameKey?.error : undefined;
  return {
    // After a failed refresh, the cached copy stays; `error` is then only set when there is nothing to show.
    data: sameKey?.data ?? cached ?? (keepPrevious && !settled ? result?.data : undefined),
    error: failed && cached === undefined ? failed : undefined,
    loading: path !== null && !settled,
    reload: useCallback(() => setAttempt((n) => n + 1), []),
    /** Replace the loaded value with one the server just returned from a mutation. */
    setData: useCallback(
      (data: T) => {
        if (key === null) return;
        remember(key, data);
        setResult({ key, attempt, data });
      },
      [key, attempt],
    ),
  };
}
