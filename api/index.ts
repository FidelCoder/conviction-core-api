import type { IncomingMessage, ServerResponse } from "node:http";

import { buildApp } from "../src/app.js";

let appPromise: ReturnType<typeof buildApp> | null = null;

async function getApp() {
  appPromise ??= buildApp();
  const app = await appPromise;

  await app.ready();

  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();

  app.server.emit("request", req, res);
}
