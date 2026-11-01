-- ============================================================
--  Étape 2 : signature au doigt LIÉE À UN DOCUMENT PRÉCIS (01/11/2026) — ajouts uniquement.
--  Une signature = un arrêt + un document Morning rattaché + l'empreinte SHA-256 du fichier exact affiché
--  + le nom du réceptionnaire + le tracé. Le serveur garde une copie figée du fichier (octets identiques)
--  et un exemplaire signé (document + page de signature). Le PDF Morning d'origine n'est jamais modifié.
--  Seul le serveur écrit (api/driver-sign.js, clé secrète) ; il vérifie le livreur, l'arrêt et l'empreinte.
-- ============================================================

alter table public.delivery_signatures add column if not exists request_id        uuid;          -- même envoi = même identifiant (pas de doublon en cas de nouvel essai)
alter table public.delivery_signatures add column if not exists trip_id           uuid;
alter table public.delivery_signatures add column if not exists customer_id       uuid references public.customers(id) on delete set null;
alter table public.delivery_signatures add column if not exists original_pdf_path text;          -- copie figée du document signé (octets identiques à l'empreinte)
alter table public.delivery_signatures add column if not exists signed_pdf_path   text;          -- exemplaire signé : document + page de signature
alter table public.delivery_signatures add column if not exists image_path        text;          -- tracé rendu en image (affichage)
alter table public.delivery_signatures add column if not exists client_signed_at  timestamptz;   -- heure du téléphone (indicative)
comment on column public.delivery_signatures.signed_at is 'heure du serveur à la réception (fait foi)';
create unique index if not exists delivery_signatures_request_idx on public.delivery_signatures(request_id);
create unique index if not exists delivery_signatures_doc_idx on public.delivery_signatures(task_id, morning_id)
  where task_id is not null and morning_id is not null;                      -- un document = une signature par livraison

-- Historique : « document signé », attribué au livreur
create or replace function public.tg_signature_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value, note)
  values (new.trip_id, new.task_id, (select user_id from public.drivers where id = new.driver_id), 'driver', 'signature', new.receiver_name, new.document_number);
  return new;
end $$;
drop trigger if exists signature_events on public.delivery_signatures;
create trigger signature_events after insert on public.delivery_signatures
  for each row execute function public.tg_signature_events();
revoke all on function public.tg_signature_events() from public, anon, authenticated;

-- Le livreur voit, pour chaque document de ses arrêts, s'il est déjà signé
create or replace function public.driver_trip(p_trip uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare r public.trips; v_driver uuid := public.current_driver_id();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip and driver_id = v_driver and published_at is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return json_build_object('id', r.id, 'date', r.date, 'name', r.name, 'published_at', r.published_at,
    'stops', coalesce((select json_agg(json_build_object(
        'id', t.id, 'position', t.position, 'created_at', t.created_at,
        'name', coalesce(c.name, t.title), 'street', c.street,
        'city', coalesce(nullif(trim(c.city), ''), t.city),
        'contact', c.contact, 'phone', c.phone, 'phone2', c.phone2, 'gps', c.gps,
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
      from public.tasks t left join public.customers c on c.id = t.customer_id where t.trip_id = r.id), '[]'::json));
end $$;

-- Stockage : les fichiers de signature (« signatures/<tournée>/<arrêt>/<envoi>/… ») sont écrits par le serveur seulement ;
-- le livreur peut relire ceux de SES arrêts (tournée publiée, attribuée, livreur actif) ; l'équipe lit tout le compartiment.
create or replace function public.driver_signature_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 1) = 'signatures'
     and p_name ~ '^signatures/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(signed\.pdf|original\.pdf|signature\.png)$'
     and exists (
       select 1 from public.tasks t join public.trips r on r.id = t.trip_id
       where r.id::text = split_part(p_name, '/', 2) and t.id::text = split_part(p_name, '/', 3)
         and r.published_at is not null and r.driver_id = public.current_driver_id())
$$;
revoke all on function public.driver_signature_path_ok(text) from public, anon;
grant execute on function public.driver_signature_path_ok(text) to authenticated;
drop policy if exists "signatures driver read" on storage.objects;
create policy "signatures driver read" on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and public.driver_signature_path_ok(name));
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] where id = 'delivery-proofs';

do $$ begin
  begin alter publication supabase_realtime add table public.delivery_signatures; exception when duplicate_object then null; end;
end $$;
notify pgrst, 'reload schema';
