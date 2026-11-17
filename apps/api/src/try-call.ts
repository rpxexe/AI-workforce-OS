// Development only: a real phone call against your Twilio number, end to end, without the
// dashboard. It starts the API, creates a throwaway organization with a published employee that
// can book meetings, points VOICE_NUMBER at PUBLIC_URL, prints the transcript live, and cleans up
// when the call ends.
//
//   pnpm --filter @workforce/api try-call            you call VOICE_NUMBER
//   CALL_TO=+15551234567 pnpm --filter @workforce/api try-call    the employee calls you
//   pnpm --filter @workforce/api try-call --check    only checks the settings are there
import { randomUUID } from "node:crypto";
import { prisma } from "@workforce/database";
import { defaultEmployeeConfig, type CallSummary, type EmployeeDetail, type Workspace } from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth } from "./testing.ts";

const REQUIRED = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "PUBLIC_URL", "VOICE_NUMBER"];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing (in .env or the environment): ${missing.join(", ")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log("All voice settings are present.");
  process.exit(0);
}

const number = process.env.VOICE_NUMBER ?? "";
const port = Number(process.env.API_PORT || 4000);
const org = `org_trycall_${randomUUID()}`;
const app = await buildApp({ authenticate: headerAuth });
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, headers: adminOf(org), payload });
const expect = async <T>(what: string, res: Promise<{ statusCode: number; payload: string; json: () => unknown }>) => {
  const r = await res;
  if (r.statusCode >= 300) throw new Error(`${what} failed (${r.statusCode}): ${r.payload}`);
  return r.json() as T;
};

let cleaned = false;
const cleanUp = async () => {
  if (cleaned) return;
  cleaned = true;
  await app.close();
  await deleteOrgs(org);
  await prisma.$disconnect();
};
process.on("SIGINT", () => void cleanUp().then(() => process.exit(130)));

try {
  // A number left assigned by an earlier run that crashed.
  await prisma.phoneNumber.deleteMany({ where: { number, organizationId: { startsWith: "org_trycall_" } } });
  await app.listen({ port, host: "0.0.0.0" });

  const [workspace] = await expect<Workspace[]>("Creating the organization", call("GET", "/workspaces"));
  const ws = `/workspaces/${workspace?.id}`;
  const employee = await expect<EmployeeDetail>(
    "Creating the employee",
    call("POST", `${ws}/employees`, {
      ...defaultEmployeeConfig(process.env.VOICE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone),
      name: "Ava",
      role: "Receptionist",
      language: process.env.VOICE_LANGUAGE || "en",
      systemInstructions: "Help callers with their questions. When someone asks for a meeting, book it.",
    }),
  );
  await expect("Publishing", call("POST", `${ws}/employees/${employee.id}/publish`, { version: 1 }));
  await expect("Granting the calendar", call("PUT", `${ws}/employees/${employee.id}/tools`, { tools: [{ name: "calendar_book_meeting" }] }));
  await expect("Assigning the number (this points it at PUBLIC_URL)", call("POST", `${ws}/phone-numbers`, { number, employeeId: employee.id }));

  if (process.env.CALL_TO) {
    const placed = await expect<CallSummary>("Placing the call", call("POST", `${ws}/employees/${employee.id}/calls`, { to: process.env.CALL_TO }));
    console.log(`\nCalling ${placed.to} from ${number}. Answer and talk to Ava.\n`);
  } else console.log(`\nReady. Call ${number} and talk to Ava. Try: "Book me a meeting tomorrow at 3 PM."\n`);

  // Print the call as it happens, until it ends.
  const printed = new Set<string>();
  let status = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const current = await prisma.call.findFirst({
      where: { organizationId: org },
      orderBy: { createdAt: "desc" },
      include: { transcript: { orderBy: { offsetMs: "asc" } } },
    });
    if (!current) continue;
    if (current.status !== status) console.log(`[call ${current.status.toLowerCase()}]`);
    status = current.status;
    for (const t of current.transcript)
      if (!printed.has(t.id)) {
        printed.add(t.id);
        console.log(`${(t.offsetMs / 1000).toFixed(1).padStart(6)}s ${t.speaker === "CUSTOMER" ? "Caller" : "Ava   "}: ${t.text}${t.interrupted ? "  [interrupted]" : ""}`);
      }
    if (current.endedAt && ["COMPLETED", "BUSY", "NO_ANSWER", "FAILED", "CANCELED"].includes(current.status)) {
      await new Promise((r) => setTimeout(r, 1500)); // late transcript lines and the status callback
      const done = await prisma.call.findUniqueOrThrow({ where: { id: current.id } });
      const turns = await prisma.conversationMessage.count({ where: { conversationId: done.conversationId ?? "" } });
      const tools = await prisma.toolExecution.findMany({ where: { organizationId: org } });
      const events = await prisma.calendarEvent.findMany({ where: { organizationId: org } });
      console.log(`\nCall ended: ${done.status}, ${done.durationSec ?? "?"} s${done.error ? `, error: ${done.error}` : ""}.`);
      console.log(`Conversation messages saved: ${turns}. Tool calls: ${tools.map((t) => `${t.tool} ${t.status}`).join(", ") || "none"}.`);
      for (const e of events) console.log(`Booked: "${e.title}" ${e.startsAt.toISOString()} (${e.timezone})`);
      break;
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await cleanUp();
}
