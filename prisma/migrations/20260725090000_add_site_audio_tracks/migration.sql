CREATE TABLE IF NOT EXISTS "site_audio_tracks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "audio_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_audio_tracks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "site_audio_tracks_sort_order_idx" ON "site_audio_tracks"("sort_order");
