import type { FastifyReply } from "fastify";

export type ApiSuccess<TData> = {
  ok: true;
  data: TData;
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function sendSuccess<TData>(reply: FastifyReply, data: TData, statusCode = 200) {
  return reply.code(statusCode).send({
    ok: true,
    data,
  } satisfies ApiSuccess<TData>);
}

export function sendError(
  reply: FastifyReply,
  error: { code: string; message: string; details?: unknown },
  statusCode: number,
) {
  return reply.code(statusCode).send({
    ok: false,
    error,
  } satisfies ApiError);
}
