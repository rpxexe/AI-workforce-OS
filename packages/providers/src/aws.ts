// AWS Signature Version 4 (S3, SES and the S3-compatible stores), per the AWS "Create a signed request" docs.
import { createHash, createHmac } from "node:crypto";

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** encodeURIComponent plus the characters RFC 3986 reserves that it leaves alone. */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers to send: the given ones plus host, x-amz-date, authorization (and x-amz-content-sha256 when asked: S3 wants it). */
export function signV4(o: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
  contentSha256Header?: boolean;
}): Record<string, string> {
  const amzDate = (o.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(o.body);
  const headers: Record<string, string> = { ...o.headers, host: o.url.host, "x-amz-date": amzDate };
  if (o.contentSha256Header) headers["x-amz-content-sha256"] = payloadHash;

  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canonicalHeaders.map(([k]) => k).join(";");
  const path = o.url.pathname.split("/").map((segment) => rfc3986(decodeURIComponent(segment))).join("/");
  const query = [...o.url.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [o.method, path || "/", query, ...canonicalHeaders.map(([k, v]) => `${k}:${v}`), "", signedHeaders, payloadHash].join("\n");

  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), o.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
