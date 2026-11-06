-- Daily paragraph quota per authenticated user
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null default ((timezone('utc', now()))::date),
  paragraph_count integer not null default 0 check (paragraph_count >= 0),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, usage_date)
);

create index if not exists usage_daily_date_idx on public.usage_daily (usage_date);

alter table public.usage_daily enable row level security;

-- Users can read their own usage; writes happen via service role in Edge Functions
create policy "Users can read own usage"
  on public.usage_daily
  for select
  to authenticated
  using (auth.uid() = user_id);
