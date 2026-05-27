import type { UIMessage } from "ai";

export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type StoredMessage = {
  id: string;
  conversation_id: string;
  role: UIMessage["role"];
  parts: UIMessage["parts"];
  content: string;
  created_at: string;
};

export type ToolCallRecord = {
  id?: string;
  conversation_id: string;
  message_id?: string | null;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  output?: unknown;
  status: "success" | "error";
  error?: string | null;
  duration_ms?: number | null;
};

export type OrthogonalResultRecord = {
  conversation_id: string;
  tool_call_id: string;
  api?: string | null;
  path?: string | null;
  prompt?: string | null;
  request: unknown;
  response: unknown;
  status: "success" | "error";
  price?: string | number | null;
  request_id?: string | null;
};

export type ChatRequestBody = {
  messages: UIMessage[];
  conversationId?: string;
  userId?: string;
};

export function getTextFromParts(parts: UIMessage["parts"]) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
