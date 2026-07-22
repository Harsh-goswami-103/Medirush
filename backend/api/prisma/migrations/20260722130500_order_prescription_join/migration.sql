-- CreateTable
CREATE TABLE "OrderPrescription" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "status" "RxStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "patientName" TEXT,
    "doctorName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderPrescription_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "OrderPrescription_prescriptionId_idx" ON "OrderPrescription"("prescriptionId");
-- CreateIndex
CREATE INDEX "OrderPrescription_orderId_status_idx" ON "OrderPrescription"("orderId", "status");
-- CreateIndex
CREATE UNIQUE INDEX "OrderPrescription_orderId_prescriptionId_key" ON "OrderPrescription"("orderId", "prescriptionId");
-- AddForeignKey
ALTER TABLE "OrderPrescription" ADD CONSTRAINT "OrderPrescription_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "OrderPrescription" ADD CONSTRAINT "OrderPrescription_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every prescription already bound to an order IS a dispensing, and
-- it carries a verdict a pharmacist actually gave. Move that verdict onto the
-- join row so nothing loses its review history and no order silently reverts
-- to PENDING. cuid()-shaped ids are generated here rather than relying on the
-- application, so the migration is self-contained.
INSERT INTO "OrderPrescription" (
  "id", "orderId", "prescriptionId", "status",
  "reviewerId", "reviewNote", "patientName", "doctorName", "reviewedAt", "createdAt"
)
SELECT
  'c' || substr(md5(random()::text || p."id"), 1, 24),
  p."orderId",
  p."id",
  p."status",
  p."reviewerId",
  p."reviewNote",
  p."patientName",
  p."doctorName",
  p."reviewedAt",
  p."createdAt"
FROM "Prescription" p
WHERE p."orderId" IS NOT NULL
ON CONFLICT ("orderId", "prescriptionId") DO NOTHING;
