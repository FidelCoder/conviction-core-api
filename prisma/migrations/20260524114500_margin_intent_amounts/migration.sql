-- AlterTable
ALTER TABLE "Position"
ADD COLUMN     "marginCollateral" DECIMAL(18,8),
ADD COLUMN     "notionalAmount" DECIMAL(18,8),
ADD COLUMN     "borrowedAmount" DECIMAL(18,8);

-- AlterTable
ALTER TABLE "CopyTrade"
ADD COLUMN     "marginCollateral" DECIMAL(18,8),
ADD COLUMN     "notionalAmount" DECIMAL(18,8),
ADD COLUMN     "borrowedAmount" DECIMAL(18,8);

-- AlterTable
ALTER TABLE "ExecutionAttempt"
ADD COLUMN     "marginCollateral" DECIMAL(18,8),
ADD COLUMN     "notionalAmount" DECIMAL(18,8),
ADD COLUMN     "borrowedAmount" DECIMAL(18,8);
