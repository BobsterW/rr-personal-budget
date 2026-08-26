/* Controlled API errors, bounded JSON parsing, JSON response construction, and
 * safe conversion of unexpected D1/runtime failures into public messages. */
import type { ValidationIssue } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ValidationIssue[],
  ) {
    super(message);
  }
}

export function json(
  data: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1_000_000)
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 1 MB.");
  try {
    return await request.json();
  } catch {
    throw new ApiError(
      400,
      "MALFORMED_JSON",
      "The request body is not valid JSON.",
    );
  }
}

export function errorResponse(
  error: unknown,
  requestId: string,
  headers: HeadersInit = {},
): Response {
  let apiError: ApiError;
  if (error instanceof ApiError) apiError = error;
  else {
    const message = error instanceof Error ? error.message : String(error);
    if (/FOREIGN KEY constraint failed/i.test(message))
      apiError = new ApiError(
        409,
        "RELATED_RECORD_MISSING",
        "A selected account, category, or import record no longer exists. Refresh the page and try again.",
      );
    else if (/UNIQUE constraint failed/i.test(message))
      apiError = new ApiError(
        409,
        "DUPLICATE_RECORD",
        "That name or record already exists.",
      );
    else if (/no such (table|column)/i.test(message))
      apiError = new ApiError(
        503,
        "DATABASE_MIGRATION_REQUIRED",
        "The database schema is out of date. Apply all D1 migrations and try again.",
      );
    else
      apiError = new ApiError(
        500,
        "INTERNAL_ERROR",
        "The server could not complete this operation. Use the request ID when checking Worker logs.",
      );
  }
  return json(
    {
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details ? { details: apiError.details } : {}),
        requestId,
      },
    },
    apiError.status,
    headers,
  );
}
