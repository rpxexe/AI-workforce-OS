"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";

export type Member = { id: string; name: string };

/** The organization's members (Clerk), for assigning conversations and naming agents. */
export function useMembers() {
  const { userId } = useAuth();
  // shortcut: the first 100 members; page through Clerk when organizations get bigger
  const { memberships } = useOrganization({ memberships: { pageSize: 100 } });
  const list: Member[] = (memberships?.data ?? []).flatMap((m) => {
    const u = m.publicUserData;
    if (!u?.userId) return [];
    return [{ id: u.userId, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.identifier }];
  });
  const nameOf = (id: string | null) =>
    id === null ? "Unassigned" : id === userId ? "You" : (list.find((m) => m.id === id)?.name ?? "A teammate");
  return { me: userId ?? null, list, nameOf };
}
