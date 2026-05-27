# orthogonal-ai-chat

A small production-style take-home app: persistent AI chat with streaming responses and server-side Orthogonal API tools.

## Stack

- Node `24.15.0` via `fnm`
- Next.js App Router, TypeScript, Tailwind
- Vercel AI SDK + OpenAI
- Orthogonal REST API
- Supabase Postgres
- Vercel deployment

## Run Locally

```bash
fnm use
npm install
cp .env.local.example .env.local
npm run dev
```

Fill in `.env.local`:

```bash
OPENAI_API_KEY=
ORTHOGONAL_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Create the Supabase tables by running [supabase/schema.sql](/Users/liamzhang/GitHub/orthogonal-ai-chat/supabase/schema.sql) in the Supabase SQL editor.

## What It Does

- Streams assistant responses in the chat UI.
- Lets the assistant call Orthogonal tools for API catalog search, web search, company enrichment, and generic endpoint runs.
- Saves conversations, messages, tool calls, and raw Orthogonal responses in Supabase.
- Shows previous conversations in a sidebar so chats survive refreshes.
- Handles slow or failed Orthogonal calls with timeouts and friendly tool failure messages.

## Simple System Design

The browser is the chat screen. Next.js is the backend middleman. OpenAI is the assistant brain. Orthogonal provides real external data. Supabase stores the app history.

```text
User sends message
-> Next.js /api/chat receives it
-> OpenAI decides whether real data is needed
-> Next.js calls Orthogonal if needed
-> Supabase saves messages and API results
-> Assistant streams response back to browser
```

Supabase stores:

- `conversations`: chat threads
- `messages`: user and assistant messages
- `tool_calls`: each assistant tool invocation
- `orthogonal_api_results`: raw Orthogonal responses, status, request IDs, and price when returned
- `conversation_summaries`: reserved for future rolling summaries

## Context Window Strategy

The app does not send the entire database back to the model. For v1, `/api/chat` sends only the most recent messages and stores large raw Orthogonal responses outside the prompt. Tool outputs are compacted before returning to the model.

With more time, I would generate rolling summaries into `conversation_summaries` and retrieve only relevant old tool results when the user references prior research.

## Concurrency and Failure Handling

Today, each chat request calls Orthogonal from the server and uses an 18 second timeout. Failed tool calls are saved and returned as clear assistant-visible errors.

At scale, I would add:

- Redis rate limits per user
- a global Orthogonal concurrency limit
- request deduplication for repeated searches
- cached API results with short TTLs
- per-user usage budgets
- background workers for slow provider calls
- observability around provider latency, cost, and error rates

## Deployment

Deploy on Vercel and add the same environment variables in the Vercel project settings. The app calls Orthogonal directly from the Next.js server with `ORTHOGONAL_API_KEY`.

## Local Orthogonal MCP

MCP is optional developer tooling, not part of the production app. It can help a local coding agent inspect Orthogonal APIs while building, but the deployed chatbot should not depend on a local MCP client or server.

Example MCP config for Cursor, Claude Code, or another MCP-compatible client:

```json
{
  "mcpServers": {
    "orthogonal": {
      "url": "https://mcp.orth.sh"
    }
  }
}
```

Production path:

```text
Next.js server -> Orthogonal REST API -> external data
```

## What I Would Add With More Time

- Real Supabase Auth instead of anonymous browser IDs.
- Conversation summary generation once a chat grows past a message threshold.
- Better endpoint-specific tools for common GTM tasks like contact search and email verification.
- User-facing cost controls before expensive Orthogonal calls.
- Evals for tool selection quality and answer faithfulness.
