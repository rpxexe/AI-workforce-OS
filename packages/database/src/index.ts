import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.ts";

export * from "./generated/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
