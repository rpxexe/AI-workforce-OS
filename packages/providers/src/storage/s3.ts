// S3 and the stores that speak its API (Cloudflare R2, Google Cloud Storage with HMAC keys, MinIO and the like),
// signed with SigV4 over plain fetch.
import { kindOfStatus, ProviderError } from "@workforce/shared";
import { rfc3986, signV4 } from "../aws.ts";
import type { ObjectStorage } from "../types.ts";

/** A key as a URL path: each segment encoded, the slashes kept. */
export const keyPath = (key: string) => key.split("/").map(rfc3986).join("/");

/** Fetches, turning a network failure into ProviderError("unavailable"). `hide` is scrubbed from the text (a SAS token in the URL). */
export async function reach(name: string, http: typeof fetch, url: URL, init: RequestInit, hide?: string): Promise<Response> {
  try {
    return await http(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new ProviderError("unavailable", `${name} could not be reached: ${(hide ? text.split(hide).join("***") : text).slice(0, 300)}`);
  }
}

/** The error an S3 or Azure response means, from its XML <Code> and <Message>. */
export async function storageFailure(name: string, res: Response, hide?: string) {
  const xml = await res.text().catch(() => "");
  const code = /<Code>([^<]*)<\/Code>/.exec(xml)?.[1];
  let message = (/<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? `HTTP ${res.status}`).slice(0, 300);
  if (hide) message = message.split(hide).join("***");
  return new ProviderError(kindOfStatus(res.status), `${name} refused (${res.status}${code ? ` ${code}` : ""}): ${message}`);
}

type Keys = { accessKeyId: string; secretAccessKey: string };

export function s3Storage(o: Keys & { name: string; endpoint: string; region: string; bucket: string; pathStyle: boolean; fetch?: typeof fetch }): ObjectStorage {
  const http = o.fetch ?? fetch;
  const base = new URL(o.endpoint);
  const bucketUrl = o.pathStyle ? `${base.origin}/${rfc3986(o.bucket)}` : `${base.protocol}//${o.bucket}.${base.host}`;

  const call = async (method: string, url: URL, body: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}) => {
    const signed = signV4({ method, url, headers, body, region: o.region, service: "s3", accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, contentSha256Header: true });
    delete signed.host; // fetch sets the same Host from the URL
    return reach(o.name, http, url, { method, headers: signed, ...(body.length > 0 && { body: new Uint8Array(body) }) });
  };
  const object = (key: string) => new URL(`${bucketUrl}/${keyPath(key)}`);

  return {
    name: o.name,
    async put(key, data, contentType) {
      const res = await call("PUT", object(key), data, { "content-type": contentType });
      if (!res.ok) throw await storageFailure(o.name, res);
    },
    async get(key) {
      const res = await call("GET", object(key));
      if (res.status === 404) throw new ProviderError("config", `${o.name}: ${key} not found`);
      if (!res.ok) throw await storageFailure(o.name, res);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await call("DELETE", object(key));
      if (!res.ok && res.status !== 404) throw await storageFailure(o.name, res);
    },
    async check() {
      const res = await call("GET", new URL(`${bucketUrl}/?list-type=2&max-keys=1`));
      if (!res.ok) throw await storageFailure(o.name, res);
    },
  };
}

export const awsS3 = (o: { region: string; bucket: string; keys: Keys; fetch?: typeof fetch }) =>
  s3Storage({ name: "s3", endpoint: `https://s3.${o.region}.amazonaws.com`, region: o.region, bucket: o.bucket, pathStyle: false, ...o.keys, fetch: o.fetch });

export const r2 = (o: { accountId: string; bucket: string; keys: Keys; fetch?: typeof fetch }) =>
  s3Storage({ name: "r2", endpoint: `https://${o.accountId}.r2.cloudflarestorage.com`, region: "auto", bucket: o.bucket, pathStyle: true, ...o.keys, fetch: o.fetch });

/** Google Cloud Storage through its S3 interoperability (XML API with HMAC keys). */
export const gcs = (o: { bucket: string; keys: Keys; fetch?: typeof fetch }) =>
  s3Storage({ name: "gcs", endpoint: "https://storage.googleapis.com", region: "auto", bucket: o.bucket, pathStyle: true, ...o.keys, fetch: o.fetch });

export const s3Compatible = (o: { endpoint: string; region: string; bucket: string; keys: Keys; fetch?: typeof fetch }) =>
  s3Storage({ name: "s3_compatible", endpoint: o.endpoint, region: o.region, bucket: o.bucket, pathStyle: true, ...o.keys, fetch: o.fetch });
