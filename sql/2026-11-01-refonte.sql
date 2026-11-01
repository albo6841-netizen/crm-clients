-- Refonte de l'app (01/11/2026)
-- Date d'échéance des documents Morning (pour calculer les retards de paiement)
alter table public.morning_documents add column if not exists due_date date;

-- Les visites notées depuis la fiche client sont des tâches de type 'visit' déjà faites
-- (même table que les arrêts de tournée) : aucune nouvelle table.

notify pgrst, 'reload schema';
