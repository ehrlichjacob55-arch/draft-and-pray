import type { ErrorCode } from "@dnp/contract";
import { DomainError } from "@dnp/db";
import type { Context } from "hono";
import type { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = (message = "Sign in required") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "You do not have access to this resource") =>
  new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);

/** HTTP status for a DomainError code raised by @dnp/db. */
export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case "bad_request":
    case "validation_error":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
    case "invite_not_found":
      return 404;
    case "internal_error":
      return 500;
    default:
      return 409;
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/** Parses the JSON body with a zod schema; 400 bad_request / validation_error on failure. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(400, "validation_error", parsed.error.issues[0]?.message ?? "Invalid body");
  return parsed.data;
}

export function toErrorResponse(err: unknown): {
  status: number;
  body: ReturnType<typeof errorBody>;
} {
  if (err instanceof ApiError)
    return { status: err.status, body: errorBody(err.code, err.message) };
  if (err instanceof DomainError)
    return { status: statusForCode(err.code), body: errorBody(err.code, err.message) };
  return { status: 500, body: errorBody("internal_error", "Internal Server Error") };
}
