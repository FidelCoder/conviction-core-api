-- CreateEnum
CREATE TYPE "TradeSignalSource" AS ENUM ('TELEGRAM', 'FARCASTER', 'WEB');

-- AlterTable
ALTER TABLE "TradeSignal" ADD COLUMN     "convictionLevel" INTEGER,
ADD COLUMN     "source" "TradeSignalSource" NOT NULL,
ADD COLUMN     "thesis" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "TradeSignal_source_idx" ON "TradeSignal"("source");

-- CreateIndex
CREATE INDEX "TradeSignal_createdAt_idx" ON "TradeSignal"("createdAt");

