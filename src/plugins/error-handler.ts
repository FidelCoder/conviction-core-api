import type { FastifyError, FastifyInstance } from "fastify";

import { isAppError } from "../lib/errors.js";
import { sendError } from "../lib/responses.js";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (isAppError(error)) {
      return sendError(
        reply,
        { code: error.code, message: error.message, details: error.details },
        error.statusCode,
      );
    }

    if (error.validation) {
      return sendError(
        reply,
        {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.validation,
        },
        400,
      );
    }

    app.log.error(error);

    return sendError(
      reply,
      { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
      500,
    );
  });
}
