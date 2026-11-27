// Applies migration 20261126130000_message_tenant to a large live database without long locks, then lets Prisma
// record it as applied. The migration as written backfills every message in one UPDATE (21 min and a full row lock
// on 6M messages). This does the same end state in small committed batches. Safe to rerun after a failure.
//
//   DATABASE_URL=<direct, non-pooled url> node scripts/backfill-message-tenant.ts
//   pnpm --filter @workforce/database exec prisma migrate resolve --applied 20261126130000_message_tenant
//   pnpm --filter @workforce/database exec prisma migrate deploy      (the other pending migrations)
//   deploy the new code, then:
//   DATABASE_URL=<same url> node scripts/backfill-message-tenant.ts --drop-trigger
//
// DATABASE_URL is never read from .env here on purpose: the target database must be named explicitly.
import { prisma } from "../src/index.ts";

const MIGRATION = "20261126130000_message_tenant";
const INDEX = "ConversationMessage_tenant_createdAt_idx";
const BATCH = Number(process.env.BATCH ?? 5000);

const exec = (sql: string) => prisma.$executeRawUnsafe(sql);
/** DDL that needs a brief ACCESS EXCLUSIVE lock: give up after 5 s instead of queueing every query behind it. */
const briefLock = (sql: string) => prisma.$transaction([exec("SET LOCAL lock_timeout = '5s'"), exec(sql)]);

async function main() {
  if (process.argv.includes("--drop-trigger")) {
    await briefLock(`DROP TRIGGER IF EXISTS message_tenant_fill ON "ConversationMessage"`);
    await exec(`DROP FUNCTION IF EXISTS message_tenant_fill()`);
    console.log("Trigger dropped.");
    return;
  }

  const applied = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL`,
    MIGRATION,
  );
  if (applied.length) throw new Error(`${MIGRATION} is already applied here; nothing to do.`);

  console.log("1/5 nullable columns");
  await briefLock(`ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "organizationId" TEXT, ADD COLUMN IF NOT EXISTS "workspaceId" TEXT`);

  // The old code keeps inserting messages without these columns until the new code is live.
  console.log("2/5 insert trigger for messages written by the old code");
  await exec(`CREATE OR REPLACE FUNCTION message_tenant_fill() RETURNS trigger AS $$
    BEGIN
      IF NEW."organizationId" IS NULL OR NEW."workspaceId" IS NULL THEN
        SELECT c."organizationId", c."workspaceId" INTO NEW."organizationId", NEW."workspaceId"
        FROM "Conversation" c WHERE c.id = NEW."conversationId";
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await briefLock(`CREATE OR REPLACE TRIGGER message_tenant_fill BEFORE INSERT ON "ConversationMessage"
    FOR EACH ROW EXECUTE FUNCTION message_tenant_fill()`);

  console.log(`3/5 backfill in batches of ${BATCH}`);
  let last = "";
  let total = 0;
  for (;;) {
    // Keyset over the primary key, so each batch is an index range and earlier rows are never rescanned.
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `WITH batch AS (SELECT id FROM "ConversationMessage" WHERE id > $1 ORDER BY id LIMIT ${BATCH}),
       done AS (UPDATE "ConversationMessage" m SET "organizationId" = c."organizationId", "workspaceId" = c."workspaceId"
                FROM batch b, "Conversation" c
                WHERE m.id = b.id AND c.id = m."conversationId" AND (m."organizationId" IS NULL OR m."workspaceId" IS NULL))
       SELECT max(id) AS id FROM batch`,
      last,
    );
    const next = rows[0]?.id;
    if (!next) break;
    last = next;
    total += BATCH;
    if (total % (BATCH * 20) === 0) console.log(`   ~${total} rows scanned`);
  }
  const [{ missing }] = await prisma.$queryRawUnsafe<{ missing: bigint }[]>(
    `SELECT count(*) AS missing FROM "ConversationMessage" WHERE "organizationId" IS NULL OR "workspaceId" IS NULL`,
  );
  if (missing > 0n) throw new Error(`${missing} messages still have no tenant (orphans?). Inspect before continuing.`);

  // A validated CHECK lets SET NOT NULL skip its full-table scan, so the exclusive lock is momentary.
  console.log("4/5 NOT NULL");
  await briefLock(`ALTER TABLE "ConversationMessage" DROP CONSTRAINT IF EXISTS message_tenant_not_null,
    ADD CONSTRAINT message_tenant_not_null CHECK ("organizationId" IS NOT NULL AND "workspaceId" IS NOT NULL) NOT VALID`);
  await exec(`ALTER TABLE "ConversationMessage" VALIDATE CONSTRAINT message_tenant_not_null`);
  await briefLock(`ALTER TABLE "ConversationMessage" ALTER COLUMN "organizationId" SET NOT NULL, ALTER COLUMN "workspaceId" SET NOT NULL`);
  await briefLock(`ALTER TABLE "ConversationMessage" DROP CONSTRAINT message_tenant_not_null`);

  console.log("5/5 index (concurrently)");
  // A failed concurrent build leaves an invalid index behind; drop it and build again.
  const invalid = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
    INDEX,
  );
  if (invalid.length) await exec(`DROP INDEX CONCURRENTLY "${INDEX}"`);
  await exec(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"
    ON "ConversationMessage"("organizationId", "workspaceId", "createdAt", "conversationId")`);

  console.log(`Done. Next: prisma migrate resolve --applied ${MIGRATION}, then prisma migrate deploy.`);
}

main().finally(() => prisma.$disconnect()).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
