-- =============================================================================
-- USE WHEN: "permission denied for table users" still happens on Create Project
--           and you already ran set-project-owner-default.sql.
--
-- This REMOVES all RLS policies on public.projects and adds simple ones that
-- only use auth.uid() — no SELECT from auth.users or public.users.
--
-- WARNING: Only run if you are okay resetting policies on `projects`. Copy your
-- old policies from Dashboard → Authentication → Policies (or pg_policies)
-- if you need them later. Adjust `user_id` if your owner column has another name.
-- =============================================================================

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- If you see: policy "…" already exists — drop that name first, then re-run from here.
-- Common tutorial names:
DROP POLICY IF EXISTS "users_own_projects" ON public.projects;
DROP POLICY IF EXISTS users_own_projects ON public.projects;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.projects', r.policyname);
  END LOOP;
END $$;

-- Owner column must match what DEFAULT auth.uid() fills (usually user_id).
CREATE POLICY "preshield_projects_select_own"
  ON public.projects FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "preshield_projects_insert_own"
  ON public.projects FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "preshield_projects_update_own"
  ON public.projects FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "preshield_projects_delete_own"
  ON public.projects FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- If INSERT still fails with "permission denied for table users":
--   1) FK projects.user_id → auth.users — run fix-fk-to-auth-users.sql
--   2) Else TRIGGER on projects — see fix-permission-denied-users.sql section 4
