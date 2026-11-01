-- Nettoyage de secours des positions par le serveur, toutes les 5 minutes (indépendant des pages ouvertes).
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'positions-cleanup';
select cron.schedule('positions-cleanup', '*/5 * * * *', $$select public.positions_cleanup()$$);
