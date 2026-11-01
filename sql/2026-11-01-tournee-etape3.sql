-- ============================================================
--  Tournée du livreur, étape 3 : position du livreur (première version simple).
--  • Partage VOLONTAIRE, lancé et arrêté par le livreur sur sa page.
--  • UNE seule ligne par tournée : le dernier point, son heure et sa précision. Aucune trace du trajet.
--  • Le point est effacé : arrêt du partage, fin de tournée, accès retiré (lien expiré/révoqué, tournée en
--    brouillon, autre livreur, livreur désactivé), point de plus de 10 min ; et tout est effacé à minuit (Israël).
--  • Nettoyage de secours par le serveur toutes les 5 minutes (pg_cron).
--  • Les fonctions de livraison, de preuves et de signatures ne sont PAS modifiées.
-- ============================================================

create table if not exists public.driver_positions (
  trip_id     uuid primary key references public.trips(id) on delete cascade,   -- une seule ligne par tournée
  driver_id   uuid references public.drivers(id) on delete cascade,
  state       text not null check (state in ('active', 'stopped', 'denied', 'ended', 'lost')),
  lat         double precision,
  lng         double precision,
  accuracy_m  real,
  captured_at timestamptz,                         -- heure du téléphone
  received_at timestamptz not null default now(), -- heure du serveur (sert à l'âge affiché)
  via         text check (via in ('phone', 'link')),
  link_id     uuid,
  -- un point n'existe que pendant un partage actif
  check ((state = 'active') = (lat is not null and lng is not null and accuracy_m is not null))
);
alter table public.driver_positions enable row level security;
revoke all on public.driver_positions from anon, authenticated;
grant select on public.driver_positions to authenticated;
drop policy if exists "team reads positions" on public.driver_positions;
create policy "team reads positions" on public.driver_positions for select to authenticated using ((select public.is_staff()));

-- La tournée est-elle terminée pour le livreur ? (tous les arrêts publiés, non annulés, sont traités)
create or replace function public.trip_finished(p_trip uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.tasks t join public.trips r on r.id = t.trip_id
      left join public.trip_versions v on v.trip_id = r.id and v.version = r.published_version
     where t.trip_id = p_trip and t.cancelled_at is null and t.delivery_status is null
       and (v.id is null or t.id = any(v.stop_ids)))
$$;
revoke all on function public.trip_finished(uuid) from public, anon, authenticated;

-- Écriture commune (appelée seulement par les fonctions ci-dessous, après vérification de l'accès)
create or replace function public.position_write(p_trip uuid, p_driver uuid, p_via text, p_link uuid,
  p_lat double precision, p_lng double precision, p_acc real, p_captured_at timestamptz) returns json
language plpgsql security definer set search_path = public as $$
declare cur public.driver_positions;
begin
  if public.trip_finished(p_trip) then
    insert into public.driver_positions(trip_id, driver_id, state, received_at, via, link_id) values (p_trip, p_driver, 'ended', now(), p_via, p_link)
    on conflict (trip_id) do update set state = 'ended', lat = null, lng = null, accuracy_m = null, captured_at = null, received_at = now(), via = excluded.via, link_id = excluded.link_id, driver_id = excluded.driver_id;
    return json_build_object('state', 'ended');
  end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
     or p_acc is null or p_acc <= 0 or p_acc > 5000 then raise exception 'bad_position' using errcode = '22023'; end if;
  if p_captured_at is null or p_captured_at < now() - interval '10 minutes' or p_captured_at > now() + interval '2 minutes' then
    raise exception 'stale_position' using errcode = '22023';
  end if;
  select * into cur from public.driver_positions where trip_id = p_trip;
  if found and cur.state = 'active' and cur.received_at > now() - interval '10 seconds' then
    return json_build_object('state', 'active', 'skipped', true);        -- plancher : pas plus d'un point toutes les 10 s
  end if;
  insert into public.driver_positions(trip_id, driver_id, state, lat, lng, accuracy_m, captured_at, received_at, via, link_id)
  values (p_trip, p_driver, 'active', round(p_lat::numeric, 5), round(p_lng::numeric, 5), round(p_acc::numeric), p_captured_at, now(), p_via, p_link)
  on conflict (trip_id) do update set driver_id = excluded.driver_id, state = 'active', lat = excluded.lat, lng = excluded.lng,
    accuracy_m = excluded.accuracy_m, captured_at = excluded.captured_at, received_at = now(), via = excluded.via, link_id = excluded.link_id;
  return json_build_object('state', 'active');
end $$;
revoke all on function public.position_write(uuid, uuid, text, uuid, double precision, double precision, real, timestamptz) from public, anon, authenticated;

create or replace function public.position_stop(p_trip uuid, p_driver uuid, p_via text, p_link uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare v_state text := case when p_reason = 'denied' then 'denied' when public.trip_finished(p_trip) then 'ended' else 'stopped' end;
begin
  insert into public.driver_positions(trip_id, driver_id, state, received_at, via, link_id) values (p_trip, p_driver, v_state, now(), p_via, p_link)
  on conflict (trip_id) do update set state = v_state, lat = null, lng = null, accuracy_m = null, captured_at = null,
    received_at = now(), via = excluded.via, link_id = excluded.link_id, driver_id = excluded.driver_id;
  return json_build_object('state', v_state);
end $$;
revoke all on function public.position_stop(uuid, uuid, text, uuid, text) from public, anon, authenticated;

-- Livreur connecté par téléphone
create or replace function public.driver_share_position(p_trip uuid, p_lat double precision, p_lng double precision, p_acc real, p_captured_at timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  if not exists (select 1 from public.trips where id = p_trip and driver_id = v_driver and published_at is not null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return public.position_write(p_trip, v_driver, 'phone', null, p_lat, p_lng, p_acc, p_captured_at);
end $$;
revoke all on function public.driver_share_position(uuid, double precision, double precision, real, timestamptz) from public, anon;
grant execute on function public.driver_share_position(uuid, double precision, double precision, real, timestamptz) to authenticated;

create or replace function public.driver_stop_sharing(p_trip uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  if not exists (select 1 from public.trips where id = p_trip and driver_id = v_driver) then raise exception 'not_found' using errcode = 'P0002'; end if;
  return public.position_stop(p_trip, v_driver, 'phone', null, p_reason);
end $$;
revoke all on function public.driver_stop_sharing(uuid, text) from public, anon;
grant execute on function public.driver_stop_sharing(uuid, text) to authenticated;

-- Livreur avec un lien privé (appelé par le serveur /api/link seulement)
create or replace function public.link_share_position(p_hash text, p_lat double precision, p_lng double precision, p_acc real, p_captured_at timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare l public.driver_links;
begin
  l := public.link_valid(p_hash);      -- lien expiré, révoqué, tournée en brouillon… → refus
  return public.position_write(l.trip_id, l.driver_id, 'link', l.id, p_lat, p_lng, p_acc, p_captured_at);
end $$;
revoke all on function public.link_share_position(text, double precision, double precision, real, timestamptz) from public, anon, authenticated;
grant execute on function public.link_share_position(text, double precision, double precision, real, timestamptz) to service_role;

create or replace function public.link_stop_sharing(p_hash text, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare l public.driver_links;
begin
  select * into l from public.driver_links where token_hash = p_hash;      -- arrêter reste possible même si le lien vient d'expirer
  if not found then raise exception 'link_invalid' using errcode = '28000'; end if;
  if l.revoked_at is not null or l.expires_at <= now() then
    delete from public.driver_positions where trip_id = l.trip_id and link_id = l.id;
    return json_build_object('state', 'removed');
  end if;
  return public.position_stop(l.trip_id, l.driver_id, 'link', l.id, p_reason);
end $$;
revoke all on function public.link_stop_sharing(text, text) from public, anon, authenticated;
grant execute on function public.link_stop_sharing(text, text) to service_role;

-- Nettoyage : appelé par le serveur toutes les 5 minutes, et avant chaque lecture de l'équipe
create or replace function public.positions_cleanup() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; k int; v_midnight timestamptz := (date_trunc('day', now() at time zone 'Asia/Jerusalem')) at time zone 'Asia/Jerusalem';
begin
  -- tout ce qui date d'avant minuit (heure d'Israël)
  delete from public.driver_positions where received_at < v_midnight; get diagnostics k = row_count; n := n + k;
  -- accès retiré : tournée en brouillon, autre livreur, livreur désactivé, lien expiré ou révoqué
  delete from public.driver_positions p using public.trips r
   where r.id = p.trip_id and (r.published_at is null or r.driver_id is distinct from p.driver_id); get diagnostics k = row_count; n := n + k;
  delete from public.driver_positions p using public.drivers d where d.id = p.driver_id and not d.active; get diagnostics k = row_count; n := n + k;
  delete from public.driver_positions p using public.driver_links l
   where p.via = 'link' and l.id = p.link_id and (l.revoked_at is not null or l.expires_at <= now()); get diagnostics k = row_count; n := n + k;
  -- tournée terminée : le point disparaît
  update public.driver_positions set state = 'ended', lat = null, lng = null, accuracy_m = null, captured_at = null
   where state = 'active' and public.trip_finished(trip_id); get diagnostics k = row_count; n := n + k;
  -- plus de 10 minutes sans nouveau point : le point disparaît (« אין עדכון עדכני »)
  update public.driver_positions set state = 'lost', lat = null, lng = null, accuracy_m = null, captured_at = null
   where state = 'active' and received_at < now() - interval '10 minutes'; get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.positions_cleanup() from public, anon, authenticated;

-- Lecture de l'équipe : nettoyage d'abord, puis les positions
create or replace function public.staff_positions() returns setof public.driver_positions
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.positions_cleanup();
  return query select * from public.driver_positions;
end $$;
revoke all on function public.staff_positions() from public, anon;
grant execute on function public.staff_positions() to authenticated;

-- Accès retiré par l'équipe (brouillon, autre livreur) ou livreur désactivé : point effacé tout de suite
create or replace function public.tg_positions_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'trips' then
    if new.published_at is null or new.driver_id is distinct from old.driver_id then
      delete from public.driver_positions where trip_id = new.id;
    end if;
  elsif tg_table_name = 'drivers' then
    if not new.active then delete from public.driver_positions where driver_id = new.id; end if;
  elsif tg_table_name = 'driver_links' then
    if new.revoked_at is not null then delete from public.driver_positions where link_id = new.id; end if;
  end if;
  return null;
end $$;
drop trigger if exists positions_access on public.trips;
create trigger positions_access after update of driver_id, published_at on public.trips for each row execute function public.tg_positions_access();
drop trigger if exists positions_access on public.drivers;
create trigger positions_access after update of active on public.drivers for each row execute function public.tg_positions_access();
drop trigger if exists positions_access on public.driver_links;
create trigger positions_access after update of revoked_at on public.driver_links for each row execute function public.tg_positions_access();
