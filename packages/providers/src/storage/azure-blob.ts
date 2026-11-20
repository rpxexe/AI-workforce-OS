// Azure Blob Storage with a container SAS token: the token rides in the query string, so nothing is signed here.
import { ProviderError } from "@workforce/shared";
import type { ObjectStorage } from "../types.ts";
import { keyPath, reach, storageFailure } from "./s3.ts";

const NAME = "azure_blob";

export function azureBlobStorage(o: { account: string; container: string; sasToken: string; fetch?: typeof fetch; host?: string }): ObjectStorage {
  const http = o.fetch ?? fetch;
  const sas = o.sasToken.replace(/^\?/, "");
  const container = `${o.host ?? `https://${o.account}.blob.core.windows.net`}/${encodeURIComponent(o.container)}`;
  const headers = { "x-ms-version": "2023-11-03" };
  const object = (key: string) => new URL(`${container}/${keyPath(key)}?${sas}`);
  // The SAS is the secret; it is in every URL, so keep it out of any error text.
  const call = (url: URL, init: RequestInit) => reach(NAME, http, url, init, sas);

  return {
    name: NAME,
    async put(key, data, contentType) {
      const res = await call(object(key), {
        method: "PUT",
        headers: { ...headers, "x-ms-blob-type": "BlockBlob", "content-type": contentType },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw await storageFailure(NAME, res, sas);
    },
    async get(key) {
      const res = await call(object(key), { headers });
      if (res.status === 404) throw new ProviderError("config", `${NAME}: ${key} not found`);
      if (!res.ok) throw await storageFailure(NAME, res, sas);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await call(object(key), { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) throw await storageFailure(NAME, res, sas);
    },
    async check() {
      const res = await call(new URL(`${container}?restype=container&comp=list&maxresults=1&${sas}`), { headers });
      if (!res.ok) throw await storageFailure(NAME, res, sas);
    },
  };
}
