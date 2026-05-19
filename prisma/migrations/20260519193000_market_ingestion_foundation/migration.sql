-- CreateEnum
CREATE TYPE "MarketSource" AS ENUM ('POLYMARKET', 'KALSHI');

-- DropIndex
DROP INDEX "Market_provider_externalId_key";

-- RenameColumns
ALTER TABLE "Market" RENAME COLUMN "externalId" TO "externalMarketId";
ALTER TABLE "Market" RENAME COLUMN "provider" TO "source";
ALTER TABLE "Market" RENAME COLUMN "resolvedAt" TO "resolutionDate";

-- AlterTable
ALTER TABLE "Market"
DROP COLUMN "closesAt",
ADD COLUMN "category" TEXT,
ADD COLUMN "externalUrl" TEXT,
ADD COLUMN "noTokenId" TEXT,
ADD COLUMN "yesTokenId" TEXT;

-- CastSource
ALTER TABLE "Market"
ALTER COLUMN "source" TYPE "MarketSource" USING UPPER("source")::"MarketSource";

-- CreateIndex
CREATE INDEX "Market_source_idx" ON "Market"("source");

-- CreateIndex
CREATE INDEX "Market_category_idx" ON "Market"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Market_source_externalMarketId_key" ON "Market"("source", "externalMarketId");
