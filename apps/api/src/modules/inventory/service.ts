import type { Prisma } from "@prisma/client";
import { AppError } from "../../core/errors";
import type { FefoAllocation } from "./fefo";

/**
 * Commit confirmed batch allocations for ONE order item inside the caller's
 * transaction (BLUEPRINT §9.4, packing → READY).
 *
 * Each batch is decremented CONDITIONALLY (`qtyAvailable >= qty`) via raw SQL,
 * so a concurrent packer can never oversell a batch — affected rows ≠ 1 aborts
 * the whole TX with 409 STOCK_INSUFFICIENT. The batch number and expiry are
 * snapshotted on the ItemBatchAlloc row (traceability + Schedule H1 register).
 */
export async function commitAllocations(
  tx: Prisma.TransactionClient,
  orderItemId: string,
  allocs: FefoAllocation[],
): Promise<void> {
  for (const alloc of allocs) {
    const affected = await tx.$executeRaw`
      UPDATE "Batch"
      SET "qtyAvailable" = "qtyAvailable" - ${alloc.qty}
      WHERE "id" = ${alloc.batchId} AND "qtyAvailable" >= ${alloc.qty}
    `;
    if (affected !== 1) {
      throw new AppError("STOCK_INSUFFICIENT", "Batch has insufficient quantity available", 409, {
        batchId: alloc.batchId,
        requestedQty: alloc.qty,
      });
    }

    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: alloc.batchId },
      select: { batchNo: true, expiryDate: true },
    });

    await tx.itemBatchAlloc.create({
      data: {
        orderItemId,
        batchId: alloc.batchId,
        batchNoSnap: batch.batchNo,
        expirySnap: batch.expiryDate,
        qty: alloc.qty,
      },
    });
  }
}
