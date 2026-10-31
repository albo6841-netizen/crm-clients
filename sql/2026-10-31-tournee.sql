-- ============================================================
--  Nouvelle tournée (מסלולים v2) — ajouts uniquement, rien n'est supprimé
-- ============================================================

-- Arrêts (table tasks)
alter table public.tasks add column if not exists position    int;                         -- ordre dans la journée
alter table public.tasks add column if not exists skipped     boolean not null default false; -- « לא ביקרתי »
alter table public.tasks add column if not exists skip_reason text;                         -- raison du « pas visité »
alter table public.tasks add column if not exists visit_note  text;                         -- résumé de la visite

-- Journées (table trips) : heure de départ retenue
alter table public.trips add column if not exists start_time text;
