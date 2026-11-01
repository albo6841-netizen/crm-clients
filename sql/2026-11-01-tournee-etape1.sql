-- ============================================================
--  Tournée du livreur, étape 1 (écran de l'équipe) — ajouts uniquement.
--  Rien n'est supprimé ; les fonctions lues par la page du livreur ne changent pas.
-- ============================================================

-- Cadenas : l'arrêt reste à cette place (1 = première place de la tournée)
alter table public.tasks add column if not exists locked_position int;
alter table public.tasks drop constraint if exists tasks_locked_position_check;
alter table public.tasks add constraint tasks_locked_position_check check (locked_position is null or locked_position > 0);

-- Heure limite de réception confirmée par l'équipe pour cet arrêt (« HH:MM »)
alter table public.tasks add column if not exists receive_until text;
alter table public.tasks drop constraint if exists tasks_receive_until_check;
alter table public.tasks add constraint tasks_receive_until_check check (receive_until is null or receive_until ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Position exacte du départ et de l'arrivée (« lat, lng »), quand l'adresse a été choisie dans les suggestions
alter table public.trips add column if not exists start_gps text;
alter table public.trips add column if not exists end_gps text;
