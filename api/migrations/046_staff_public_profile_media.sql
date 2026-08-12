ALTER TABLE staff ADD COLUMN IF NOT EXISTS public_profile_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS staff_media (
  id text PRIMARY KEY,
  staff_id text NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('avatar','portfolio')),
  storage_key text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_media_staff_sort_idx ON staff_media (staff_id, kind, sort_order, created_at);
