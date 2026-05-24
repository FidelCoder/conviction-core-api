-- CreateEnum
CREATE TYPE "ExecutionAttemptStatus" AS ENUM ('CREATED', 'BLOCKED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionAttemptTarget" AS ENUM ('POSITION', 'COPY_TRADE');

-- CreateTable
CREATE TABLE "ExecutionAttempt" (
    "id" TEXT NOT NULL,
    "targetType" "ExecutionAttemptTarget" NOT NULL,
    "positionId" TEXT,
    "copyTradeId" TEXT,
    "adapterId" TEXT NOT NULL,
    "executionMode" "ExecutionMode" NOT NULL,
    "chainId" INTEGER,
    "walletAddress" TEXT,
    "requestedQuantity" DECIMAL(18,8),
    "leverageMultiplier" DECIMAL(10,4),
    "observedMarketPrice" DECIMAL(18,8),
    "status" "ExecutionAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "externalOrderId" TEXT,
    "chainTransactionHash" TEXT,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExecutionAttempt_target_check" CHECK (
      ("targetType" = 'POSITION' AND "positionId" IS NOT NULL AND "copyTradeId" IS NULL)
      OR ("targetType" = 'COPY_TRADE' AND "copyTradeId" IS NOT NULL AND "positionId" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "ExecutionAttempt_targetType_idx" ON "ExecutionAttempt"("targetType");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_positionId_idx" ON "ExecutionAttempt"("positionId");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_copyTradeId_idx" ON "ExecutionAttempt"("copyTradeId");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_adapterId_idx" ON "ExecutionAttempt"("adapterId");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_status_idx" ON "ExecutionAttempt"("status");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_chainId_idx" ON "ExecutionAttempt"("chainId");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_createdAt_idx" ON "ExecutionAttempt"("createdAt");

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_copyTradeId_fkey" FOREIGN KEY ("copyTradeId") REFERENCES "CopyTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
