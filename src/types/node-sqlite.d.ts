// Minimal declaration for Node 22.13+/24 built-in `node:sqlite` (not in @types/node v20).
declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;
  export interface StatementColumn { column: string | null; database: string | null; name: string; table: string | null; type: string | null }
  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    columns?(): StatementColumn[];
    readonly sourceSQL: string;
    readonly expandedSQL: string;
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
    open(): void;
    readonly isOpen: boolean;
  }
}
