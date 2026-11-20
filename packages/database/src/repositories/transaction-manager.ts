import type { TransactionContext, TransactionManagerPort } from "@docuflow/domain";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type DrizzleDbExecutor = Pick<
  NodePgDatabase,
  "select" | "insert" | "update" | "delete"
>;

const txExecutorMap = new WeakMap<TransactionContext, DrizzleDbExecutor>();

export function resolveDbExecutor(
  db: NodePgDatabase,
  tx?: TransactionContext,
): DrizzleDbExecutor {
  if (!tx) {
    return db;
  }
  const executor = txExecutorMap.get(tx);
  if (!executor) {
    throw new Error("Invalid or foreign TransactionContext provided to repository.");
  }
  return executor;
}

export function createTransactionManager(db: NodePgDatabase): TransactionManagerPort {
  return {
    async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return db.transaction(async (drizzleTx) => {
        const token: TransactionContext = { __brand: "TransactionContext" };
        txExecutorMap.set(token, drizzleTx);
        try {
          return await work(token);
        } finally {
          txExecutorMap.delete(token);
        }
      });
    },
  };
}
