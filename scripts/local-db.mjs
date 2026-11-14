import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createLocalDb(filename = ':memory:') {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) {
    sqlite.exec(readFileSync(resolve(import.meta.dirname, '../drizzle/0000_accounts.sql'), 'utf8'));
  }
  const columns = sqlite.prepare('PRAGMA table_info(market_cache)').all();
  if (!columns.some(column => column.name === 'lease_until')) {
    sqlite.exec(readFileSync(resolve(import.meta.dirname, '../drizzle/0001_market_lease.sql'), 'utf8'));
  }
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            first: async () => statement.get(...values) || null,
            all: async () => ({ results: statement.all(...values) }),
            run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
          };
        },
        first: async () => sqlite.prepare(sql).get() || null,
        all: async () => ({ results: sqlite.prepare(sql).all() }),
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run().changes) } }),
      };
    },
    close: () => sqlite.close(),
  };
}
