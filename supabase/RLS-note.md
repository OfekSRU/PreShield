# “permission denied for table users” (Supabase / Postgres)

That message comes from the **database**, not the React app. It usually means an **RLS policy**, **trigger**, or **view** runs SQL that reads a `users` table (often `auth.users` or a mis-qualified `users`) while acting as the **`authenticated`** role, which is not allowed to read `auth.users` directly.

**Real example:** policy `members_can_view_projects` with `SELECT … FROM auth.users` → replace with **`auth.jwt() ->> 'email'`** (see **`supabase/fix-policy-members-can-view-projects.sql`**).

**“new row violates row-level security policy” on `projects`:** usually **no INSERT policy** or **WITH CHECK** rejects the row (e.g. `user_id` must equal `auth.uid()`). See **`supabase/fix-projects-insert-rls.sql`** and confirm **`user_id` DEFAULT `auth.uid()`** (`set-project-owner-default.sql`).

## App behavior (create project)

The client sends **`POST /projects` without `user_id`**. Postgres should set the owner with:

`ALTER TABLE public.projects ALTER COLUMN user_id SET DEFAULT auth.uid();`

Run **`supabase/set-project-owner-default.sql`** once in the SQL Editor. Without that default, inserts can fail (NOT NULL) or RLS can misbehave.

**Why not send `user_id` from the browser?** Inserts that include `user_id` often trigger a **foreign-key check** against **`public.users`**. If RLS on `public.users` blocks the `authenticated` role, Postgres reports **“permission denied for table users”** even though your policy only mentions `projects`.

A separate regression was **`addProjectCreator`** (`POST project_members` with **`user_id`**), which also touched `users`/`auth.users` paths. That flow is **not** used on create anymore.

## What to change in the Supabase SQL Editor

1. Open **Authentication → Policies** (or **Table Editor →** your table → **RLS**).
2. Inspect policies on **`projects`** and **`project_members`** (and any related tables).
3. Replace patterns like:
   - `SELECT … FROM users …`
   - `SELECT … FROM auth.users …` inside policies for normal users  
   with **`auth.uid()`** only, e.g.:
   - `user_id = auth.uid()`
   - `auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = …)`  
     (only if `project_members.user_id` is a normal column your policies may read — avoid reading `auth.users` in the policy.)

4. If you use a **`public.profiles`** (or similar) table synced from Auth, policies should reference **`public.profiles`**, not `users`.

5. **Triggers** on `projects` / `project_members` that `SELECT` from `auth.users` should run as **`SECURITY DEFINER`** and be owned by a privileged role, or be rewritten to avoid reading `auth.users`.

If the error still appears on **create project**, inspect **`projects` INSERT** policies and any **triggers/FKs** on **`projects.user_id`** (e.g. FK to a `users` table that RLS blocks).

### Still seeing it after `DEFAULT auth.uid()`?

The app side is already correct (no `user_id` in the JSON). Next step is **only in Supabase**:

1. **Fast path:** run **`supabase/projects-rls-replace-policies.sql`** — replaces all **`projects`** RLS policies with ones that only use **`auth.uid()`** (no `users` table). Rename **`user_id`** in that file if your column differs.
2. **Diagnostics:** **`supabase/fix-permission-denied-users.sql`** (FKs, policies mentioning `users`, triggers on `projects`).
3. If `projects.user_id` references **`public.users`** (FK), you need a **`SELECT`** policy on **`public.users`** for `id = auth.uid()`, or remove that FK — see the fix file. (If **`public.users` does not exist**, skip that.)
4. If the error **continues after replacing `projects` policies**, check **foreign keys from `public.projects` to schema `auth`** (not only `auth.users`). Run **`supabase/fix-fk-to-auth-users.sql`** (lists them, then drops all such FKs). If the list is **empty**, run **`supabase/diagnose-users-error.sql`** and inspect **triggers** and **policies**.
5. If still failing, a **trigger** on **`projects`** may read **`auth.users`** — inspect it and use **`SECURITY DEFINER`** or remove the read.
