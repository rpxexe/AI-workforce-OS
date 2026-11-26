import { prisma, type Prisma } from "@workforce/database";
import { factWrites, PROFILE_KEYS, validFact } from "@workforce/memory";
import {
  listCustomersQuery,
  updateMemorySchema,
  type CustomerDetail,
  type CustomerExport,
  type CustomerFilter,
  type CustomerMemoryItem,
  type CustomerPage,
  type CustomerSummary,
  type MemoryCategory,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate, type Member } from "./auth.ts";
import { within } from "./employees.ts";

const customerParams = z.object({ workspaceId: z.string().min(1), customerId: z.string().min(1) });
const memoryParams = customerParams.extend({ memoryId: z.string().min(1) });

const toSummary = (c: Prisma.CustomerGetPayload<{ include: { profile: true } }>): CustomerSummary => ({
  id: c.id,
  externalId: c.externalId,
  name: c.profile?.name ?? null,
  email: c.profile?.email ?? null,
  phone: c.profile?.phone ?? null,
  company: c.profile?.company ?? null,
  lastSeenAt: c.lastSeenAt.toISOString(),
});

type MemoryRow = Prisma.CustomerMemoryGetPayload<object>;
const toMemory = (m: MemoryRow): CustomerMemoryItem => ({
  id: m.id,
  category: m.category as MemoryCategory,
  key: m.key,
  value: m.value,
  confidence: m.confidence,
  conversationId: m.conversationId,
  updatedAt: m.updatedAt.toISOString(),
});

const isProfileKey = (m: { category: string; key: string }): m is { category: string; key: (typeof PROFILE_KEYS)[number] } =>
  m.category === "identity" && (PROFILE_KEYS as readonly string[]).includes(m.key);

/** Audit row for a change to a customer's memory. Details name keys, never values, so a delete leaves nothing behind. */
const audit = (scope: Member & { workspaceId: string }, customerId: string, action: string, detail: Prisma.InputJsonObject = {}) =>
  prisma.customerAuditLog.create({
    data: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, customerId, action, actorId: scope.userId, detail },
  });

/**
 * Customers are created by conversations and their memory by the agent runtime. Members read;
 * admins correct, delete, clear and export memory, and every one of those is audited.
 */
export function customerRoutes(app: FastifyInstance, authenticate: Authenticate) {
  const { member, admin, inWorkspace } = guards(authenticate);

  /** The customer in the caller's workspace, or a 404 (another organization's customer included). */
  const findCustomer = async (scope: Member & { workspaceId: string }, customerId: string) => {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...within(scope) }, select: { id: true } });
    if (!customer) throw httpError(404, "Customer not found");
    return customer.id;
  };
  const findMemory = async (scope: Member & { workspaceId: string }, customerId: string, memoryId: string) => {
    const memory = await prisma.customerMemory.findFirst({ where: { id: memoryId, customer: { id: customerId, ...within(scope) } } });
    if (!memory) throw httpError(404, "Memory not found");
    return memory;
  };

  app.get("/workspaces/:workspaceId/customers", async (req): Promise<CustomerPage> => {
    const { workspaceId } = customerParams.pick({ workspaceId: true }).parse(req.params);
    const { q, filter, limit, cursor } = listCustomersQuery.parse(req.query);
    const scope = await inWorkspace(member(req), workspaceId);
    const like = { contains: q, mode: "insensitive" as const };
    const where: Prisma.CustomerWhereInput = {
      ...within(scope),
      ...(q && {
        OR: [{ externalId: like }, { profile: { OR: [{ name: like }, { email: like }, { phone: like }, { company: like }] } }],
      }),
    };
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const has = (field: "email" | "phone" | "company"): Prisma.CustomerWhereInput => ({ profile: { [field]: { not: null } } });
    const filters: Record<CustomerFilter, Prisma.CustomerWhereInput> = {
      all: {},
      week: { lastSeenAt: { gte: weekAgo } },
      email: has("email"),
      phone: has("phone"),
    };
    const count = (extra: Prisma.CustomerWhereInput) => prisma.customer.count({ where: { AND: [where, extra] } });
    const [rows, total, seenThisWeek, withEmail, withPhone, reachable, withCompany] = await Promise.all([
      prisma.customer.findMany({
        where: { AND: [where, filters[filter]] },
        include: { profile: true },
        orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      }),
      count({}),
      count(filters.week),
      count(filters.email),
      count(filters.phone),
      count({ OR: [has("email"), has("phone")] }),
      count(has("company")),
    ]);
    return {
      data: rows.slice(0, limit).map(toSummary),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      counts: { total, seenThisWeek, withEmail, withPhone, reachable, withCompany },
    };
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
      memories: customer.memories.map(toMemory),
      conversations: customer.conversations.map((c) => ({
        id: c.conversationId,
        employeeId: c.conversation.employeeId,
        channel: c.conversation.channel,
        status: c.conversation.status,
        title: c.conversation.title,
        summary: c.summary,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });

  // A person's correction: same validation as extraction, profile kept in step, confidence 1.
  app.patch("/workspaces/:workspaceId/customers/:customerId/memories/:memoryId", async (req): Promise<CustomerMemoryItem> => {
    const { workspaceId, customerId, memoryId } = memoryParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const memory = await findMemory(scope, customerId, memoryId);
    const { value } = updateMemorySchema.parse(req.body);
    const fact = validFact({ category: memory.category, key: memory.key, value, confidence: 1 });
    if (!fact) throw httpError(400, "That value cannot be stored in memory (card numbers and secrets are refused)");
    await prisma.$transaction([
      ...factWrites(memory.customerId, [fact], memory.conversationId),
      audit(scope, memory.customerId, "memory_edit", { memoryId, key: memory.key }),
    ]);
    return toMemory(await prisma.customerMemory.findUniqueOrThrow({ where: { id: memoryId } }));
  });

  app.delete("/workspaces/:workspaceId/customers/:customerId/memories/:memoryId", async (req, reply) => {
    const { workspaceId, customerId, memoryId } = memoryParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const memory = await findMemory(scope, customerId, memoryId);
    await prisma.$transaction([
      prisma.customerMemory.delete({ where: { id: memory.id } }),
      ...(isProfileKey(memory) ? [prisma.customerProfile.updateMany({ where: { customerId: memory.customerId }, data: { [memory.key]: null } })] : []),
      audit(scope, memory.customerId, "memory_delete", { memoryId, key: memory.key }),
    ]);
    return reply.code(204).send();
  });

  // Forgets everything recalled into prompts: facts, the profile built from them, and conversation summaries.
  // Conversations and their messages stay.
  app.delete("/workspaces/:workspaceId/customers/:customerId/memories", async (req, reply) => {
    const { workspaceId, customerId } = customerParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const id = await findCustomer(scope, customerId);
    const [memories, , summaries] = await prisma.$transaction([
      prisma.customerMemory.deleteMany({ where: { customerId: id } }),
      prisma.customerProfile.updateMany({ where: { customerId: id }, data: { name: null, email: null, phone: null, company: null } }),
      prisma.customerConversation.updateMany({ where: { customerId: id, summary: { not: "" } }, data: { summary: "" } }),
    ]);
    await audit(scope, id, "memory_clear", { memories: memories.count, summaries: summaries.count });
    return reply.code(204).send();
  });

  app.get("/workspaces/:workspaceId/customers/:customerId/export", async (req, reply): Promise<CustomerExport> => {
    const { workspaceId, customerId } = customerParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, ...within(scope) },
      include: {
        profile: true,
        memories: { orderBy: { updatedAt: "desc" } },
        conversations: { orderBy: { updatedAt: "desc" }, include: { conversation: true } },
      },
    });
    if (!customer) throw httpError(404, "Customer not found");
    await audit(scope, customer.id, "export");
    void reply.header("content-disposition", `attachment; filename="customer-${customer.id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      customer: { ...toSummary(customer), createdAt: customer.createdAt.toISOString() },
      memories: customer.memories.map((m) => ({ ...toMemory(m), createdAt: m.createdAt.toISOString() })),
      conversations: customer.conversations.map((c) => ({
        id: c.conversationId,
        employeeId: c.conversation.employeeId,
        channel: c.conversation.channel,
        title: c.conversation.title,
        summary: c.summary,
        createdAt: c.conversation.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });
}
