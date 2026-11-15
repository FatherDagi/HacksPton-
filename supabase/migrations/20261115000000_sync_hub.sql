-- Shared sync hub for the dispatch console and patrol terminals.
-- Every screen's actions (assignments, acknowledgements, messages, field edits...) go into one ordered
-- log, so dispatchers and officers on different devices see the same state.
-- Run once: Supabase dashboard -> SQL Editor -> paste this file -> Run.
-- Only the server (service role key) touches these tables; the browser never talks to Supabase directly.

create table if not exists public.sync_hub (
  ns         text primary key,          -- demo namespace (bumped when the demo roster changes)
  seq        bigint not null default 0, -- last action number
  snap_seq   bigint not null default 0, -- action number the saved snapshot includes
  snapshot   jsonb  not null,           -- full app state at snap_seq
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_log (
  ns         text   not null references public.sync_hub (ns) on delete cascade,
  seq        bigint not null,
  client     text   not null,
  cid        integer not null,
  action     jsonb  not null,
  created_at timestamptz not null default now(),
  primary key (ns, seq)
);

create table if not exists public.sync_terminals (
  ns        text   not null,
  unit      text   not null,
  last_seen bigint not null, -- ms since epoch, server clock
  primary key (ns, unit)
);

-- Locked down: no policies, so the public anon key can read or write nothing here.
alter table public.sync_hub enable row level security;
alter table public.sync_log enable row level security;
alter table public.sync_terminals enable row level security;

-- Create the namespace with its seed state if it doesn't exist yet; return the latest snapshot.
create or replace function public.sync_init(p_ns text, p_seed jsonb)
returns jsonb language plpgsql as $$
declare out jsonb;
begin
  insert into public.sync_hub (ns, snapshot) values (p_ns, p_seed) on conflict (ns) do nothing;
  select jsonb_build_object('seq', snap_seq, 'state', snapshot) into out from public.sync_hub where ns = p_ns;
  return out;
end $$;

-- Append one action. The row lock on sync_hub hands out gap-free, ordered action numbers.
create or replace function public.sync_append(p_ns text, p_client text, p_cid integer, p_action jsonb, p_keep integer)
returns bigint language plpgsql as $$
declare s bigint;
begin
  update public.sync_hub set seq = seq + 1, updated_at = now() where ns = p_ns returning seq into s;
  if s is null then raise exception 'sync hub % is not initialised', p_ns; end if;
  insert into public.sync_log (ns, seq, client, cid, action) values (p_ns, s, p_client, p_cid, p_action);
  if s % 100 = 0 then delete from public.sync_log where ns = p_ns and seq <= s - p_keep; end if;
  if p_action ->> 'type' = 'RESET' then delete from public.sync_terminals where ns = p_ns; end if;
  return s;
end $$;

-- Actions after p_after (in order), the current head, and which patrol terminals are signed in.
-- One statement, so the head and the entries come from the same moment.
create or replace function public.sync_pull(p_ns text, p_after bigint, p_units text[], p_now bigint, p_limit integer)
returns jsonb language plpgsql as $$
begin
  insert into public.sync_terminals (ns, unit, last_seen)
  select p_ns, u, p_now from unnest(coalesce(p_units, '{}'::text[])) as u
  on conflict (ns, unit) do update set last_seen = excluded.last_seen;
  return jsonb_build_object(
    'seq', (select h.seq from public.sync_hub h where h.ns = p_ns),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('seq', l.seq, 'client', l.client, 'cid', l.cid, 'action', l.action) order by l.seq)
      from (select * from public.sync_log where ns = p_ns and seq > p_after order by seq limit p_limit) l
    ), '[]'::jsonb),
    'terminals', coalesce((
      select jsonb_object_agg(t.unit, t.last_seen) from public.sync_terminals t where t.ns = p_ns
    ), '{}'::jsonb)
  );
end $$;

-- Move the saved snapshot forward (never back).
create or replace function public.sync_save_snapshot(p_ns text, p_seq bigint, p_state jsonb)
returns void language plpgsql as $$
begin
  update public.sync_hub set snapshot = p_state, snap_seq = p_seq where ns = p_ns and snap_seq < p_seq;
end $$;

revoke all on function public.sync_init(text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_append(text, text, integer, jsonb, integer) from public, anon, authenticated;
revoke all on function public.sync_pull(text, bigint, text[], bigint, integer) from public, anon, authenticated;
revoke all on function public.sync_save_snapshot(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sync_init(text, jsonb) to service_role;
grant execute on function public.sync_append(text, text, integer, jsonb, integer) to service_role;
grant execute on function public.sync_pull(text, bigint, text[], bigint, integer) to service_role;
grant execute on function public.sync_save_snapshot(text, bigint, jsonb) to service_role;
