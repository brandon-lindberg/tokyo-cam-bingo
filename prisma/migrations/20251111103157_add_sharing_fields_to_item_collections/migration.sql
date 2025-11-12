-- AlterTable
ALTER TABLE "ItemCollection" ADD COLUMN     "creatorName" TEXT,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" JSONB,
ADD COLUMN     "usageCount" INTEGER NOT NULL DEFAULT 0;
