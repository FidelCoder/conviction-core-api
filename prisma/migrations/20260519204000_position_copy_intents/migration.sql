-- Create replacement execution status enums with intent-first names.
CREATE TYPE "PositionStatus_new" AS ENUM ('PENDING_EXECUTION', 'EXECUTED', 'FAILED', 'CANCELLED');
CREATE TYPE "CopyTradeStatus_new" AS ENUM ('PENDING_EXECUTION', 'EXECUTED', 'FAILED', 'CANCELLED');

-- Position intent fields. Execution-only fields stay nullable until an adapter confirms execution.
ALTER TABLE "Position"
ADD COLUMN     "observedMarketPrice" DECIMAL(18,8),
ADD COLUMN     "observedMarketPriceSource" TEXT,
ADD COLUMN     "observedMarketPriceAt" TIMESTAMP(3);

ALTER TABLE "Position" ALTER COLUMN "averageEntryPrice" DROP NOT NULL;
ALTER TABLE "Position" ALTER COLUMN "openedAt" DROP DEFAULT;
ALTER TABLE "Position" ALTER COLUMN "openedAt" DROP NOT NULL;
ALTER TABLE "Position" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Position" ALTER COLUMN "status" TYPE "PositionStatus_new" USING (
  CASE "status"::text
    WHEN 'OPEN' THEN 'PENDING_EXECUTION'::"PositionStatus_new"
    WHEN 'CLOSED' THEN 'EXECUTED'::"PositionStatus_new"
    ELSE 'PENDING_EXECUTION'::"PositionStatus_new"
  END
);
ALTER TYPE "PositionStatus" RENAME TO "PositionStatus_old";
ALTER TYPE "PositionStatus_new" RENAME TO "PositionStatus";
DROP TYPE "PositionStatus_old";
ALTER TABLE "Position" ALTER COLUMN "status" SET DEFAULT 'PENDING_EXECUTION';

-- Copy records are copy intents tied to a source position until execution is integrated.
ALTER TABLE "CopyTrade"
ADD COLUMN     "sourcePositionId" TEXT,
ADD COLUMN     "observedMarketPrice" DECIMAL(18,8),
ADD COLUMN     "observedMarketPriceSource" TEXT,
ADD COLUMN     "observedMarketPriceAt" TIMESTAMP(3);

ALTER TABLE "CopyTrade" DROP CONSTRAINT "CopyTrade_sourceSignalId_fkey";
ALTER TABLE "CopyTrade" ALTER COLUMN "sourceSignalId" DROP NOT NULL;
ALTER TABLE "CopyTrade" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "CopyTrade" ALTER COLUMN "status" TYPE "CopyTradeStatus_new" USING (
  CASE "status"::text
    WHEN 'REQUESTED' THEN 'PENDING_EXECUTION'::"CopyTradeStatus_new"
    WHEN 'EXECUTED' THEN 'EXECUTED'::"CopyTradeStatus_new"
    WHEN 'FAILED' THEN 'FAILED'::"CopyTradeStatus_new"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"CopyTradeStatus_new"
    ELSE 'PENDING_EXECUTION'::"CopyTradeStatus_new"
  END
);
ALTER TYPE "CopyTradeStatus" RENAME TO "CopyTradeStatus_old";
ALTER TYPE "CopyTradeStatus_new" RENAME TO "CopyTradeStatus";
DROP TYPE "CopyTradeStatus_old";
ALTER TABLE "CopyTrade" ALTER COLUMN "status" SET DEFAULT 'PENDING_EXECUTION';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CopyTrade" WHERE "sourcePositionId" IS NULL) THEN
    RAISE EXCEPTION 'Existing CopyTrade rows must be assigned a sourcePositionId before applying copy-intent schema.';
  END IF;
END $$;

ALTER TABLE "CopyTrade" ALTER COLUMN "sourcePositionId" SET NOT NULL;

CREATE INDEX "CopyTrade_sourcePositionId_idx" ON "CopyTrade"("sourcePositionId");

ALTER TABLE "CopyTrade" ADD CONSTRAINT "CopyTrade_sourcePositionId_fkey" FOREIGN KEY ("sourcePositionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CopyTrade" ADD CONSTRAINT "CopyTrade_sourceSignalId_fkey" FOREIGN KEY ("sourceSignalId") REFERENCES "TradeSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
