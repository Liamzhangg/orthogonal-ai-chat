import { openai } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  describeOrthogonalEndpoint,
  enrichCompanyWithOrthogonal,
  runOrthogonalApi,
  searchOrthogonal,
  webSearchWithOrthogonal,
} from "@/lib/orthogonal";
import {
  saveMessage,
  saveOrthogonalResult,
  saveToolCall,
} from "@/lib/store";
import type { ChatRequestBody } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const RECENT_MESSAGE_LIMIT = 14;
const DEFAULT_RUN_ORTHOGONAL_LIMIT = 1;
const EXPLICIT_RETRY_RUN_ORTHOGONAL_LIMIT = 2;

type ValidationDetail = {
  field: string;
  type: string;
  msg?: string;
};

type RunAttemptState = {
  runOrthogonalCalls: number;
  runOrthogonalLimit: number;
  validationFailures: Set<string>;
  endpointRequirements: Map<string, ValidationDetail[]>;
  describeAttempts: Set<string>;
  endpointsKnownToAcceptEmpty: Set<string>;
  probedEndpoints: Set<string>;
};

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const body = (await request.json()) as ChatRequestBody;
  const messages = body.messages ?? [];
  const conversationId = body.conversationId;
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const latestUserText = getMessageText(latestUserMessage);
  const lastAssistantText = getLastAssistantText(messages);
  const userDeclined = userMessageReadsAsDecline(latestUserText);
  const runAttemptState: RunAttemptState = {
    runOrthogonalCalls: 0,
    runOrthogonalLimit: userExplicitlyRequestedRetry(latestUserText)
      ? EXPLICIT_RETRY_RUN_ORTHOGONAL_LIMIT
      : DEFAULT_RUN_ORTHOGONAL_LIMIT,
    validationFailures: new Set(),
    endpointRequirements: new Map(),
    describeAttempts: new Set(),
    endpointsKnownToAcceptEmpty: new Set(),
    probedEndpoints: new Set(),
  };

  hydrateRunAttemptStateFromHistory(messages, runAttemptState);

  if (latestUserMessage) {
    await saveMessage(conversationId, latestUserMessage);
  }

  const modelMessages = await convertToModelMessages(
    messages.slice(-RECENT_MESSAGE_LIMIT),
  );

  const result = streamText({
    model: openai("gpt-4.1"),
    system: [
      "You are a focused AI research assistant for go-to-market data.",
      "Default to action. Every clarifying question you can answer with searchWeb or describeOrthogonalEndpoint is one you must not ask the user. The user wants you to drive — not interview them. The only user touchpoint per paid call is the Step 3 confirmation message below.",
      "searchOrthogonalCatalog, searchWeb, and describeOrthogonalEndpoint are free helpers; chain them aggressively to assemble the call yourself. runOrthogonalApi and enrichCompany are paid and gated by a single confirmation message. One paid call per response.",
      "Follow this 4-step protocol on every data-fetching request:",
      "Step 1 (Discover, Augment, Select — autonomous): Call searchOrthogonalCatalog once with a prompt describing the user's intent. Pick the single best matching provider+endpoint yourself; do not ask the user to choose. Then, in the same turn, call searchWeb as many times as needed to derive every identifier the call will need (company domain, person's full name, LinkedIn URL, exact title, location, etc.). Use multiple searchWeb queries if the first is thin. Do not ask the user for an identifier you could look up. Narrate briefly in one short line what you're looking up — do not write a long plan.",
      "Step 2 (Probe schema — autonomous): In the same turn, call describeOrthogonalEndpoint(api, path) for the endpoint you selected. It is a FREE probe — the upstream rejects an empty body with a validation error and Orthogonal does not charge you. The returned errorDetail (array of {field, type, msg}) lists the exact required field names and nesting. Read it carefully; you will mirror it in Step 3.",
      "Step 3 (Confirm — the only user touchpoint): In the same turn as Steps 1 and 2, write the exact planned call back to the user: the provider slug, the literal endpoint path (for example /find-email), and the full body/query JSON you intend to send — using the field names and nesting exactly as they appeared in describeOrthogonalEndpoint's errorDetail. If errorDetail listed a field like 'body.lead.name', body must contain a 'lead' object with a 'name' key — do not flatten. Include the expected price from the catalog. End with 'Confirm to proceed?'. Your Step 3 message MUST contain the literal endpoint path and the word 'Confirm'. The app inspects your previous assistant message for these two tokens before allowing the paid call; if they are missing the tool returns notCalled=true and no money is spent. Do NOT call runOrthogonalApi or enrichCompany in this turn. The turn ends here.",
      "Step 4 (Execute): Only when the latest user message reads as a confirmation, call runOrthogonalApi (or enrichCompany for the company-enrich domain enricher) exactly once with the confirmed inputs. The body shape must match what you presented in Step 3, which itself must match the describeOrthogonalEndpoint errorDetail. If you receive notCalled with blockedReason mentioning 'schema not yet known', call describeOrthogonalEndpoint first. If you receive notCalled with blockedReason mentioning the confirmation gate, write a fresh Step 3 message and wait.",
      "Step 5 (Report): After the call returns, cite the provider slug, endpoint path, requestId, and price. Recovery is autonomous: on isValidationError, re-read errorDetail, fix the body, and re-present Step 3 yourself — do not ask the user to correct field nesting. On isEmpty, run one more searchWeb for a stronger identifier (domain, LinkedIn URL, full name) and re-present Step 3 with the better input. On a hard isError from the provider, tell the user what failed and stop. Only ask the user for help when searchWeb has genuinely returned nothing usable after a real attempt.",
      "State recovery: Before any tool call or text reply, scan the conversation history. If your previous assistant message stated a planned call body and asked to confirm (containing the path and the word 'Confirm'), and the latest user message reads as a confirmation, go straight to Step 4. Otherwise you are starting a fresh request — run Steps 1–3 in a single turn and stop at Step 3. Never call a paid tool without a Step 3 message preceding it in this conversation.",
      "Underspecified requests: If the user's first message is genuinely missing a target (e.g. 'find this company's cofounder's email' with no company named) AND a quick searchWeb cannot disambiguate, ask the one missing piece of information — but only that. Do not also ask which provider, which endpoint, or which inputs. If searchOrthogonalCatalog returns nothing useful, say so plainly and stop. Do not invent a call. Do not ask the user to suggest providers.",
      "Formatting: In Step 3, name the chosen provider as a planned-call heading where only the provider name is linked, like ## Planning to call: [Sixtyfour API](https://api.sixtyfour.ai). Put the endpoint path on the next line, then the body JSON in a code block, then price, then 'Confirm to proceed?'. Never use a bare provider heading like ## [Sixtyfour API](https://api.sixtyfour.ai).",
      "Do not invent data. If a tool returns no useful data, say so clearly. Keep answers concise.",
    ].join(" "),
    messages: modelMessages,
    stopWhen: stepCountIs(10),
    tools: {
      searchOrthogonalCatalog: tool({
        description:
          "Step 1 of the protocol. Search Orthogonal's API catalog for providers/endpoints that can answer the user's request. Free helper — run first on every data request. You will auto-select the single best match; do not ask the user to choose.",
        inputSchema: z.object({
          prompt: z
            .string()
            .describe("Natural language description of the API capability to find."),
          limit: z.number().min(1).max(10).default(5),
        }),
        execute: async (input, options) =>
          runTrackedTool({
            conversationId,
            toolCallId: options.toolCallId,
            toolName: "searchOrthogonalCatalog",
            input,
            api: null,
            path: "/v1/search",
            prompt: input.prompt,
            execute: () => searchOrthogonal(input, options.abortSignal),
          }),
      }),
      searchWeb: tool({
        description:
          "Step 1 helper. Search the web through Orthogonal for current news, websites, company facts, people, leadership, or public web results. Free helper — run autonomously as many times as needed to derive any missing identifier (company domain, person's name, LinkedIn URL, exact title, location, etc.) before constructing a paid call. Prefer one more searchWeb over asking the user. Tell the user in one short line what you are checking. Do NOT use this for the user's primary paid call.",
        inputSchema: z.object({
          query: z.string().describe("The web search query to run."),
        }),
        execute: async (input, options) =>
          runTrackedTool({
            conversationId,
            toolCallId: options.toolCallId,
            toolName: "searchWeb",
            input,
            api: "tavily",
            path: "/search",
            prompt: input.query,
            execute: () => webSearchWithOrthogonal(input.query, options.abortSignal),
          }),
      }),
      enrichCompany: tool({
        description:
          "Step 4 (Execute) for the company-enrich domain enricher. Paid provider call. Only invoke after a Step 3 confirmation message naming /companies/enrich and containing the word 'Confirm' has been sent and the latest user message reads as a confirmation. If the confirmation gate blocks the call, write a fresh Step 3 message — do not retry.",
        inputSchema: z.object({
          domain: z
            .string()
            .describe("Company domain, such as stripe.com or orthogonal.com."),
        }),
        execute: async (input, options) =>
          runTrackedTool({
            conversationId,
            toolCallId: options.toolCallId,
            toolName: "enrichCompany",
            input,
            api: "company-enrich",
            path: "/companies/enrich",
            prompt: input.domain,
            execute: async () => {
              const gateInput = {
                api: "company-enrich",
                path: "/companies/enrich",
              };
              const gateBlock = getConfirmationGateBlock(
                gateInput,
                lastAssistantText,
                userDeclined,
              );

              if (gateBlock) {
                return gateBlock;
              }

              return enrichCompanyWithOrthogonal(
                input.domain,
                options.abortSignal,
              );
            },
          }),
      }),
      runOrthogonalApi: tool({
        description:
          "Step 4 (Execute). Paid provider call. Only invoke after TWO technical gates have been cleared: (1) describeOrthogonalEndpoint has been called for this exact api/path in this response so the schema is known, and (2) your previous assistant message contains the literal endpoint path and the word 'Confirm', and the latest user message reads as a confirmation. The body shape MUST match the field names and nesting from describeOrthogonalEndpoint's errorDetail. The app enforces one paid call per response and will return notCalled with blockedReason='schema not yet known' if you skipped the describe probe. Recovery is autonomous: on isValidationError, fix the body from errorDetail and re-present Step 3 yourself; on isEmpty, run one more searchWeb for a stronger identifier and re-present Step 3; on a hard isError, tell the user what failed and stop.",
        inputSchema: z.object({
          api: z.string().describe("Provider slug, for example apollo."),
          path: z.string().describe("Endpoint path, for example /v1/people/match."),
          query: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional()
            .describe("Query parameters for GET-like endpoints."),
          body: z.unknown().optional().describe("JSON body for POST endpoints."),
        }),
        execute: async (input, options) =>
          runTrackedTool({
            conversationId,
            toolCallId: options.toolCallId,
            toolName: "runOrthogonalApi",
            input,
            api: input.api,
            path: input.path,
            prompt: null,
            execute: async () => {
              const gateBlock = getConfirmationGateBlock(
                input,
                lastAssistantText,
                userDeclined,
              );

              if (gateBlock) {
                return gateBlock;
              }

              const blocked = getRunReadinessBlock(input, runAttemptState);

              if (blocked) {
                return blocked;
              }

              runAttemptState.runOrthogonalCalls += 1;
              const output = await runOrthogonalApi(input, options.abortSignal);
              rememberRunOutcome(input, output, runAttemptState);

              return output;
            },
          }),
      }),
      describeOrthogonalEndpoint: tool({
        description:
          "Step 2 (Probe schema) free probe. Run this autonomously after you have auto-selected the best catalog match and before writing the Step 3 confirmation message — same turn. Sends an empty body to the endpoint; the upstream rejects it with a validation error that lists the exact required field names, types, and nesting (returned as errorDetail: array of {field, type, msg}). When the upstream rejects on validation, no money is charged. The rare case where the endpoint accepts an empty body returns acceptsEmpty=true plus a sampleResponse — in that case this counts as a paid call. There is a one-probe-per-endpoint-per-response cap; reuse the prior errorDetail rather than re-probing.",
        inputSchema: z.object({
          api: z.string().describe("Provider slug, for example sixtyfour."),
          path: z
            .string()
            .describe("Endpoint path, for example /find-email."),
        }),
        execute: async (input, options) =>
          runTrackedTool({
            conversationId,
            toolCallId: options.toolCallId,
            toolName: "describeOrthogonalEndpoint",
            input,
            api: input.api,
            path: input.path,
            prompt: null,
            execute: async () => {
              const endpointKey = getEndpointKey(input);

              if (runAttemptState.describeAttempts.has(endpointKey)) {
                return buildNotCalledResult({
                  input,
                  reason:
                    "this endpoint was already probed this response; reuse the prior errorDetail instead of re-probing",
                  missingFields: [],
                });
              }

              if (runAttemptState.endpointsKnownToAcceptEmpty.has(endpointKey)) {
                const gateBlock = getConfirmationGateBlock(
                  input,
                  lastAssistantText,
                  userDeclined,
                );
                if (gateBlock) return gateBlock;

                const budgetBlock = getPaidCallBudgetBlock(
                  input,
                  runAttemptState,
                );
                if (budgetBlock) return budgetBlock;
              }

              runAttemptState.describeAttempts.add(endpointKey);

              const output = await describeOrthogonalEndpoint(
                input,
                options.abortSignal,
              );

              // describeOrthogonalEndpoint returns acceptsEmpty=true only when
              // the upstream accepted the empty body and produced a real response
              // — which means a real charge. acceptsEmpty=false means the
              // upstream rejected with validation, no charge.
              const acceptsEmpty =
                isRecord(output) && output.acceptsEmpty === true;

              if (acceptsEmpty) {
                runAttemptState.runOrthogonalCalls += 1;
                runAttemptState.endpointsKnownToAcceptEmpty.add(endpointKey);
              }

              rememberEndpointRequirements(input, output, runAttemptState);
              runAttemptState.probedEndpoints.add(endpointKey);

              return output;
            },
          }),
      }),
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: generateId,
    onFinish: async ({ responseMessage }) => {
      await saveMessage(conversationId, responseMessage as UIMessage);
    },
    onError: (error) => {
      console.error("[chat stream onError]", error);

      if (error instanceof Error) {
        if (error.stack) {
          console.error(error.stack);
        }
        return error.message;
      }

      try {
        const serialized = JSON.stringify(error);
        if (serialized) {
          return serialized.length > 200
            ? `${serialized.slice(0, 200)}…`
            : serialized;
        }
      } catch {
        // fall through to generic message
      }

      return "The assistant hit an unexpected error.";
    },
  });
}

async function runTrackedTool({
  conversationId,
  toolCallId,
  toolName,
  input,
  api,
  path,
  prompt,
  execute,
}: {
  conversationId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  api: string | null;
  path: string | null;
  prompt: string | null;
  execute: () => Promise<unknown>;
}) {
  const startedAt = performance.now();

  try {
    const output = await execute();
    const durationMs = Math.round(performance.now() - startedAt);
    const outputRecord = isRecord(output) ? output : {};

    if (conversationId) {
      await saveToolCall({
        conversation_id: conversationId,
        message_id: null,
        tool_call_id: toolCallId,
        tool_name: toolName,
        input,
        output,
        status: "success",
        duration_ms: durationMs,
      });

      if (outputRecord.notCalled !== true) {
        await saveOrthogonalResult({
          conversation_id: conversationId,
          tool_call_id: toolCallId,
          api,
          path,
          prompt,
          request: input,
          response: outputRecord.raw ?? output,
          status: outputRecord.isError === true ? "error" : "success",
          price: outputRecord.price as string | number | null | undefined,
          request_id: outputRecord.requestId as string | null | undefined,
        });
      }
    }

    return output;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : "Tool failed.";

    if (conversationId) {
      await saveToolCall({
        conversation_id: conversationId,
        message_id: null,
        tool_call_id: toolCallId,
        tool_name: toolName,
        input,
        output: null,
        status: "error",
        error: message,
        duration_ms: durationMs,
      });

      await saveOrthogonalResult({
        conversation_id: conversationId,
        tool_call_id: toolCallId,
        api,
        path,
        prompt,
        request: input,
        response: { error: message },
        status: "error",
      });
    }

    return {
      success: false,
      isError: true,
      error: message,
      hint: "Tell the user the call failed. If it looks like a bad identifier, run one more searchWeb and re-present Step 3 yourself.",
    };
  }
}

function getRunReadinessBlock(
  input: {
    api: string;
    path: string;
    query?: Record<string, string | number | boolean | null>;
    body?: unknown;
  },
  state: RunAttemptState,
) {
  const endpointKey = getEndpointKey(input);

  const schemaKnown =
    state.endpointRequirements.has(endpointKey) ||
    state.endpointsKnownToAcceptEmpty.has(endpointKey) ||
    state.probedEndpoints.has(endpointKey);

  if (!schemaKnown) {
    return buildNotCalledResult({
      input,
      reason:
        "this endpoint has not been probed yet in this conversation. Call describeOrthogonalEndpoint(api, path) once before runOrthogonalApi — it is a free probe and its errorDetail lists any required fields. If the probe already ran but returned no errorDetail, proceed with the call you planned and surface whatever the upstream says",
      missingFields: [],
    });
  }

  if (state.validationFailures.has(endpointKey)) {
    return buildNotCalledResult({
      input,
      reason:
        "a validation error already occurred for this endpoint in this response",
      missingFields: getRequirementFieldNames(
        state.endpointRequirements.get(endpointKey),
      ),
    });
  }

  const requiredFields = state.endpointRequirements.get(endpointKey) ?? [];
  const schemaProblems = getSchemaProblems(input, requiredFields);

  if (schemaProblems.length > 0) {
    return buildNotCalledResult({
      input,
      reason: `required endpoint fields are missing or invalid: ${schemaProblems.join(", ")}`,
      missingFields: schemaProblems,
    });
  }

  if (isContactOrEmailRun(input) && !hasNonEmptyObject(input.body) && !hasNonEmptyObject(input.query)) {
    return buildNotCalledResult({
      input,
      reason:
        "contact/email endpoints need structured identifiers before calling",
      missingFields: ["body or query with name, company, domain, email, or LinkedIn URL"],
    });
  }

  const budgetBlock = getPaidCallBudgetBlock(input, state);

  if (budgetBlock) {
    return budgetBlock;
  }

  return null;
}

function getPaidCallBudgetBlock(
  input: { api: string; path: string },
  state: RunAttemptState,
) {
  if (state.runOrthogonalCalls >= state.runOrthogonalLimit) {
    return buildNotCalledResult({
      input,
      reason: "the one-call safety budget is already used for this response",
      missingFields: [],
    });
  }

  return null;
}

function rememberRunOutcome(
  input: { api: string; path: string },
  output: unknown,
  state: RunAttemptState,
) {
  if (!isRecord(output)) {
    return;
  }

  const detail = readValidationDetail(output);

  if (output.isValidationError === true || detail.length > 0) {
    const endpointKey = getEndpointKey(input);

    state.validationFailures.add(endpointKey);

    if (detail.length > 0) {
      state.endpointRequirements.set(endpointKey, detail);
    }
  }
}

function rememberEndpointRequirements(
  input: { api: string; path: string },
  output: unknown,
  state: RunAttemptState,
) {
  if (!isRecord(output)) {
    return;
  }

  const detail = readValidationDetail(output);

  if (detail.length > 0) {
    state.endpointRequirements.set(getEndpointKey(input), detail);
  }
}

function hydrateRunAttemptStateFromHistory(
  messages: UIMessage[],
  state: RunAttemptState,
) {
  for (const message of messages) {
    if (!message.parts) continue;

    for (const part of message.parts) {
      const partType = (part as { type?: string }).type;

      if (
        partType !== "tool-describeOrthogonalEndpoint" &&
        partType !== "tool-runOrthogonalApi"
      ) {
        continue;
      }

      const input = (part as { input?: unknown }).input;
      const output = (part as { output?: unknown }).output;

      if (!isRecord(input) || !isRecord(output)) continue;
      if (output.notCalled === true) continue;

      const api = typeof input.api === "string" ? input.api : null;
      const path = typeof input.path === "string" ? input.path : null;

      if (!api || !path) continue;

      const endpointInput = { api, path };

      rememberEndpointRequirements(endpointInput, output, state);

      if (partType === "tool-describeOrthogonalEndpoint") {
        state.probedEndpoints.add(getEndpointKey(endpointInput));

        if (output.acceptsEmpty === true) {
          state.endpointsKnownToAcceptEmpty.add(getEndpointKey(endpointInput));
        }
      }
    }
  }
}

function buildNotCalledResult({
  input,
  reason,
  missingFields,
}: {
  input: { api: string; path: string };
  reason: string;
  missingFields: string[];
}) {
  const summary = `Not called: ${reason}.`;

  return {
    success: false,
    notCalled: true,
    blocked: true,
    isError: false,
    isValidationError: false,
    isEmpty: false,
    api: input.api,
    path: input.path,
    requestId: null,
    price: null,
    mayHaveCharged: false,
    missingFields,
    blockedReason: reason,
    summary,
    nextStepHint:
      "If the block was the confirmation gate, write a fresh Step 3 confirmation message containing the endpoint path and the word 'Confirm' and stop. If identifiers are missing, run searchWeb to derive them before re-presenting Step 3 — do not ask the user.",
    raw: {
      notCalled: true,
      reason,
      missingFields,
    },
  };
}

function getEndpointKey(input: { api: string; path: string }) {
  return `${input.api}:${input.path}`;
}

function isContactOrEmailRun(input: { api: string; path: string; body?: unknown; query?: unknown }) {
  const text = `${input.api} ${input.path} ${formatForInspection(input.body)} ${formatForInspection(input.query)}`.toLowerCase();

  return (
    text.includes("email") ||
    text.includes("contact") ||
    text.includes("people") ||
    text.includes("person") ||
    text.includes("lead") ||
    text.includes("apollo") ||
    text.includes("sixtyfour")
  );
}

function hasNonEmptyObject(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).some(hasMeaningfulValue);
}

function hasMeaningfulValue(value: unknown): boolean {
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
    return value.some(hasMeaningfulValue);
  }

  if (isRecord(value)) {
    return Object.values(value).some(hasMeaningfulValue);
  }

  return false;
}

function getSchemaProblems(
  input: { body?: unknown; query?: unknown },
  requirements: ValidationDetail[],
) {
  const problems: string[] = [];
  const requestShape = {
    body: input.body,
    query: input.query,
  };

  for (const requirement of requirements) {
    if (!requirement.field || requirement.field === "(unspecified)") {
      continue;
    }

    const value = getValueAtPath(requestShape, requirement.field);

    if (!matchesValidationRequirement(value, requirement.type)) {
      problems.push(`${requirement.field} (${requirement.type || "required"})`);
    }
  }

  return problems;
}

function matchesValidationRequirement(value: unknown, type: string) {
  if (!hasMeaningfulValue(value)) {
    return false;
  }

  if (type.includes("dict") || type.includes("object")) {
    return isRecord(value);
  }

  if (type.includes("list") || type.includes("array")) {
    return Array.isArray(value);
  }

  if (type.includes("string") || type.includes("str")) {
    return typeof value === "string" && value.trim().length > 0;
  }

  if (type.includes("int") || type.includes("float") || type.includes("number")) {
    return typeof value === "number";
  }

  if (type.includes("bool")) {
    return typeof value === "boolean";
  }

  return true;
}

function getValueAtPath(value: unknown, path: string) {
  const parts = path.split(".").filter(Boolean);
  let current = value;

  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function readValidationDetail(value: Record<string, unknown>) {
  if (!Array.isArray(value.errorDetail)) {
    return [];
  }

  return value.errorDetail.flatMap((entry): ValidationDetail[] => {
    if (!isRecord(entry) || typeof entry.field !== "string") {
      return [];
    }

    return [
      {
        field: entry.field,
        type: typeof entry.type === "string" ? entry.type : "required",
        msg: typeof entry.msg === "string" ? entry.msg : undefined,
      },
    ];
  });
}

function getRequirementFieldNames(requirements: ValidationDetail[] | undefined) {
  return requirements?.map((requirement) => requirement.field) ?? [];
}

function getLastAssistantText(messages: UIMessage[]) {
  const latestUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        return i;
      }
    }
    return messages.length;
  })();

  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      return getMessageText(messages[i]);
    }
  }

  return "";
}

function userMessageReadsAsDecline(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return false;
  }

  // Standalone decline messages: "no", "no.", "stop!", "wait", "nevermind"
  if (/^(no|cancel|stop|wait|nevermind|don'?t|do not)\b[.,!?\s]*$/i.test(trimmed)) {
    return true;
  }

  // Messages that lead with a decline followed by elaboration: "no thanks",
  // "don't run that", "stop, use the other one". "wait" is excluded here
  // because it commonly appears as a clarifier ("wait, also include X").
  if (/^(no|cancel|stop|nevermind|don'?t|do not)[\s,.!?-]/i.test(trimmed)) {
    return true;
  }

  return false;
}

function getConfirmationGateBlock(
  input: { api: string; path: string },
  lastAssistantText: string,
  userDeclined: boolean,
) {
  if (userDeclined) {
    return buildNotCalledResult({
      input,
      reason:
        "the latest user message reads as a decline or hesitation. Ask the user what to change before calling again",
      missingFields: [],
    });
  }

  const path = (input.path ?? "").trim();
  const hasPath = path.length > 0 && lastAssistantText.includes(path);
  const hasConfirmToken = /\bconfirm\b/i.test(lastAssistantText);

  if (!hasPath || !hasConfirmToken) {
    return buildNotCalledResult({
      input,
      reason: `confirmation gate not satisfied: your previous assistant message did not present path=${input.path} with the word "confirm". Write a Step 3 message naming the provider slug, endpoint path, full body/query JSON, and ending with "Confirm to proceed?", then stop.`,
      missingFields: [],
    });
  }

  return null;
}

function getMessageText(message: UIMessage | undefined) {
  if (!message?.parts) {
    return "";
  }

  return message.parts
    .map((part) => {
      const text = "text" in part ? part.text : null;

      return typeof text === "string" ? text : "";
    })
    .join(" ");
}

function userExplicitlyRequestedRetry(text: string) {
  return /\b(retry|try again|rerun|run again|call it again)\b/i.test(text);
}

function formatForInspection(value: unknown) {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
