export interface TransactionContext {
  readonly __brand: "TransactionContext";
}

export interface TransactionManagerPort {
  runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
