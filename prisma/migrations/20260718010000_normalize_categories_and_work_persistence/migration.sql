-- Normalize existing project/work category values and add persistent Work fields safely.
UPDATE "projects"
SET "category" = CASE
  WHEN lower(trim("category")) IN ('restaurant', 'restoran', 'restoranlar') THEN 'restaurant'
  WHEN lower(trim("category")) IN ('gazebo', 'besedka', 'besedkalar') THEN 'gazebo'
  WHEN lower(trim("category")) IN ('sauna', 'bath', 'hamam', 'hamam & sauna', 'hamam və sauna') THEN 'sauna'
  ELSE 'house'
END
WHERE "category" IS DISTINCT FROM CASE
  WHEN lower(trim("category")) IN ('restaurant', 'restoran', 'restoranlar') THEN 'restaurant'
  WHEN lower(trim("category")) IN ('gazebo', 'besedka', 'besedkalar') THEN 'gazebo'
  WHEN lower(trim("category")) IN ('sauna', 'bath', 'hamam', 'hamam & sauna', 'hamam və sauna') THEN 'sauna'
  ELSE 'house'
END;

ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "area" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "stories" INTEGER;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "rooms" INTEGER;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "build_time_az" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "build_time_ru" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "build_time_en" TEXT;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "work_items" ALTER COLUMN "category" SET DEFAULT 'house';
ALTER TABLE "work_items" ALTER COLUMN "cover_image" DROP NOT NULL;

UPDATE "work_items"
SET "category" = CASE
  WHEN lower(trim("category")) IN ('restaurant', 'restoran', 'restoranlar') THEN 'restaurant'
  WHEN lower(trim("category")) IN ('gazebo', 'besedka', 'besedkalar') THEN 'gazebo'
  WHEN lower(trim("category")) IN ('sauna', 'bath', 'hamam', 'hamam & sauna', 'hamam və sauna') THEN 'sauna'
  ELSE 'house'
END
WHERE "category" IS DISTINCT FROM CASE
  WHEN lower(trim("category")) IN ('restaurant', 'restoran', 'restoranlar') THEN 'restaurant'
  WHEN lower(trim("category")) IN ('gazebo', 'besedka', 'besedkalar') THEN 'gazebo'
  WHEN lower(trim("category")) IN ('sauna', 'bath', 'hamam', 'hamam & sauna', 'hamam və sauna') THEN 'sauna'
  ELSE 'house'
END;
