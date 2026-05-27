create extension if not exists pgcrypto;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null default 'New research chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  parts jsonb not null,
  content text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id text references messages(id) on delete set null,
  tool_call_id text not null,
  tool_name text not null,
  input jsonb not null,
  output jsonb,
  status text not null check (status in ('success', 'error')),
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists orthogonal_api_results (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tool_call_id text not null,
  api text,
  path text,
  prompt text,
  request jsonb not null,
  response jsonb not null,
  status text not null check (status in ('success', 'error')),
  price text,
  request_id text,
  created_at timestamptz not null default now()
);

create table if not exists conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  summary text not null,
  through_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists conversations_user_updated_idx
  on conversations(user_id, updated_at desc);

create index if not exists messages_conversation_created_idx
  on messages(conversation_id, created_at asc);

create index if not exists tool_calls_conversation_created_idx
  on tool_calls(conversation_id, created_at desc);

create index if not exists orthogonal_results_conversation_created_idx
  on orthogonal_api_results(conversation_id, created_at desc);
