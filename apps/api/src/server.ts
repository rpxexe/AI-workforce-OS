import { buildApp } from "./app.ts";

const app = await buildApp();
// 0.0.0.0 so the API is reachable from containers and other devices on the LAN.
await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: "0.0.0.0" });
