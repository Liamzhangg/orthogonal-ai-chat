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
  };

  if (latestUserMessage) {
    await saveMessage(conversationId, latestUserMessage);
  }

  const modelMessages = await convertToModelMessages(
    messages.slice(-RECENT_MESSAGE_LIMIT),
  );

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: [
      "You are a focused AI research assistant for go-to-market data.",
      "You operate in a strict confirmation-gated workflow before any paid Orthogonal provider call. searchOrthogonalCatalog and searchWeb are free helpers and may run without asking the user. Every other Orthogonal tool (runOrthogonalApi, enrichCompany, describeOrthogonalEndpoint) requires the user to first pick a provider and then confirm the inputs. Process one provider+endpoint per turn. If the user asks for two people or two enrichments, present a plan for the first one, run it after confirmation, then move to the second on a later turn.",
      "Follow this 7-step protocol on every data-fetching request:",
      "Step 1 (Discover): Call searchOrthogonalCatalog once with a prompt describing the user's intent. Do this autonomously; do not ask permission.",
      "Step 2 (Augment): If you need background facts or identifiers (company domain, full name, LinkedIn URL, etc.) to describe the options or build a future call, call searchWeb autonomously. Tell the user in one short line what you are checking. Do not call paid provider tools yet.",
      "Step 3 (Present and ask which API): Write a brief markdown shortlist of the 2-4 best catalog matches. For each item include: provider name as a markdown link to its baseUrl (for example, ## 1. [Sixtyfour API](https://api.sixtyfour.ai)), endpoint path, one-line description, the inputs you believe it needs (best-effort inferred from the description), and the price if shown. End the message with a direct question like 'Which one should I use?'. Do NOT call any tool in this turn. The turn ends here, awaiting the user's choice.",
      "Step 4 (Gather inputs): Once the user has picked a provider/endpoint, derive missing inputs from prior conversation context or one searchWeb call. Do not call paid provider tools yet.",
      "Step 5 (Confirm inputs): Write the exact planned call back to the user: the provider slug, the literal endpoint path (for example /find-email), the full body/query JSON you intend to send, and the expected price from the catalog. End with a direct question like 'Confirm to proceed?'. Your Step 5 message MUST contain the literal endpoint path and the word 'Confirm'. The app inspects your previous assistant message for these two tokens before allowing the paid call; if they are missing the tool returns notCalled=true with a confirmation-gate error and your money is not spent. Do NOT call any tool in this turn. The turn ends here.",
      "Step 6 (Execute): Only when the latest user message reads as a confirmation, call runOrthogonalApi (or enrichCompany if the user picked the company-enrich domain enricher) exactly once with the confirmed inputs. Use describeOrthogonalEndpoint in this step only if the catalog description was too vague to infer the body shape AND you have not yet made any paid call this turn; note that doing so consumes the one paid call budget for this turn. If you receive notCalled with blockedReason mentioning the confirmation gate, do NOT retry the tool. Stop tool use, write a Step 5 confirmation message that names the path and the word 'Confirm', and wait for the user.",
      "Step 7 (Report): After the call returns, cite the provider slug, endpoint path, requestId, and price (or cost). If the result has isError, isValidationError, isEmpty, or notCalled set to true, explain what was missing or wrong and ask the user how to proceed: adjust inputs (go back to step 5) or pick a different provider (go back to step 3). Never auto-retry without explicit user confirmation.",
      "State recovery: Before any tool call or text reply, read the conversation history to determine which protocol step you are on. If your previous assistant message presented options and asked which to use, the next user message is a provider selection - move to Step 4, not Step 6. If your previous assistant message stated a planned call body and asked to confirm (containing the path and the word 'Confirm'), the next user message is a confirmation (or rejection) - then and only then move to Step 6. Even when the user names a specific provider in their message (for example 'try sixtyfour' or 'use apollo'), treat that as a Step 3 selection. You still must proceed through Step 4 (Gather inputs) and Step 5 (Confirm inputs) before calling any paid tool. Never skip Step 5.",
      "Exceptions: If the user asks a purely conversational question that needs no data fetch, skip the protocol and answer directly. If searchOrthogonalCatalog returns zero useful matches, tell the user honestly and ask for clarification instead of inventing a call.",
      "When listing API providers in step 3, make each provider heading a markdown link to its base URL, like ## 2. [Apollo API](https://api.apollo.io). Do not add a separate Base URL bullet when the heading already links to the base URL. Write Endpoints: as plain text, then put endpoint entries as indented bullets below it.",
      "Do not invent data. If a tool returns no useful data, say so clearly. Keep answers concise.",
    ].join(" "),
    messages: modelMessages,
    stopWhen: stepCountIs(10),
    tools: {
      searchOrthogonalCatalog: tool({
        description:
          "Step 1 (Discover) of the gated workflow. Search Orthogonal's API catalog for providers/endpoints that can answer the user's request. Free helper - run autonomously without asking permission. Results will be summarized to the user in step 3 for them to choose a provider.",
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
          "Step 2 (Augment) or step 4 (Gather inputs) of the gated workflow. Search the web through Orthogonal for current news, websites, company facts, people, leadership, or public web results. Free helper - run autonomously to gather background or derive missing identifiers (such as a company domain or LinkedIn URL). Tell the user in one short line what you are checking. Do NOT use this to make the user's primary paid call.",
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
          "Step 6 (Execute) of the gated workflow when the user selected the company-enrich domain enricher. Paid provider call. Only invoke after the user has selected this option in step 3 and confirmed the exact domain in step 5. If you have not yet completed those gates, present the option to the user first and wait for confirmation.",
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
          "Step 6 (Execute) of the gated workflow. Paid provider call. Only invoke after BOTH gates have been cleared: the user selected this exact api/path in step 3, and the user confirmed the body/query in step 5. If you are uncertain whether the user has confirmed in the most recent message, do not call - ask again in plain text instead. The app enforces a one-call-per-turn budget and may return notCalled if state suggests the call is unsafe. On isError, isValidationError, isEmpty, or notCalled: explain to the user what went wrong and return to step 5 (different inputs) or step 3 (different provider). Never auto-retry without a fresh user confirmation.",
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
          "Optional schema probe for step 6 (Execute) of the gated workflow. Paid call that consumes the same one-paid-call-per-turn budget as runOrthogonalApi. Use only when the catalog description from step 1 is too vague to infer the body/query shape AND the user has already cleared both gates (selected the provider in step 3 and confirmed inputs in step 5). Prefer to skip this and let an attempted runOrthogonalApi error guide a corrected retry on the next turn. Returns errorDetail (array of {field, type, msg}) listing required fields when the upstream validates inputs, or acceptsEmpty=true plus a sampleResponse when the endpoint runs on empty input.",
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
              const gateBlock = getConfirmationGateBlock(
                input,
                lastAssistantText,
                userDeclined,
              );

              if (gateBlock) {
                return gateBlock;
              }

              const blocked = getPaidCallBudgetBlock(input, runAttemptState);

              if (blocked) {
                return blocked;
              }

              runAttemptState.runOrthogonalCalls += 1;
              const output = await describeOrthogonalEndpoint(
                input,
                options.abortSignal,
              );
              rememberEndpointRequirements(input, output, runAttemptState);

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
    onError: (error) =>
      error instanceof Error
        ? error.message
        : "The assistant hit an unexpected error.",
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
      hint: "Tell the user the Orthogonal call failed and suggest a retry or a narrower query.",
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
      "Ask the user for the missing identifiers or confirm a corrected request before making another Orthogonal call.",
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
  return /\b(no|cancel|stop|wait|nevermind|don'?t|do not)\b/i.test(text);
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
      reason: `confirmation gate not satisfied: your previous assistant message did not present this call (path=${input.path}) with the word "confirm". Write a Step 5 message that names the provider slug, endpoint path, the full body/query JSON, and ends with "Confirm to proceed?", then wait for the user`,
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
