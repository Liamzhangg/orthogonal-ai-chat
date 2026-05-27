# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
fnm use          # activate Node 24.15.0
npm install
npm run dev      # start dev server
npm run build    # production build
npm run lint     # ESLint check
```

There is no test suite.

## Architecture Overview

A Next.js 16 App Router application where:

- **Browser** (`src/app/page.tsx`) is a single `"use client"` component using `useChat` from `@ai-sdk/react`. It manages user identity as an anonymous UUID stored in `localStorage`.
- **`/api/chat`** (`src/app/api/chat/route.ts`) is the core backend: receives messages, calls `streamText` with OpenAI `gpt-4o-mini`, orchestrates Orthogonal tool calls, and persists everything to Supabase.
- **Orthogonal layer** (`src/lib/orthogonal.ts`) wraps the Orthogonal REST API (`https://api.orth.sh`). All calls go through `orthogonalPost` (18 s timeout) and then `compactOrthogonalResponse`, which trims large responses before they reach the model (2 800 char preview, 2 000 char raw).
- **Persistence layer** (`src/lib/store.ts`) writes to Supabase using the service role client. If Supabase env vars are absent, `getSupabaseAdmin()` returns `null` and every store function silently no-ops — the app still works, just without persistence.

### Data flow for a chat turn

```
Browser sendMessage({ text }, { body: { conversationId, userId } })
  → POST /api/chat
    → saveMessage(userMessage)               // Supabase
    → streamText with tools
      → tool execute() calls Orthogonal      // orthogonal.ts
      → runTrackedTool() wraps every call:
          saveToolCall() + saveOrthogonalResult()
    → onFinish → saveMessage(assistantMessage)
  → UIMessageStream back to browser
```

### Confirmation-gate system

Two server-side guards prevent the model from making paid Orthogonal calls without explicit user consent:

1. **Confirmation gate** (`getConfirmationGateBlock`): checks that the previous assistant message contained the literal endpoint `path` and the word `"confirm"`. If not, the tool returns `notCalled: true`.
2. **Budget gate** (`getPaidCallBudgetBlock`): enforces one paid call per response (`DEFAULT_RUN_ORTHOGONAL_LIMIT = 1`), raised to 2 if the user explicitly typed "retry" or similar.

`describeOrthogonalEndpoint` counts against the same budget as `runOrthogonalApi`. `searchOrthogonalCatalog` and `searchWeb` are free helpers with no gate.

### Message context management

Only the 14 most recent messages (`RECENT_MESSAGE_LIMIT`) are sent to the model. Large Orthogonal responses are stored in `orthogonal_api_results` outside the prompt; `compactOrthogonalResponse` returns a trimmed summary and `dataPreview` to the model instead.

### Markdown rendering

There is no markdown library. `MarkdownContent` in `page.tsx` is a hand-rolled parser supporting headings (h1–h3), bullet lists with one level of nesting, ordered lists, inline code, bold, and `[text](url)` links.

## Environment Variables

| Variable | Where used |
|---|---|
| `OPENAI_API_KEY` | `/api/chat` (server) |
| `ORTHOGONAL_API_KEY` | `orthogonal.ts` (server) |
| `NEXT_PUBLIC_SUPABASE_URL` | `supabase.ts` (server) |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.ts` (server, admin client) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | In `.env.local.example` but not referenced in code |

## Database

Run `supabase/schema.sql` in the Supabase SQL editor to create tables. Key relationships:

- `conversations` ← `messages` (cascade delete)
- `conversations` ← `tool_calls` (cascade delete)
- `conversations` ← `orthogonal_api_results` (cascade delete)

Conversation titles auto-update to the first 56 characters of the first user message.
