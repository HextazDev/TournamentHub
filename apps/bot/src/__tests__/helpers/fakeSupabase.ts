type Row = Record<string, unknown>;

/**
 * TST-01 (#104) : colonnes réelles du schéma SQL validées à l'écriture pour reproduire
 * le rejet PostgREST (`PGRST204`) en cas de colonne inexistante (ex: `winner_id` / `loser_id` sur `matches`).
 */
const TABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  matches: new Set([
    "id",
    "phase_id",
    "team1_id",
    "team2_id",
    "team1_score",
    "team2_score",
    "status",
    "discord_channel_id",
    "group_id",
    "next_match_winner_id",
    "next_match_loser_id",
    "reported_by_team_id",
    "round_number",
    "match_number",
    "version",
    "created_at",
    "updated_at",
  ]),
};

export type Filter =
  | { column: string; value: unknown }
  | { column: string; values: readonly unknown[] }
  | { column: string; not: unknown }
  | { column: string; ilike: string };

export interface ReadLog {
  table: string;
  counting: boolean;
  filters: Filter[];
}

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
  public readonly reads: ReadLog[] = [];
  public readonly staleReads: Record<string, Row[]> = {};
  public readonly tableErrors: Record<string, { code: string; message: string }> = {};
  public rpcHandler?: (fnName: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown };

  constructor(public readonly tables: Record<string, Row[]>) {}

  public from(table: string) {
    return new FakeQuery(this, table);
  }

  public rpc(fnName: string, args: Record<string, unknown> = {}) {
    if (this.rpcHandler) {
      return Promise.resolve(this.rpcHandler(fnName, args));
    }
    if (fnName === "assign_team_to_match") {
      const match = (this.tables.matches ?? []).find(m => m.id === args.p_target_match_id);
      if (match) {
        if (!match.team1_id) {
          match.team1_id = args.p_team_id;
          return Promise.resolve({ data: [match], error: null });
        } else if (!match.team2_id && match.team1_id !== args.p_team_id) {
          match.team2_id = args.p_team_id;
          return Promise.resolve({ data: [match], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: { message: "match not found", code: "404" } });
    }
    return Promise.resolve({ data: null, error: null });
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

  public match(record: Record<string, unknown>) {
    for (const [column, value] of Object.entries(record)) {
      this.filters.push({ column, value });
    }
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

  /** Égalité insensible à la casse ; les jokers `%`/`_` sont neutralisés par l'appelant. */
  public ilike(column: string, pattern: string) {
    this.filters.push({ column, ilike: pattern });
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
      if ("ilike" in f) {
        const value = row[f.column];
        if (typeof value !== "string") return false;
        // PostgREST convertit tout `*` en `%` dans `ilike` (REG-10).
        const regexPattern = f.ilike
          .replace(/\*/g, "%")
          .replace(/\\([%_\\])/g, (_, ch: string) => `\u0000${ch}`)
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".")
          .replace(/\u0000(.)/g, (_, ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        return new RegExp(`^${regexPattern}$`, "i").test(value);
      }
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

  private findUnknownColumn(payload: Row | Row[]): string | null {
    const allowed = TABLE_COLUMNS[this.table];
    if (!allowed) return null;
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      for (const col of Object.keys(row)) {
        if (!allowed.has(col)) return col;
      }
    }
    return null;
  }

  private execute(): QueryResult {
    if (this.db.tableErrors[this.table]) {
      return { data: null, error: this.db.tableErrors[this.table]! };
    }
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);

    if (this.op === "insert") {
      const unknownCol = this.findUnknownColumn(this.payload);
      if (unknownCol) {
        return {
          data: null,
          error: {
            code: "PGRST204",
            message: `Could not find the '${unknownCol}' column of '${this.table}' in the schema cache`,
          },
        };
      }
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = list.map((r, idx) => ({ id: (r.id as string) || `fake-${this.table}-${rows.length + idx + 1}`, ...r }));
      rows.push(...inserted);
      this.db.writes.push({ table: this.table, op: "insert", payload: this.payload, filters: [], affected: list.length });
      return { data: this.returning ? inserted.map(r => ({ ...r })) : null, error: null };
    }

    if (this.op === "delete") {
      const removed = rows.filter(r => this.matches(r));
      const kept = rows.filter(r => !this.matches(r));
      const affected = removed.length;
      rows.splice(0, rows.length, ...kept);
      if (this.table === "organizations" && removed.length > 0) {
        const removedIds = new Set(removed.map(r => r.id));
        for (const childTable of [
          "organization_integrations",
          "organization_members",
          "integration_access_grants",
          "organization_invites",
          "tournaments",
        ]) {
          const childRows = this.db.tables[childTable];
          if (childRows) {
            const keptChildren = childRows.filter(c => !removedIds.has(c.organization_id));
            childRows.splice(0, childRows.length, ...keptChildren);
          }
        }
      }
      this.db.writes.push({ table: this.table, op: "delete", payload: {}, filters: [...this.filters], affected });
      return { data: null, error: null };
    }

    if (this.op === "update") {
      const unknownCol = this.findUnknownColumn(this.payload);
      if (unknownCol) {
        return {
          data: null,
          error: {
            code: "PGRST204",
            message: `Could not find the '${unknownCol}' column of '${this.table}' in the schema cache`,
          },
        };
      }
      const hit = rows.filter(r => this.matches(r));
      const update = Array.isArray(this.payload) ? {} : this.payload;
      hit.forEach(r => Object.assign(r, update));
      this.db.writes.push({ table: this.table, op: "update", payload: this.payload, filters: [...this.filters], affected: hit.length });
      return { data: this.returning ? hit.map(r => ({ ...r })) : null, error: null };
    }

    const source = this.db.staleReads[this.table] ?? rows;
    const found = source.filter(r => this.matches(r)).map(r => ({ ...r }));
    this.db.reads.push({ table: this.table, counting: this.counting, filters: [...this.filters] });
    if (this.counting) return { data: null, error: null, count: found.length };
    return { data: this.max === null ? found : found.slice(0, this.max), error: null };
  }
}
