import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { api, query, session } from "./api";
import "./styles.css";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const compact = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const date = (v) =>
  v
    ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(v))
    : "—";
const palette = {
  ink: "#071b31",
  blue: "#235cff",
  cyan: "#17c3b2",
  coral: "#ff6b4a",
  muted: "#728098",
  grid: "#e7ebf2",
};
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

function Chart({ option, className = "" }) {
  const ref = useRef();
  useEffect(() => {
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption(option);
    const resize = () => chart.resize();
    addEventListener("resize", resize);
    return () => {
      removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} className={`chart ${className}`} />;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const x = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      session.set(x.token);
      onLogin();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="mark">BV</div>
        <p>FINANÇAS EM CONTEXTO</p>
        <h1>Decisões claras começam com números bem lidos.</h1>
        <span>
          Visão consolidada, rastreável e inteligente do fluxo financeiro.
        </span>
      </section>
      <form className="login-card" onSubmit={submit}>
        <div>
          <small>ACESSO SEGURO</small>
          <h2>Bem-vindo ao DashBV</h2>
          <p>Entre para consultar o painel financeiro.</p>
        </div>
        <label>
          E-mail
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>
          {busy ? "Entrando…" : "Entrar no dashboard"}
        </button>
        <footer>Ambiente protegido · dados privados</footer>
      </form>
    </main>
  );
}

function KPI({ label, value, tone, sub }) {
  return (
    <article className={`kpi ${tone || ""}`}>
      <div className="kpi-top">
        <span>{label}</span>
        <i />
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </article>
  );
}

function Dashboard({ logout }) {
  const [activeSection, setActiveSection] = useState(
    window.location.hash.replace("#", "") || "visao-geral",
  );
  const [filters, setFilters] = useState({ granularity: "month" });
  const [data, setData] = useState();
  const [meta, setMeta] = useState();
  const [insight, setInsight] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const [d, m] = await Promise.all([
        api(`/api/dashboard?${query(filters)}`),
        api("/api/meta"),
      ]);
      setData(d);
      setMeta(m);
      setInsight(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [
    filters.granularity,
    filters.from,
    filters.to,
    filters.fund,
    filters.scope,
  ]);
  async function analyze() {
    setInsight({ loading: true });
    try {
      setInsight(
        await api("/api/insights", {
          method: "POST",
          body: JSON.stringify(filters),
        }),
      );
    } catch (e) {
      setInsight({ error: e.message });
    }
  }
  function navigateTo(section) {
    setActiveSection(section);
    window.history.replaceState(null, "", `#${section}`);
    document
      .getElementById(section)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const timeline = useMemo(
    () => ({
      tooltip: { trigger: "axis", valueFormatter: (v) => money.format(v) },
      legend: { top: 0, data: ["Receitas", "Despesas"] },
      grid: { left: 18, right: 18, bottom: 10, top: 48, containLabel: true },
      xAxis: {
        type: "category",
        data: data?.timeline.map((x) => date(x.period)),
        axisLine: { lineStyle: { color: palette.grid } },
        axisLabel: { color: palette.muted },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (v) => compact.format(v),
          color: palette.muted,
        },
        splitLine: { lineStyle: { color: palette.grid } },
      },
      series: [
        {
          name: "Receitas",
          type: "line",
          smooth: 0.25,
          symbolSize: 7,
          data: data?.timeline.map((x) => x.revenue),
          lineStyle: { width: 3, color: palette.cyan },
          itemStyle: { color: palette.cyan },
          areaStyle: { color: "rgba(23,195,178,.08)" },
        },
        {
          name: "Despesas",
          type: "line",
          smooth: 0.25,
          symbolSize: 7,
          data: data?.timeline.map((x) => x.expense),
          lineStyle: { width: 3, color: palette.coral },
          itemStyle: { color: palette.coral },
          areaStyle: { color: "rgba(255,107,74,.06)" },
        },
      ],
    }),
    [data],
  );
  const expenses =
    data?.categories.filter((x) => x.kind === "Despesa").slice(0, 8) || [];
  const bars = useMemo(
    () => ({
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => money.format(v),
      },
      grid: { left: 8, right: 20, bottom: 8, top: 8, containLabel: true },
      xAxis: {
        type: "value",
        axisLabel: { formatter: (v) => compact.format(v) },
        splitLine: { lineStyle: { color: palette.grid } },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: expenses.map((x) =>
          x.category.length > 24 ? x.category.slice(0, 23) + "…" : x.category,
        ),
        axisLabel: { color: palette.ink },
      },
      series: [
        {
          type: "bar",
          data: expenses.map((x) => x.amount),
          barWidth: 16,
          itemStyle: { color: palette.blue, borderRadius: [0, 5, 5, 0] },
        },
      ],
    }),
    [data],
  );
  const scopeNames = ["Área Geral", "Edifício Boa Vista"];
  const scopeChart = useMemo(() => {
    const get = (scope, kind) =>
      Number(
        data?.scopes.find((x) => x.scope === scope && x.kind === kind)
          ?.amount || 0,
      );
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => money.format(v),
      },
      legend: { top: 0, data: ["Receitas", "Despesas"] },
      grid: { left: 15, right: 15, bottom: 10, top: 45, containLabel: true },
      xAxis: {
        type: "category",
        data: scopeNames,
        axisLabel: { color: palette.ink },
      },
      yAxis: {
        type: "value",
        axisLabel: { formatter: (v) => compact.format(v) },
        splitLine: { lineStyle: { color: palette.grid } },
      },
      series: [
        {
          name: "Receitas",
          type: "bar",
          data: scopeNames.map((x) => get(x, "Receita")),
          itemStyle: { color: palette.cyan, borderRadius: [5, 5, 0, 0] },
        },
        {
          name: "Despesas",
          type: "bar",
          data: scopeNames.map((x) => get(x, "Despesa")),
          itemStyle: { color: palette.coral, borderRadius: [5, 5, 0, 0] },
        },
      ],
    };
  }, [data]);
  if (loading && !data)
    return <div className="loading">Carregando inteligência financeira…</div>;
  return (
    <div className="app">
      <aside>
        <div className="logo">
          <b>BV</b>
          <span>
            Dash<strong>Finance</strong>
          </span>
        </div>
        <nav>
          {[
            ["visao-geral", "Visão geral"],
            ["lancamentos", "Lançamentos"],
            ["importacoes", "Importações"],
            ["agente-financeiro", "Agente financeiro"],
          ].map(([section, label]) => (
            <button
              type="button"
              key={section}
              className={activeSection === section ? "active" : ""}
              onClick={() => navigateTo(section)}
              aria-current={activeSection === section ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="aside-foot">
          <small>ÚLTIMA CARGA</small>
          <span>
            {meta?.lastImport ? date(meta.lastImport.finished_at) : "—"}
          </span>
          <button onClick={logout}>Sair</button>
        </div>
      </aside>
      <main className="content">
        <header id="visao-geral">
          <div>
            <small>PAINEL FINANCEIRO</small>
            <h1>Visão geral</h1>
            <p>Acompanhe Área Geral e Edifício Boa Vista separadamente.</p>
          </div>
          <div className="fresh">
            <i /> Atualizado{" "}
            {data ? new Date(data.generatedAt).toLocaleString("pt-BR") : "—"}
          </div>
        </header>
        <section className="filters">
          <label>
            De
            <input
              type="date"
              value={filters.from || ""}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            />
          </label>
          <label>
            Até
            <input
              type="date"
              value={filters.to || ""}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            />
          </label>
          <label>
            Centro de custo
            <select
              value={filters.scope || ""}
              onChange={(e) =>
                setFilters({ ...filters, scope: e.target.value })
              }
            >
              <option value="">Área Geral + Boa Vista</option>
              {meta?.scopes?.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Fundo
            <select
              value={filters.fund || ""}
              onChange={(e) => setFilters({ ...filters, fund: e.target.value })}
            >
              <option value="">Todos os fundos</option>
              {meta?.funds.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <div className="segmented">
            {[
              ["week", "Semana"],
              ["month", "Mês"],
              ["quarter", "Trimestre"],
              ["year", "Ano"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={filters.granularity === v ? "on" : ""}
                onClick={() => setFilters({ ...filters, granularity: v })}
              >
                {l}
              </button>
            ))}
          </div>
        </section>
        {error && <div className="error banner">{error}</div>}
        <section className="kpis">
          <KPI
            label="Receitas"
            value={money.format(data?.kpis.revenue || 0)}
            sub={`${data?.kpis.transactions || 0} lançamentos no recorte`}
            tone="positive"
          />
          <KPI
            label="Despesas"
            value={money.format(data?.kpis.expense || 0)}
            sub="Saídas consolidadas"
            tone="negative"
          />
          <KPI
            label="Resultado"
            value={money.format(data?.kpis.net || 0)}
            sub={
              data?.kpis.net >= 0
                ? "Superávit no período"
                : "Déficit no período"
            }
            tone={data?.kpis.net >= 0 ? "positive" : "negative"}
          />
          <KPI
            label="Saldo final apurado"
            value={
              data?.kpis.endingBalance == null
                ? "—"
                : money.format(data.kpis.endingBalance)
            }
            sub="Saldo contábil consolidado"
          />
        </section>
        <section className="grid">
          <article className="panel wide">
            <div className="panel-title">
              <div>
                <small>MOVIMENTO</small>
                <h2>Receitas x despesas</h2>
              </div>
              <span>
                {date(data?.coverage.min_date)} —{" "}
                {date(data?.coverage.max_date)}
              </span>
            </div>
            <Chart option={timeline} />
          </article>
          <article className="panel ai" id="agente-financeiro">
            <div className="panel-title">
              <div>
                <small>AGENTE FINANCEIRO</small>
                <h2>Leitura inteligente</h2>
              </div>
              <b>GROQ</b>
            </div>
            {!insight && (
              <div className="ai-empty">
                <div>✦</div>
                <p>
                  Gere uma análise objetiva do período e centro de custo
                  selecionados, com destaques, riscos e ações sugeridas.
                </p>
                <button onClick={analyze}>Analisar este recorte</button>
              </div>
            )}
            {insight?.loading && (
              <div className="ai-empty">
                <p>Analisando os indicadores…</p>
              </div>
            )}
            {insight?.error && (
              <div className="ai-empty">
                <p>{insight.error}</p>
                <button onClick={analyze}>Tentar novamente</button>
              </div>
            )}
            {insight?.summary && (
              <div className="ai-result">
                <p>{insight.summary}</p>
                <h3>Destaques</h3>
                <ul>
                  {insight.highlights?.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <h3>Ações</h3>
                <ul>
                  {insight.actions?.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
          <article className="panel">
            <div className="panel-title">
              <div>
                <small>CONCENTRAÇÃO</small>
                <h2>Maiores despesas</h2>
              </div>
            </div>
            <Chart option={bars} />
          </article>
          <article className="panel">
            <div className="panel-title">
              <div>
                <small>CENTROS DE CUSTO</small>
                <h2>Área Geral x Edifício Boa Vista</h2>
              </div>
            </div>
            <Chart option={scopeChart} />
          </article>
          <article className="panel table-panel full" id="lancamentos">
            <div className="panel-title">
              <div>
                <small>AUDITORIA</small>
                <h2>Maiores lançamentos</h2>
              </div>
              <span>{data?.coverage.source_files || 0} arquivos-fonte</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Centro</th>
                    <th>Tipo</th>
                    <th>Categoria</th>
                    <th>Histórico</th>
                    <th>Valor</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.topTransactions.map((x, i) => (
                    <tr key={i}>
                      <td>{date(x.date)}</td>
                      <td>
                        <span className="tag scope">{x.scope}</span>
                      </td>
                      <td>
                        <span
                          className={`tag ${x.kind === "Receita" ? "in" : "out"}`}
                        >
                          {x.kind}
                        </span>
                      </td>
                      <td>{x.category}</td>
                      <td>{x.description}</td>
                      <td className="amount">{money.format(x.amount)}</td>
                      <td>
                        {x.source_file} · p.{x.source_page}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className="panel import-panel full" id="importacoes">
            <div className="panel-title">
              <div>
                <small>ATUALIZAÇÃO DOS DADOS</small>
                <h2>Importações</h2>
              </div>
              <span>
                {meta?.lastImport?.status === "success"
                  ? "Carga concluída"
                  : meta?.lastImport?.status || "Sem carga registrada"}
              </span>
            </div>
            <div className="import-summary">
              <div>
                <small>ÚLTIMA EXECUÇÃO</small>
                <strong>
                  {meta?.lastImport?.finished_at
                    ? new Date(meta.lastImport.finished_at).toLocaleString(
                        "pt-BR",
                      )
                    : "—"}
                </strong>
              </div>
              <div>
                <small>ARQUIVOS NO RECORTE</small>
                <strong>{data?.coverage.source_files || 0}</strong>
              </div>
              <div>
                <small>LINHAS IMPORTADAS</small>
                <strong>{meta?.lastImport?.rows_imported || 0}</strong>
              </div>
              <div>
                <small>ORIGEM</small>
                <strong>Pasta doc · PDFs</strong>
              </div>
            </div>
          </article>
        </section>
        <footer className="page-foot">
          Datas estimadas: {data?.coverage.estimated_dates || 0} · Fonte:
          demonstrativos PDF processados e rastreáveis por página. Área Geral é
          identificada pelas referências explícitas “Área Geral”, “A.Geral”,
          “Taxa Geral”, “Bl.Geral”, “Controle Geral/Área” e “Quadro Geral”; os
          demais lançamentos pertencem ao Edifício Boa Vista.
        </footer>
      </main>
    </div>
  );
}

function App() {
  const [logged, setLogged] = useState(Boolean(session.get()));
  useEffect(() => {
    const fn = () => setLogged(false);
    addEventListener("dashbv:logout", fn);
    return () => removeEventListener("dashbv:logout", fn);
  }, []);
  return logged ? (
    <Dashboard
      logout={() => {
        session.clear();
        setLogged(false);
      }}
    />
  ) : (
    <Login onLogin={() => setLogged(true)} />
  );
}
createRoot(document.getElementById("root")).render(<App />);
