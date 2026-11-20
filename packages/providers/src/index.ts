// Phase 14: the provider registry, adapters that have no older package of their own (email beyond Resend, object
// storage), sealed credentials, and fallback across connections. Everything outside talks to these interfaces.
export * from "./types.ts";
export * from "./seal.ts";
export * from "./fallback.ts";
export * from "./registry.ts";
export { rfc3986, signV4 } from "./aws.ts";
export { azureBlobStorage } from "./storage/azure-blob.ts";
export { awsS3, gcs, r2, s3Compatible, s3Storage } from "./storage/s3.ts";
export { sendGridEmail } from "./email/sendgrid.ts";
export { sesEmail } from "./email/ses.ts";
export { smtpEmail } from "./email/smtp.ts";
