CREATE TYPE "ExecutionMode" AS ENUM ('SPOT', 'MARGIN');

ALTER TABLE "Position"
ADD COLUMN     "chainId" INTEGER,
ADD COLUMN     "walletAddress" TEXT,
ADD COLUMN     "executionMode" "ExecutionMode" NOT NULL DEFAULT 'SPOT',
ADD COLUMN     "leverageMultiplier" DECIMAL(10,4),
ADD COLUMN     "executionAdapterId" TEXT,
ADD COLUMN     "chainTransactionHash" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

ALTER TABLE "CopyTrade"
ADD COLUMN     "chainId" INTEGER,
ADD COLUMN     "walletAddress" TEXT,
ADD COLUMN     "executionMode" "ExecutionMode" NOT NULL DEFAULT 'SPOT',
ADD COLUMN     "leverageMultiplier" DECIMAL(10,4),
ADD COLUMN     "executionAdapterId" TEXT,
ADD COLUMN     "chainTransactionHash" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Position_userId_idempotencyKey_key" ON "Position"("userId", "idempotencyKey");
CREATE INDEX "Position_chainId_idx" ON "Position"("chainId");
CREATE INDEX "Position_executionMode_idx" ON "Position"("executionMode");

CREATE UNIQUE INDEX "CopyTrade_followerId_idempotencyKey_key" ON "CopyTrade"("followerId", "idempotencyKey");
CREATE INDEX "CopyTrade_chainId_idx" ON "CopyTrade"("chainId");
CREATE INDEX "CopyTrade_executionMode_idx" ON "CopyTrade"("executionMode");
