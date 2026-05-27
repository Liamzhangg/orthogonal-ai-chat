"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export default function Home() {
  const [input, setInput] = useState("");
  const [userId] = useState(getOrCreateUserId);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
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

  function startNewChat() {
    scrollModeRef.current = "idle";
    setActiveConversationId("");
    setMessages([]);
    setInput("");
    clearError();
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

  return (
    <main className="flex h-dvh overflow-hidden bg-white text-[#171717]">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex h-dvh w-72 flex-col border-r border-[#ededed] bg-[#f9f9f9] transition-transform duration-200 lg:static ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex h-16 items-center justify-between px-4">
          <p className="text-lg font-semibold text-[#171717]">
            Orthogonal Chat
          </p>
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="grid size-9 place-items-center rounded-lg text-[#6b6b6b] hover:bg-[#ececec] lg:hidden"
            aria-label="Close sidebar"
            title="Close sidebar"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <div className="space-y-1 px-2 pb-3">
          <button
            type="button"
            onClick={startNewChat}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-[#171717] hover:bg-[#ececec]"
          >
            <MessageSquarePlus className="size-4" />
            New chat
          </button>
          <div className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm text-[#555]">
            <Search className="size-4" />
            Search chats
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {historyError ? (
            <div className="m-2 rounded-xl border border-[#f3d5c9] bg-[#fff7f4] p-3 text-sm text-[#9a3412]">
              {historyError}
            </div>
          ) : null}

          {conversations.length === 0 ? (
            <div className="px-3 py-6 text-sm leading-6 text-[#8a8a8a]">
              No saved chats yet.
            </div>
          ) : (
            <div className="space-y-1">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void loadConversation(conversation.id)}
                  className={`flex w-full items-start rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    conversation.id === activeConversationId
                      ? "bg-[#ececec] text-[#171717]"
                      : "text-[#444] hover:bg-[#f0f0f0]"
                  }`}
                >
                  <span className="line-clamp-2">{conversation.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {isSidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar overlay"
          className="fixed inset-0 z-20 bg-black/20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}

      <section className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <header className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              className="grid size-9 place-items-center rounded-lg text-[#555] hover:bg-[#f2f2f2] lg:hidden"
              aria-label="Open sidebar"
              title="Open sidebar"
            >
              <Menu className="size-5" />
            </button>
          </div>
        </header>

        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto px-4">
          <div
            className={`mx-auto flex min-h-full w-full max-w-[54rem] flex-col ${
              messages.length === 0 ? "justify-center" : "gap-7 py-7"
            }`}
          >
            {isLoadingConversation ? (
              <div className="flex items-center gap-2 text-sm text-[#6b6b6b]">
                <Loader2 className="size-4 animate-spin" />
                Loading conversation
              </div>
            ) : null}

            {messages.length === 0 ? (
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

            {isWorking ? (
              <div className="flex items-center gap-2 pl-1 text-sm text-[#6b6b6b]">
                <Loader2 className="size-4 animate-spin" />
                Thinking
              </div>
            ) : null}

            {error ? (
              <div className="flex items-start gap-2 rounded-xl border border-[#f3d5c9] bg-[#fff7f4] p-3 text-sm text-[#9a3412]">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error.message}</span>
              </div>
            ) : null}

            <div ref={messagesEndRef} />
          </div>
        </div>

        <div
          className={`bg-white px-4 pb-5 pt-2 ${
            messages.length === 0 ? "hidden" : "block"
          }`}
        >
          <Composer
            input={input}
            isWorking={isWorking}
            userId={userId}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            onStop={stop}
          />
        </div>
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
  const prompts = [
    "Company info",
    "Recent web results",
    "Find contact APIs",
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-2 pb-24">
      <h2 className="text-center text-2xl font-medium tracking-normal text-[#171717] sm:text-[32px]">
        What can I help with?
      </h2>

      <Composer
        input={input}
        isWorking={isWorking}
        userId={userId}
        onInputChange={onInputChange}
        onSubmit={onSubmit}
        onStop={onStop}
      />

      <div className="flex flex-wrap justify-center gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-full border border-[#e5e5e5] bg-white px-3.5 py-1.5 text-[13px] text-[#5f5f5f] hover:bg-[#f7f7f7]"
          >
            {prompt}
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
  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-[1.5rem] border border-[#d9d9d9] bg-white p-2 pl-5 shadow-[0_10px_30px_rgba(0,0,0,0.06)]"
    >
      <label className="sr-only" htmlFor="chat-input">
        Message
      </label>
      <textarea
        id="chat-input"
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Reply..."
        className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-6 text-[#171717] outline-none placeholder:text-[#98a2b3]"
        rows={1}
      />
      {isWorking ? (
        <button
          type="button"
          onClick={() => void onStop()}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-[#171717] text-white hover:bg-[#333] disabled:cursor-not-allowed"
          aria-label="Stop response"
          title="Stop response"
        >
          <Square className="size-4 fill-current" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim() || !userId}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-[#171717] text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:bg-[#d7d7d7]"
          aria-label="Send message"
          title="Send message"
        >
          <Send className="size-4" />
        </button>
      )}
    </form>
  );
}

function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <article
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      aria-label={`${message.role} message`}
    >
      <div
        className={`max-w-[min(48rem,92vw)] text-[15px] leading-7 text-[#344054] ${
          isUser
            ? "rounded-[1.35rem] bg-[#f3f4f6] px-5 py-2.5 text-[#111827]"
            : "px-1 py-1"
        }`}
      >
        <div className="space-y-4">
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

  return (
    <div className="relative ml-4 py-1 text-[14px] text-[#344054]">
      <div className="absolute bottom-3 left-0 top-3 w-px bg-[#d8dee8]" />
      <div className="ml-6 inline-flex max-w-full items-center gap-3 rounded-full border border-[#d8dee8] bg-white px-3.5 py-1.5 text-[#344054] shadow-sm">
        <Search className="size-4 shrink-0 text-[#667085]" />
        <span className="truncate">{label}</span>
        <ChevronRight className="size-4 shrink-0 text-[#98a2b3]" />
        <span className="rounded-full bg-[#f2f4f7] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[#667085]">
          {stateLabel}
        </span>
      </div>

      {part.errorText ? (
        <p className="ml-6 mt-2 text-sm text-[#9a3412]">{part.errorText}</p>
      ) : null}

      {preview ? (
        <p className="ml-6 mt-2 max-w-3xl text-[13px] leading-6 text-[#667085]">
          {preview}
        </p>
      ) : null}

      {part.input || part.output ? (
        <details className="ml-6 mt-2 max-w-3xl rounded-2xl border border-[#eaecf0] bg-[#fcfcfd] px-3 py-2 text-xs text-[#667085]">
          <summary className="cursor-pointer font-medium">
            Tool details
          </summary>
          {part.input ? (
            <>
              <p className="mt-3 font-semibold text-[#475467]">Input</p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-[11px] leading-5 text-[#475467]">
                {formatUnknown(part.input)}
              </pre>
            </>
          ) : null}

          {part.output ? (
            <>
              <p className="mt-3 font-semibold text-[#475467]">Result</p>
              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-[11px] leading-5 text-[#475467]">
                {formatUnknown(part.output)}
              </pre>
            </>
          ) : null}
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
      blocks.push(
        <h3
          key={`h3-${index}`}
          className="mt-6 text-base font-semibold leading-7 text-[#101828]"
        >
          <InlineText text={trimmed.replace(/^###\s+/, "")} />
        </h3>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      blocks.push(
        <h2
          key={`h2-${index}`}
          className="mt-6 text-lg font-semibold leading-7 text-[#101828]"
        >
          <InlineText text={trimmed.replace(/^##\s+/, "")} />
        </h2>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      blocks.push(
        <h2
          key={`h1-${index}`}
          className="mt-6 text-lg font-semibold leading-7 text-[#101828]"
        >
          <InlineText text={trimmed.replace(/^#\s+/, "")} />
        </h2>,
      );
      index += 1;
      continue;
    }

    if (isBulletLine(line)) {
      const list = parseBulletList(lines, index);

      blocks.push(
        <BulletList key={`ul-${index}`} items={list.items} />,
      );
      index = list.nextIndex;
      continue;
    }

    if (isOrderedListLine(line)) {
      const list = parseOrderedList(lines, index);

      blocks.push(
        <OrderedList key={`ol-${index}`} items={list.items} />,
      );
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
      <p key={`p-${index}`} className="my-2.5 text-[#344054]">
        <InlineText text={paragraphLines.join(" ")} />
      </p>,
    );
  }

  return <div className="space-y-1.5">{blocks}</div>;
}

function BulletList({ items }: { items: BulletItem[] }) {
  return (
    <ul className="my-3 list-disc space-y-1.5 pl-5 text-[#344054] marker:text-[#c0c7d2]">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`}>
          <InlineText text={item.text} />
          {item.children.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 marker:text-[#d0d5dd]">
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
    <ol className="my-3 list-decimal space-y-2 pl-5 text-[#344054] marker:text-[#667085]">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`} className="pl-1">
          <InlineText text={item.text} />
          {item.children.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 marker:text-[#d0d5dd]">
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
              className="font-semibold text-[#1f4e79] decoration-[#98a2b3] underline-offset-4 transition hover:text-[#12385a] hover:underline hover:decoration-[#1f4e79]"
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
              className="rounded-md bg-[#f2f4f7] px-1.5 py-0.5 font-mono text-[0.9em] text-[#344054]"
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={`${part}-${index}`} className="font-semibold text-[#101828]">
              <InlineText text={part.slice(2, -2)} />
            </strong>
          );
        }

        return <span key={`${part}-${index}`}>{part}</span>;
      })}
    </>
  );
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
  const pieces: string[] = [];
  const input = isRecord(part.input) ? part.input : null;

  if (typeof input?.api === "string") {
    pieces.push(`Provider ${input.api}`);
  }

  if (typeof input?.path === "string") {
    pieces.push(`Endpoint ${input.path}`);
  }

  if (output?.notCalled === true) {
    const blockedReason =
      typeof output.blockedReason === "string"
        ? output.blockedReason
        : "blocked by call safety guard";

    pieces.push(`Not called: ${blockedReason}`);
    pieces.push("No credits used");

    return pieces.join(" · ");
  }

  if (output?.requestId) {
    pieces.push(`Request ${String(output.requestId)}`);
  }

  if (output?.mayHaveCharged === true) {
    pieces.push("May have used credits");
  }

  if (output?.price !== null && output?.price !== undefined) {
    pieces.push(`Cost ${String(output.price)}`);
  }

  if (output?.count !== null && output?.count !== undefined) {
    pieces.push(`${String(output.count)} result${output.count === 1 ? "" : "s"}`);
  }

  if (output?.isValidationError === true) {
    const errorMessage =
      typeof output.errorMessage === "string" ? output.errorMessage : "";
    const detail = Array.isArray(output.errorDetail)
      ? output.errorDetail
          .map((entry) => {
            if (!isRecord(entry)) {
              return "";
            }

            const field =
              typeof entry.field === "string" ? entry.field : "field";
            const type =
              typeof entry.type === "string" ? entry.type : "invalid";

            return `${field} (${type})`;
          })
          .filter(Boolean)
          .join(", ")
      : "";

    pieces.push(
      detail
        ? `Input error: ${detail}`
        : errorMessage || "Input error returned by provider",
    );

    return pieces.join(" · ");
  }

  const summary = typeof output?.summary === "string" ? output.summary : "";
  const preview =
    typeof output?.dataPreview === "string" ? output.dataPreview : "";
  const outputText = formatUnknown(part.output);

  if (summary) {
    pieces.push(summary);
  } else if (isContactLookupTool(part) && !containsEmail(outputText)) {
    pieces.push("No email returned");
  } else if (preview) {
    pieces.push(shortenPreview(preview));
  }

  return pieces.length > 0 ? pieces.join(" · ") : "Completed";
}

function isContactLookupTool(part: ToolPart) {
  const text = `${getToolName(part)} ${formatUnknown(part.input)}`.toLowerCase();

  return (
    text.includes("email") ||
    text.includes("contact") ||
    text.includes("people") ||
    text.includes("person") ||
    text.includes("apollo")
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
