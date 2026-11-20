// Network access for tools. The model never gets a socket: tools call `safeFetch`, which only
// reaches public addresses, so a tool cannot be pointed at the server itself or the private network.
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { ToolError } from "./types.ts";

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, prefix, "ipv6");

// BlockList checks IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) against the IPv4 rules itself.
export const isPrivateAddress = (address: string) => PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/** The resolver every safe connection uses; tests replace it to play a DNS-rebinding host. */
export const resolver = { lookup: (host: string) => lookup(host, { all: true }) };

/**
 * Resolves for the socket itself and refuses private answers. The address checked is the address connected to, so a host
 * that answers public first and private on the connection (DNS rebinding) cannot reach the private network.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  resolver.lookup(hostname).then(
    (addresses) => {
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address)))
        return callback(new ToolError(`${hostname} is a private address`), "", 4);
      if (options.all) return (callback as unknown as (err: null, all: typeof addresses) => void)(null, addresses);
      const first = addresses.find((a) => !options.family || a.family === options.family) ?? addresses[0]!;
      callback(null, first.address, first.family);
    },
    (err: Error) => callback(Object.assign(err, { code: "ENOTFOUND" }), "", 4),
  );
};

const pinned = new Agent({ connect: { lookup: publicLookup } });

/**
 * `fetch` for public https endpoints only. Redirects are not followed, so an allowed host
 * cannot bounce the request somewhere else, and the connection resolves through `publicLookup`.
 */
export const safeFetch: typeof fetch = async (target, init) => {
  const url = new URL(target instanceof Request ? target.url : target);
  if (url.protocol !== "https:") throw new ToolError("Only https:// addresses are allowed");
  if (url.username || url.password) throw new ToolError("Addresses with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await resolver.lookup(host);
  } catch {
    throw new ToolError(`${url.hostname} could not be found`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address)))
    throw new ToolError(`${url.hostname} is a private address`);
  // The check above gives a clear error; the pinned agent is what makes it hold for the connection.
  return fetch(target, { ...init, redirect: "manual", dispatcher: pinned } as RequestInit);
};
