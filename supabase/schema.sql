-- Run this in your Supabase SQL editor

create table if not exists links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  url text not null,
  title text,
  note text,
  category text,
  label text,
  read_time_minutes int,
  intent text check (intent in ('read', 'act')),
  is_done boolean default false,
  ai_processed boolean default false,
  created_at timestamptz default now()
);

-- Row-level security
alter table links enable row level security;

create policy "Users can manage own links"
  on links for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Enable realtime
alter publication supabase_realtime add table links;
