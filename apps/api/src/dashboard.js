import { pool } from "./db.js";

const grains = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};
const scopeSql = `(CASE WHEN
  upper(description) LIKE '%AREA GERAL%' OR upper(description) LIKE '%A.GERAL%' OR
  upper(description) LIKE '%TAXA GERAL%' OR upper(description) LIKE '%QUADRO GERAL%' OR
  upper(description) LIKE '%CONTROLE%GERAL%' OR upper(description) LIKE '%CONTROLE%AREA%' OR
  upper(category) LIKE '%BL.GERAL%'
  THEN 'Área Geral' ELSE 'Edifício Boa Vista' END)`;
function where(filters, start = 1) {
  const values = [];
  const parts = [];
  if (filters.from) {
    values.push(filters.from);
    parts.push(`occurred_at >= $${start + values.length - 1}`);
  }
  if (filters.to) {
    values.push(filters.to);
    parts.push(`occurred_at <= $${start + values.length - 1}`);
  }
  if (filters.fund) {
    values.push(filters.fund);
    parts.push(`fund = $${start + values.length - 1}`);
  }
  if (filters.scope) {
    values.push(filters.scope);
    parts.push(`${scopeSql} = $${start + values.length - 1}`);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", values };
}

export async function dashboard(filters = {}) {
  const grain = grains[filters.granularity] || "month";
  const w = where(filters);
  const [kpi, timeline, categories, funds, scopes, top, coverage] =
    await Promise.all([
      pool.query(
        `SELECT coalesce(sum(amount) FILTER(WHERE kind='Receita'),0)::float revenue,
      coalesce(sum(amount) FILTER(WHERE kind='Despesa'),0)::float expense,
      (coalesce(sum(amount) FILTER(WHERE kind='Receita'),0)-coalesce(sum(amount) FILTER(WHERE kind='Despesa'),0))::float net,
      count(*)::int transactions FROM transactions ${w.sql}`,
        w.values,
      ),
      pool.query(
        `SELECT date_trunc('${grain}',occurred_at)::date period,
      coalesce(sum(amount) FILTER(WHERE kind='Receita'),0)::float revenue,
      coalesce(sum(amount) FILTER(WHERE kind='Despesa'),0)::float expense
      FROM transactions ${w.sql} GROUP BY 1 ORDER BY 1`,
        w.values,
      ),
      pool.query(
        `SELECT kind,category,sum(amount)::float amount,count(*)::int entries FROM transactions ${w.sql}
      GROUP BY kind,category ORDER BY amount DESC LIMIT 20`,
        w.values,
      ),
      pool.query(
        `SELECT fund,sum(amount) FILTER(WHERE kind='Receita')::float revenue,
      sum(amount) FILTER(WHERE kind='Despesa')::float expense FROM transactions ${w.sql} GROUP BY fund ORDER BY coalesce(sum(amount),0) DESC`,
        w.values,
      ),
      pool.query(
        `SELECT ${scopeSql} scope,kind,sum(amount)::float amount,count(*)::int entries
      FROM transactions ${w.sql} GROUP BY 1,2 ORDER BY 1,2`,
        w.values,
      ),
      pool.query(
        `SELECT occurred_at date,kind,${scopeSql} scope,category,description,amount::float,source_file,source_page
      FROM transactions ${w.sql} ORDER BY amount DESC LIMIT 15`,
        w.values,
      ),
      pool.query(
        `SELECT min(occurred_at)::date min_date,max(occurred_at)::date max_date,
      count(DISTINCT source_file)::int source_files,count(*) FILTER(WHERE estimated_date)::int estimated_dates FROM transactions ${w.sql}`,
        w.values,
      ),
    ]);
  const latestBalance = await pool.query(
    "SELECT month,ending_balance::float FROM monthly_summaries ORDER BY month DESC LIMIT 1",
  );
  return {
    kpis: {
      ...kpi.rows[0],
      endingBalance: latestBalance.rows[0]?.ending_balance ?? null,
    },
    timeline: timeline.rows,
    categories: categories.rows,
    funds: funds.rows,
    scopes: scopes.rows,
    topTransactions: top.rows,
    coverage: coverage.rows[0],
    generatedAt: new Date().toISOString(),
  };
}

export async function transactions(filters = {}) {
  const w = where(filters);
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(filters.limit) || 25));
  const values = [...w.values, limit, (page - 1) * limit];
  const rows = await pool.query(
    `SELECT id,occurred_at date,kind,${scopeSql} scope,fund,category,description,amount::float,estimated_date,source_file,source_page
    FROM transactions ${w.sql} ORDER BY occurred_at DESC,id DESC LIMIT $${w.values.length + 1} OFFSET $${w.values.length + 2}`,
    values,
  );
  const total = Number(
    (await pool.query(`SELECT count(*) n FROM transactions ${w.sql}`, w.values))
      .rows[0].n,
  );
  return { rows: rows.rows, total, page, limit };
}
