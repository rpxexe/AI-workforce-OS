"use client";

import { ADMIN_ROLE, type Workspace } from "@workforce/shared";
import { useAuth } from "@clerk/nextjs";
import { createContext, useContext, useState, type ReactNode } from "react";
import { LoadingState } from "@/components/states";
import { useApiQuery, type ApiRequestError } from "@/lib/api";

type WorkspaceState = {
  workspaces: Workspace[] | undefined;
  /** The workspace the dashboard is showing. Undefined until the list has loaded. */
  workspace: Workspace | undefined;
  select: (id: string) => void;
  reload: () => void;
  loading: boolean;
  error: ApiRequestError | undefined;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const storageKey = (orgId: string) => `workspace:${orgId}`;

// localStorage can throw (private mode, blocked storage); the choice is a convenience, so ignore failures.
const remembered = (orgId: string) => {
  try {
    return localStorage.getItem(storageKey(orgId));
  } catch {
    return null;
  }
};

/**
 * Loads the active organization's workspaces; `orgId` is null until one is selected.
 * Mount it with `key={orgId}` so switching organization resets it.
 */
export function WorkspaceProvider({ orgId, children }: { orgId: string | null; children: ReactNode }) {
  const { data, error, loading, reload } = useApiQuery<Workspace[]>(orgId ? "/workspaces" : null);
  const [selected, setSelected] = useState(() => orgId && remembered(orgId));

  const select = (id: string) => {
    setSelected(id);
    if (!orgId) return;
    try {
      localStorage.setItem(storageKey(orgId), id);
    } catch {
      // see `remembered`
    }
  };

  const workspace = data?.find((w) => w.id === selected) ?? data?.[0];
  return (
    <WorkspaceContext value={{ workspaces: data, workspace, select, reload, loading, error }}>
      {children}
    </WorkspaceContext>
  );
}

export function useWorkspaces() {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error("useWorkspaces must be used inside WorkspaceProvider");
  return state;
}

/**
 * Wraps a page that needs a workspace: it shows a loading state until one is available, and
 * remounts the page when the workspace changes so nothing from the previous one lingers.
 */
export function withWorkspace(Page: (props: { workspace: Workspace }) => ReactNode) {
  return function WorkspacePage() {
    const { workspace } = useWorkspaces();
    return workspace ? <Page key={workspace.id} workspace={workspace} /> : <LoadingState />;
  };
}

/** Members read; admins also change things. The API enforces this; the UI only hides what would fail. */
export const useIsAdmin = () => useAuth().orgRole === ADMIN_ROLE;
