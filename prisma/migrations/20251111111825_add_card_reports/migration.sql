-- CreateTable
CREATE TABLE "CardReport" (
    "id" TEXT NOT NULL,
    "cardCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "CardReport_pkey" PRIMARY KEY ("id")
);
