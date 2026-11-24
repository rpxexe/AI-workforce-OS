// Phase 17: API keys. A key is "wfk_<prefix>_<secret>": the prefix (12 hex characters) is stored and finds the row,
// the whole key is stored only as a SHA-256 hash. The secret has 256 random bits, so a plain hash cannot be guessed
// back and needs no salt or slow hash; it is shown once and never again.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { prisma, type Prisma } from "@workforce/database";
import type { ApiKeyInfo, ApiKeyStatus, ApiScope } from "@workforce/shared";
import type { FastifyBaseLogger } from "fastify";
import { httpError } from "../auth.ts";

const KEY = /^wfk_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
/** lastUsedAt is written at most this often per key, so busy keys do not write on every request. */
const LAST_USED_EVERY_MS = 60_000;

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key: what is stored (prefix, hash) and the secret the caller sees once. */
export function newKey() {
  const prefix = randomBytes(6).toString("hex");
  const secret = `wfk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { prefix, hash: hashKey(secret), secret };
}

export const statusOf = (k: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): ApiKeyStatus =>
  k.revokedAt ? "revoked" : k.expiresAt && k.expiresAt <= now ? "expired" : k.expiresAt ? "expiring" : "active";

export const keyInclude = { workspace: { select: { name: true } } } satisfies Prisma.ApiKeyInclude;

export const toApiKeyInfo = (k: Prisma.ApiKeyGetPayload<{ include: typeof keyInclude }>): ApiKeyInfo => ({
  id: k.id,
  name: k.name,
  workspaceId: k.workspaceId,
  workspaceName: k.workspace.name,
  prefix: `wfk_${k.prefix}_`,
  scopes: k.scopes as ApiScope[],
  status: statusOf(k),
  createdBy: k.createdBy,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  lastUsedIp: k.lastUsedIp,
  expiresAt: k.expiresAt?.toISOString() ?? null,
  rateLimitPerMinute: k.rateLimitPerMinute,
  allowedIps: k.allowedIps,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  replacedById: k.replacedById,
});

export type KeyScope = { id: string; organizationId: string; workspaceId: string; scopes: string[]; rate: { limit: number; remaining: number; resetSec: number } };

/** Whether `ip` is one of the key's addresses or ranges. IPv4 callers seen as ::ffff:a.b.c.d match IPv4 rules. */
export function ipAllowed(ip: string, allowed: string[]) {
  if (allowed.length === 0) return true;
  const list = new BlockList();
  for (const entry of allowed) {
    const [address = "", prefix] = entry.split("/");
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return isIP(ip) !== 0 && list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

// shortcut: counts per API process (a fixed one-minute window), so N processes allow up to N x the limit; count in Redis or Postgres when that matters
const windows = new Map<string, { minute: number; count: number }>();
/** Counts one request against the key's per-minute limit. */
export function countRequest(keyId: string, limit: number, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  if (windows.size > 10_000) for (const [id, w] of windows) if (w.minute < minute) windows.delete(id);
  const window = windows.get(keyId);
  const current = window && window.minute === minute ? window : { minute, count: 0 };
  current.count++;
  windows.set(keyId, current);
  return { limit, remaining: Math.max(0, limit - current.count), resetSec: Math.ceil(((minute + 1) * 60_000 - now) / 1000), over: current.count > limit };
}

/**
 * The key in `Authorization: Bearer <key>`, or a 401. The tenant comes from the key's row, never from the request.
 * Every failure says only what the caller can fix; an unknown and a wrong key read the same.
 */
export async function verifyKey(header: string | undefined, ip: string, log: FastifyBaseLogger): Promise<KeyScope> {
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const match = KEY.exec(presented);
  if (!match) throw httpError(401, "Send an API key as `Authorization: Bearer wfk_...`");
  const key = await prisma.apiKey.findUnique({ where: { prefix: match[1] } });
  if (!key || !timingSafeEqual(Buffer.from(hashKey(presented)), Buffer.from(key.hash))) throw httpError(401, "This API key is not valid");
  const now = new Date();
  if (key.revokedAt) throw httpError(401, "This API key was revoked");
  if (key.expiresAt && key.expiresAt <= now) throw httpError(401, key.replacedById ? "This API key has expired (it was rotated)" : "This API key has expired");
  if (!ipAllowed(ip, key.allowedIps)) throw httpError(403, `This API key cannot be used from ${ip}`);
  const rate = countRequest(key.id, key.rateLimitPerMinute, now.getTime());
  if (rate.over) throw Object.assign(httpError(429, `Over this key's limit of ${rate.limit} requests a minute`), { rate });
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_EVERY_MS)
    prisma.apiKey
      .updateMany({
        where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } }] },
        data: { lastUsedAt: now, lastUsedIp: ip },
      })
      .catch((err: unknown) => log.warn({ err, keyId: key.id }, "Recording an API key's last use failed"));
  return { id: key.id, organizationId: key.organizationId, workspaceId: key.workspaceId, scopes: key.scopes, rate };
}
