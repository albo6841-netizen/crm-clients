-- ============================================================
--  Succursales (סניפים) dans les tournées
--  • Un arrêt peut viser une succursale précise d'un client (franchise avec plusieurs magasins).
--  • Le livreur voit alors le nom, l'adresse, le téléphone et la position de la succursale.
--  Ajout d'une colonne + nouvelle version de deux fonctions de lecture. Rien n'est supprimé.
--  Retour arrière : remettre les anciennes définitions (fichiers 2026-11-01-signature.sql / livreurs.sql) ;
--  la colonne branch_id peut rester (vide = magasin principal).
-- ============================================================
alter table public.tasks add column if not exists branch_id text;   -- id de la succursale dans customers.branches (vide = adresse principale)

-- La succursale d'un arrêt (ou null)
create or replace function public.stop_branch(p_branches jsonb, p_branch text)
returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(case when jsonb_typeof(p_branches) = 'array' then p_branches else '[]'::jsonb end) e
   where p_branch is not null and e->>'id' = p_branch limit 1
$$;
revoke all on function public.stop_branch(jsonb, text) from public, anon, authenticated;   -- utilisée seulement à l'intérieur des fonctions ci-dessous

create or replace function public.trip_json(p_trip uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', r.id, 'date', r.date, 'name', r.name, 'published_at', r.published_at,
    'stops', coalesce((select json_agg(json_build_object(
        'id', t.id, 'position', t.position, 'created_at', t.created_at,
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
      ) order by t.position nulls last, t.created_at)
      from public.tasks t left join public.customers c on c.id = t.customer_id
      cross join lateral (select public.stop_branch(c.branches, t.branch_id) as b) sb
      where t.trip_id = r.id), '[]'::json))
  from public.trips r where r.id = p_trip
$$;

create or replace function public.driver_my_trips()
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.date nulls last, x.name), '[]'::json) from (
    select r.id, r.date, r.name, r.published_at,
      (select count(*) from public.tasks t where t.trip_id = r.id) as total,
      (select count(*) from public.tasks t where t.trip_id = r.id and t.delivery_status is not null) as done,
      (select coalesce(json_agg(c2.city order by c2.first), '[]'::json) from (
         select coalesce(case when b is not null then nullif(trim(b->>'city'), '') else nullif(trim(c.city), '') end, t.city) as city,
                min(coalesce(t.position, 9999)) as first
         from public.tasks t left join public.customers c on c.id = t.customer_id
         cross join lateral (select public.stop_branch(c.branches, t.branch_id) as b) sb
         where t.trip_id = r.id group by 1) c2 where c2.city is not null) as cities
    from public.trips r
    where r.driver_id = public.current_driver_id() and r.published_at is not null
      and (r.date is null or r.date >= (now() at time zone 'Asia/Jerusalem')::date - 7)
  ) x
$$;
