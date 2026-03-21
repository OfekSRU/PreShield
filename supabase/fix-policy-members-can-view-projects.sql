-- =============================================================================
-- Fix: "permission denied for table users"
--
-- Your policy `members_can_view_projects` used:
--   SELECT ... FROM auth.users
-- The "authenticated" role cannot read auth.users → that error (even on INSERT
-- with return=representation, Postgres checks SELECT policies on the new row).
--
-- Replace with the same idea using the JWT email claim (no auth.users read).
-- =============================================================================

DROP POLICY IF EXISTS "members_can_view_projects" ON public.projects;

CREATE POLICY "members_can_view_projects"
  ON public.projects
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.email IS NOT NULL
        AND lower(trim(pm.email)) = lower(trim((auth.jwt() ->> 'email')))
    )
  );

-- user_id = auth.uid(): owner can read (needed right after create; no auth.users query).
-- EXISTS (...): invited members matched by JWT email, same as before without auth.users.

-- If (auth.jwt() ->> 'email') is null, only the owner branch applies; ensure sign-in uses email provider or set a custom claim.
