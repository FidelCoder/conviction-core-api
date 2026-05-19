-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "acceptingOrders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bestAsk" DECIMAL(18,8),
ADD COLUMN     "bestBid" DECIMAL(18,8),
ADD COLUMN     "conditionId" TEXT,
ADD COLUMN     "lastTradePrice" DECIMAL(18,8),
ADD COLUMN     "orderBookEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "orderMinSize" DECIMAL(18,8),
ADD COLUMN     "orderPriceMinTickSize" DECIMAL(18,8),
ADD COLUMN     "questionId" TEXT,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Market_conditionId_idx" ON "Market"("conditionId");

-- CreateIndex
CREATE INDEX "Market_questionId_idx" ON "Market"("questionId");

