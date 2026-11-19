// Background jobs: work that must not hold up a request or a webhook.
//
//   knowledge/document.uploaded   parse, chunk and embed an uploaded document
//   memory/exchange.saved         learn customer memory from a saved exchange
//   channel/message.received      answer a WhatsApp or email message (one at a time per customer)
//   workflow/run.due              advance a workflow run; sleeps until its next step is due
//   workflow-sweep (cron, 1 min)  hands due workflow runs to workflow/run.due (lost events, crashed runners)
//
// One set of handlers, two backends. Inngest (durable: retries, sleeps and per-customer ordering that
// survive restarts and span API processes) when INNGEST_EVENT_KEY or INNGEST_DEV is set; otherwise
// in this process, as before Inngest existed (tests, and development without the Inngest dev server).
// Events carry ids only: customer text never leaves our database.
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Inngest } from "inngest";
import { serve } from "inngest/fastify";

export type JobEvents = {
  "knowledge/document.uploaded": { documentId: string };
  "memory/exchange.saved": { organizationId: string; workspaceId: string; customerId: string; conversationId: string; replyId: string };
  "channel/message.received": { messageId: string; queueKey: string };
  "workflow/run.due": { executionId: string };
};
export type JobName = keyof JobEvents;

/** What a handler may do between steps. Inngest memoizes `run` results (JSON) and sleeps without holding a process. */
export type Steps = {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(id: string, at: Date | string): Promise<void>;
};

export type JobDefinition<K extends JobName> = {
  handler: (data: JobEvents[K], step: Steps) => Promise<unknown>;
  /** A field of the data: jobs with the same value run one at a time, in order. */
  orderedBy?: keyof JobEvents[K] & string;
  /** Retries after a failure (Inngest only). Jobs that spend money or message customers keep this low. */
  retries?: 0 | 1 | 2 | 3;
};
export type JobDefinitions = { [K in JobName]: JobDefinition<K> };
export type Schedule = { id: string; cron: string; handler: (step: Steps) => Promise<unknown> };

export interface Jobs {
  readonly backend: "inngest" | "inline";
  /** Queues a job. With Inngest this records the event; in process the job starts now and is not awaited. */
  send<K extends JobName>(name: K, data: JobEvents[K]): Promise<void>;
}

/** Runs jobs in this process, not awaited, in order per `orderedBy` key. Schedules are not run (the workflow runner polls instead). */
export function inlineJobs(definitions: JobDefinitions, log: FastifyBaseLogger): Jobs {
  const steps: Steps = {
    run: (_id, fn) => fn(),
    sleepUntil: (_id, at) => sleep(Math.max(0, new Date(at).getTime() - Date.now())),
  };
  const queues = new Map<string, Promise<void>>();
  return {
    backend: "inline",
    async send(name, data) {
      const definition = definitions[name] as JobDefinition<typeof name>;
      const work = () => definition.handler(data, steps).then(
        () => {},
        (err: unknown) => log.error({ err, job: name }, "Background job failed"),
      );
      const key = definition.orderedBy && `${name}:${String(data[definition.orderedBy])}`;
      if (!key) return void work();
      const next = (queues.get(key) ?? Promise.resolve()).then(work);
      queues.set(key, next);
      void next.finally(() => queues.get(key) === next && queues.delete(key));
    },
  };
}

/** Jobs through Inngest. Registers `/api/inngest`, where Inngest calls the functions (signed with INNGEST_SIGNING_KEY). */
export function inngestJobs(app: FastifyInstance, definitions: JobDefinitions, schedules: Schedule[]): Jobs {
  const client = new Inngest({ id: "ai-workforce-os" });
  const functions = [
    ...(Object.entries(definitions) as [JobName, JobDefinition<JobName>][]).map(([name, definition]) =>
      client.createFunction(
        {
          id: name.replace("/", "-"),
          triggers: [{ event: name }],
          retries: definition.retries ?? 3,
          ...(definition.orderedBy ? { concurrency: { limit: 1, key: `event.data.${definition.orderedBy}` } } : {}),
        },
        // Inngest's step tools are a superset of ours.
        async ({ event, step }) => definition.handler(event.data as never, step as unknown as Steps),
      ),
    ),
    ...schedules.map((schedule) =>
      client.createFunction({ id: schedule.id, triggers: [{ cron: schedule.cron }], retries: 0 }, async ({ step }) =>
        schedule.handler(step as unknown as Steps),
      ),
    ),
  ];
  app.route({ method: ["GET", "POST", "PUT"], url: "/api/inngest", handler: serve({ client, functions }) });
  return {
    backend: "inngest",
    async send(name, data) {
      await client.send({ name, data });
    },
  };
}
