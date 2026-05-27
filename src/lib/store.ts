import type { UIMessage } from "ai";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getTextFromParts,
  type Conversation,
  type OrthogonalResultRecord,
  type StoredMessage,
  type ToolCallRecord,
} from "@/lib/types";

const DEFAULT_TITLE = "New research chat";

export async function listConversations(userId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data as Conversation[];
}

export async function createConversation(userId: string, title = DEFAULT_TITLE) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return {
      id: crypto.randomUUID(),
      user_id: userId,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies Conversation;
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as Conversation;
}

export async function getConversation(conversationId: string, userId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();

  if (error) {
    throw error;
  }

  return data as Conversation;
}

export async function getConversationMessages(
  conversationId: string,
  userId: string,
) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return [];
  }

  await getConversation(conversationId, userId);

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data as StoredMessage[];
}

export async function saveMessage(
  conversationId: string | undefined,
  message: UIMessage,
) {
  if (!conversationId) {
    return;
  }

  if (!message.id) {
    throw new Error("Refusing to save message without id");
  }

  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const content = getTextFromParts(message.parts);

  const { error } = await supabase.from("messages").upsert(
    {
      id: message.id,
      conversation_id: conversationId,
      role: message.role,
      parts: message.parts,
      content,
    },
    { onConflict: "id" },
  );

  if (error) {
    throw error;
  }

  await touchConversation(conversationId);
  await maybeUpdateConversationTitle(conversationId, content);
}

export async function saveToolCall(record: ToolCallRecord) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.from("tool_calls").insert(record);

  if (error) {
    throw error;
  }
}

export async function saveOrthogonalResult(record: OrthogonalResultRecord) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const { error } = await supabase
    .from("orthogonal_api_results")
    .insert(record);

  if (error) {
    throw error;
  }
}

async function touchConversation(conversationId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

async function maybeUpdateConversationTitle(
  conversationId: string,
  firstMessageText: string,
) {
  const supabase = getSupabaseAdmin();

  if (!supabase || !firstMessageText) {
    return;
  }

  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .limit(2);

  if (data?.length !== 1) {
    return;
  }

  const title =
    firstMessageText.length > 56
      ? `${firstMessageText.slice(0, 53)}...`
      : firstMessageText;

  await supabase
    .from("conversations")
    .update({ title })
    .eq("id", conversationId);
}
