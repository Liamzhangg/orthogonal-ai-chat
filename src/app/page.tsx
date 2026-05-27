"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  Search,
  Send,
  Square,
} from "lucide-react";
import type { Conversation, StoredMessage } from "@/lib/types";

const USER_ID_STORAGE_KEY = "orthogonal-chat-user-id";
const chatTransport = new DefaultChatTransport({
  api: "/api/chat",
});

type ToolPart = {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type BulletItem = {
  text: string;
  children: string[];
};

type ScrollMode = "history-load" | "new-message" | "streaming" | "idle";
type ToolStateKind = "running" | "done" | "error" | "skipped";

const SUGGESTED_PROMPTS = [
  {
    label: "Company brief",
    hint: "Profile a company with funding, people, and recent news.",
    prompt: "Give me a brief on Anthropic — funding, founders, and recent news.",
  },
  {
    label: "Contact lookup",
    hint: "Surface email and role for a person at a target company.",
    prompt: "Find the work email for the head of engineering at Linear.",
  },
  {
    label: "Web research",
    hint: "Fresh web results synthesized into a short answer.",
    prompt: "Summarize recent reporting on the EU AI Act implementation.",
  },
];

export default function Home() {
  const [input, setInput] = useState("");
  const [userId] = useState(getOrCreateUserId);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollModeRef = useRef<ScrollMode>("idle");

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    clearError,
  } = useChat({
    transport: chatTransport,
    onFinish: () => {
      void refreshConversations(userId);
    },
  });

  const isWorking = status === "submitted" || status === "streaming";

  const refreshConversations = useCallback(async (currentUserId: string) => {
    if (!currentUserId) {
      return;
    }

    try {
      const response = await fetch(
        `/api/conversations?userId=${encodeURIComponent(currentUserId)}`,
      );
      const data = (await response.json()) as {
        conversations?: Conversation[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load conversations.");
      }

      setConversations(data.conversations ?? []);
      setHistoryError("");
    } catch (loadError) {
      setHistoryError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load conversations.",
      );
    }
  }, []);

  useEffect(() => {
    void refreshConversations(userId);
  }, [refreshConversations, userId]);

  useEffect(() => {
    if (isWorking) {
      scrollModeRef.current = "streaming";
    }

    const scrollMode = scrollModeRef.current;

    if (scrollMode === "idle") {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: scrollMode === "history-load" ? "auto" : "smooth",
    });

    if (scrollMode === "history-load" || scrollMode === "new-message") {
      scrollModeRef.current = "idle";
    }
  }, [isWorking, messages]);

  function startNewChat() {
    scrollModeRef.current = "idle";
    setActiveConversationId("");
    setMessages([]);
    setInput("");
    clearError();
  }

  async function createConversation() {
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        title: "New research chat",
      }),
    });
    const data = (await response.json()) as {
      conversation?: Conversation;
      error?: string;
    };

    if (!response.ok || !data.conversation) {
      throw new Error(data.error ?? "Could not create conversation.");
    }

    setActiveConversationId(data.conversation.id);
    setConversations((current) => [data.conversation!, ...current]);
    setHistoryError("");

    return data.conversation.id;
  }

  async function ensureConversation() {
    if (activeConversationId) {
      return activeConversationId;
    }

    return createConversation();
  }

  async function loadConversation(conversationId: string) {
    if (!userId) {
      return;
    }

    setIsLoadingConversation(true);
    scrollModeRef.current = "history-load";
    clearError();

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}?userId=${encodeURIComponent(
          userId,
        )}`,
      );
      const data = (await response.json()) as {
        conversation?: Conversation;
        messages?: StoredMessage[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not load conversation.");
      }

      setActiveConversationId(conversationId);
      setMessages((data.messages ?? []).map(toUIMessage));
      setHistoryError("");
    } catch (loadError) {
      setHistoryError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load conversation.",
      );
    } finally {
      setIsLoadingConversation(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedInput = input.trim();

    if (!trimmedInput || isWorking || !userId) {
      return;
    }

    clearError();
    scrollModeRef.current = "new-message";
    const conversationId = await ensureConversation();
    setInput("");
    await sendMessage(
      { text: trimmedInput },
      { body: { conversationId, userId } },
    );
  }

  const groupedConversations = useMemo(
    () => groupConversations(filterConversations(conversations, searchQuery)),
    [conversations, searchQuery],
  );
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId],
  );

  return (
    <main className="relative flex h-dvh overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex h-dvh w-[280px] flex-col overflow-hidden border-r border-[var(--hairline)] bg-[var(--paper-soft)]/85 backdrop-blur-xl transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] lg:static lg:translate-x-0 ${
          isSidebarOpen
            ? "translate-x-0"
            : "-translate-x-full lg:w-0 lg:border-r-0"
        }`}
        aria-label="Conversation history"
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/orthogonal-mark.svg"
              alt=""
              className="size-8 shrink-0 rounded-lg"
            />
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
              Orthogonal Chat
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="grid size-9 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--hairline)]/60 hover:text-[var(--ink)]"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <div className="space-y-2 px-3">
          <button
            type="button"
            onClick={startNewChat}
            className="group flex h-10 w-full items-center gap-2.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--ink)] shadow-[0_1px_0_rgba(0,0,0,0.03)] transition hover:border-[var(--hairline-strong)] hover:shadow-[0_4px_18px_-12px_rgba(0,0,0,0.18)]"
          >
            <MessageSquarePlus className="size-3.5 text-[var(--muted)] transition group-hover:text-[var(--ink)]" />
            New chat
          </button>

          <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-transparent bg-[var(--hairline)]/40 px-3 text-[13px] text-[var(--muted)] transition focus-within:border-[var(--hairline-strong)] focus-within:bg-[var(--surface)]">
            <Search className="size-3.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search chats"
              className="flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </label>
        </div>

        <div className="scrollbar-fine mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {historyError ? (
            <div className="m-2 rounded-lg border border-[var(--warm-warning-border)] bg-[var(--warm-warning-bg)] p-2.5 text-[12px] leading-5 text-[var(--warm-warning-ink)]">
              {historyError}
            </div>
          ) : null}

          {groupedConversations.length === 0 ? (
            <p className="px-3 py-5 text-[13px] leading-6 text-[var(--muted)]">
              {searchQuery.trim()
                ? "No chats match that search."
                : "Start a conversation and it will appear here."}
            </p>
          ) : (
            <div className="space-y-5">
              {groupedConversations.map(([groupName, items]) => (
                <div key={groupName} className="space-y-0.5">
                  <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--muted)]">
                    {groupName}
                  </p>
                  {items.map((conversation) => {
                    const isActive =
                      conversation.id === activeConversationId;
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => void loadConversation(conversation.id)}
                        className={`group relative flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] leading-5 transition-colors duration-150 ${
                          isActive
                            ? "bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_0_rgba(0,0,0,0.04)]"
                            : "text-[var(--ink-soft)] hover:bg-[var(--surface)]/60 hover:text-[var(--ink)]"
                        }`}
                      >
                        {isActive ? (
                          <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-[var(--accent)]" />
                        ) : null}
                        <span className="line-clamp-2">
                          {conversation.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--hairline)] px-5 py-3">
          <p className="text-[11px] leading-5 text-[var(--muted)]">
            Live data via the Orthogonal API catalog.
          </p>
        </div>
      </aside>

      {isSidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar overlay"
          className="animate-fade fixed inset-0 z-20 bg-[var(--ink)]/20 backdrop-blur-sm lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}

      <section className="relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper)]">
        <header className="flex h-14 shrink-0 items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen((open) => !open)}
              className="grid size-9 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--hairline)]/60 hover:text-[var(--ink)]"
              aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <Menu className="size-4" />
            </button>
            {activeConversation ? (
              <span className="hidden truncate text-[13px] text-[var(--ink-soft)] sm:inline">
                {activeConversation.title}
              </span>
            ) : null}
          </div>
        </header>

        <div
          ref={scrollContainerRef}
          className="scrollbar-fine min-h-0 flex-1 overflow-y-auto px-5"
        >
          <div
            className={`mx-auto flex min-h-full w-full max-w-[44rem] flex-col ${
              messages.length === 0 ? "justify-center" : "gap-8 py-10"
            }`}
          >
            {isLoadingConversation ? (
              <div className="animate-fade flex items-center gap-2 text-[13px] text-[var(--muted)]">
                <Loader2 className="size-3.5 animate-spin" />
                Loading conversation
              </div>
            ) : null}

            {messages.length === 0 && !isLoadingConversation ? (
              <EmptyState
                input={input}
                isWorking={isWorking}
                userId={userId}
                onInputChange={setInput}
                onPick={setInput}
                onSubmit={handleSubmit}
                onStop={stop}
              />
            ) : null}

            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}

            {isWorking ? <ThinkingIndicator /> : null}

            {error ? (
              <div className="animate-rise flex items-start gap-2.5 rounded-xl border border-[var(--warm-warning-border)] bg-[var(--warm-warning-bg)] p-3 text-[13px] leading-6 text-[var(--warm-warning-ink)]">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error.message}</span>
              </div>
            ) : null}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {messages.length > 0 ? (
          <div className="shrink-0 bg-gradient-to-t from-[var(--paper)] via-[var(--paper)]/95 to-transparent px-5 pb-5 pt-4">
            <div className="mx-auto w-full max-w-[44rem]">
              <Composer
                input={input}
                isWorking={isWorking}
                userId={userId}
                onInputChange={setInput}
                onSubmit={handleSubmit}
                onStop={stop}
              />
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function EmptyState({
  input,
  isWorking,
  userId,
  onInputChange,
  onPick,
  onSubmit,
  onStop,
}: {
  input: string;
  isWorking: boolean;
  userId: string;
  onInputChange: (value: string) => void;
  onPick: (prompt: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => Promise<void>;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[36rem] flex-col items-center gap-8 pb-12">
      <div className="space-y-3 text-center">
        <h1
          className="animate-rise text-[40px] font-medium leading-[1.05] tracking-[-0.02em] text-[var(--ink)] sm:text-[48px]"
          style={{ animationDelay: "0ms" }}
        >
          What are we
          <br />
          looking into?
        </h1>
        <p
          className="animate-rise text-[14px] leading-6 text-[var(--muted)]"
          style={{ animationDelay: "80ms" }}
        >
          Ask anything.
        </p>
      </div>

      <div
        className="animate-rise w-full"
        style={{ animationDelay: "180ms" }}
      >
        <Composer
          input={input}
          isWorking={isWorking}
          userId={userId}
          onInputChange={onInputChange}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </div>

      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
        {SUGGESTED_PROMPTS.map((prompt, index) => (
          <button
            key={prompt.label}
            type="button"
            onClick={() => onPick(prompt.prompt)}
            className="animate-rise group flex flex-col items-start gap-1.5 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-[var(--hairline-strong)] hover:shadow-[0_10px_28px_-16px_rgba(0,0,0,0.18)]"
            style={{ animationDelay: `${260 + index * 60}ms` }}
          >
            <span className="text-[13px] font-medium text-[var(--ink)]">
              {prompt.label}
            </span>
            <span className="text-[12px] leading-5 text-[var(--muted)]">
              {prompt.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  input,
  isWorking,
  userId,
  onInputChange,
  onSubmit,
  onStop,
}: {
  input: string;
  isWorking: boolean;
  userId: string;
  onInputChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => Promise<void>;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const hasInput = input.trim().length > 0;

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className={`group mx-auto flex w-full items-center gap-2 rounded-[20px] border bg-[var(--surface)] p-2 pl-4 transition-all duration-200 ease-out ${
        isFocused
          ? "border-[var(--ink)]/30 shadow-[0_10px_36px_-14px_rgba(0,0,0,0.22)]"
          : "border-[var(--hairline)] shadow-[0_2px_10px_-4px_rgba(0,0,0,0.06)]"
      }`}
    >
      <label className="sr-only" htmlFor="chat-input">
        Message
      </label>
      <textarea
        id="chat-input"
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Ask Orthogonal anything…"
        className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted-soft)]"
        rows={1}
      />
      {isWorking ? (
        <button
          type="button"
          onClick={() => void onStop()}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-[var(--paper)] transition hover:bg-[var(--ink-soft)]"
          aria-label="Stop response"
          title="Stop response"
        >
          <Square className="size-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!hasInput || !userId}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-[var(--paper)] transition duration-200 hover:bg-[var(--ink-soft)] disabled:cursor-not-allowed disabled:bg-[var(--hairline-strong)] disabled:text-[var(--muted)]"
          aria-label="Send message"
          title="Send message"
        >
          <Send className="size-3.5" />
        </button>
      )}
    </form>
  );
}

function ThinkingIndicator() {
  return (
    <div className="animate-fade flex items-center gap-2 pl-1 text-[13px] text-[var(--muted)]">
      <span className="flex items-center gap-1">
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-[var(--ink)]/45" />
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-[var(--ink)]/45" />
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-[var(--ink)]/45" />
      </span>
      <span className="ml-1">Thinking</span>
    </div>
  );
}

function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <article
      className={`animate-rise flex ${
        isUser ? "justify-end" : "justify-start"
      }`}
      aria-label={`${message.role} message`}
    >
      <div
        className={
          isUser
            ? "max-w-[min(36rem,88vw)] rounded-[18px] rounded-br-md bg-[var(--ink)] px-4 py-2.5 text-[14.5px] leading-6 text-[var(--paper)]"
            : "w-full max-w-[min(44rem,92vw)] text-[15px] leading-7 text-[var(--ink-soft)]"
        }
      >
        <div className={isUser ? "" : "space-y-4"}>
          {message.parts.map((part, index) => {
            if (part.type === "text") {
              return (
                <MarkdownContent
                  key={`${message.id}-text-${index}`}
                  text={part.text}
                  compact={isUser}
                />
              );
            }

            if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
              return (
                <ToolResult
                  key={`${message.id}-tool-${index}`}
                  part={part as ToolPart}
                />
              );
            }

            return null;
          })}
        </div>
      </div>
    </article>
  );
}

function ToolResult({ part }: { part: ToolPart }) {
  const toolName = getToolName(part);
  const label = getToolLabel(toolName);
  const stateLabel = getToolStateLabel(part);
  const preview = getToolResultPreview(part);
  const stateKind = getToolStateKind(part);

  const statePillClasses =
    stateKind === "error"
      ? "text-[var(--warm-warning-ink)] bg-[var(--warm-warning-bg)]"
      : stateKind === "running"
        ? "text-[var(--accent)] bg-[var(--accent)]/8"
        : stateKind === "skipped"
          ? "text-[var(--muted)] bg-[var(--hairline)]/60"
          : "text-[var(--ink-soft)] bg-[var(--hairline)]/60";

  return (
    <div className="animate-fade relative pl-5 text-[13.5px] text-[var(--ink-soft)]">
      <div className="absolute bottom-2 left-0 top-2 w-px bg-[var(--hairline-strong)]" />
      <div
        className={`absolute left-[-3.5px] top-[10px] size-[8px] rounded-full ring-2 ring-[var(--paper)] ${
          stateKind === "running"
            ? "bg-[var(--accent)]"
            : stateKind === "error"
              ? "bg-[var(--warm-warning-ink)]"
              : "bg-[var(--ink-soft)]"
        }`}
      />
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Search className="size-3.5 shrink-0 text-[var(--muted)]" />
        <span className="text-[13px] text-[var(--ink-soft)]">{label}</span>
        <span
          className={`rounded-full px-2 py-[2px] text-[10.5px] font-medium uppercase tracking-[0.14em] ${statePillClasses}`}
        >
          {stateLabel}
        </span>
      </div>

      {preview ? (
        <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-[var(--muted)]">
          {preview}
        </p>
      ) : null}

      {part.errorText ? (
        <p className="mt-1.5 text-[13px] text-[var(--warm-warning-ink)]">
          {part.errorText}
        </p>
      ) : null}

      {part.input || part.output ? (
        <details className="mt-2 max-w-2xl overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface)] text-[12px] text-[var(--muted)]">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--ink-soft)] transition hover:bg-[var(--hairline)]/30">
            <ChevronRight className="size-3 shrink-0" />
            Inspect
          </summary>
          <div className="space-y-3 border-t border-[var(--hairline)] p-3">
            {part.input ? (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
                  Input
                </p>
                <pre className="scrollbar-fine mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--paper)] p-2.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.55] text-[var(--ink-soft)]">
                  {formatUnknown(part.input)}
                </pre>
              </div>
            ) : null}
            {part.output ? (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
                  Result
                </p>
                <pre className="scrollbar-fine mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--paper)] p-2.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.55] text-[var(--ink-soft)]">
                  {formatUnknown(part.output)}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MarkdownContent({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <p className="whitespace-pre-wrap">
        <InlineText text={stripInlineMarkdown(text)} />
      </p>
    );
  }

  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      const headingText = formatProviderPlanningHeading(
        trimmed.replace(/^###\s+/, ""),
      );

      blocks.push(
        <h3
          key={`h3-${index}`}
          className="mt-6 text-[15px] font-semibold leading-7 text-[var(--ink)]"
        >
          <InlineText text={headingText} />
        </h3>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      const headingText = formatProviderPlanningHeading(
        trimmed.replace(/^##\s+/, ""),
      );

      blocks.push(
        <h2
          key={`h2-${index}`}
          className="mt-6 text-[17px] font-semibold leading-7 text-[var(--ink)]"
        >
          <InlineText text={headingText} />
        </h2>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      const headingText = formatProviderPlanningHeading(
        trimmed.replace(/^#\s+/, ""),
      );

      blocks.push(
        <h2
          key={`h1-${index}`}
          className="mt-6 text-[18px] font-semibold leading-7 text-[var(--ink)]"
        >
          <InlineText text={headingText} />
        </h2>,
      );
      index += 1;
      continue;
    }

    if (isBulletLine(line)) {
      const list = parseBulletList(lines, index);

      blocks.push(<BulletList key={`ul-${index}`} items={list.items} />);
      index = list.nextIndex;
      continue;
    }

    if (isOrderedListLine(line)) {
      const list = parseOrderedList(lines, index);

      blocks.push(<OrderedList key={`ol-${index}`} items={list.items} />);
      index = list.nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];

    while (index < lines.length) {
      const current = lines[index].trim();

      if (
        !current ||
        current.startsWith("# ") ||
        current.startsWith("## ") ||
        current.startsWith("### ") ||
        isBulletLine(lines[index]) ||
        isOrderedListLine(lines[index])
      ) {
        break;
      }

      paragraphLines.push(current);
      index += 1;
    }

    blocks.push(
      <p key={`p-${index}`} className="my-2.5 text-[var(--ink-soft)]">
        <InlineText text={paragraphLines.join(" ")} />
      </p>,
    );
  }

  return <div className="space-y-1.5">{blocks}</div>;
}

function BulletList({ items }: { items: BulletItem[] }) {
  return (
    <ul className="my-3 list-disc space-y-1.5 pl-5 text-[var(--ink-soft)] marker:text-[var(--muted-soft)]">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`}>
          <InlineText text={item.text} />
          {item.children.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 marker:text-[var(--hairline-strong)]">
              {item.children.map((child, childIndex) => (
                <li key={`${child}-${childIndex}`}>
                  <InlineText text={child} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OrderedList({ items }: { items: BulletItem[] }) {
  return (
    <ol className="my-3 list-decimal space-y-2 pl-5 text-[var(--ink-soft)] marker:text-[var(--muted)]">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`} className="pl-1">
          <InlineText text={item.text} />
          {item.children.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 marker:text-[var(--hairline-strong)]">
              {item.children.map((child, childIndex) => (
                <li key={`${child}-${childIndex}`}>
                  <InlineText text={child} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function InlineText({ text }: { text: string }) {
  const parts = text
    .split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);

        if (link) {
          return (
            <a
              key={`${part}-${index}`}
              href={link[2]}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--accent)] decoration-[var(--muted-soft)] underline-offset-4 transition hover:text-[var(--ink)] hover:underline hover:decoration-[var(--accent)]"
              title={`Open ${link[2]}`}
            >
              {link[1]}
            </a>
          );
        }

        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={`${part}-${index}`}
              className="rounded-md bg-[var(--hairline)]/60 px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[0.88em] text-[var(--ink)]"
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong
              key={`${part}-${index}`}
              className="font-semibold text-[var(--ink)]"
            >
              <InlineText text={part.slice(2, -2)} />
            </strong>
          );
        }

        return <span key={`${part}-${index}`}>{part}</span>;
      })}
    </>
  );
}

function formatProviderPlanningHeading(text: string) {
  if (/^Planning to call:/i.test(text)) {
    return text;
  }

  const normalized = text.replace(/^\*\*([\s\S]+)\*\*$/, "$1").trim();
  const bareProviderLink = normalized.match(
    /^\[([^\]]*(?:API|Provider|Enrich)[^\]]*)\]\(https?:\/\/[^)\s]+\)$/,
  );

  if (!bareProviderLink) {
    return text;
  }

  return `Planning to call: ${normalized}`;
}

function isBulletLine(line?: string) {
  return Boolean(line && /^(\s*)[-*]\s+/.test(line));
}

function isOrderedListLine(line?: string) {
  return Boolean(line && /^(\s*)\d+\.\s+/.test(line));
}

function parseBulletList(lines: string[], startIndex: number) {
  const items: BulletItem[] = [];
  let index = startIndex;

  while (index < lines.length && isBulletLine(lines[index])) {
    const line = lines[index];
    const indent = getIndent(line);
    const text = line.trim().replace(/^[-*]\s+/, "");

    if (indent === 0 || items.length === 0) {
      items.push({ text, children: [] });
    } else {
      items[items.length - 1].children.push(text);
    }

    index += 1;
  }

  return {
    items,
    nextIndex: index,
  };
}

function parseOrderedList(lines: string[], startIndex: number) {
  const items: BulletItem[] = [];
  let index = startIndex;

  while (index < lines.length && isOrderedListLine(lines[index])) {
    const line = lines[index];
    const indent = getIndent(line);
    const text = line.trim().replace(/^\d+\.\s+/, "");
    const item: BulletItem = { text, children: [] };

    index += 1;

    while (
      index < lines.length &&
      isBulletLine(lines[index]) &&
      getIndent(lines[index]) > indent
    ) {
      item.children.push(lines[index].trim().replace(/^[-*]\s+/, ""));
      index += 1;
    }

    items.push(item);
  }

  return {
    items,
    nextIndex: index,
  };
}

function getIndent(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function stripInlineMarkdown(text: string) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function getToolName(part: ToolPart) {
  if (part.type === "dynamic-tool") {
    return "dynamic";
  }

  return part.type.replace("tool-", "");
}

function getToolLabel(toolName: string) {
  const labels: Record<string, string> = {
    searchOrthogonalCatalog: "Searched the API catalog",
    searchWeb: "Searched the web",
    enrichCompany: "Enriched company data",
    runOrthogonalApi: "Called Orthogonal API",
    describeOrthogonalEndpoint: "Probed endpoint schema",
    dynamic: "Used Orthogonal tool",
  };

  return labels[toolName] ?? "Used Orthogonal tool";
}

function getToolStateKind(part: ToolPart): ToolStateKind {
  if (!part.state || part.state.startsWith("input-")) {
    return "running";
  }

  if (part.state === "output-error" || part.errorText) {
    return "error";
  }

  if (part.state === "output-available") {
    const output = isRecord(part.output) ? part.output : null;

    if (output?.notCalled === true) {
      return "skipped";
    }

    if (output?.isError === true || output?.isValidationError === true) {
      return "error";
    }
  }

  return "done";
}

function getToolStateLabel(part: ToolPart) {
  if (!part.state || part.state.startsWith("input-")) {
    return "Running";
  }

  if (part.state === "output-error" || part.errorText) {
    return "Failed";
  }

  if (part.state === "output-available") {
    const output = isRecord(part.output) ? part.output : null;

    if (output?.notCalled === true) {
      return "Not called";
    }

    if (output?.isValidationError === true) {
      return "Input error";
    }

    if (output?.isError === true) {
      return "Failed";
    }

    if (isContactLookupTool(part) && output?.hasEmail === false) {
      return "No match";
    }

    if (getToolName(part) === "searchOrthogonalCatalog") {
      return "Searched";
    }

    return "Called";
  }

  return part.state.replace("output-", "").replace(/-/g, " ");
}

function getToolResultPreview(part: ToolPart) {
  if (part.errorText) {
    return part.errorText;
  }

  if (part.state !== "output-available" || !part.output) {
    return "";
  }

  const output = isRecord(part.output) ? part.output : null;
  const input = isRecord(part.input) ? part.input : null;
  const toolName = getToolName(part);

  if (output?.notCalled === true) {
    const blockedReason =
      typeof output.blockedReason === "string"
        ? output.blockedReason
        : "blocked by call safety guard";

    return [
      typeof input?.api === "string" ? `Provider ${input.api}` : null,
      typeof input?.path === "string" ? `Endpoint ${input.path}` : null,
      `Not called: ${blockedReason}`,
      "No credits used",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (toolName === "searchWeb") {
    return formatSearchWebPreview(input, output);
  }

  if (toolName === "searchOrthogonalCatalog") {
    return formatCatalogSearchPreview(input, output);
  }

  if (toolName === "describeOrthogonalEndpoint") {
    return formatDescribePreview(input, output);
  }

  if (toolName === "runOrthogonalApi" || toolName === "enrichCompany") {
    return formatPaidCallPreview(part, input, output, toolName);
  }

  return formatGenericPreview(part, input, output);
}

function formatSearchWebPreview(
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
) {
  const query = typeof input?.query === "string" ? input.query : "";
  const pieces: string[] = [
    query ? `Searched for "${shortenPreview(query)}"` : "Searched the web",
  ];

  if (output?.isError === true) {
    pieces.push(`Failed: ${extractErrorPhrase(output)}`);
    return pieces.join(" · ");
  }

  const count = getResultCount(output);
  if (count !== null) {
    pieces.push(`${count} result${count === 1 ? "" : "s"}`);
  } else if (output?.isEmpty === true) {
    pieces.push("No results");
  }

  return pieces.join(" · ");
}

function formatCatalogSearchPreview(
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const pieces: string[] = [
    prompt
      ? `Searched catalog for "${shortenPreview(prompt)}"`
      : "Searched the API catalog",
  ];

  if (output?.isError === true) {
    pieces.push(`Failed: ${extractErrorPhrase(output)}`);
    return pieces.join(" · ");
  }

  const count = getResultCount(output);
  if (count !== null && count > 0) {
    pieces.push(`Found ${count} provider${count === 1 ? "" : "s"}`);
  } else {
    pieces.push("No matches");
  }

  return pieces.join(" · ");
}

function formatDescribePreview(
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
) {
  const api = typeof input?.api === "string" ? input.api : "endpoint";
  const path = typeof input?.path === "string" ? input.path : "";
  const pieces: string[] = [`Probed ${api}${path ? ` ${path}` : ""}`];

  if (output?.acceptsEmpty === true) {
    pieces.push("endpoint accepts empty body");
    pieces.push("May have used credits");
    return pieces.join(" · ");
  }

  const detailFields = getErrorDetailFields(output);
  if (detailFields.length > 0) {
    const shown = detailFields.slice(0, 5).join(", ");
    const suffix = detailFields.length > 5 ? ", …" : "";
    pieces.push(`schema: ${shown}${suffix}`);
    return pieces.join(" · ");
  }

  if (output?.isError === true) {
    pieces.push("no schema details returned");
    return pieces.join(" · ");
  }

  const summary = typeof output?.summary === "string" ? output.summary : "";
  if (summary) {
    pieces.push(shortenPreview(summary));
  }

  return pieces.join(" · ");
}

function formatPaidCallPreview(
  part: ToolPart,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
  toolName: string,
) {
  const pieces: string[] = [];

  if (toolName === "enrichCompany") {
    const domain = typeof input?.domain === "string" ? input.domain : "";
    pieces.push(domain ? `Enriched ${domain}` : "Enriched company");
  } else {
    const api = typeof input?.api === "string" ? input.api : "Orthogonal";
    pieces.push(`Called ${api} API`);
  }

  if (output?.isValidationError === true) {
    const detail = getErrorDetailFields(output)
      .map((field) => field)
      .join(", ");
    pieces.push(
      detail
        ? `Input error: ${detail}`
        : `Input error: ${extractErrorPhrase(output)}`,
    );
    return pieces.join(" · ");
  }

  if (output?.isError === true) {
    pieces.push(`Failed: ${extractErrorPhrase(output)}`);
    return pieces.join(" · ");
  }

  if (isContactLookupTool(part)) {
    if (output?.hasEmail === true) {
      pieces.push("successfully retrieved email");
    } else if (output?.hasEmail === false || output?.isEmpty === true) {
      pieces.push("no email returned");
    } else {
      pieces.push("successfully retrieved data");
    }
  } else if (output?.isEmpty === true) {
    pieces.push("no results returned");
  } else if (output?.hasData === true) {
    pieces.push("successfully retrieved data");
  } else {
    pieces.push("call completed");
  }

  if (output?.price !== null && output?.price !== undefined) {
    pieces.push(`Cost ${String(output.price)}`);
  }

  if (output?.mayHaveCharged === true) {
    pieces.push("May have used credits");
  }

  return pieces.join(" · ");
}

function formatGenericPreview(
  part: ToolPart,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
) {
  const pieces: string[] = [];

  if (typeof input?.api === "string") {
    pieces.push(`Provider ${input.api}`);
  }

  if (typeof input?.path === "string") {
    pieces.push(`Endpoint ${input.path}`);
  }

  const summary = typeof output?.summary === "string" ? output.summary : "";
  const preview =
    typeof output?.dataPreview === "string" ? output.dataPreview : "";
  const outputText = formatUnknown(part.output);

  if (summary) {
    pieces.push(shortenPreview(summary));
  } else if (isContactLookupTool(part) && !containsEmail(outputText)) {
    pieces.push("No email returned");
  } else if (preview) {
    pieces.push(shortenPreview(preview));
  }

  return pieces.length > 0 ? pieces.join(" · ") : "Completed";
}

function getResultCount(output: Record<string, unknown> | null): number | null {
  if (!output) {
    return null;
  }

  if (Array.isArray(output.results)) {
    return output.results.length;
  }

  if (typeof output.count === "number") {
    return output.count;
  }

  return null;
}

function getErrorDetailFields(
  output: Record<string, unknown> | null,
): string[] {
  if (!output || !Array.isArray(output.errorDetail)) {
    return [];
  }

  const fields: string[] = [];
  for (const entry of output.errorDetail) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === "string" ? entry.field : "";
    if (field && field !== "(unspecified)" && !fields.includes(field)) {
      fields.push(field);
    }
  }
  return fields;
}

function extractErrorPhrase(output: Record<string, unknown> | null): string {
  if (!output) return "unknown error";
  const errorMessage =
    typeof output.errorMessage === "string" ? output.errorMessage : "";
  if (errorMessage) {
    return shortenPreview(errorMessage);
  }
  const summary = typeof output.summary === "string" ? output.summary : "";
  if (summary) {
    return shortenPreview(summary);
  }
  return "unknown error";
}

function isContactLookupTool(part: ToolPart) {
  const toolName = getToolName(part);

  if (toolName !== "runOrthogonalApi" && toolName !== "enrichCompany") {
    return false;
  }

  if (toolName === "enrichCompany") {
    return false;
  }

  const input = isRecord(part.input) ? part.input : null;
  const api = typeof input?.api === "string" ? input.api.toLowerCase() : "";
  const path = typeof input?.path === "string" ? input.path.toLowerCase() : "";
  const text = `${api} ${path}`;

  return (
    text.includes("email") ||
    text.includes("contact") ||
    text.includes("people") ||
    text.includes("person") ||
    text.includes("lead") ||
    api === "apollo" ||
    api === "sixtyfour"
  );
}

function containsEmail(text: string) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

function shortenPreview(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();

  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toUIMessage(message: StoredMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
  };
}

function getOrCreateUserId() {
  if (typeof window === "undefined") {
    return "";
  }

  let storedUserId = window.localStorage.getItem(USER_ID_STORAGE_KEY);

  if (!storedUserId) {
    storedUserId = crypto.randomUUID();
    window.localStorage.setItem(USER_ID_STORAGE_KEY, storedUserId);
  }

  return storedUserId;
}

function formatUnknown(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function filterConversations(items: Conversation[], query: string) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return items;
  }
  return items.filter((conversation) =>
    conversation.title.toLowerCase().includes(trimmed),
  );
}

function groupConversations(
  items: Conversation[],
): Array<[string, Conversation[]]> {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const sevenDaysAgo = new Date(startOfToday);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date(startOfToday);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const buckets: Record<string, Conversation[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    "Previous 30 days": [],
    Older: [],
  };

  for (const conversation of items) {
    const updated = new Date(conversation.updated_at);
    if (updated >= startOfToday) {
      buckets.Today.push(conversation);
    } else if (updated >= startOfYesterday) {
      buckets.Yesterday.push(conversation);
    } else if (updated >= sevenDaysAgo) {
      buckets["Previous 7 days"].push(conversation);
    } else if (updated >= thirtyDaysAgo) {
      buckets["Previous 30 days"].push(conversation);
    } else {
      buckets.Older.push(conversation);
    }
  }

  return Object.entries(buckets).filter(([, list]) => list.length > 0);
}
