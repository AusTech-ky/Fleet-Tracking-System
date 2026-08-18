-- What kind of asset a tracker is attached to. Drives the icon drawn on the
-- map, so a glance tells car from boat from trailer. Free text is deliberately
-- NOT allowed: the UI needs a bounded set to have an icon for each.
ALTER TABLE device ADD COLUMN IF NOT EXISTS asset_type text NOT NULL DEFAULT 'car'
  CHECK (asset_type IN ('car','motorcycle','bus','truck','boat','trailer','equipment','other'));
