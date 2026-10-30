-- ============================================================
--  Branchement Morning (חשבונית ירוקה) — tables en LECTURE SEULE pour l'équipe
--  Seul le serveur (clé secrète Supabase) écrit dedans.
--  Ne contient que les clients Morning reliés à une fiche du CRM (par ח.פ).
-- ============================================================

-- 1) Fiches Morning reliées à une fiche CRM (un client CRM peut avoir plusieurs fiches Morning en double)
create table if not exists public.morning_clients (
  morning_id      uuid primary key,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  name            text,
  tax_id          text,
  active          boolean,
  income_amount   numeric,      -- total facturé selon Morning
  payment_amount  numeric,      -- total payé selon Morning
  balance_amount  numeric,      -- solde Morning = payé − facturé (négatif = le client doit)
  synced_at       timestamptz not null default now()
);
create index if not exists morning_clients_customer_idx on public.morning_clients(customer_id);

-- 2) Documents Morning (factures, avoirs, reçus…) des clients reliés
create table if not exists public.morning_documents (
  morning_id        uuid primary key,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  morning_client_id uuid not null,
  type              int  not null,   -- 305 חשבונית מס, 320 חשבונית מס/קבלה, 330 זיכוי, 400 קבלה, 300 חשבון עסקה, 200 תעודת משלוח…
  number            text,
  status            int  not null,   -- 0 פתוח, 1 סגור, 2 סגור ידנית, 3 מבטל, 4 בוטל
  doc_date          date,
  amount            numeric not null default 0,   -- montant en ₪ (amountLocal), signé comme dans Morning
  amount_opened     numeric,         -- reste à payer de la facture selon Morning
  description       text,
  pdf_path          text,            -- fichier dans le stockage privé « morning-pdf » (null = pas encore copié)
  synced_at         timestamptz not null default now()
);
create index if not exists morning_documents_customer_idx on public.morning_documents(customer_id, doc_date);

-- 3) État de la synchronisation (une seule ligne)
create table if not exists public.morning_sync (
  id          int primary key default 1 check (id = 1),
  last_run    timestamptz,
  last_ok     timestamptz,
  last_error  text,
  clients     int,
  documents   int
);
insert into public.morning_sync (id) values (1) on conflict (id) do nothing;

-- 4) Sécurité : l'équipe connectée peut LIRE, personne ne peut écrire (sauf le serveur, qui contourne RLS)
alter table public.morning_clients   enable row level security;
alter table public.morning_documents enable row level security;
alter table public.morning_sync      enable row level security;

drop policy if exists "team read" on public.morning_clients;
drop policy if exists "team read" on public.morning_documents;
drop policy if exists "team read" on public.morning_sync;
create policy "team read" on public.morning_clients   for select to authenticated using (true);
create policy "team read" on public.morning_documents for select to authenticated using (true);
create policy "team read" on public.morning_sync      for select to authenticated using (true);

-- 5) Mise à jour en direct dans l'appli
do $$ begin
  begin alter publication supabase_realtime add table public.morning_clients;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.morning_documents; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.morning_sync;      exception when duplicate_object then null; end;
end $$;

-- 6) Stockage privé des PDF originaux Morning : l'équipe peut seulement les ouvrir (lien de 2 minutes)
insert into storage.buckets (id, name, public)
values ('morning-pdf', 'morning-pdf', false)
on conflict (id) do nothing;

drop policy if exists "team read morning pdf" on storage.objects;
create policy "team read morning pdf" on storage.objects for select to authenticated using (bucket_id = 'morning-pdf');
