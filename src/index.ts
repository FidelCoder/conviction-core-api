import { config } from "./config/index.js";

export function start(): void {
  console.log(`conviction-core-api ready on port ${config.port}`);
}

start();
