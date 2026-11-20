// Secrets at rest: AES-256-GCM under a key derived from the server secret (AI_CREDENTIALS_KEY). The format names its
// version: v1 (Phase 13) seals a bare API key, v2 seals a JSON object of every secret field of a connection.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyFrom = (secret: string) => createHash("sha256").update(secret).digest();

const seal = (version: string, plain: string, secret: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [version, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

const open = (sealed: string, secret: string) => {
  const [version, iv, tag, data] = sealed.split(":");
  if ((version !== "v1" && version !== "v2") || !iv || !tag || !data) throw new Error("Unknown sealed key format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return { version, plain: Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8") };
};

/** Phase 13's format: one API key. */
export const sealKey = (plain: string, secret: string) => seal("v1", plain, secret);
export const openKey = (sealed: string, secret: string) => open(sealed, secret).plain;

export const sealCredentials = (credentials: Record<string, string>, secret: string) => seal("v2", JSON.stringify(credentials), secret);

/**
 * Opens a connection's secrets with the current server secret, else the previous one (AI_CREDENTIALS_KEY_PREVIOUS, while
 * rotating it). `stale` says it was sealed under the previous secret or in the v1 format: seal it again with the current one.
 */
export function openCredentials(sealed: string, secrets: { current: string; previous?: string | null }): { credentials: Record<string, string>; stale: boolean } {
  let opened: ReturnType<typeof open>;
  let stale = false;
  try {
    opened = open(sealed, secrets.current);
  } catch (err) {
    if (!secrets.previous) throw err;
    opened = open(sealed, secrets.previous);
    stale = true;
  }
  if (opened.version === "v1") return { credentials: { apiKey: opened.plain }, stale: true };
  return { credentials: JSON.parse(opened.plain) as Record<string, string>, stale };
}

/** What may be shown of a secret: its last 4 characters. */
export const hintOf = (value: string) => (value.length > 8 ? `…${value.slice(-4)}` : "…");

/**
 * Masks what looks like a credential in text whose secrets are not known (provider errors in logs and usage rows): long
 * runs of key characters that mix letters and digits, and Bearer/Basic values.
 */
export const scrubSecrets = (text: string) =>
  text
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/[\w-]{24,}/g, (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? `${run.slice(0, 3)}…[redacted]` : run));

/** Replaces every secret value (and every 6+ character run of one) in a message, so provider errors can be stored and shown. */
export function redact(message: string, secrets: Record<string, string> | string[]) {
  let out = message;
  for (const value of Array.isArray(secrets) ? secrets : Object.values(secrets)) {
    if (!value || value.length < 4) continue;
    out = out.split(value).join("[redacted]");
    // Providers sometimes echo part of a key ("sk-ab...WXYZ"): hide its distinctive ends too.
    if (value.length >= 12) out = out.split(value.slice(0, 8)).join("[redacted]").split(value.slice(-6)).join("[redacted]");
  }
  return out;
}
