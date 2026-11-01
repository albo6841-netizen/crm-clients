-- ============================================================
--  Retirer un arrêt d'une tournée (équipe seulement), en une seule opération.
--  Ajout uniquement : une fonction. Rien d'existant n'est modifié.
--
--  • Visite déjà faite (commercial) : retirée de la tournée mais gardée dans l'historique du client.
--  • Sinon : l'arrêt est supprimé (documents liés supprimés en cascade) ; le livreur ne le voit plus.
--  • Refus s'il existe une photo ou une signature pour cet arrêt (preuve de livraison).
-- ============================================================
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
  select kind into v_kind from public.trips where id = t.trip_id;
  if coalesce(v_kind, 'visit') = 'visit' and t.done and not t.skipped then
    update public.tasks set trip_id = null, type = 'visit', position = null where id = p_task;
    return json_build_object('result', 'kept_visit');
  end if;
  delete from public.tasks where id = p_task;
  return json_build_object('result', 'deleted');
end $$;

revoke all on function public.staff_remove_stop(uuid) from public, anon;
grant execute on function public.staff_remove_stop(uuid) to authenticated;
