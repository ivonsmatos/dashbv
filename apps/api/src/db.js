import pg from 'pg';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id bigserial PRIMARY KEY,
      occurred_at date NOT NULL,
      kind varchar(10) NOT NULL CHECK (kind IN ('Receita','Despesa')),
      fund text NOT NULL,
      category text NOT NULL,
      description text NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount >= 0),
      estimated_date boolean NOT NULL DEFAULT false,
      source_file text NOT NULL,
      source_page integer,
      fingerprint text UNIQUE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_kind_category ON transactions(kind, category);
    CREATE TABLE IF NOT EXISTS monthly_summaries (
      month date PRIMARY KEY, revenue numeric(14,2), expense numeric(14,2), net numeric(14,2),
      ending_balance numeric(14,2), source_file text, balance_page integer
    );
    CREATE TABLE IF NOT EXISTS insight_cache (
      cache_key text PRIMARY KEY, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS import_runs (
      id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      status text NOT NULL, files_seen integer DEFAULT 0, rows_imported integer DEFAULT 0, message text
    );
  `);
}

function fingerprint(r, ordinal) {
  return [r.date,r.type,r.fund,r.category,r.description,r.amount,r.source_file,r.source_page,ordinal].join('|');
}

export async function seedIfEmpty() {
  const count = Number((await pool.query('SELECT count(*) n FROM transactions')).rows[0].n);
  const path = process.env.SEED_CSV;
  if (count || !path || !fs.existsSync(path)) return;
  const rows = parse(fs.readFileSync(path), { columns: true, skip_empty_lines: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [ordinal, r] of rows.entries()) {
      await client.query(`INSERT INTO transactions
        (occurred_at,kind,fund,category,description,amount,estimated_date,source_file,source_page,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(fingerprint) DO NOTHING`,
        [r.date,r.type,r.fund,r.category,r.description,r.amount,r.estimated_date==='True',r.source_file,Number(r.source_page)||null,fingerprint(r,ordinal)]);
    }
    const summaryPath = process.env.SEED_SUMMARY_CSV;
    if (summaryPath && fs.existsSync(summaryPath)) {
      const summaries = parse(fs.readFileSync(summaryPath), { columns: true, skip_empty_lines: true });
      for (const r of summaries) await client.query(`INSERT INTO monthly_summaries
        (month,revenue,expense,net,ending_balance,source_file,balance_page) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(month) DO UPDATE SET revenue=excluded.revenue,expense=excluded.expense,net=excluded.net,
        ending_balance=excluded.ending_balance,source_file=excluded.source_file,balance_page=excluded.balance_page`,
        [r.period_start,r.revenue,r.expense,r.net,r.ending_balance,r.source_file,Number(r.balance_page)||null]);
    }
    await client.query(`INSERT INTO import_runs(status,finished_at,rows_imported,message) VALUES('success',now(),$1,'Carga inicial CSV')`,[rows.length]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
