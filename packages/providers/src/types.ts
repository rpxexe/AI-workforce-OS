import type { ChannelSender } from "@workforce/channels";

/** A bucket or container the organization owns. Keys are paths inside it; data is whole files (knowledge uploads, 10 MB). */
export interface ObjectStorage {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Fails with ProviderError("config") when the object does not exist. */
  get(key: string): Promise<Buffer>;
  /** Deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** A cheap authenticated call proving the credentials and the bucket: Test Connection. */
  check(): Promise<void>;
}

/** An email sender (ChannelSender with kind "email") that can also prove its credentials without sending. */
export type EmailSender = ChannelSender & { readonly name: string; check(): Promise<void> };
