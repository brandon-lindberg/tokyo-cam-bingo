-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "customItems" JSONB;

-- CreateTable
CREATE TABLE "ItemCollection" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemCollection_code_key" ON "ItemCollection"("code");
