-- ============================================================
--  Revue P1-4 + P2-11 : enregistrement de l'ordre des arrêts en UNE opération.
--  • Tout l'ordre est écrit d'un coup (jamais à moitié) ou rien du tout.
--  • Contrôles côté serveur, même si l'écran fonctionne :
--      - liste sans doublon, sans arrêt inconnu ni d'une autre tournée ('bad_order') ;
--      - exactement les arrêts actifs de la tournée ('order_mismatch' : un arrêt a été ajouté ou retiré entre-temps) ;
--      - l'ordre de départ attendu est toujours celui de la base ('order_changed' : quelqu'un d'autre l'a modifié) ;
--      - tournée du livreur : un arrêt déjà traité garde sa place ('handled_moved').
--  • Aucune donnée existante modifiée par cette migration ; la publication au livreur (staff_publish_trip) est inchangée.
-- ============================================================
begin;

create or replace function public.staff_save_order(p_trip uuid, p_order uuid[], p_expected uuid[])
returns json language plpgsql security definer set search_path = public as $$
declare v_kind text; v_live uuid[]; v_cur uuid[]; n int;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  -- verrou de la tournée : deux enregistrements simultanés passent l'un après l'autre
  select kind into v_kind from public.trips where id = p_trip for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  n := coalesce(cardinality(p_order), 0);
  if n = 0 or array_position(p_order, null) is not null
     or (select count(distinct x) from unnest(p_order) x) <> n
     or coalesce(cardinality(p_expected), 0) <> n
     or (select count(distinct x) from unnest(p_expected) x) <> n
     or exists (select 1 from unnest(p_order) x where not (x = any(p_expected))) then
    raise exception 'bad_order' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_order) x left join public.tasks t on t.id = x and t.trip_id = p_trip where t.id is null) then
    raise exception 'bad_order' using errcode = '22023';
  end if;

  -- les arrêts actifs de la tournée (sans les annulés ni les retraits en attente) = exactement la liste reçue
  select coalesce(array_agg(t.id), '{}') into v_live from public.tasks t
   where t.trip_id = p_trip and t.cancelled_at is null and not coalesce(t.removal_pending, false);
  if cardinality(v_live) <> n or exists (select 1 from unnest(v_live) x where not (x = any(p_order))) then
    raise exception 'order_mismatch' using errcode = 'P0001';
  end if;

  -- l'ordre sur lequel l'écran s'est basé est-il toujours celui de la base ?
  select array_agg(t.id order by t.position nulls last, t.created_at, t.id) into v_cur
    from public.tasks t where t.id = any(p_expected);
  if v_cur is distinct from p_expected then
    raise exception 'order_changed' using errcode = 'P0001';
  end if;

  -- tournée du livreur : un arrêt déjà traité ne change pas de place
  if v_kind = 'delivery' and exists (
       select 1 from public.tasks t
        where t.id = any(p_order) and t.delivery_status is not null and t.delivery_status <> 'pending'
          and array_position(p_order, t.id) <> array_position(p_expected, t.id)) then
    raise exception 'handled_moved' using errcode = 'P0001';
  end if;

  update public.tasks t set position = o.k
    from unnest(p_order) with ordinality as o(id, k)
   where t.id = o.id and t.position is distinct from o.k::int;
  return json_build_object('ok', true, 'count', n);
end $$;

revoke all on function public.staff_save_order(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.staff_save_order(uuid, uuid[], uuid[]) to authenticated;

commit;
