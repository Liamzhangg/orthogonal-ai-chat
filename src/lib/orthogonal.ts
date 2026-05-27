const ORTHOGONAL_BASE_URL = "https://api.orth.sh";
const DEFAULT_TIMEOUT_MS = 18_000;
const MAX_PREVIEW_CHARS = 2_800;
const MAX_RAW_CHARS = 2_000;
const MAX_ERROR_DETAILS = 10;

const META_ONLY_KEYS = new Set([
  "success",
  "price",
  "priceCents",
  "price_cents",
  "cost",
  "cost_cents",
  "costCents",
  "requestId",
  "request_id",
  "id",
  "count",
  "apisCount",
  "time",
  "duration",
  "usage",
  "status",
]);

type OrthogonalRequest = {
  endpoint: string;
  body: unknown;
  signal?: AbortSignal;
};

export type OrthogonalSearchInput = {
  prompt: string;
  limit?: number;
};

export type OrthogonalRunInput = {
  api: string;
  path: string;
  query?: Record<string, string | number | boolean | null>;
  body?: unknown;
};

export type OrthogonalDescribeInput = {
  api: string;
  path: string;
};

export async function searchOrthogonal(
  input: OrthogonalSearchInput,
  signal?: AbortSignal,
) {
  const response = await orthogonalPost({
    endpoint: "/v1/search",
    body: {
      prompt: input.prompt,
      limit: input.limit ?? 5,
    },
    signal,
  });

  return compactOrthogonalResponse(response);
}

export async function runOrthogonalApi(
  input: OrthogonalRunInput,
  signal?: AbortSignal,
) {
  const response = await orthogonalPost({
    endpoint: "/v1/run",
    body: {
      api: input.api,
      path: input.path,
      query: input.query,
      body: input.body,
    },
    signal,
  });

  return compactOrthogonalResponse(response);
}

export async function describeOrthogonalEndpoint(
  input: OrthogonalDescribeInput,
  signal?: AbortSignal,
) {
  const response = await orthogonalPost({
    endpoint: "/v1/run",
    body: {
      api: input.api,
      path: input.path,
      query: {},
      body: {},
    },
    signal,
  });

  const compact = compactOrthogonalResponse(response);

  if (compact.isError) {
    return {
      api: input.api,
      path: input.path,
      acceptsEmpty: false,
      errorMessage: compact.errorMessage,
      errorDetail: compact.errorDetail,
      summary:
        compact.errorDetail && compact.errorDetail.length > 0
          ? `Required fields: ${compact.errorDetail
              .map((entry) => `${entry.field} (${entry.type})`)
              .join(", ")}`
          : compact.summary,
      nextStepHint:
        "Use the listed errorDetail fields to construct a real call via runOrthogonalApi.",
      raw: compact.raw,
    };
  }

  return {
    api: input.api,
    path: input.path,
    acceptsEmpty: true,
    sampleResponse: compact.dataPreview,
    summary:
      "Endpoint accepted an empty call. Inspect sampleResponse to see returned field names.",
    nextStepHint:
      "Call runOrthogonalApi with relevant identifiers to get richer data.",
    requestId: compact.requestId,
    raw: compact.raw,
  };
}

export async function webSearchWithOrthogonal(
  query: string,
  signal?: AbortSignal,
) {
  return runOrthogonalApi(
    {
      api: "tavily",
      path: "/search",
      body: {
        query,
        search_depth: "basic",
      },
    },
    signal,
  );
}

export async function enrichCompanyWithOrthogonal(
  domain: string,
  signal?: AbortSignal,
) {
  return runOrthogonalApi(
    {
      api: "company-enrich",
      path: "/companies/enrich",
      query: { domain },
    },
    signal,
  );
}

async function orthogonalPost({ endpoint, body, signal }: OrthogonalRequest) {
  const apiKey = process.env.ORTHOGONAL_API_KEY;

  if (!apiKey) {
    throw new Error("ORTHOGONAL_API_KEY is not configured.");
  }

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(`${ORTHOGONAL_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    if (isRecord(json)) {
      return {
        ...json,
        success: false,
        httpStatus: response.status,
      };
    }

    throw new Error(
      getOrthogonalErrorMessage(response.status, text ?? response.statusText),
    );
  }

  return json;
}

type ErrorDetailEntry = {
  field: string;
  type: string;
  msg: string;
};

function compactOrthogonalResponse(response: unknown) {
  const objectResponse = isRecord(response) ? response : { data: response };
  const price =
    objectResponse.price ??
    objectResponse.priceCents ??
    objectResponse.price_cents ??
    null;
  const requestId =
    objectResponse.requestId ??
    objectResponse.request_id ??
    objectResponse.id ??
    null;
  const httpStatus =
    typeof objectResponse.httpStatus === "number"
      ? objectResponse.httpStatus
      : null;
  const results = Array.isArray(objectResponse.results)
    ? objectResponse.results.slice(0, 5).map(compactApiResult)
    : undefined;
  const data = objectResponse.data;
  const previewValue = data ?? objectResponse;
  const dataPreview = stringifyPreview(previewValue);
  const hasResultFields = hasUsefulData(previewValue);
  const hasEmail = containsEmail(dataPreview);
  const upstreamSucceeded = objectResponse.success !== false;
  const errorDetail = upstreamSucceeded
    ? undefined
    : extractErrorDetail(objectResponse);
  const errorMessage = upstreamSucceeded
    ? undefined
    : extractErrorMessage(objectResponse);
  const isError = !upstreamSucceeded;
  const isValidationError =
    isError &&
    (httpStatus === 400 ||
      httpStatus === 422 ||
      Boolean(errorDetail?.length));
  const isEmpty =
    upstreamSucceeded && !results?.length && !hasResultFields;
  const summary = summarizeOrthogonalResponse({
    response: objectResponse,
    results,
    dataPreview,
    hasResultFields,
    hasEmail,
    isError,
    isEmpty,
    errorMessage,
    errorDetail,
    isValidationError,
  });
  const nextStepHint = buildNextStepHint({
    isError,
    isEmpty,
    hasEmail,
    isValidationError,
  });

  return {
    success: objectResponse.success ?? true,
    isError,
    isValidationError,
    isEmpty,
    httpStatus,
    price,
    requestId,
    mayHaveCharged: Boolean(requestId),
    count: objectResponse.count ?? objectResponse.apisCount ?? null,
    results,
    hasData: hasResultFields,
    hasEmail,
    summary,
    errorMessage,
    errorDetail,
    nextStepHint,
    dataPreview,
    raw: trimRaw(objectResponse),
  };
}

function compactApiResult(result: unknown) {
  if (!isRecord(result)) {
    return result;
  }

  return {
    name: result.name,
    slug: result.slug,
    endpoints: Array.isArray(result.endpoints)
      ? result.endpoints.slice(0, 4).map((endpoint) => {
          if (!isRecord(endpoint)) {
            return endpoint;
          }

          return {
            path: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            price: endpoint.price,
            verified: endpoint.verified,
          };
        })
      : [],
  };
}

function stringifyPreview(value: unknown) {
  const text = JSON.stringify(value, null, 2);

  if (!text) {
    return "";
  }

  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}...`
    : text;
}

function trimRaw(value: unknown) {
  const text = JSON.stringify(value);

  if (!text) {
    return value;
  }

  if (text.length <= MAX_RAW_CHARS) {
    return value;
  }

  return `${text.slice(0, MAX_RAW_CHARS)}...[truncated ${
    text.length - MAX_RAW_CHARS
  } chars]`;
}

function summarizeOrthogonalResponse({
  response,
  results,
  dataPreview,
  hasResultFields,
  hasEmail,
  isError,
  isEmpty,
  errorMessage,
  errorDetail,
  isValidationError,
}: {
  response: Record<string, unknown>;
  results: unknown[] | undefined;
  dataPreview: string;
  hasResultFields: boolean;
  hasEmail: boolean;
  isError: boolean;
  isEmpty: boolean;
  errorMessage: string | undefined;
  errorDetail: ErrorDetailEntry[] | undefined;
  isValidationError: boolean;
}) {
  if (isError) {
    const base = `${isValidationError ? "Input error" : "Upstream rejected the call"}: ${
      errorMessage ?? "unknown error"
    }`;

    if (errorDetail && errorDetail.length > 0) {
      const fields = errorDetail
        .map((entry) => `${entry.field} (${entry.type || "invalid"})`)
        .join(", ");
      return `${base}. Required/invalid fields: ${fields}.`;
    }

    const previewSnippet = dataPreview
      ? `. Detail: ${dataPreview.slice(0, 200)}`
      : "";
    return `${base}${previewSnippet}.`;
  }

  if (results?.length) {
    return `Found ${results.length} catalog option${
      results.length === 1 ? "" : "s"
    }.`;
  }

  if (isEmpty) {
    return "Provider accepted the call but returned no result fields. Required identifiers may be missing for this endpoint.";
  }

  if (hasEmail) {
    return "Returned email-like contact data.";
  }

  if (!hasResultFields) {
    return "The API completed, but did not return usable result data.";
  }

  const status =
    response.status ??
    response.message ??
    response.code ??
    null;

  if (typeof status === "string" && status.trim()) {
    return status;
  }

  return dataPreview
    ? "Returned result data."
    : "The API completed.";
}

function buildNextStepHint({
  isError,
  isEmpty,
  hasEmail,
  isValidationError,
}: {
  isError: boolean;
  isEmpty: boolean;
  hasEmail: boolean;
  isValidationError: boolean;
}): string | undefined {
  if (isError) {
    if (isValidationError) {
      return "Re-read errorDetail, fix the body shape, and re-present Step 3 yourself. Do not ask the user to correct field nesting.";
    }

    return "If the failure looks like a bad identifier, run one more searchWeb with a refined query and re-present Step 3. Otherwise tell the user the provider failed and stop.";
  }

  if (isEmpty) {
    return "Run one more searchWeb for a stronger identifier (domain, LinkedIn URL, full name, exact title) and re-present Step 3 with the better input. Only ask the user if searchWeb truly returns nothing usable.";
  }

  if (hasEmail) {
    return "Cite provider, path, requestId, and price when summarizing to the user.";
  }

  return undefined;
}

function extractErrorMessage(
  response: Record<string, unknown>,
): string | undefined {
  const candidates: unknown[] = [
    response.error,
    response.message,
    response.code,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

function extractErrorDetail(
  response: Record<string, unknown>,
): ErrorDetailEntry[] | undefined {
  const data = response.data;
  const detail = isRecord(data) ? data.detail : undefined;

  if (Array.isArray(detail)) {
    const entries: ErrorDetailEntry[] = [];

    for (const item of detail) {
      if (entries.length >= MAX_ERROR_DETAILS) {
        break;
      }

      if (!isRecord(item)) {
        continue;
      }

      const locValue = item.loc;
      const field = Array.isArray(locValue)
        ? locValue.map((part) => String(part)).join(".")
        : typeof locValue === "string"
          ? locValue
          : "(unspecified)";
      const type = typeof item.type === "string" ? item.type : "invalid";
      const msg = typeof item.msg === "string" ? item.msg : "";

      entries.push({ field, type, msg });
    }

    if (entries.length > 0) {
      return entries;
    }
  }

  if (typeof detail === "string" && detail.trim()) {
    return [{ field: "(unspecified)", type: "error", msg: detail }];
  }

  const errorsArrays: unknown[] = [];
  if (isRecord(data) && Array.isArray(data.errors)) {
    errorsArrays.push(...data.errors);
  }
  if (Array.isArray(response.errors)) {
    errorsArrays.push(...response.errors);
  }

  if (errorsArrays.length === 0) {
    return undefined;
  }

  const entries: ErrorDetailEntry[] = [];

  for (const item of errorsArrays) {
    if (entries.length >= MAX_ERROR_DETAILS) {
      break;
    }

    if (!isRecord(item)) {
      continue;
    }

    const msg =
      (typeof item.details === "string" && item.details) ||
      (typeof item.message === "string" && item.message) ||
      (typeof item.msg === "string" && item.msg) ||
      "";
    const typeRaw =
      (typeof item.id === "string" && item.id) ||
      (item.code !== undefined && item.code !== null && String(item.code)) ||
      "";
    const type = typeRaw || "invalid";

    const fields = parseFieldsFromErrorMessage(msg);

    if (fields.length === 0) {
      entries.push({ field: "(unspecified)", type, msg });
      continue;
    }

    for (const field of fields) {
      if (entries.length >= MAX_ERROR_DETAILS) {
        break;
      }
      entries.push({ field, type, msg });
    }
  }

  return entries.length > 0 ? entries : undefined;
}

function parseFieldsFromErrorMessage(message: string): string[] {
  if (!message) {
    return [];
  }

  const missingOne = message.match(
    /missing(?:\s+the)?\s+([A-Za-z_][A-Za-z0-9_]*)\s+parameter/i,
  );
  if (missingOne) {
    return [missingOne[1]];
  }

  const oneOf = message.match(
    /one of the following parameters?:\s*([A-Za-z0-9_,\s]+)/i,
  );
  if (oneOf) {
    return oneOf[1]
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  }

  return [];
}

function hasUsefulData(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => {
      if (META_ONLY_KEYS.has(key)) {
        return false;
      }

      return hasUsefulData(entry);
    });
  }

  return false;
}

function containsEmail(text: string) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getOrthogonalErrorMessage(status: number, payload: unknown) {
  if (isRecord(payload)) {
    const message = payload.message ?? payload.error ?? payload.code;

    if (typeof message === "string") {
      return `Orthogonal API error ${status}: ${message}`;
    }
  }

  return `Orthogonal API error ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
