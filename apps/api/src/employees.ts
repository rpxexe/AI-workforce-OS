import { configOf } from "@workforce/agent-runtime";
import { Prisma, prisma } from "@workforce/database";
import {
  employeeConfigSchema,
  publishSchema,
  setStatusSchema,
  type EmployeeConfig,
  type EmployeeDetail,
  type EmployeeSummary,
  type EmployeeVersion,
  type UsageLimiter,
} from "@workforce/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate, type Member } from "./auth.ts";
import { assertPublishable, release } from "./releases.ts";

type VersionRow = Prisma.AiEmployeeVersionGetPayload<object>;

export { configOf };

const toVersion = (v: VersionRow): EmployeeVersion => ({
  ...configOf(v),
  number: v.number,
  createdBy: v.createdBy,
  createdAt: v.createdAt.toISOString(),
});

const detailInclude = {
  versions: { orderBy: { number: "desc" } },
  publishedVersion: { select: { number: true } },
} satisfies Prisma.AiEmployeeInclude;

const toDetail = (e: Prisma.AiEmployeeGetPayload<{ include: typeof detailInclude }>): EmployeeDetail => ({
  id: e.id,
  status: e.status,
  publishedVersion: e.publishedVersion?.number ?? null,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
  versions: e.versions.map(toVersion),
});

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
export const employeeParams = workspaceParams.extend({ id: z.string().min(1) });

export type Scope = Member & { workspaceId: string };
/** The tenant filter every employee query carries. */
export const within = (s: { organizationId: string; workspaceId: string }) => ({ organizationId: s.organizationId, workspaceId: s.workspaceId });

/** A workspace's employees, most recently changed first: the archived ones, or the rest (the default). */
export async function listEmployees(scope: { organizationId: string; workspaceId: string }, archived = false): Promise<EmployeeSummary[]> {
  const employees = await prisma.aiEmployee.findMany({
    where: { ...within(scope), status: archived ? "ARCHIVED" : { not: "ARCHIVED" } },
    orderBy: { updatedAt: "desc" },
    // shortcut: no pagination, add a cursor when a workspace nears 200 employees
    take: 200,
    include: { versions: { orderBy: { number: "desc" }, take: 1 }, publishedVersion: { select: { number: true } } },
  });
  return employees.flatMap((e) => {
    const latest = e.versions[0];
    if (!latest) return [];
    const { name, role, description, avatar, language } = configOf(latest);
    return {
      id: e.id,
      status: e.status,
      name,
      role,
      description,
      avatar,
      language,
      latestVersion: latest.number,
      publishedVersion: e.publishedVersion?.number ?? null,
      updatedAt: e.updatedAt.toISOString(),
    };
  });
}

/**
 * AI Employee CRUD. Every query is scoped to the organization in the session and to a workspace
 * of that organization; an employee anywhere else answers 404, the same as one that does not exist.
 */
export function employeeRoutes(app: FastifyInstance, authenticate: Authenticate, planLimits?: UsageLimiter) {
  const { member, admin, inWorkspace } = guards(authenticate);
  /** 402 when the organization's plan allows no more AI employees (archived ones do not count). */
  const roomForOneMore = async (organizationId: string) => {
    const refused = await planLimits?.(organizationId, ["employees"]);
    if (refused) throw httpError(402, refused);
  };
  const base = "/workspaces/:workspaceId/employees";

  /** Resolves the caller, the workspace and (for item routes) the employee id in one step. */
  const scoped = async (req: FastifyRequest, guard: typeof member) => {
    const params = employeeParams.partial({ id: true }).parse(req.params);
    return { scope: await inWorkspace(guard(req), params.workspaceId), id: params.id ?? "" };
  };

  const loadDetail = async (scope: Scope, id: string) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id, ...within(scope) }, include: detailInclude });
    if (!employee) throw httpError(404, "Employee not found");
    return toDetail(employee);
  };

  const latestVersion = async (scope: Scope, id: string) => {
    const latest = await prisma.aiEmployeeVersion.findFirst({
      where: { employee: { id, ...within(scope) } },
      orderBy: { number: "desc" },
    });
    if (!latest) throw httpError(404, "Employee not found");
    return latest;
  };

  const create = async (scope: Scope, config: EmployeeConfig) => {
    await roomForOneMore(scope.organizationId);
    const employee = await prisma.aiEmployee.create({
      data: {
        ...within(scope),
        createdBy: scope.userId,
        versions: { create: { ...config, number: 1, createdBy: scope.userId } },
      },
      include: detailInclude,
    });
    return toDetail(employee);
  };

  app.get(base, async (req): Promise<EmployeeSummary[]> => {
    const { scope } = await scoped(req, member);
    const { archived } = z.object({ archived: z.enum(["true", "false"]).default("false") }).parse(req.query);
    return listEmployees(scope, archived === "true");
  });

  app.post(base, async (req, reply) => {
    const { scope } = await scoped(req, admin);
    return reply.code(201).send(await create(scope, employeeConfigSchema.parse(req.body)));
  });

  app.get(`${base}/:id`, async (req) => {
    const { scope, id } = await scoped(req, member);
    return loadDetail(scope, id);
  });

  /** Appends a version; nothing goes live until it is published. */
  const saveVersion = async (scope: Scope, id: string, config: EmployeeConfig) => {
    const latest = await latestVersion(scope, id);
    try {
      await prisma.aiEmployee.update({
        where: { id },
        data: {
          updatedAt: new Date(),
          versions: { create: { ...config, number: latest.number + 1, createdBy: scope.userId } },
        },
      });
    } catch (err) {
      // Two saves raced for the same version number; the unique index let one through.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw httpError(409, "Someone else saved this employee at the same time. Reload and try again.");
      throw err;
    }
  };

  /** Moves the live pointer to a version (and logs the release); 409 during a rollout or for an unapproved suggestion's version. */
  const publish = async (scope: Scope, id: string, version: number) => {
    const target = await prisma.aiEmployeeVersion.findFirst({
      where: { number: version, employee: { id, ...within(scope) } },
      select: { id: true, number: true, employee: { select: { id: true, status: true, publishedVersion: { select: { id: true, number: true } } } } },
    });
    if (!target) throw httpError(404, "Version not found");
    if (target.employee.publishedVersion?.id === target.id) return;
    await assertPublishable(id, target.id);
    await prisma.$transaction((tx) => release(tx, { scope, employee: target.employee, version: target, action: "publish", by: scope.userId }));
  };

  // Saving never changes an existing version: it appends one. Production keeps serving the
  // published version until someone publishes the new one.
  app.put(`${base}/:id`, async (req) => {
    const { scope, id } = await scoped(req, admin);
    await saveVersion(scope, id, employeeConfigSchema.parse(req.body));
    return loadDetail(scope, id);
  });

  app.post(`${base}/:id/publish`, async (req) => {
    const { scope, id } = await scoped(req, admin);
    await publish(scope, id, publishSchema.parse(req.body).version);
    return loadDetail(scope, id);
  });

  // Pause, resume, archive and restore.
  app.patch(`${base}/:id/status`, async (req) => {
    const { scope, id } = await scoped(req, admin);
    const { status } = setStatusSchema.parse(req.body);
    const employee = await prisma.aiEmployee.findFirst({
      where: { id, ...within(scope) },
      select: { publishedVersionId: true, status: true },
    });
    if (!employee) throw httpError(404, "Employee not found");
    if (employee.status === "ARCHIVED" && status !== "ARCHIVED") await roomForOneMore(scope.organizationId);
    const published = employee.publishedVersionId !== null;
    if (status === "ACTIVE" && !published) throw httpError(409, "Publish a version before activating this employee");
    // An employee with nothing published has no live state to pause: restoring it returns it to draft.
    const next = status === "PAUSED" && !published ? "DRAFT" : status;
    await prisma.aiEmployee.update({ where: { id }, data: { status: next } });
    return loadDetail(scope, id);
  });

  app.post(`${base}/:id/duplicate`, async (req, reply) => {
    const { scope, id } = await scoped(req, admin);
    const config = configOf(await latestVersion(scope, id));
    const copy = await create(scope, { ...config, name: `${config.name.slice(0, 73)} (copy)` });
    return reply.code(201).send(copy);
  });

  return { create, saveVersion, publish, latestVersion };
}
export type EmployeeActions = ReturnType<typeof employeeRoutes>;
