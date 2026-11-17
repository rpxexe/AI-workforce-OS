import { getAuth } from "@clerk/fastify";
import { prisma } from "@workforce/database";
import { ADMIN_ROLE } from "@workforce/shared";
import type { FastifyRequest } from "fastify";

/** Who is calling, as established by the identity provider. Tests substitute their own. */
export type Authenticate = (req: FastifyRequest) => {
  userId?: string | null;
  orgId?: string | null;
  orgRole?: string | null;
  orgSlug?: string | null;
};

export const clerkAuthenticate: Authenticate = (req) => getAuth(req);

/** An error meant for the client: its message is shown whatever the status, 5xx included. */
export const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, expose: true });

export type Member = { userId: string; organizationId: string; organizationName: string; role: string | null };

/**
 * Authorization for tenant data. The organization always comes from the verified session,
 * never from the request, so a caller cannot name an organization they are not signed in to.
 */
export function guards(authenticate: Authenticate) {
  const member = (req: FastifyRequest): Member => {
    const { userId, orgId, orgSlug, orgRole } = authenticate(req);
    if (!userId) throw httpError(401, "Sign in required");
    if (!orgId) throw httpError(403, "Select an organization first");
    return { userId, organizationId: orgId, organizationName: orgSlug ?? orgId, role: orgRole ?? null };
  };

  const admin = (req: FastifyRequest): Member => {
    const auth = member(req);
    if (auth.role !== ADMIN_ROLE) throw httpError(403, "Only organization admins can make changes");
    return auth;
  };

  /** Confirms the workspace belongs to the caller's organization. Another organization's workspace is a 404. */
  const inWorkspace = async (auth: Member, workspaceId: string) => {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: auth.organizationId },
      select: { id: true },
    });
    if (!workspace) throw httpError(404, "Workspace not found");
    return { ...auth, workspaceId: workspace.id };
  };

  return { member, admin, inWorkspace };
}
