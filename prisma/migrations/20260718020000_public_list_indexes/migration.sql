-- Public list endpoint indexes; safe additive migration, no data rewrite.
CREATE INDEX IF NOT EXISTS projects_archived_created_at_idx ON projects (archived, created_at DESC);
CREATE INDEX IF NOT EXISTS projects_category_archived_idx ON projects (category, archived);
CREATE INDEX IF NOT EXISTS work_items_public_sort_idx ON work_items (active, archived, sort_order ASC, featured DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS work_items_category_public_idx ON work_items (category, active, archived);
CREATE INDEX IF NOT EXISTS gallery_items_public_sort_idx ON gallery_items (archived, sort_order ASC, id DESC);
