-- Avoirs (חשבונית זיכוי, type 330) : facture(s) auxquelles Morning les relie.
-- Rempli par la synchro (GET /documents/{id}/linked de Morning, lecture seule), une seule demande par avoir.
--   null = pas encore demandé à Morning ; {} = demandé, aucune facture liée.
-- Lisible par l'équipe comme le reste de la table (règle « team read » inchangée).
alter table public.morning_documents add column if not exists linked_ids text[];
