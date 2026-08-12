ALTER TABLE staff ADD COLUMN IF NOT EXISTS protected_owner boolean NOT NULL DEFAULT false;

ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('owner', 'manager', 'admin', 'master'));

WITH protected AS (
  SELECT id FROM staff WHERE role = 'owner' ORDER BY id LIMIT 1
)
UPDATE staff SET protected_owner = true
WHERE id IN (SELECT id FROM protected);

CREATE UNIQUE INDEX IF NOT EXISTS staff_one_protected_owner_idx
  ON staff ((protected_owner)) WHERE protected_owner = true;
