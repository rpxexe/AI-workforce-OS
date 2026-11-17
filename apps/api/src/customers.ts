import { prisma, type Prisma } from "@workforce/database";
import type { CustomerDetail, CustomerSummary, MemoryCategory } from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { within } from "./employees.ts";

const customerParams = z.object({ workspaceId: z.string().min(1), customerId: z.string().min(1) });

const toSummary = (c: Prisma.CustomerGetPayload<{ include: { profile: true } }>): CustomerSummary => ({
  id: c.id,
  externalId: c.externalId,
  name: c.profile?.name ?? null,
  email: c.profile?.email ?? null,
  phone: c.profile?.phone ?? null,
  company: c.profile?.company ?? null,
  lastSeenAt: c.lastSeenAt.toISOString(),
});

/** Read-only: customers are created by conversations and their memory by the agent runtime. */
export function customerRoutes(app: FastifyInstance, authenticate: Authenticate) {
  const { member, inWorkspace } = guards(authenticate);

  app.get("/workspaces/:workspaceId/customers", async (req): Promise<CustomerSummary[]> => {
    const { workspaceId } = customerParams.pick({ workspaceId: true }).parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const customers = await prisma.customer.findMany({
      where: within(scope),
      include: { profile: true },
      orderBy: { lastSeenAt: "desc" },
      // shortcut: newest 200 only, add a cursor and search when the customer list is built
      take: 200,
    });
    return customers.map(toSummary);
  });

  app.get("/workspaces/:workspaceId/customers/:customerId", async (req): Promise<CustomerDetail> => {
    const { workspaceId, customerId } = customerParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, ...within(scope) },
      include: {
        profile: true,
        memories: { orderBy: { updatedAt: "desc" } },
        conversations: { orderBy: { updatedAt: "desc" }, take: 50, include: { conversation: true } },
      },
    });
    if (!customer) throw httpError(404, "Customer not found");
    return {
      ...toSummary(customer),
      memories: customer.memories.map((m) => ({
        category: m.category as MemoryCategory,
        key: m.key,
        value: m.value,
        updatedAt: m.updatedAt.toISOString(),
      })),
      conversations: customer.conversations.map((c) => ({
        id: c.conversationId,
        employeeId: c.conversation.employeeId,
        title: c.conversation.title,
        summary: c.summary,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });
}
