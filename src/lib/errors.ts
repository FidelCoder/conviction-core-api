export type ErrorDetails = Record<string, unknown> | undefined;

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: ErrorDetails;

  constructor(
    message: string,
    options: { code: string; statusCode: number; details?: ErrorDetails },
  ) {
    super(message);
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
