-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "pauseTimerOnReroll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timerAccumulatedPause" INTEGER,
ADD COLUMN     "timerDuration" INTEGER,
ADD COLUMN     "timerEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timerPausedAt" TIMESTAMP(3),
ADD COLUMN     "timerStartedAt" TIMESTAMP(3);
