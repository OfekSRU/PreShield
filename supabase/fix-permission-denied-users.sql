-- Fix "permission denied for table users" after set-project-owner-default.sql
--
-- If you get: relation "public.users" does not exist → you do NOT have public.users.
-- Skip any block that alters public.users. Use sections 1, 3, 4, and "5" below.

-- ── 0) Where is a table named `users`? (often only auth.users) ─────────────
SELECT n.nspname AS schema, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND c.relname = 'users';

-- ── 1) Foreign keys FROM public.projects (referenced schema is correct here) ─
SELECT
  c.conname AS constraint_name,
  a.attname AS column_in_projects,
  nref.nspname AS referenced_schema,
  cf.relname AS referenced_table
FROM pg_constraint c
JOIN pg_class f ON f.oid = c.conrelid
JOIN pg_namespace nf ON nf.oid = f.relnamespace
JOIN pg_class cf ON cf.oid = c.confrelid
JOIN pg_namespace nref ON nref.oid = cf.relnamespace
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f'
  AND f.relname = 'projects'
  AND nf.nspname = 'public';

-- If referenced_schema = auth AND referenced_table = users → run
-- supabase/fix-fk-to-auth-users.sql (drop that FK).

-- ── 2) ONLY if section 1 shows referenced_table = users AND schema = public ─
--     (Skip if public.users does not exist — you’ll get 42P01.)

-- ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS "users_select_own_for_fk" ON public.users;
-- CREATE POLICY "users_select_own_for_fk"
--   ON public.users FOR SELECT TO authenticated
--   USING (id = auth.uid());

-- ── 3) Policies in public that mention "users" (often bad: touches auth.users) ─
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    coalesce(qual::text, '') ILIKE '%users%'
    OR coalesce(with_check::text, '') ILIKE '%users%'
  );

-- Fix: rewrite so policies use auth.uid() only — never SELECT FROM auth.users
-- in RLS for the "authenticated" role.

-- ── 4) Triggers on public.projects ──────────────────────────────────────────
SELECT tgname, pg_get_triggerdef(oid, true) AS def
FROM pg_trigger
WHERE tgrelid = 'public.projects'::regclass
  AND NOT tgisinternal;

-- If a trigger reads auth.users, it must be SECURITY DEFINER (owned by postgres)
-- or rewritten to use NEW.user_id / auth.uid() without querying auth.users.

-- ── 5) No public.users: typical fix is policies on `projects` ───────────────
-- Example INSERT policy that does NOT touch users:
--
-- DROP POLICY IF EXISTS "projects_insert_own" ON public.projects;
-- CREATE POLICY "projects_insert_own"
--   ON public.projects FOR INSERT TO authenticated
--   WITH CHECK (user_id = auth.uid());
--
-- Example SELECT (owner sees own rows):
--
-- DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
-- CREATE POLICY "projects_select_own"
--   ON public.projects FOR SELECT TO authenticated
--   USING (user_id = auth.uid());
