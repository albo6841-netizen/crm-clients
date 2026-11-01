-- ============================================================
--  Suppression d'une tournée depuis le CRM (équipe seulement), en une seule opération.
--  Ajout uniquement : une fonction. Rien d'existant n'est modifié.
--
--  • Tournée du commercial : les visites déjà faites restent dans l'historique du client
--    (elles deviennent des visites notées) ; les arrêts pas encore faits sont supprimés.
--  • Tournée du livreur : refusée dès qu'il y a une photo ou une signature (preuve de livraison).
--    Sinon : arrêts, documents liés et liens privés supprimés ; le livreur ne voit plus la tournée.
--  Les arrêts ne sont pas liés aux tournées par une clé étrangère : sans cette fonction,
--  supprimer la tournée seule laisserait ses arrêts « orphelins ».
-- ============================================================
create or replace function public.staff_delete_trip(p_trip uuid)
returns json language plpgsql security definer set search_path = public as $$
declare r public.trips; v_kept int := 0; v_del int := 0;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  if exists (select 1 from public.delivery_proofs p
              where p.trip_id = p_trip or p.task_id in (select id from public.tasks where trip_id = p_trip))
     or exists (select 1 from public.delivery_signatures s
              where s.trip_id = p_trip or s.task_id in (select id from public.tasks where trip_id = p_trip)) then
    raise exception 'trip_has_proofs' using errcode = 'P0001';
  end if;

  if r.kind = 'visit' then
    update public.tasks set trip_id = null, type = 'visit', position = null
     where trip_id = p_trip and done and not skipped;
    get diagnostics v_kept = row_count;
  end if;

  delete from public.tasks where trip_id = p_trip;      -- documents liés : supprimés en cascade
  get diagnostics v_del = row_count;
  delete from public.trips where id = p_trip;           -- liens privés : supprimés en cascade
  return json_build_object('deleted_stops', v_del, 'kept_visits', v_kept);
end $$;

revoke all on function public.staff_delete_trip(uuid) from public, anon;
grant execute on function public.staff_delete_trip(uuid) to authenticated;
