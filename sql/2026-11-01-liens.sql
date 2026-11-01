-- ============================================================
--  Accès temporaire à UNE tournée par lien privé (sans connexion par téléphone) — ajouts uniquement.
--  Le lien contient une clé aléatoire de 256 bits ; la base n'en garde que l'empreinte SHA-256.
--  Chaque consultation / modification / fichier passe par le serveur (api/link.js, clé secrète),
--  qui appelle les fonctions link_* ci-dessous : elles revérifient à CHAQUE appel que le lien est
--  actif, non expiré, attribué au livreur actuel de la tournée, et que la tournée est envoyée.
--  La connexion par téléphone reste en place.
-- ============================================================

create table if not exists public.driver_links (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  driver_id     uuid not null references public.drivers(id) on delete cascade,
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),   -- empreinte, jamais la clé
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text,                                                          -- manual | replaced
  last_used_at  timestamptz
);
create index if not exists driver_links_trip_idx on public.driver_links(trip_id, created_at);
alter table public.driver_links enable row level security;
revoke all on public.driver_links from anon;
drop policy if exists "team read links" on public.driver_links;
create policy "team read links" on public.driver_links for select to authenticated using ((select public.is_staff()));

-- Historique : distinguer « via le lien attribué à ce livreur » d'une connexion réelle
alter table public.delivery_events  add column if not exists via_link uuid default nullif(current_setting('app.link_id', true), '')::uuid;
alter table public.delivery_proofs  add column if not exists link_id uuid;
alter table public.delivery_signatures add column if not exists link_id uuid;

create or replace function public.actor_kind() returns text
language sql stable security definer set search_path = public as $$
  select case when coalesce(current_setting('app.actor_kind', true), '') <> '' then current_setting('app.actor_kind', true)
              when auth.uid() is null then 'system'
              when public.is_staff() then 'staff'
              when exists (select 1 from public.drivers where user_id = auth.uid()) then 'driver'
              else 'system' end
$$;
create or replace function public.tg_proof_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value, note, via_link)
  values (new.trip_id, new.task_id, auth.uid(), case when new.link_id is not null then 'link' else public.actor_kind() end, 'proof', new.storage_path, new.note, new.link_id);
  return new;
end $$;
create or replace function public.tg_signature_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value, note, via_link)
  values (new.trip_id, new.task_id, (select user_id from public.drivers where id = new.driver_id),
          case when new.link_id is not null then 'link' else 'driver' end, 'signature', new.receiver_name, new.document_number, new.link_id);
  return new;
end $$;

-- Contenu d'une tournée pour le livreur (partagé : connexion par téléphone ET lien)
create or replace function public.trip_json(p_trip uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', r.id, 'date', r.date, 'name', r.name, 'published_at', r.published_at,
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
      from public.tasks t left join public.customers c on c.id = t.customer_id where t.trip_id = r.id), '[]'::json))
  from public.trips r where r.id = p_trip
$$;
create or replace function public.driver_trip(p_trip uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare r public.trips; v_driver uuid := public.current_driver_id();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip and driver_id = v_driver and published_at is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return public.trip_json(r.id);
end $$;

-- ---------- vérification d'un lien (à chaque appel) ----------
create or replace function public.link_valid(p_hash text) returns public.driver_links
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links; r public.trips; d public.drivers;
begin
  select * into l from public.driver_links where token_hash = p_hash;
  if not found then raise exception 'link_invalid' using errcode = '28000'; end if;
  if l.revoked_at is not null then raise exception 'link_revoked' using errcode = '28000'; end if;
  if l.expires_at <= now() then raise exception 'link_expired' using errcode = '28000'; end if;
  select * into r from public.trips where id = l.trip_id;
  select * into d from public.drivers where id = l.driver_id;
  if r.id is null or d.id is null or not d.active or r.driver_id is distinct from l.driver_id or r.published_at is null then
    raise exception 'link_inactive' using errcode = '28000';
  end if;
  update public.driver_links set last_used_at = now() where id = l.id;
  perform set_config('app.actor_kind', 'link', true);       -- historique : « via le lien »
  perform set_config('app.link_id', l.id::text, true);
  return l;
end $$;

-- état du lien (sans erreur) : pour le serveur avant un dépôt de fichier
create or replace function public.link_resolve(p_hash text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links; v_name text;
begin
  l := public.link_valid(p_hash);
  select name into v_name from public.drivers where id = l.driver_id;
  return json_build_object('status', 'ok', 'link_id', l.id, 'trip_id', l.trip_id, 'driver_id', l.driver_id, 'driver_name', v_name, 'expires_at', l.expires_at);
exception when sqlstate '28000' then
  return json_build_object('status', replace(sqlerrm, 'link_', ''));
end $$;

create or replace function public.link_trip(p_hash text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links;
begin
  l := public.link_valid(p_hash);
  return json_build_object('link', json_build_object('expires_at', l.expires_at, 'trip_id', l.trip_id,
                             'driver_name', (select name from public.drivers where id = l.driver_id)),
                           'trip', public.trip_json(l.trip_id));
end $$;

-- même règles que la connexion par téléphone, limitées à la tournée du lien
create or replace function public.link_set_status(p_hash text, p_task uuid, p_status text, p_note text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links; v_cur text; v_at timestamptz := now();
begin
  l := public.link_valid(p_hash);
  select t.delivery_status into v_cur from public.tasks t where t.id = p_task and t.trip_id = l.trip_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status is null or p_status not in ('delivered', 'partial', 'absent', 'impossible') then raise exception 'bad_status' using errcode = '22023'; end if;
  if p_status <> 'delivered' and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'note_required' using errcode = '22023'; end if;
  if v_cur is not null then raise exception 'already_validated' using errcode = '55000'; end if;
  update public.tasks set delivery_status = p_status, delivery_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
         delivered_at = v_at, delivered_by = l.driver_id, problem_resolved_at = null
   where id = p_task;
  return json_build_object('id', p_task, 'delivery_status', p_status, 'delivered_at', v_at);
end $$;

-- photo déjà déposée par le serveur dans « <tournée>/<arrêt>/<id>.jpg »
create or replace function public.link_add_proof(p_hash text, p_task uuid, p_path text, p_note text, p_captured_at timestamptz, p_mime text, p_bytes int) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links; v_cust uuid; p public.delivery_proofs;
begin
  l := public.link_valid(p_hash);
  select t.customer_id into v_cust from public.tasks t where t.id = p_task and t.trip_id = l.trip_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_path !~ ('^' || l.trip_id::text || '/' || p_task::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$') then raise exception 'bad_path' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'delivery-proofs' and o.name = p_path) then
    raise exception 'file_missing' using errcode = 'P0002';
  end if;
  insert into public.delivery_proofs(task_id, trip_id, customer_id, driver_id, storage_path, note, mime, bytes, captured_at, uploaded_by, link_id)
  values (p_task, l.trip_id, v_cust, l.driver_id, p_path, nullif(left(trim(coalesce(p_note, '')), 1000), ''), left(p_mime, 40), p_bytes, p_captured_at, null, l.id)
  on conflict (storage_path) do nothing;
  select * into p from public.delivery_proofs where storage_path = p_path;
  return json_build_object('id', p.id, 'path', p.storage_path, 'note', p.note, 'received_at', p.received_at);
end $$;

-- fichiers que le lien peut ouvrir : photos et signatures de SA tournée, bons Morning rattachés à SES arrêts
create or replace function public.link_paths(p_hash text, p_paths text[]) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links; v json;
begin
  l := public.link_valid(p_hash);
  select coalesce(json_agg(json_build_object('path', x.p, 'bucket', x.b)), '[]'::json) into v from (
    select p,
      case when exists (select 1 from public.delivery_documents dd join public.morning_documents m on m.morning_id = dd.morning_id
                        join public.tasks t on t.id = dd.task_id where m.pdf_path = p and t.trip_id = l.trip_id) then 'morning-pdf'
           when p ~ '^signatures/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(signed\.pdf|original\.pdf|signature\.png)$'
                and split_part(p, '/', 2) = l.trip_id::text
                and exists (select 1 from public.tasks t where t.id::text = split_part(p, '/', 3) and t.trip_id = l.trip_id) then 'delivery-proofs'
           when p ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
                and split_part(p, '/', 1) = l.trip_id::text
                and exists (select 1 from public.tasks t where t.id::text = split_part(p, '/', 2) and t.trip_id = l.trip_id) then 'delivery-proofs'
      end as b
    from unnest(p_paths[1:60]) as p) x where x.b is not null;
  return v;
end $$;

-- ---------- côté équipe : créer, prolonger, désactiver ----------
create or replace function public.staff_create_link(p_trip uuid, p_driver uuid, p_expires timestamptz) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_tok text; v_id uuid; v_replaced int; r public.trips; d public.drivers;
begin
  if not public.is_staff() then raise exception 'staff_only' using errcode = '42501'; end if;
  select * into r from public.trips where id = p_trip for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into d from public.drivers where id = p_driver;
  if not found or not d.active then raise exception 'driver_inactive' using errcode = '22023'; end if;
  if p_expires is null or p_expires <= now() + interval '5 minutes' or p_expires > now() + interval '31 days' then
    raise exception 'bad_expiry' using errcode = '22023';
  end if;
  -- le lien accompagne le livreur attribué ; créer le lien envoie la tournée (fin du brouillon, sans SMS)
  update public.trips set driver_id = p_driver, published_at = coalesce(published_at, now()) where id = p_trip;
  -- un seul lien valable par tournée : le précédent cesse de fonctionner
  update public.driver_links set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'replaced'
   where trip_id = p_trip and revoked_at is null;
  get diagnostics v_replaced = row_count;
  v_tok := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.driver_links(trip_id, driver_id, token_hash, expires_at, created_by)
  values (p_trip, p_driver, encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), p_expires, auth.uid())
  returning id into v_id;
  insert into public.delivery_events(trip_id, actor, actor_kind, kind, from_value, to_value, note)
  values (p_trip, auth.uid(), 'staff', 'link_created', case when v_replaced > 0 then 'replaced' end, p_expires::text, p_driver::text);
  return json_build_object('id', v_id, 'token', v_tok, 'expires_at', p_expires);   -- la clé n'est renvoyée qu'ici, une fois
end $$;

create or replace function public.staff_extend_link(p_link uuid, p_expires timestamptz) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links;
begin
  if not public.is_staff() then raise exception 'staff_only' using errcode = '42501'; end if;
  select * into l from public.driver_links where id = p_link for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if l.revoked_at is not null then raise exception 'link_revoked' using errcode = '22023'; end if;
  if p_expires is null or p_expires <= now() + interval '5 minutes' or p_expires > now() + interval '31 days' then
    raise exception 'bad_expiry' using errcode = '22023';
  end if;
  update public.driver_links set expires_at = p_expires where id = p_link;
  insert into public.delivery_events(trip_id, actor, actor_kind, kind, from_value, to_value)
  values (l.trip_id, auth.uid(), 'staff', 'link_extended', l.expires_at::text, p_expires::text);
  return json_build_object('id', p_link, 'expires_at', p_expires);
end $$;

create or replace function public.staff_revoke_link(p_link uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l public.driver_links;
begin
  if not public.is_staff() then raise exception 'staff_only' using errcode = '42501'; end if;
  select * into l from public.driver_links where id = p_link for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if l.revoked_at is null then
    update public.driver_links set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'manual' where id = p_link;
    insert into public.delivery_events(trip_id, actor, actor_kind, kind) values (l.trip_id, auth.uid(), 'staff', 'link_revoked');
  end if;
  return json_build_object('id', p_link, 'revoked', true);
end $$;

-- droits : fonctions link_* = serveur seulement ; staff_* = équipe connectée (vérifié dedans) ; trip_json interne
do $$ declare f text; begin
  foreach f in array array['trip_json(uuid)', 'link_valid(text)', 'link_resolve(text)', 'link_trip(text)', 'link_set_status(text,uuid,text,text)',
    'link_add_proof(text,uuid,text,text,timestamptz,text,int)', 'link_paths(text,text[])'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['staff_create_link(uuid,uuid,timestamptz)', 'staff_extend_link(uuid,timestamptz)', 'staff_revoke_link(uuid)', 'driver_trip(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
notify pgrst, 'reload schema';
