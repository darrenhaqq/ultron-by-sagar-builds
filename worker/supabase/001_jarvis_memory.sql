create table if not exists public.jarvis_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  summary text,
  status text not null default 'active' check (status in ('active','paused','completed','archived')),
  priority integer not null default 50 check (priority between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.jarvis_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.jarvis_projects(id) on delete cascade,
  kind text not null check (kind in ('decision','preference','fact','commitment','procedure','note')),
  title text not null,
  content text not null,
  importance integer not null default 60 check (importance between 0 and 100),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jarvis_projects_owner_status_idx
  on public.jarvis_projects(owner_id, status, priority desc);

create index if not exists jarvis_memories_owner_importance_idx
  on public.jarvis_memories(owner_id, importance desc, updated_at desc);

create index if not exists jarvis_memories_project_idx
  on public.jarvis_memories(project_id, importance desc, updated_at desc);

alter table public.jarvis_projects enable row level security;
alter table public.jarvis_memories enable row level security;

create policy "jarvis_projects_owner_select"
  on public.jarvis_projects for select
  using (auth.uid() = owner_id);
create policy "jarvis_projects_owner_insert"
  on public.jarvis_projects for insert
  with check (auth.uid() = owner_id);
create policy "jarvis_projects_owner_update"
  on public.jarvis_projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
create policy "jarvis_projects_owner_delete"
  on public.jarvis_projects for delete
  using (auth.uid() = owner_id);

create policy "jarvis_memories_owner_select"
  on public.jarvis_memories for select
  using (auth.uid() = owner_id);
create policy "jarvis_memories_owner_insert"
  on public.jarvis_memories for insert
  with check (auth.uid() = owner_id);
create policy "jarvis_memories_owner_update"
  on public.jarvis_memories for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
create policy "jarvis_memories_owner_delete"
  on public.jarvis_memories for delete
  using (auth.uid() = owner_id);
