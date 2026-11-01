-- ============================================================
--  Tournée du livreur, étape 2 : brouillon puis publication au livreur.
--  • L'équipe modifie l'ordre, le départ/l'arrivée, ajoute et retire des arrêts : c'est le BROUILLON.
--  • « פרסום עדכון לנהג » enregistre une VERSION (liste ordonnée d'arrêts + départ/arrivée).
--    Le livreur (téléphone ou lien) ne voit QUE la dernière version publiée.
--  • Statuts, photos, signatures, notes et historique restent dans leurs tables : jamais copiés ni remplacés.
--  • La publication est vérifiée par le serveur (version attendue, arrêts présents, arrêts traités pas déplacés,
--    retraits déjà traités) : en cas de conflit, refus sans rien modifier.
--  • Annulation urgente : immédiate, l'arrêt reste enregistré (« בוטל ») et l'action est dans l'historique.
--  • Le téléphone indique la version qu'il a réellement affichée.
--  Retour arrière : les anciennes définitions des fonctions sont dans 2026-11-01-succursales.sql, liens.sql, livreurs.sql.
-- ============================================================

-- 1) Versions publiées
create table if not exists public.trip_versions (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips(id) on delete cascade,
  version      int  not null check (version > 0),
  stop_ids     uuid[] not null,
  start_addr   text, start_gps text, start_time text, end_addr text, end_gps text,
  published_at timestamptz not null default now(),
  published_by uuid,
  unique (trip_id, version)
);
alter table public.trip_versions enable row level security;
revoke all on public.trip_versions from anon, authenticated;
grant select on public.trip_versions to authenticated;
drop policy if exists "team read versions" on public.trip_versions;
create policy "team read versions" on public.trip_versions for select to authenticated using ((select public.is_staff()));

alter table public.trips add column if not exists published_version int;
alter table public.tasks add column if not exists removal_pending boolean not null default false;   -- retiré au prochain « פרסום »
alter table public.tasks add column if not exists cancelled_at timestamptz;                         -- annulation urgente
alter table public.tasks add column if not exists cancelled_by uuid;

-- 2) Version réellement affichée par le téléphone du livreur
create table if not exists public.trip_seen (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  version int not null,
  seen_at timestamptz not null default now(),
  via     text not null check (via in ('phone', 'link'))
);
alter table public.trip_seen enable row level security;
revoke all on public.trip_seen from anon, authenticated;
grant select on public.trip_seen to authenticated;
drop policy if exists "team read seen" on public.trip_seen;
create policy "team read seen" on public.trip_seen for select to authenticated using ((select public.is_staff()));

-- 3) Tournées déjà envoyées : leur ordre actuel devient la version 1 (une seule fois)
insert into public.trip_versions(trip_id, version, stop_ids, start_addr, start_gps, start_time, end_addr, end_gps, published_at)
select r.id, 1, coalesce((select array_agg(t.id order by t.position nulls last, t.created_at) from public.tasks t where t.trip_id = r.id), '{}'),
       r.start_addr, r.start_gps, r.start_time, r.end_addr, r.end_gps, r.published_at
  from public.trips r
 where r.kind = 'delivery' and r.published_at is not null and r.published_version is null
on conflict (trip_id, version) do nothing;
update public.trips r set published_version = 1
 where r.kind = 'delivery' and r.published_at is not null and r.published_version is null
   and exists (select 1 from public.trip_versions v where v.trip_id = r.id and v.version = 1);

-- 4) Un arrêt fait-il partie de ce que voit le livreur ? (dans la version publiée et pas annulé)
create or replace function public.stop_published(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tasks t join public.trips r on r.id = t.trip_id
                   left join public.trip_versions v on v.trip_id = r.id and v.version = r.published_version
                  where t.id = p_task and t.cancelled_at is null
                    and (r.published_version is null or t.id = any(v.stop_ids)))
$$;
revoke all on function public.stop_published(uuid) from public, anon, authenticated;
grant execute on function public.stop_published(uuid) to service_role;

-- 5) Ce que lit le livreur : la version publiée (ordre, départ, arrivée), sans les arrêts annulés
create or replace function public.trip_json(p_trip uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', r.id, 'date', r.date, 'name', r.name, 'published_at', r.published_at,
    'version', r.published_version, 'version_at', v.published_at,
    'start_addr', case when v.id is null then r.start_addr else v.start_addr end,
    'start_time', case when v.id is null then r.start_time else v.start_time end,
    'end_addr',   case when v.id is null then r.end_addr   else v.end_addr   end,
    'stops', coalesce((select json_agg(json_build_object(
        'id', t.id, 'position', coalesce(array_position(v.stop_ids, t.id), t.position), 'created_at', t.created_at,
        'name', case when b is not null then coalesce(c.name, t.title) || ' · ' || coalesce(nullif(trim(b->>'name'), ''), 'סניף')
                     else coalesce(c.name, t.title) end,
        'branch', b->>'name',
        'street', case when b is not null then nullif(trim(b->>'street'), '') else c.street end,
        'city', coalesce(case when b is not null then nullif(trim(b->>'city'), '') else nullif(trim(c.city), '') end, t.city),
        'contact', coalesce(nullif(trim(b->>'contact'), ''), c.contact),
        'phone', case when nullif(trim(b->>'phone'), '') is not null then b->>'phone' else c.phone end,
        'phone2', case when nullif(trim(b->>'phone'), '') is not null then nullif(trim(b->>'phone2'), '') else c.phone2 end,
        'gps', case when b is not null then nullif(trim(b->>'gps'), '') else c.gps end,
        'instructions', t.delivery_instructions,
        'delivery_status', t.delivery_status, 'delivery_note', t.delivery_note, 'delivered_at', t.delivered_at,
        'docs', coalesce((select json_agg(json_build_object('morning_id', m.morning_id, 'type', m.type, 'number', m.number,
                    'doc_date', m.doc_date, 'pdf_path', m.pdf_path,
                    'signature', (select json_build_object('id', g.id, 'request_id', g.request_id, 'receiver_name', g.receiver_name,
                                    'signed_at', g.signed_at, 'signed_pdf_path', g.signed_pdf_path, 'image_path', g.image_path, 'document_sha256', g.document_sha256)
                                  from public.delivery_signatures g where g.task_id = t.id and g.morning_id = m.morning_id))
                    order by m.doc_date desc)
                  from public.delivery_documents dd join public.morning_documents m on m.morning_id = dd.morning_id
                  where dd.task_id = t.id), '[]'::json),
        'proofs', coalesce((select json_agg(json_build_object('id', p.id, 'path', p.storage_path, 'note', p.note,
                    'received_at', p.received_at) order by p.received_at)
                  from public.delivery_proofs p where p.task_id = t.id), '[]'::json)
      ) order by coalesce(array_position(v.stop_ids, t.id), t.position) nulls last, t.created_at)
      from public.tasks t left join public.customers c on c.id = t.customer_id
      cross join lateral (select public.stop_branch(c.branches, t.branch_id) as b) sb
      where t.trip_id = r.id and t.cancelled_at is null and (v.id is null or t.id = any(v.stop_ids))), '[]'::json))
  from public.trips r left join public.trip_versions v on v.trip_id = r.id and v.version = r.published_version
  where r.id = p_trip
$$;

create or replace function public.driver_my_trips()
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.date nulls last, x.name), '[]'::json) from (
    select r.id, r.date, r.name, r.published_at, r.published_version as version,
      (select count(*) from public.tasks t where t.trip_id = r.id and t.cancelled_at is null and (v.id is null or t.id = any(v.stop_ids))) as total,
      (select count(*) from public.tasks t where t.trip_id = r.id and t.cancelled_at is null and (v.id is null or t.id = any(v.stop_ids))
          and t.delivery_status is not null) as done,
      (select coalesce(json_agg(c2.city order by c2.first), '[]'::json) from (
         select coalesce(case when b is not null then nullif(trim(b->>'city'), '') else nullif(trim(c.city), '') end, t.city) as city,
                min(coalesce(array_position(v.stop_ids, t.id), t.position, 9999)) as first
         from public.tasks t left join public.customers c on c.id = t.customer_id
         cross join lateral (select public.stop_branch(c.branches, t.branch_id) as b) sb
         where t.trip_id = r.id and t.cancelled_at is null and (v.id is null or t.id = any(v.stop_ids)) group by 1) c2 where c2.city is not null) as cities
    from public.trips r left join public.trip_versions v on v.trip_id = r.id and v.version = r.published_version
    where r.driver_id = public.current_driver_id() and r.published_at is not null
      and (r.date is null or r.date >= (now() at time zone 'Asia/Jerusalem')::date - 7)
  ) x
$$;

-- 6) Le téléphone dit quelle version il a affichée (jamais une version qui n'existe pas)
create or replace function public.driver_trip_seen(p_trip uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id(); r public.trips;
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip and driver_id = v_driver and published_at is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_version is null or p_version < 1 or p_version > coalesce(r.published_version, 0) then return; end if;
  insert into public.trip_seen(trip_id, version, seen_at, via) values (p_trip, p_version, now(), 'phone')
  on conflict (trip_id) do update set version = excluded.version, seen_at = excluded.seen_at, via = excluded.via;
end $$;
revoke all on function public.driver_trip_seen(uuid, int) from public, anon;
grant execute on function public.driver_trip_seen(uuid, int) to authenticated;

create or replace function public.link_trip_seen(p_hash text, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare l public.driver_links; r public.trips;
begin
  l := public.link_valid(p_hash);
  select * into r from public.trips where id = l.trip_id;
  if p_version is null or p_version < 1 or p_version > coalesce(r.published_version, 0) then return; end if;
  insert into public.trip_seen(trip_id, version, seen_at, via) values (l.trip_id, p_version, now(), 'link')
  on conflict (trip_id) do update set version = excluded.version, seen_at = excluded.seen_at, via = excluded.via;
end $$;
revoke all on function public.link_trip_seen(text, int) from public, anon, authenticated;
grant execute on function public.link_trip_seen(text, int) to service_role;

-- 7) Publication vérifiée (équipe seulement)
create or replace function public.staff_publish_trip(p_trip uuid, p_expected int, p_order uuid[])
returns json language plpgsql security definer set search_path = public as $$
declare r public.trips; prev public.trip_versions; v_live uuid[]; v_new int; v_now timestamptz := now();
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.kind <> 'delivery' then raise exception 'not_delivery' using errcode = '22023'; end if;
  if r.driver_id is null then raise exception 'no_driver' using errcode = '22023'; end if;
  -- quelqu'un a publié entre-temps
  if r.published_version is distinct from p_expected then raise exception 'version_conflict' using errcode = 'P0001'; end if;
  -- la liste envoyée = exactement les arrêts actuels (ni oubli, ni doublon, ni arrêt d'ailleurs)
  if p_order is null or cardinality(p_order) = 0 then raise exception 'empty' using errcode = '22023'; end if;
  select coalesce(array_agg(t.id), '{}') into v_live from public.tasks t
   where t.trip_id = p_trip and not t.removal_pending and t.cancelled_at is null;
  if cardinality(p_order) <> cardinality(v_live)
     or (select count(distinct x) from unnest(p_order) x) <> cardinality(p_order)
     or exists (select 1 from unnest(p_order) x where not (x = any(v_live))) then
    raise exception 'order_mismatch' using errcode = 'P0001';
  end if;
  -- un arrêt à retirer a déjà été traité par le livreur
  if exists (select 1 from public.tasks t where t.trip_id = p_trip and t.removal_pending and t.cancelled_at is null
              and (t.delivery_status is not null
                   or exists (select 1 from public.delivery_proofs p where p.task_id = t.id)
                   or exists (select 1 from public.delivery_signatures g where g.task_id = t.id))) then
    raise exception 'removal_handled' using errcode = 'P0001';
  end if;
  -- un arrêt traité garde sa place par rapport aux arrêts présents dans les deux versions
  select * into prev from public.trip_versions where trip_id = p_trip and version = r.published_version;
  if found and exists (
      select 1 from public.tasks t
       where t.trip_id = p_trip and t.delivery_status is not null and t.id = any(prev.stop_ids) and t.id = any(p_order)
         and (select count(*) from unnest(prev.stop_ids) with ordinality u(x, i) where x = any(p_order) and i < array_position(prev.stop_ids, t.id))
          <> (select count(*) from unnest(p_order) with ordinality u(x, i) where x = any(prev.stop_ids) and i < array_position(p_order, t.id))) then
    raise exception 'handled_moved' using errcode = 'P0001';
  end if;
  v_new := coalesce(r.published_version, 0) + 1;
  -- retraits ordinaires : faits maintenant, et notés dans l'historique
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value, note)
  select p_trip, t.id, auth.uid(), 'staff', 'stop_removed', v_new::text, coalesce(c.name, t.title)
    from public.tasks t left join public.customers c on c.id = t.customer_id
   where t.trip_id = p_trip and t.removal_pending and t.cancelled_at is null;
  delete from public.tasks where trip_id = p_trip and removal_pending and cancelled_at is null;
  update public.tasks t set position = array_position(p_order, t.id)
   where t.trip_id = p_trip and t.id = any(p_order) and t.position is distinct from array_position(p_order, t.id);
  insert into public.trip_versions(trip_id, version, stop_ids, start_addr, start_gps, start_time, end_addr, end_gps, published_at, published_by)
  values (p_trip, v_new, p_order, r.start_addr, r.start_gps, r.start_time, r.end_addr, r.end_gps, v_now, auth.uid());
  update public.trips set published_version = v_new, published_at = coalesce(published_at, v_now) where id = p_trip;
  insert into public.delivery_events(trip_id, actor, actor_kind, kind, to_value) values (p_trip, auth.uid(), 'staff', 'version', v_new::text);
  return json_build_object('version', v_new, 'published_at', v_now);
end $$;
revoke all on function public.staff_publish_trip(uuid, int, uuid[]) from public, anon;
grant execute on function public.staff_publish_trip(uuid, int, uuid[]) to authenticated;

-- 8) Annulation urgente : immédiate, l'arrêt reste enregistré et l'action va dans l'historique
create or replace function public.staff_cancel_stop(p_task uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare t public.tasks; r public.trips;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from public.tasks where id = p_task for update;
  if not found or t.trip_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into r from public.trips where id = t.trip_id;
  if r.kind <> 'delivery' then raise exception 'not_delivery' using errcode = '22023'; end if;
  if t.cancelled_at is not null then return json_build_object('result', 'already'); end if;
  if t.delivery_status in ('delivered', 'partial')
     or exists (select 1 from public.delivery_proofs p where p.task_id = p_task)
     or exists (select 1 from public.delivery_signatures g where g.task_id = p_task) then
    raise exception 'stop_handled' using errcode = 'P0001';
  end if;
  update public.tasks set cancelled_at = now(), cancelled_by = auth.uid(), removal_pending = false, locked_position = null where id = p_task;
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, note)
  values (t.trip_id, p_task, auth.uid(), 'staff', 'stop_cancelled', nullif(left(trim(coalesce(p_reason, '')), 300), ''));
  return json_build_object('result', 'cancelled');
end $$;
revoke all on function public.staff_cancel_stop(uuid, text) from public, anon;
grant execute on function public.staff_cancel_stop(uuid, text) to authenticated;

-- 9) Actions du livreur : seulement sur un arrêt de la version publiée, pas annulé (une ligne ajoutée à chaque fonction)

CREATE OR REPLACE FUNCTION public.driver_set_status(p_task uuid, p_status text, p_note text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_driver uuid := public.current_driver_id(); v_cur text; v_at timestamptz := now();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select t.delivery_status into v_cur from public.tasks t join public.trips r on r.id = t.trip_id
   where t.id = p_task and r.driver_id = v_driver and r.published_at is not null for update of t;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.stop_published(p_task) then raise exception 'stop_unavailable' using errcode = 'P0002'; end if;   -- étape 2 : version publiée, pas annulé
  if p_status is null or p_status not in ('delivered', 'partial', 'absent', 'impossible') then raise exception 'bad_status' using errcode = '22023'; end if;
  if p_status <> 'delivered' and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'note_required' using errcode = '22023'; end if;
  if v_cur is not null then raise exception 'already_validated' using errcode = '55000'; end if;
  update public.tasks set delivery_status = p_status, delivery_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
         delivered_at = v_at, delivered_by = v_driver, problem_resolved_at = null
   where id = p_task;
  return json_build_object('id', p_task, 'delivery_status', p_status, 'delivered_at', v_at);
end $function$;

CREATE OR REPLACE FUNCTION public.driver_add_proof(p_task uuid, p_path text, p_note text, p_captured_at timestamp with time zone, p_mime text, p_bytes integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_driver uuid := public.current_driver_id(); v_trip uuid; v_cust uuid; p public.delivery_proofs;
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select t.trip_id, t.customer_id into v_trip, v_cust from public.tasks t join public.trips r on r.id = t.trip_id
   where t.id = p_task and r.driver_id = v_driver and r.published_at is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.stop_published(p_task) then raise exception 'stop_unavailable' using errcode = 'P0002'; end if;   -- étape 2 : version publiée, pas annulé
  if split_part(p_path, '/', 1) <> v_trip::text or split_part(p_path, '/', 2) <> p_task::text then raise exception 'bad_path' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'delivery-proofs' and o.name = p_path
                 and (o.owner_id = auth.uid()::text or o.owner = auth.uid())) then
    raise exception 'file_missing' using errcode = 'P0002';
  end if;
  insert into public.delivery_proofs(task_id, trip_id, customer_id, driver_id, storage_path, note, mime, bytes, captured_at, uploaded_by)
  values (p_task, v_trip, v_cust, v_driver, p_path, nullif(left(trim(coalesce(p_note, '')), 1000), ''), left(p_mime, 40), p_bytes, p_captured_at, auth.uid())
  on conflict (storage_path) do nothing;
  select * into p from public.delivery_proofs where storage_path = p_path;
  return json_build_object('id', p.id, 'path', p.storage_path, 'note', p.note, 'received_at', p.received_at);
end $function$;

CREATE OR REPLACE FUNCTION public.link_set_status(p_hash text, p_task uuid, p_status text, p_note text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l public.driver_links; v_cur text; v_at timestamptz := now();
begin
  l := public.link_valid(p_hash);
  select t.delivery_status into v_cur from public.tasks t where t.id = p_task and t.trip_id = l.trip_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.stop_published(p_task) then raise exception 'stop_unavailable' using errcode = 'P0002'; end if;   -- étape 2 : version publiée, pas annulé
  if p_status is null or p_status not in ('delivered', 'partial', 'absent', 'impossible') then raise exception 'bad_status' using errcode = '22023'; end if;
  if p_status <> 'delivered' and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'note_required' using errcode = '22023'; end if;
  if v_cur is not null then raise exception 'already_validated' using errcode = '55000'; end if;
  update public.tasks set delivery_status = p_status, delivery_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
         delivered_at = v_at, delivered_by = l.driver_id, problem_resolved_at = null
   where id = p_task;
  return json_build_object('id', p_task, 'delivery_status', p_status, 'delivered_at', v_at);
end $function$;

CREATE OR REPLACE FUNCTION public.link_add_proof(p_hash text, p_task uuid, p_path text, p_note text, p_captured_at timestamp with time zone, p_mime text, p_bytes integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l public.driver_links; v_cust uuid; p public.delivery_proofs;
begin
  l := public.link_valid(p_hash);
  select t.customer_id into v_cust from public.tasks t where t.id = p_task and t.trip_id = l.trip_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.stop_published(p_task) then raise exception 'stop_unavailable' using errcode = 'P0002'; end if;   -- étape 2 : version publiée, pas annulé
  if p_path !~ ('^' || l.trip_id::text || '/' || p_task::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$') then raise exception 'bad_path' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'delivery-proofs' and o.name = p_path) then
    raise exception 'file_missing' using errcode = 'P0002';
  end if;
  insert into public.delivery_proofs(task_id, trip_id, customer_id, driver_id, storage_path, note, mime, bytes, captured_at, uploaded_by, link_id)
  values (p_task, l.trip_id, v_cust, l.driver_id, p_path, nullif(left(trim(coalesce(p_note, '')), 1000), ''), left(p_mime, 40), p_bytes, p_captured_at, null, l.id)
  on conflict (storage_path) do nothing;
  select * into p from public.delivery_proofs where storage_path = p_path;
  return json_build_object('id', p.id, 'path', p.storage_path, 'note', p.note, 'received_at', p.received_at);
end $function$;

-- 10) Retrait immédiat ordinaire interdit sur un arrêt que le livreur voit : on passe par « הסרה בפרסום הבא » ou l'annulation urgente
create or replace function public.staff_remove_stop(p_task uuid)
returns json language plpgsql security definer set search_path = public as $$
declare t public.tasks; v_kind text;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from public.tasks where id = p_task for update;
  if not found or t.trip_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.delivery_proofs where task_id = p_task)
     or exists (select 1 from public.delivery_signatures where task_id = p_task) then
    raise exception 'stop_has_proofs' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.trips r join public.trip_versions v on v.trip_id = r.id and v.version = r.published_version
              where r.id = t.trip_id and r.kind = 'delivery' and r.published_at is not null and p_task = any(v.stop_ids)) then
    raise exception 'stop_published' using errcode = 'P0001';
  end if;
  select kind into v_kind from public.trips where id = t.trip_id;
  if coalesce(v_kind, 'visit') = 'visit' and t.done and not t.skipped then
    update public.tasks set trip_id = null, type = 'visit', position = null where id = p_task;
    return json_build_object('result', 'kept_visit');
  end if;
  delete from public.tasks where id = p_task;
  return json_build_object('result', 'deleted');
end $$;
