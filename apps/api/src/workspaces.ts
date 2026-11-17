import { Prisma, prisma } from "@workforce/database";
import { workspaceSchema, type Workspace } from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { guards, httpError, type Authenticate } from "./auth.ts";

const toWorkspace = (w: { id: string; name: string; createdAt: Date }): Workspace => ({
  id: w.id,
  name: w.name,
  createdAt: w.createdAt.toISOString(),
});

export function workspaceRoutes(app: FastifyInstance, authenticate: Authenticate) {
  const { member, admin } = guards(authenticate);

  // Also where an organization first appears in our database: Clerk creates organizations,
  // and the first signed-in request from one provisions its row and a default workspace.
  app.get("/workspaces", async (req): Promise<Workspace[]> => {
    const auth = member(req);
    const list = () =>
      prisma.workspace.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: "asc" } });

    let workspaces = await list();
    if (workspaces.length === 0) {
      // ON CONFLICT DO NOTHING, so first requests arriving together neither fail nor create two
      // defaults. Prisma's upsert is a read then an insert, and loses that race with P2002.
      await prisma.organization.createMany({
        data: [{ id: auth.organizationId, name: auth.organizationName }],
        skipDuplicates: true,
      });
      await prisma.workspace.createMany({
        data: [{ organizationId: auth.organizationId, name: "Default" }],
        skipDuplicates: true,
      });
      workspaces = await list();
    }
    return workspaces.map(toWorkspace);
  });

  app.post("/workspaces", async (req, reply) => {
    const auth = admin(req);
    const { name } = workspaceSchema.parse(req.body);
    try {
      const workspace = await prisma.workspace.create({ data: { organizationId: auth.organizationId, name } });
      return reply.code(201).send(toWorkspace(workspace));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw httpError(409, "A workspace with this name already exists");
      // The organization row is created by GET /workspaces, which the dashboard always calls first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003")
        throw httpError(409, "Organization is not set up yet. Reload and try again.");
      throw err;
    }
  });
}
