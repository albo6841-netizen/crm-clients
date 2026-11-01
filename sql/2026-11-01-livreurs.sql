-- ============================================================
--  Espace livreurs (01/11/2026) — AJOUTS UNIQUEMENT, aucune donnée supprimée.
--  Réutilise les tournées (trips) et leurs arrêts (tasks) : pas de doublon.
--
--  Principe de sécurité :
--   * l'équipe (table app_staff) garde l'accès complet au CRM, comme avant ;
--   * un livreur est un compte connecté SANS accès direct aux tables :
--     il passe uniquement par les fonctions driver_* ci-dessous, qui vérifient
--     à chaque appel que l'arrêt appartient à une tournée PUBLIÉE et attribuée
--     à CE livreur, ACTIF. Même règle dans le stockage des documents.
-- ============================================================

-- ---------- 0) L'équipe ----------
create table if not exists public.app_staff (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.app_staff enable row level security;          -- aucune règle : illisible par l'appli
revoke all on public.app_staff from anon, authenticated;

-- Les comptes existants (connexion par e-mail) forment l'équipe
insert into public.app_staff(user_id)
select id from auth.users where email is not null and coalesce(phone, '') = ''
on conflict do nothing;

-- Un compte créé plus tard avec un e-mail (et sans téléphone) rejoint l'équipe ;
-- les livreurs sont créés par le serveur avec un téléphone seulement.
create or replace function public.tg_staff_on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and coalesce(new.phone, '') = '' then
    insert into public.app_staff(user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists staff_on_new_user on auth.users;
create trigger staff_on_new_user after insert on auth.users
  for each row execute function public.tg_staff_on_new_user();

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_staff where user_id = auth.uid())
$$;

-- ---------- 1) Livreurs ----------
create table if not exists public.drivers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  phone      text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),   -- format international
  active     boolean not null default true,
  user_id    uuid unique references auth.users(id) on delete set null,      -- compte de connexion (créé par le serveur)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.drivers enable row level security;
revoke all on public.drivers from anon;

-- Le livreur connecté (null s'il est désactivé ou s'il n'est pas livreur)
create or replace function public.current_driver_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.drivers where user_id = auth.uid() and active
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.is_staff() then 'staff'
    when exists (select 1 from public.drivers where user_id = auth.uid() and active) then 'driver'
    when exists (select 1 from public.drivers where user_id = auth.uid()) then 'driver_inactive'
    else 'none' end
$$;

-- ---------- 2) Tournées : livreur attribué, brouillon / publiée ----------
alter table public.trips add column if not exists driver_id    uuid references public.drivers(id) on delete restrict;
alter table public.trips add column if not exists published_at timestamptz;   -- null = brouillon (aucune notification)
alter table public.trips drop constraint if exists trips_published_needs_driver;
alter table public.trips add constraint trips_published_needs_driver check (published_at is null or driver_id is not null);
create index if not exists trips_driver_idx on public.trips(driver_id) where driver_id is not null;

-- ---------- 3) Arrêts : la livraison ----------
alter table public.tasks add column if not exists delivery_status       text;          -- null = à livrer
alter table public.tasks add column if not exists delivery_note         text;          -- explication du livreur
alter table public.tasks add column if not exists delivered_at          timestamptz;   -- heure de validation
alter table public.tasks add column if not exists delivered_by          uuid references public.drivers(id) on delete set null;
alter table public.tasks add column if not exists delivery_instructions text;          -- consignes (équipe)
alter table public.tasks add column if not exists problem_resolved_at   timestamptz;   -- problème traité par l'équipe
alter table public.tasks drop constraint if exists tasks_delivery_status_check;
alter table public.tasks add constraint tasks_delivery_status_check
  check (delivery_status is null or delivery_status in ('delivered', 'partial', 'absent', 'impossible'));
create index if not exists tasks_trip_idx on public.tasks(trip_id);

-- Bons de livraison : documents Morning (originaux, non modifiés) rattachés à un arrêt
create table if not exists public.delivery_documents (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  morning_id uuid not null references public.morning_documents(morning_id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (task_id, morning_id)
);
alter table public.delivery_documents enable row level security;
revoke all on public.delivery_documents from anon;

-- ---------- 4) Preuves de livraison (photos du bon signé) ----------
create table if not exists public.delivery_proofs (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid references public.tasks(id) on delete set null,      -- la livraison
  trip_id      uuid not null,
  customer_id  uuid references public.customers(id) on delete set null, -- le client
  driver_id    uuid references public.drivers(id) on delete set null,   -- le livreur
  kind         text not null default 'photo' check (kind in ('photo')),
  storage_path text not null unique,                                   -- fichier dans le stockage privé « delivery-proofs »
  note         text,
  mime         text,
  bytes        int,
  captured_at  timestamptz,                                            -- moment de la photo (téléphone)
  received_at  timestamptz not null default now(),                     -- reçu et enregistré par le serveur
  uploaded_by  uuid
);
create index if not exists delivery_proofs_task_idx on public.delivery_proofs(task_id);
alter table public.delivery_proofs enable row level security;
revoke all on public.delivery_proofs from anon;

-- Étape 2 (structure prête, pas encore utilisée) : signature au doigt LIÉE À UN DOCUMENT PRÉCIS.
-- On garde le tracé (pas une image isolée) + l'empreinte du fichier affiché au moment de signer.
create table if not exists public.delivery_signatures (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references public.tasks(id) on delete set null,
  driver_id       uuid references public.drivers(id) on delete set null,
  morning_id      uuid,                                                -- document Morning signé…
  proof_id        uuid references public.delivery_proofs(id) on delete restrict,  -- …ou pièce envoyée signée
  document_number text,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  receiver_name   text not null check (length(trim(receiver_name)) > 1),          -- personne qui réceptionne
  strokes         jsonb not null,                                      -- tracé du doigt (points)
  signed_at       timestamptz not null default now(),
  constraint delivery_signatures_one_document check (morning_id is not null or proof_id is not null)
);
alter table public.delivery_signatures enable row level security;
revoke all on public.delivery_signatures from anon;

-- ---------- 5) Historique et notifications ----------
create table if not exists public.delivery_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  trip_id    uuid,
  task_id    uuid,
  actor      uuid,
  actor_kind text not null default 'system',   -- staff | driver | system
  kind       text not null,                    -- assigned, reassigned, unassigned, published, unpublished, status, reopened, resolved, proof, notified
  from_value text,
  to_value   text,
  note       text
);
create index if not exists delivery_events_trip_idx on public.delivery_events(trip_id, at);
alter table public.delivery_events enable row level security;
revoke all on public.delivery_events from anon;

create table if not exists public.delivery_notifications (
  id         bigint generated always as identity primary key,
  trip_id    uuid not null,
  driver_id  uuid,
  status     text not null check (status in ('sent', 'failed', 'not_configured')),
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists delivery_notifications_trip_idx on public.delivery_notifications(trip_id, created_at);
alter table public.delivery_notifications enable row level security;
revoke all on public.delivery_notifications from anon;

create or replace function public.actor_kind() returns text
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then 'system'
              when public.is_staff() then 'staff'
              when exists (select 1 from public.drivers where user_id = auth.uid()) then 'driver'
              else 'system' end
$$;

create or replace function public.tg_trip_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := public.actor_kind();
begin
  if tg_op = 'INSERT' then
    if new.driver_id is not null then
      insert into public.delivery_events(trip_id, actor, actor_kind, kind, to_value) values (new.id, auth.uid(), k, 'assigned', new.driver_id::text);
    end if;
    if new.published_at is not null then
      insert into public.delivery_events(trip_id, actor, actor_kind, kind, to_value) values (new.id, auth.uid(), k, 'published', new.driver_id::text);
    end if;
    return new;
  end if;
  if new.driver_id is distinct from old.driver_id then
    insert into public.delivery_events(trip_id, actor, actor_kind, kind, from_value, to_value)
    values (new.id, auth.uid(), k,
            case when old.driver_id is null then 'assigned' when new.driver_id is null then 'unassigned' else 'reassigned' end,
            old.driver_id::text, new.driver_id::text);
  end if;
  if new.published_at is distinct from old.published_at then
    insert into public.delivery_events(trip_id, actor, actor_kind, kind, to_value)
    values (new.id, auth.uid(), k, case when new.published_at is null then 'unpublished' else 'published' end, new.driver_id::text);
  end if;
  return new;
end $$;
drop trigger if exists trip_events on public.trips;
create trigger trip_events after insert or update of driver_id, published_at on public.trips
  for each row execute function public.tg_trip_events();

create or replace function public.tg_task_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := public.actor_kind();
begin
  if new.delivery_status is distinct from old.delivery_status then
    insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, from_value, to_value, note)
    values (new.trip_id, new.id, auth.uid(), k, case when new.delivery_status is null then 'reopened' else 'status' end,
            old.delivery_status, new.delivery_status, new.delivery_note);
  end if;
  if new.problem_resolved_at is not null and old.problem_resolved_at is null then
    insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value)
    values (new.trip_id, new.id, auth.uid(), k, 'resolved', new.delivery_status);
  end if;
  return new;
end $$;
drop trigger if exists task_events on public.tasks;
create trigger task_events after update of delivery_status, problem_resolved_at on public.tasks
  for each row execute function public.tg_task_events();

create or replace function public.tg_proof_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.delivery_events(trip_id, task_id, actor, actor_kind, kind, to_value, note)
  values (new.trip_id, new.task_id, auth.uid(), public.actor_kind(), 'proof', new.storage_path, new.note);
  return new;
end $$;
drop trigger if exists proof_events on public.delivery_proofs;
create trigger proof_events after insert on public.delivery_proofs
  for each row execute function public.tg_proof_events();

-- ---------- 6) Accès : l'équipe seulement sur les tables du CRM ----------
alter policy "team access" on public.customers         using ((select public.is_staff())) with check ((select public.is_staff()));
alter policy "invoices_all" on public.invoices         using ((select public.is_staff())) with check ((select public.is_staff()));
alter policy "team tasks"  on public.tasks             using ((select public.is_staff())) with check ((select public.is_staff()));
alter policy "team trips"  on public.trips             using ((select public.is_staff())) with check ((select public.is_staff()));
alter policy "team read"   on public.morning_clients   using ((select public.is_staff()));
alter policy "team read"   on public.morning_documents using ((select public.is_staff()));
alter policy "team read"   on public.morning_sync      using ((select public.is_staff()));

drop policy if exists "team read drivers" on public.drivers;
create policy "team read drivers" on public.drivers for select to authenticated using ((select public.is_staff()));
-- (création / modification des livreurs : par le serveur seulement, en même temps que leur compte de connexion)
drop policy if exists "team delivery documents" on public.delivery_documents;
create policy "team delivery documents" on public.delivery_documents for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "team read proofs" on public.delivery_proofs;
create policy "team read proofs" on public.delivery_proofs for select to authenticated using ((select public.is_staff()));
drop policy if exists "team read events" on public.delivery_events;
create policy "team read events" on public.delivery_events for select to authenticated using ((select public.is_staff()));
drop policy if exists "team read notifications" on public.delivery_notifications;
create policy "team read notifications" on public.delivery_notifications for select to authenticated using ((select public.is_staff()));
drop policy if exists "team read signatures" on public.delivery_signatures;
create policy "team read signatures" on public.delivery_signatures for select to authenticated using ((select public.is_staff()));

-- ---------- 7) Ce que le livreur a le droit de voir et de faire ----------
-- Un fichier de preuve « <tournée>/<arrêt>/<id>.jpg » appartient-il à un arrêt du livreur connecté ?
create or replace function public.driver_proof_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
     and exists (
       select 1 from public.tasks t join public.trips r on r.id = t.trip_id
       where r.id::text = split_part(p_name, '/', 1) and t.id::text = split_part(p_name, '/', 2)
         and r.published_at is not null and r.driver_id = public.current_driver_id())
$$;
-- Un PDF Morning est-il un bon rattaché à un arrêt du livreur connecté ?
create or replace function public.driver_morning_pdf_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.delivery_documents dd
    join public.morning_documents m on m.morning_id = dd.morning_id
    join public.tasks t on t.id = dd.task_id
    join public.trips r on r.id = t.trip_id
    where m.pdf_path = p_name and r.published_at is not null and r.driver_id = public.current_driver_id())
$$;

create or replace function public.driver_me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', d.id, 'name', d.name, 'phone', d.phone, 'active', d.active)
  from public.drivers d where d.user_id = auth.uid()
$$;

-- Mes tournées publiées (7 derniers jours et à venir) : date, secteur, nombre de livraisons, progression
create or replace function public.driver_my_trips() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.date nulls last, x.name), '[]'::json) from (
    select r.id, r.date, r.name, r.published_at,
      (select count(*) from public.tasks t where t.trip_id = r.id) as total,
      (select count(*) from public.tasks t where t.trip_id = r.id and t.delivery_status is not null) as done,
      (select coalesce(json_agg(c2.city order by c2.first), '[]'::json) from (
         select coalesce(nullif(trim(c.city), ''), t.city) as city, min(coalesce(t.position, 9999)) as first
         from public.tasks t left join public.customers c on c.id = t.customer_id
         where t.trip_id = r.id group by 1) c2 where c2.city is not null) as cities
    from public.trips r
    where r.driver_id = public.current_driver_id() and r.published_at is not null
      and (r.date is null or r.date >= (now() at time zone 'Asia/Jerusalem')::date - 7)
  ) x
$$;

-- Une tournée : seulement les informations utiles à la livraison (ni finances, ni notes commerciales)
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
                    'doc_date', m.doc_date, 'pdf_path', m.pdf_path) order by m.doc_date desc)
                  from public.delivery_documents dd join public.morning_documents m on m.morning_id = dd.morning_id
                  where dd.task_id = t.id), '[]'::json),
        'proofs', coalesce((select json_agg(json_build_object('id', p.id, 'path', p.storage_path, 'note', p.note,
                    'received_at', p.received_at) order by p.received_at)
                  from public.delivery_proofs p where p.task_id = t.id), '[]'::json)
      ) order by t.position nulls last, t.created_at)
      from public.tasks t left join public.customers c on c.id = t.customer_id where t.trip_id = r.id), '[]'::json));
end $$;

-- Valider une livraison (une seule fois ; l'équipe peut la rouvrir). Ne touche à rien de comptable.
create or replace function public.driver_set_status(p_task uuid, p_status text, p_note text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id(); v_cur text; v_at timestamptz := now();
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select t.delivery_status into v_cur from public.tasks t join public.trips r on r.id = t.trip_id
   where t.id = p_task and r.driver_id = v_driver and r.published_at is not null for update of t;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status is null or p_status not in ('delivered', 'partial', 'absent', 'impossible') then raise exception 'bad_status' using errcode = '22023'; end if;
  if p_status <> 'delivered' and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'note_required' using errcode = '22023'; end if;
  if v_cur is not null then raise exception 'already_validated' using errcode = '55000'; end if;
  update public.tasks set delivery_status = p_status, delivery_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
         delivered_at = v_at, delivered_by = v_driver, problem_resolved_at = null
   where id = p_task;
  return json_build_object('id', p_task, 'delivery_status', p_status, 'delivered_at', v_at);
end $$;

-- Enregistrer une photo déjà déposée dans le stockage. Renvoie la ligne seulement si tout est confirmé.
create or replace function public.driver_add_proof(p_task uuid, p_path text, p_note text, p_captured_at timestamptz, p_mime text, p_bytes int) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id(); v_trip uuid; v_cust uuid; p public.delivery_proofs;
begin
  if v_driver is null then raise exception 'not_driver' using errcode = '42501'; end if;
  select t.trip_id, t.customer_id into v_trip, v_cust from public.tasks t join public.trips r on r.id = t.trip_id
   where t.id = p_task and r.driver_id = v_driver and r.published_at is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
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
end $$;

-- Serveur seulement : retrouver un compte de connexion existant par son numéro (sans « + »)
create or replace function public.admin_auth_user_by_phone(p_phone text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from auth.users where phone = p_phone limit 1
$$;
revoke all on function public.admin_auth_user_by_phone(text) from public, anon, authenticated;
grant execute on function public.admin_auth_user_by_phone(text) to service_role;

-- Fonctions : jamais pour les visiteurs non connectés
do $$ declare f text; begin
  foreach f in array array['is_staff()', 'current_driver_id()', 'my_role()', 'actor_kind()', 'driver_proof_path_ok(text)', 'driver_morning_pdf_ok(text)',
    'driver_me()', 'driver_my_trips()', 'driver_trip(uuid)', 'driver_set_status(uuid,text,text)',
    'driver_add_proof(uuid,text,text,timestamptz,text,int)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['tg_staff_on_new_user()', 'tg_trip_events()', 'tg_task_events()', 'tg_proof_events()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ---------- 8) Stockage ----------
-- Documents existants : l'équipe seulement (les PDF Morning rattachés à un arrêt : aussi le livreur de cet arrêt)
drop policy if exists "team read morning pdf" on storage.objects;
create policy "team read morning pdf" on storage.objects for select to authenticated
  using (bucket_id = 'morning-pdf' and ((select public.is_staff()) or public.driver_morning_pdf_ok(name)));
drop policy if exists "team read docs" on storage.objects;
create policy "team read docs" on storage.objects for select to authenticated using (bucket_id = 'documents' and (select public.is_staff()));
drop policy if exists "team upload docs" on storage.objects;
create policy "team upload docs" on storage.objects for insert to authenticated with check (bucket_id = 'documents' and (select public.is_staff()));
drop policy if exists "team delete docs" on storage.objects;
create policy "team delete docs" on storage.objects for delete to authenticated using (bucket_id = 'documents' and (select public.is_staff()));

-- Preuves de livraison : privé ; le livreur dépose et relit seulement pour SES arrêts ; personne ne remplace ni n'efface
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-proofs', 'delivery-proofs', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "proofs team read" on storage.objects;
create policy "proofs team read" on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and (select public.is_staff()));
drop policy if exists "proofs driver read" on storage.objects;
create policy "proofs driver read" on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and public.driver_proof_path_ok(name));
drop policy if exists "proofs driver upload" on storage.objects;
create policy "proofs driver upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-proofs' and public.driver_proof_path_ok(name));

-- ---------- 9) Mise à jour en direct dans le CRM ----------
do $$ begin
  begin alter publication supabase_realtime add table public.delivery_proofs;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.delivery_notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.drivers;                exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';
