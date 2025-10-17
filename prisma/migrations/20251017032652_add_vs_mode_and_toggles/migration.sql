-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "flagsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'REGULAR',
ADD COLUMN     "rerollsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sharedCard" JSONB;

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "color" TEXT,
ADD COLUMN     "stampedSquares" JSONB;
