-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "otpAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "refId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsAlert_acknowledgedAt_createdAt_idx" ON "OpsAlert"("acknowledgedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Delivery_driverId_idx" ON "Delivery"("driverId");

-- CreateIndex
CREATE INDEX "ItemBatchAlloc_orderItemId_idx" ON "ItemBatchAlloc"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "Prescription_orderId_idx" ON "Prescription"("orderId");
