// Types and validation shared by the API, the dashboard and the workers.

/** Body of `GET /health` on the API. */
export type HealthResponse = {
  status: "ok" | "degraded";
  /** Whether the API could reach PostgreSQL. */
  db: boolean;
};

/** Body of every non-2xx API response. */
export type ApiError = { error: string; issues?: { path: string; message: string }[] };

export * from "./employee.ts";
export * from "./workspace.ts";
export * from "./conversation.ts";
export * from "./knowledge.ts";
export * from "./customer.ts";
export * from "./tool.ts";
export * from "./voice.ts";
export * from "./workflow.ts";
