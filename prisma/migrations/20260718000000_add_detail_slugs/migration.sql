-- Add stable public slugs for SEO-friendly project and work detail pages.
CREATE EXTENSION IF NOT EXISTS unaccent;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "slug" TEXT;

CREATE OR REPLACE FUNCTION bc_slugify(input TEXT) RETURNS TEXT AS $$
DECLARE
  value TEXT := lower(coalesce(input, ''));
BEGIN
  value := translate(value, 'ƏəÖöÜüĞğŞşÇçİIı', 'eeoouuggsscciii');
  value := unaccent(value);
  value := regexp_replace(value, '[^a-z0-9]+', '-', 'g');
  value := regexp_replace(value, '(^-+|-+$)', '', 'g');
  IF value = '' THEN value := 'detal'; END IF;
  RETURN value;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

WITH numbered AS (
  SELECT id, bc_slugify(title_az) AS base_slug, row_number() OVER (PARTITION BY bc_slugify(title_az) ORDER BY created_at, id) AS rn
  FROM "projects"
)
UPDATE "projects" p
SET slug = CASE WHEN n.rn = 1 THEN n.base_slug ELSE n.base_slug || '-' || n.rn::text END
FROM numbered n
WHERE p.id = n.id AND (p.slug IS NULL OR p.slug = '');

WITH numbered AS (
  SELECT id, bc_slugify(title_az) AS base_slug, row_number() OVER (PARTITION BY bc_slugify(title_az) ORDER BY created_at, id) AS rn
  FROM "work_items"
)
UPDATE "work_items" w
SET slug = CASE WHEN n.rn = 1 THEN n.base_slug ELSE n.base_slug || '-' || n.rn::text END
FROM numbered n
WHERE w.id = n.id AND (w.slug IS NULL OR w.slug = '');

ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "work_items" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "projects_slug_key" ON "projects"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_slug_key" ON "work_items"("slug");
DROP FUNCTION IF EXISTS bc_slugify(TEXT);
