-- Add boardSize column with default 5 so existing records stay valid
ALTER TABLE "Game"
ADD COLUMN "boardSize" INTEGER NOT NULL DEFAULT 5;
