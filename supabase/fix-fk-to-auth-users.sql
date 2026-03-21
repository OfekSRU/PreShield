-- =============================================================================
-- Fix: "permission denied for table users" when inserting into public.projects
--
-- Cause: Any FOREIGN KEY from public.projects → a table in schema auth
--        (usually auth.users). Postgres checks the FK with SELECT on that
--        table. Role "authenticated" cannot read auth.* → that exact error.
--
-- Fix: Drop those foreign keys. user_id still comes from DEFAULT auth.uid().
-- =============================================================================

-- 1) See what will be removed
SELECT
  c.conname AS constraint_name,
  ns_ref.nspname AS referenced_schema,
  cls_ref.relname AS referenced_table
FROM pg_constraint c
JOIN pg_class cls ON cls.oid = c.conrelid
JOIN pg_namespace ns ON ns.oid = cls.relnamespace
JOIN pg_class cls_ref ON cls_ref.oid = c.confrelid
JOIN pg_namespace ns_ref ON ns_ref.oid = cls_ref.relnamespace
WHERE c.contype = 'f'
  AND ns.nspname = 'public'
  AND cls.relname = 'projects'
  AND ns_ref.nspname = 'auth';

-- 2) Drop ALL foreign keys from public.projects → anything in auth (run this)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class cls ON cls.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    JOIN pg_class cls_ref ON cls_ref.oid = c.confrelid
    JOIN pg_namespace ns_ref ON ns_ref.oid = cls_ref.relnamespace
    WHERE c.contype = 'f'
      AND ns.nspname = 'public'
      AND cls.relname = 'projects'
      AND ns_ref.nspname = 'auth'
  LOOP
    EXECUTE format('ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS %I', r.conname);
    RAISE NOTICE 'Dropped constraint: %', r.conname;
  END LOOP;
END $$;

-- If step 1 returned zero rows, the problem is NOT an FK to auth — run
-- diagnose-users-error.sql and check triggers (C) and policies (B).
