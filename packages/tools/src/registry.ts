import type { ToolSpec } from "@workforce/ai-provider";
import { z } from "zod";
import type { AnyTool } from "./types.ts";

/** The tools that exist. The model can only ever call a tool by a name registered here. */
export type ToolRegistry = {
  get(name: string): AnyTool | undefined;
  list(): AnyTool[];
  /** How the named tools are described to the model, in registry order (stable, so prompts cache). */
  specs(names: Iterable<string>): ToolSpec[];
};

export function createToolRegistry(tools: AnyTool[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.name as string, t]));
  return {
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    specs(names) {
      const wanted = new Set(names);
      return tools
        .filter((t) => wanted.has(t.name))
        .map((t) => {
          // "input" describes what the model sends: fields with defaults are optional.
          const inputSchema: Record<string, unknown> = z.toJSONSchema(t.input, { io: "input" });
          delete inputSchema.$schema;
          return { name: t.name, description: t.description, inputSchema };
        });
    },
  };
}
