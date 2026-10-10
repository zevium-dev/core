/** Row storage only; all multi-table transitions are owned by WalletDO. */
export type WalletTable =
  | "reservations"
  | "pending_settlements"
  | "applied_grants"
  | "key_settings"
  | "dead_letters";

/** Keeps writes proportional to changed rows, never serializes a whole table. */
export class WalletRows<T> {
  #rows = new Map<string, { data: string; position: number }>();
  constructor(
    private readonly sql: SqlStorage,
    private readonly table: WalletTable,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS ${table}_position ON ${table}(position)`);
  }

  load(): Array<[string, T]> {
    this.#rows.clear();
    return this.sql
      .exec<{ id: string; data: string; position: number }>(
        `SELECT id, data, position FROM ${this.table} ORDER BY position`,
      )
      .toArray()
      .map(({ id, data, position }) => {
        this.#rows.set(id, { data, position });
        return [id, JSON.parse(data) as T];
      });
  }

  /** Call in transactionSync; reload after rollback before accepting more work. */
  write(rows: Array<[string, T]>): void {
    const retained = new Set(rows.map(([id]) => id));
    let lastPosition = -1;
    let nextPosition = 0;
    for (const row of this.#rows.values())
      nextPosition = Math.max(nextPosition, row.position + 1);
    for (const id of this.#rows.keys()) {
      if (!retained.has(id)) {
        this.sql.exec(`DELETE FROM ${this.table} WHERE id = ?`, id);
        this.#rows.delete(id);
      }
    }
    for (const [id, value] of rows) {
      const previous = this.#rows.get(id);
      const position =
        previous && previous.position > lastPosition
          ? previous.position
          : nextPosition++;
      lastPosition = position;
      const data = JSON.stringify(value);
      if (previous?.data === data && previous.position === position) continue;
      this.sql.exec(
        `INSERT INTO ${this.table} (id, data, position) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, position = excluded.position`,
        id,
        data,
        position,
      );
      this.#rows.set(id, { data, position });
    }
  }
}
