-- Run in Supabase → SQL Editor (required for this app’s project inserts).
-- The app does not send `user_id` on POST /projects; the row owner must default to the session user.

ALTER TABLE public.projects
  ALTER COLUMN user_id SET DEFAULT auth.uid();

-- If inserts still fail with NOT NULL on user_id, the column may lack a default; the line above fixes that.
-- If your column is not named user_id, rename in ALTER to match (e.g. owner_id).

-- Example RLS (adjust / drop duplicates if you already have policies):

-- ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "projects_select_own"
--   ON public.projects FOR SELECT TO authenticated
--   USING (user_id = auth.uid());

-- CREATE POLICY "projects_insert_own"
--   ON public.projects FOR INSERT TO authenticated
--   WITH CHECK (user_id = auth.uid());

-- CREATE POLICY "projects_update_own"
--   ON public.projects FOR UPDATE TO authenticated
--   USING (user_id = auth.uid())
--   WITH CHECK (user_id = auth.uid());

-- CREATE POLICY "projects_delete_own"
--   ON public.projects FOR DELETE TO authenticated
--   USING (user_id = auth.uid());
