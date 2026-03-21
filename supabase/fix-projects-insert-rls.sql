-- =============================================================================
-- Error: "new row violates row-level security policy for table projects"
--
-- Means: no INSERT policy allows this row, or WITH CHECK failed (often
-- user_id must equal auth.uid() after DEFAULT is applied).
-- =============================================================================

-- A) Confirm user_id gets the session user (run set-project-owner-default.sql if null)
SELECT column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'projects'
  AND column_name = 'user_id';
-- Expect: (auth.uid()) or similar

-- B) See INSERT policies on projects
SELECT policyname, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'projects'
  AND cmd = 'INSERT';

-- C) Ensure at least one permissive INSERT policy for authenticated users
DROP POLICY IF EXISTS "preshield_projects_insert_own" ON public.projects;

CREATE POLICY "preshield_projects_insert_own"
  ON public.projects
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- If (C) alone still fails, another INSERT policy may be RESTRICTIVE or AND’d;
-- list all policies with: SELECT * FROM pg_policies WHERE tablename = 'projects';
