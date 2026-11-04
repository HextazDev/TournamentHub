type Row = Record<string, unknown>;
type Filter =
  | { column: string; value: unknown }
  | { column: string; values: readonly unknown[] }
  | { column: string; not: unknown };

export interface WriteLog {
  table: string;
  op: "update" | "insert" | "delete";
  payload: Row | Row[];
  filters: Filter[];
  affected: number;
}

export interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
  count?: number;
}

/**
 * Base Supabase en mémoire : `select / eq / in / limit / single / maybeSingle / update / insert`.
 * L'update applique réellement ses filtres `eq` (comme PostgREST) : un `update().eq("status", X)` sur une ligne
 * dont le statut a changé ne modifie rien et renvoie 0 ligne. On teste ainsi l'atomicité observable.
 *
 * `staleReads` : instantané servi aux SELECT d'une table, pour simuler un clic concurrent ayant lu l'état
 * avant qu'un autre clic n'écrive (fenêtre de course entre lecture et écriture).
 */
export class FakeSupabase {
  public readonly writes: WriteLog[] = [];
  public readonly staleReads: Record<string, Row[]> = {};

  constructor(public readonly tables: Record<string, Row[]>) {}

  public from(table: string) {
    return new FakeQuery(this, table);
  }

  public writesTo(table: string, op?: WriteLog["op"]): WriteLog[] {
    return this.writes.filter(w => w.table === table && (op === undefined || w.op === op));
  }
}

class FakeQuery implements PromiseLike<QueryResult> {
  private readonly filters: Filter[] = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
  private counting = false;
  private payload: Row | Row[] = {};
  private returning = false;
  private max: number | null = null;

  constructor(private readonly db: FakeSupabase, private readonly table: string) {}

  /** `{ count: "exact", head: true }` : renvoie `count` sans lignes. */
  public select(_columns?: string, options?: { count?: "exact"; head?: boolean }) {
    if (this.op !== "select") this.returning = true;
    if (options?.count === "exact") this.counting = true;
    return this;
  }

  public delete() {
    this.op = "delete";
    return this;
  }

  public eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  public neq(column: string, value: unknown) {
    this.filters.push({ column, not: value });
    return this;
  }

  /** Seul `not(column, "is", null)` est simulé (colonne renseignée). */
  public not(column: string, operator: "is", value: null) {
    if (operator !== "is" || value !== null) throw new Error(`FakeSupabase: not(${operator}) non simulé`);
    this.filters.push({ column, not: null });
    return this;
  }

  public in(column: string, values: readonly unknown[]) {
    this.filters.push({ column, values });
    return this;
  }

  public order() {
    return this;
  }

  public limit(n: number) {
    this.max = n;
    return this;
  }

  public update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  public insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  public single(): Promise<QueryResult> {
    return Promise.resolve(this.toSingle(this.execute()));
  }

  public maybeSingle(): Promise<QueryResult> {
    const res = this.execute();
    const rows = Array.isArray(res.data) ? res.data : [];
    return Promise.resolve({ data: rows[0] ?? null, error: res.error });
  }

  public then<T1 = QueryResult, T2 = never>(
    onfulfilled?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(f => {
      if ("values" in f) return f.values.includes(row[f.column]);
      if ("not" in f) return f.not === null ? row[f.column] != null : row[f.column] !== f.not;
      return row[f.column] === f.value;
    });
  }

  private toSingle(res: QueryResult): QueryResult {
    const rows = Array.isArray(res.data) ? res.data : [];
    if (res.error) return res;
    if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "no rows" } };
    return { data: rows[0], error: null };
  }

  private execute(): QueryResult {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);

    if (this.op === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows.push(...list.map(r => ({ ...r })));
      this.db.writes.push({ table: this.table, op: "insert", payload: this.payload, filters: [], affected: list.length });
      return { data: null, error: null };
    }

    if (this.op === "delete") {
      const kept = rows.filter(r => !this.matches(r));
      const affected = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      this.db.writes.push({ table: this.table, op: "delete", payload: {}, filters: [...this.filters], affected });
      return { data: null, error: null };
    }

    if (this.op === "update") {
      const hit = rows.filter(r => this.matches(r));
      const update = Array.isArray(this.payload) ? {} : this.payload;
      hit.forEach(r => Object.assign(r, update));
      this.db.writes.push({ table: this.table, op: "update", payload: this.payload, filters: [...this.filters], affected: hit.length });
      return { data: this.returning ? hit.map(r => ({ ...r })) : null, error: null };
    }

    const source = this.db.staleReads[this.table] ?? rows;
    const found = source.filter(r => this.matches(r)).map(r => ({ ...r }));
    if (this.counting) return { data: null, error: null, count: found.length };
    return { data: this.max === null ? found : found.slice(0, this.max), error: null };
  }
}
