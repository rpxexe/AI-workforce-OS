import { prisma, type Prisma } from "@workforce/database";
import {
  setEmployeeToolsSchema,
  TOOL_NAMES,
  type EmployeeTool,
  type ToolExecutionRecord,
  type ToolInfo,
  type ToolName,
} from "@workforce/shared";
import { toolRegistry } from "@workforce/tools";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { employeeParams, within, type Scope } from "./employees.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const executionQuery = z.object({
  employeeId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

/** The tool catalog, what each employee may use, and the audit log of what they did. */
export function toolRoutes(app: FastifyInstance, authenticate: Authenticate) {
  const { member, admin, inWorkspace } = guards(authenticate);

  app.get("/workspaces/:workspaceId/tools", async (req): Promise<ToolInfo[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    await inWorkspace(member(req), workspaceId);
    return toolRegistry.list().map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      permissions: [...t.permissions],
      timeoutMs: t.timeoutMs,
      retry: t.retry,
    }));
  });

  const employeeTools = async (employeeId: string): Promise<EmployeeTool[]> => {
    const grants = await prisma.toolPermission.findMany({ where: { employeeId } });
    return grants
      .filter((g) => (TOOL_NAMES as readonly string[]).includes(g.tool))
      .toSorted((a, b) => TOOL_NAMES.indexOf(a.tool as ToolName) - TOOL_NAMES.indexOf(b.tool as ToolName))
      .map((g) => ({
        name: g.tool as ToolName,
        config: g.config as Record<string, unknown>,
        permissions: g.permissions,
        grantedAt: g.createdAt.toISOString(),
      }));
  };

  const findEmployee = async (id: string, scope: Scope) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id, ...within(scope) }, select: { id: true } });
    if (!employee) throw httpError(404, "Employee not found");
  };

  app.get("/workspaces/:workspaceId/employees/:id/tools", async (req): Promise<EmployeeTool[]> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    await findEmployee(id, await inWorkspace(member(req), workspaceId));
    return employeeTools(id);
  });

  // Replaces the employee's grants. Each tool's settings are validated by that tool's schema.
  app.put("/workspaces/:workspaceId/employees/:id/tools", async (req): Promise<EmployeeTool[]> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    await findEmployee(id, scope);
    const { tools } = setEmployeeToolsSchema.parse(req.body);
    if (new Set(tools.map((t) => t.name)).size !== tools.length) throw httpError(400, "Each tool can be granted once");

    const grants = tools.map(({ name, config }, i) => {
      const tool = toolRegistry.get(name);
      if (!tool) throw httpError(400, `Unknown tool ${name}`);
      const parsed = tool.config.safeParse(config);
      if (!parsed.success)
        // Reported like any validation failure, with paths the form can match to its fields.
        throw new z.ZodError(parsed.error.issues.map((issue) => ({ ...issue, path: ["tools", i, "config", ...issue.path] })));
      return {
        employeeId: id,
        tool: name,
        config: parsed.data as Prisma.InputJsonValue,
        permissions: [...tool.permissions],
        grantedBy: scope.userId,
      };
    });
    await prisma.$transaction([
      prisma.toolPermission.deleteMany({ where: { employeeId: id } }),
      prisma.toolPermission.createMany({ data: grants }),
    ]);
    return employeeTools(id);
  });

  app.get("/workspaces/:workspaceId/tool-executions", async (req): Promise<ToolExecutionRecord[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const { employeeId, conversationId } = executionQuery.parse(req.query);
    const scope = await inWorkspace(member(req), workspaceId);
    const rows = await prisma.toolExecution.findMany({
      where: { ...within(scope), employeeId, conversationId },
      orderBy: { createdAt: "desc" },
      // shortcut: newest 100 only, add a cursor when an audit page is built
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      status: r.status,
      employeeId: r.employeeId,
      conversationId: r.conversationId,
      input: r.input,
      output: r.output,
      error: r.error,
      attempts: r.attempts,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
