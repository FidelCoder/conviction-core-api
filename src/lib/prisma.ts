import { PrismaClient } from "@prisma/client";

import { env } from "../config/index.js";

export const prisma = new PrismaClient({
  log: env.environment === "development" ? ["warn", "error"] : ["error"],
});
