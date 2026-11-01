-- ============================================================
--  Tournées : les trajets du commercial (visites) et ceux des livreurs (livraisons) sont séparés.
--  Toutes les tournées existantes restent des visites. Seule une tournée de livraison peut avoir un livreur,
--  être envoyée à un livreur ou recevoir un lien privé. Aucune donnée supprimée.
-- ============================================================
alter table public.trips add column if not exists kind text not null default 'visit';
alter table public.trips drop constraint if exists trips_kind_check;
alter table public.trips add constraint trips_kind_check check (kind in ('visit', 'delivery'));
update public.trips set kind = 'delivery' where driver_id is not null and kind <> 'delivery';   -- (aucune aujourd'hui)
alter table public.trips drop constraint if exists trips_driver_needs_delivery;
alter table public.trips add constraint trips_driver_needs_delivery check (driver_id is null or kind = 'delivery');

-- lien privé : seulement pour une tournée de livraison (message clair au lieu d'une erreur de contrainte)
create or replace function public.staff_create_link(p_trip uuid, p_driver uuid, p_expires timestamptz) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_tok text; v_id uuid; v_replaced int; r public.trips; d public.drivers;
begin
  if not public.is_staff() then raise exception 'staff_only' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.kind <> 'delivery' then raise exception 'not_delivery' using errcode = '22023'; end if;
  select * into d from public.drivers where id = p_driver;
  if not found or not d.active then raise exception 'driver_inactive' using errcode = '22023'; end if;
  if p_expires is null or p_expires <= now() + interval '5 minutes' or p_expires > now() + interval '31 days' then
    raise exception 'bad_expiry' using errcode = '22023';
  end if;
  update public.trips set driver_id = p_driver, published_at = coalesce(published_at, now()) where id = p_trip;
  update public.driver_links set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'replaced'
   where trip_id = p_trip and revoked_at is null;
  get diagnostics v_replaced = row_count;
  v_tok := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.driver_links(trip_id, driver_id, token_hash, expires_at, created_by)
  values (p_trip, p_driver, encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), p_expires, auth.uid())
  returning id into v_id;
  insert into public.delivery_events(trip_id, actor, actor_kind, kind, from_value, to_value, note)
  values (p_trip, auth.uid(), 'staff', 'link_created', case when v_replaced > 0 then 'replaced' end, p_expires::text, p_driver::text);
  return json_build_object('id', v_id, 'token', v_tok, 'expires_at', p_expires);
end $$;
revoke all on function public.staff_create_link(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.staff_create_link(uuid, uuid, timestamptz) to authenticated;
notify pgrst, 'reload schema';
