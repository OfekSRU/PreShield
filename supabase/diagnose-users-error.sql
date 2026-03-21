-- Paste results (or screenshots of each result grid) if "permission denied for table users" persists.
-- Run in Supabase → SQL Editor.

-- A) Foreign keys FROM public.projects (any referenced table)
SELECT
  c.conname AS fk_name,
  ns_ref.nspname AS referenced_schema,
  cls_ref.relname AS referenced_table
FROM pg_constraint c
JOIN pg_class cls ON cls.oid = c.conrelid
JOIN pg_namespace ns ON ns.oid = cls.relnamespace
JOIN pg_class cls_ref ON cls_ref.oid = c.confrelid
JOIN pg_namespace ns_ref ON ns_ref.oid = cls_ref.relnamespace
WHERE c.contype = 'f'
  AND ns.nspname = 'public'
  AND cls.relname = 'projects';

-- B) RLS policies on public.projects
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'projects';

-- C) Triggers on public.projects (definitions)
SELECT tgname, pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
WHERE t.tgrelid = 'public.projects'::regclass
  AND NOT t.tgisinternal;

-- D) Default on user_id (should mention auth.uid)
SELECT column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'projects'
  AND column_name = 'user_id';
