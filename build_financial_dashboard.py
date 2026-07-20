from __future__ import annotations

import csv
import glob
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import fitz


ROOT = Path(os.environ.get("DATA_ROOT", Path(__file__).resolve().parent))
PDF_DIR = ROOT / "doc"
MONEY_RE = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d{2}$")
DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")


def money(value: str) -> float:
    return float(value.replace(".", "").replace(",", "."))


def clean_text(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split()).strip(" .-")


def ascii_upper(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in value if not unicodedata.combining(ch)).upper()


def page_lines(page: fitz.Page) -> list[list[tuple]]:
    words = sorted(page.get_text("words"), key=lambda w: (round(w[1], 1), w[0]))
    grouped: list[list[tuple]] = []
    for word in words:
        if not grouped or abs(grouped[-1][0][1] - word[1]) > 1.0:
            grouped.append([word])
        else:
            grouped[-1].append(word)
    for row in grouped:
        row.sort(key=lambda w: w[0])
    return grouped


def row_text(row: list[tuple], min_x: float = 0, max_x: float = 9999) -> str:
    return clean_text(" ".join(w[4] for w in row if min_x <= w[0] < max_x))


def find_amount(text: str, label: str, after: bool) -> float | None:
    lines = [clean_text(x) for x in text.splitlines() if clean_text(x)]
    for idx, line in enumerate(lines):
        if ascii_upper(label) in ascii_upper(line):
            candidates = lines[idx + 1 : idx + 6] if after else list(reversed(lines[max(0, idx - 6) : idx]))
            for item in candidates:
                if MONEY_RE.fullmatch(item):
                    return money(item)
    return None


IGNORED_HEADINGS = {
    "DEMONSTRATIVO DE RECEITAS",
    "DEMONSTRATIVO DE DESPESAS",
    "DATA",
    "HISTORICO",
    "VALOR",
    "TOTAL",
    "UNIDADE",
    "RECIBO",
    "VENCTO",
}


def heading_candidate(text: str) -> str | None:
    text = clean_text(text)
    folded = ascii_upper(text)
    if not text or folded in IGNORED_HEADINGS or folded.startswith("TOTAL "):
        return None
    letters = [c for c in text if c.isalpha()]
    if not letters or not all(c.isupper() for c in letters):
        return None
    if re.search(r"\d{2}/\d{2}/\d{4}", text):
        return None
    return text


def parse_revenue_pages(doc: fitz.Document, page_indexes: list[int], source_file: str) -> list[dict]:
    rows: list[dict] = []
    category = "OUTRAS RECEITAS"
    fund = "CAIXA ORDINARIO"
    for page_idx in page_indexes:
        for line in page_lines(doc[page_idx]):
            text = row_text(line)
            folded = ascii_upper(text)
            candidate = heading_candidate(text)
            if candidate:
                if folded.startswith("CAIXA ") or folded in {"FUNDO DE RESERVA", "PINTURA E MELHORIAS"}:
                    fund = candidate
                elif min(w[0] for w in line) < 115:
                    category = candidate

            date_tokens = [w[4] for w in line if 90 <= w[0] < 155 and DATE_RE.fullmatch(w[4])]
            amounts = [w[4] for w in line if w[0] >= 510 and MONEY_RE.fullmatch(w[4])]
            if not date_tokens or not amounts:
                continue
            description = row_text(line, 325, 510) or category
            rows.append(
                {
                    "date": datetime.strptime(date_tokens[0], "%d/%m/%Y").date().isoformat(),
                    "type": "Receita",
                    "fund": fund,
                    "category": clean_text(category),
                    "description": clean_text(description),
                    "amount": round(money(amounts[-1]), 2),
                    "estimated_date": False,
                    "source_file": source_file,
                    "source_page": page_idx + 1,
                }
            )
    return rows


def parse_expense_pages(doc: fitz.Document, page_indexes: list[int], source_file: str, period_end) -> list[dict]:
    rows: list[dict] = []
    category = "OUTRAS DESPESAS"
    fund = "CAIXA ORDINARIO"
    for page_idx in page_indexes:
        for line in page_lines(doc[page_idx]):
            text = row_text(line)
            folded = ascii_upper(text)
            candidate = heading_candidate(text)
            if candidate:
                if folded.startswith("CAIXA ") or folded in {"FUNDO DE RESERVA", "PINTURA E MELHORIAS", "INSS/FGTS"}:
                    fund = candidate
                elif min(w[0] for w in line) < 125:
                    category = candidate

            date_tokens = [w[4] for w in line if 90 <= w[0] < 155 and DATE_RE.fullmatch(w[4])]
            amounts = [w[4] for w in line if 380 <= w[0] < 450 and MONEY_RE.fullmatch(w[4])]
            if not amounts:
                continue
            description = row_text(line, 145, 385) or category
            if not date_tokens and (not description or ascii_upper(description) in IGNORED_HEADINGS):
                continue
            rows.append(
                {
                    "date": (datetime.strptime(date_tokens[0], "%d/%m/%Y").date() if date_tokens else period_end).isoformat(),
                    "type": "Despesa",
                    "fund": fund,
                    "category": clean_text(category),
                    "description": clean_text(description),
                    "amount": round(money(amounts[-1]), 2),
                    "estimated_date": not bool(date_tokens),
                    "source_file": source_file,
                    "source_page": page_idx + 1,
                }
            )
    return rows


def parse_month_summary(page: fitz.Page) -> tuple[float, float, float] | None:
    for row in page_lines(page):
        left = ascii_upper(row_text(row, 55, 150))
        values = [money(w[4]) for w in row if w[0] >= 300 and MONEY_RE.fullmatch(w[4])]
        if left == "TOTAL" and len(values) >= 4:
            return round(values[1], 2), round(values[2], 2), round(values[3], 2)
    return None


def extract_all() -> tuple[list[dict], list[dict], list[dict]]:
    transactions: list[dict] = []
    months: list[dict] = []
    qa: list[dict] = []
    for pdf_path in sorted(PDF_DIR.glob("*.pdf")):
        doc = fitz.open(pdf_path)
        revenue_pages: list[int] = []
        for idx, page in enumerate(doc):
            text = page.get_text("text")
            if "Demonstrativo de Receitas\nUnidade" in text:
                revenue_pages.append(idx)
        if not revenue_pages:
            doc.close()
            continue

        expense_pages: list[int] = []
        idx = revenue_pages[-1] + 1
        while idx < min(len(doc), revenue_pages[-1] + 6):
            text = doc[idx].get_text("text")
            if "Demonstrativo de Despesas" in text and "Data" in text and "Histórico" in text:
                break
            idx += 1
        while idx < len(doc):
            text = doc[idx].get_text("text")
            if "Demonstrativo de Despesas" not in text:
                break
            expense_pages.append(idx)
            if "TOTAL DAS DESPESAS" in text:
                break
            idx += 1

        cover = doc[0].get_text("text")
        period_text = doc[revenue_pages[0]].get_text("text")
        period_match = re.search(r"Período:\s*(\d{2}/\d{2}/\d{4})\s*a\s*(\d{2}/\d{2}/\d{4})", period_text)
        if not period_match:
            raise RuntimeError(f"Período não encontrado em {pdf_path.name}")
        period_start = datetime.strptime(period_match.group(1), "%d/%m/%Y").date()
        period_end = datetime.strptime(period_match.group(2), "%d/%m/%Y").date()

        revenue_rows = parse_revenue_pages(doc, revenue_pages, pdf_path.name)
        expense_rows = parse_expense_pages(doc, expense_pages, pdf_path.name, period_end)
        revenue_rows = [x for x in revenue_rows if any(ch.isalnum() for ch in x["description"])]
        revenue_total = None
        for p in reversed(revenue_pages):
            revenue_total = find_amount(doc[p].get_text("text"), "TOTAL GERAL RECEITAS", after=True)
            if revenue_total is not None:
                break
        expense_total = None
        for p in reversed(expense_pages):
            expense_total = find_amount(doc[p].get_text("text"), "TOTAL DAS DESPESAS", after=True)
            if expense_total is not None:
                break
        balance_total = None
        balance_page = None
        summary = None
        for p in range(min(revenue_pages)):
            text = doc[p].get_text("text")
            if "SALDO FINAL" in text:
                summary = parse_month_summary(doc[p])
                balance_total = summary[2] if summary else find_amount(text, "SALDO FINAL", after=False)
                balance_page = p + 1
                break

        if summary:
            revenue_total, expense_total, balance_total = summary

        parsed_revenue = round(sum(x["amount"] for x in revenue_rows), 2)
        parsed_expense = round(sum(x["amount"] for x in expense_rows), 2)
        if summary is None:
            revenue_total = parsed_revenue
            expense_total = parsed_expense
        for tx_type, parsed, reported, target in (
            ("Receita", parsed_revenue, revenue_total, revenue_rows),
            ("Despesa", parsed_expense, expense_total, expense_rows),
        ):
            if reported is not None and abs(reported - parsed) >= 0.01:
                target.append({
                    "date": period_end.isoformat(),
                    "type": tx_type,
                    "fund": "CONSOLIDADO",
                    "category": "AJUSTE DE CONCILIAÇÃO",
                    "description": "Diferença sem data individual no demonstrativo; alocada ao fim do mês",
                    "amount": round(reported - parsed, 2),
                    "estimated_date": True,
                    "source_file": pdf_path.name,
                    "source_page": balance_page,
                })
        transactions.extend(revenue_rows)
        transactions.extend(expense_rows)
        months.append(
            {
                "month": period_start.strftime("%Y-%m"),
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
                "revenue": revenue_total,
                "expense": expense_total,
                "net": round((revenue_total or 0) - (expense_total or 0), 2),
                "ending_balance": balance_total,
                "source_file": pdf_path.name,
                "balance_page": balance_page,
                "revenue_pages": ",".join(str(x + 1) for x in revenue_pages),
                "expense_pages": ",".join(str(x + 1) for x in expense_pages),
            }
        )
        qa.append(
            {
                "month": period_start.strftime("%Y-%m"),
                "reported_revenue": revenue_total,
                "parsed_revenue": parsed_revenue,
                "revenue_diff": None if revenue_total is None else round(sum(x["amount"] for x in revenue_rows) - revenue_total, 2),
                "reported_expense": expense_total,
                "parsed_expense": parsed_expense,
                "expense_diff": None if expense_total is None else round(sum(x["amount"] for x in expense_rows) - expense_total, 2),
                "revenue_rows": len(revenue_rows),
                "expense_rows": len(expense_rows),
                "source_file": pdf_path.name,
            }
        )
        doc.close()
    months.sort(key=lambda x: x["month"])
    transactions.sort(key=lambda x: (x["date"], x["type"], x["category"], x["amount"]))
    qa.sort(key=lambda x: x["month"])
    return transactions, months, qa


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def aggregate_rows(transactions: list[dict], months: list[dict]) -> dict[str, list[dict]]:
    weekly = defaultdict(lambda: {"revenue": 0.0, "expense": 0.0})
    expense_categories = defaultdict(float)
    revenue_categories = defaultdict(float)
    for row in transactions:
        day = datetime.strptime(row["date"], "%Y-%m-%d").date()
        week = (day - timedelta(days=day.weekday())).isoformat()
        key = "revenue" if row["type"] == "Receita" else "expense"
        weekly[week][key] += row["amount"]
        if row["category"] != "AJUSTE DE CONCILIAÇÃO":
            target = revenue_categories if row["type"] == "Receita" else expense_categories
            target[row["category"]] += row["amount"]

    weekly_rows = []
    weekly_flow = []
    for week, values in sorted(weekly.items()):
        revenue = round(values["revenue"], 2)
        expense = round(values["expense"], 2)
        weekly_rows.append({"week": week, "revenue": revenue, "expense": expense, "net": round(revenue - expense, 2)})
        weekly_flow.extend([
            {"week": week, "series": "Receitas", "value": revenue},
            {"week": week, "series": "Despesas", "value": expense},
        ])

    monthly_flow = []
    for row in months:
        month_date = f'{row["month"]}-01'
        monthly_flow.extend([
            {"month": month_date, "series": "Receitas", "value": row["revenue"]},
            {"month": month_date, "series": "Despesas", "value": row["expense"]},
        ])

    annual = defaultdict(lambda: {"revenue": 0.0, "expense": 0.0, "months": 0})
    for row in months:
        year = row["month"][:4]
        annual[year]["revenue"] += row["revenue"]
        annual[year]["expense"] += row["expense"]
        annual[year]["months"] += 1
    annual_rows = []
    annual_flow = []
    for year, values in sorted(annual.items()):
        coverage = "Ano completo" if values["months"] == 12 else f'{values["months"]} meses'
        annual_rows.append({
            "year": year,
            "coverage": coverage,
            "months": values["months"],
            "revenue": round(values["revenue"], 2),
            "expense": round(values["expense"], 2),
            "net": round(values["revenue"] - values["expense"], 2),
        })
        annual_flow.extend([
            {"year": year, "series": "Receitas", "value": round(values["revenue"], 2), "coverage": coverage},
            {"year": year, "series": "Despesas", "value": round(values["expense"], 2), "coverage": coverage},
        ])

    def ranked(values, n):
        return [
            {"category": key, "value": round(value, 2), "rank": idx + 1}
            for idx, (key, value) in enumerate(sorted(values.items(), key=lambda item: item[1], reverse=True)[:n])
        ]

    top_expenses = sorted(
        (
            {"date": x["date"], "category": x["category"], "description": x["description"], "amount": x["amount"], "source_file": x["source_file"], "source_page": x["source_page"]}
            for x in transactions
            if x["type"] == "Despesa" and x["category"] != "AJUSTE DE CONCILIAÇÃO" and x["amount"] > 0
        ),
        key=lambda x: x["amount"],
        reverse=True,
    )[:30]

    total_revenue = round(sum(x["revenue"] for x in months), 2)
    total_expense = round(sum(x["expense"] for x in months), 2)
    latest = months[-1]
    max_expense_month = max(months, key=lambda x: x["expense"])
    kpis = [{
        "total_revenue": total_revenue,
        "total_expense": total_expense,
        "net_total": round(total_revenue - total_expense, 2),
        "ending_balance": latest["ending_balance"],
        "avg_monthly_expense": round(total_expense / len(months), 2),
        "latest_month": latest["month"],
    }]
    return {
        "kpis": kpis,
        "monthly": months,
        "monthly_flow": monthly_flow,
        "weekly": weekly_rows,
        "weekly_flow": weekly_flow,
        "annual": annual_rows,
        "annual_flow": annual_flow,
        "expense_categories": ranked(expense_categories, 12),
        "revenue_categories": ranked(revenue_categories, 12),
        "top_expenses": top_expenses,
        "max_expense_month": [max_expense_month],
    }


def build_artifact(transactions: list[dict], months: list[dict], qa: list[dict]) -> dict:
    datasets = aggregate_rows(transactions, months)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    top_expense_category = datasets["expense_categories"][0]
    max_month = datasets["max_expense_month"][0]
    source_id = "prestacoes_contas_pdf"
    source_manifest = {
        "id": source_id,
        "label": "37 prestações de contas mensais (PDF)",
        "path": "doc/*.pdf",
    }
    cards = [
        {"id": "card_revenue", "dataset": "kpis", "sourceId": source_id, "description": "Créditos consolidados nos 37 demonstrativos mensais.", "metrics": [{"label": "Receitas acumuladas (R$)", "field": "total_revenue", "format": "number"}]},
        {"id": "card_expense", "dataset": "kpis", "sourceId": source_id, "description": "Débitos consolidados nos 37 demonstrativos mensais.", "metrics": [{"label": "Despesas acumuladas (R$)", "field": "total_expense", "format": "number"}]},
        {"id": "card_net", "dataset": "kpis", "sourceId": source_id, "description": "Receitas menos despesas no período coberto.", "metrics": [{"label": "Resultado acumulado (R$)", "field": "net_total", "format": "number", "signed": True}]},
        {"id": "card_balance", "dataset": "kpis", "sourceId": source_id, "description": "Saldo final consolidado do demonstrativo de maio/2026.", "metrics": [{"label": "Saldo final (R$)", "field": "ending_balance", "format": "number"}]},
    ]

    def line_chart(cid, title, dataset, xfield, xlabel, subtitle):
        return {
            "id": cid, "title": title, "subtitle": subtitle, "type": "line", "dataset": dataset,
            "sourceId": source_id, "valueFormat": "number",
            "encodings": {
                "x": {"field": xfield, "type": "temporal", "label": xlabel},
                "y": {"field": "value", "type": "quantitative"},
                "color": {"field": "series", "type": "nominal", "label": "Fluxo"},
                "tooltip": [
                    {"field": "series", "type": "nominal", "label": "Fluxo"},
                    {"field": "value", "type": "quantitative", "label": "Valor (R$)", "format": "number"},
                ],
            },
        }

    charts = [
        line_chart("weekly_chart", "Receitas e despesas por semana", "weekly_flow", "week", "Semana iniciada em", "Transações diárias agrupadas pela segunda-feira de cada semana."),
        line_chart("monthly_chart", "Receitas e despesas por mês", "monthly_flow", "month", "Mês", "Valores consolidados e reconciliados com cada prestação de contas."),
        {
            "id": "annual_chart", "title": "Receitas e despesas por ano", "subtitle": "2023 cobre mai–dez; 2026 cobre jan–mai.",
            "type": "bar", "dataset": "annual_flow", "sourceId": source_id, "valueFormat": "number", "settings": {"showValues": False},
            "encodings": {
                "x": {"field": "year", "type": "nominal", "label": "Ano"},
                "y": {"field": "value", "type": "quantitative"},
                "color": {"field": "series", "type": "nominal", "label": "Fluxo"},
                "tooltip": [
                    {"field": "coverage", "type": "nominal", "label": "Cobertura"},
                    {"field": "value", "type": "quantitative", "label": "Valor (R$)", "format": "number"},
                ],
            },
        },
        {
            "id": "net_chart", "title": "Resultado líquido mensal", "subtitle": "Receitas menos despesas; barras negativas indicam déficit mensal.",
            "type": "bar", "dataset": "monthly", "sourceId": source_id, "valueFormat": "number", "settings": {"showValues": False},
            "encodings": {
                "x": {"field": "period_start", "type": "temporal", "label": "Mês"},
                "y": {"field": "net", "type": "quantitative"},
                "tooltip": [
                    {"field": "revenue", "type": "quantitative", "label": "Receitas (R$)", "format": "number"},
                    {"field": "expense", "type": "quantitative", "label": "Despesas (R$)", "format": "number"},
                ],
            },
        },
        {
            "id": "expense_category_chart", "title": "Categorias com maior despesa", "subtitle": "Top 12 no período; ajustes de conciliação excluídos.",
            "type": "horizontalBar", "dataset": "expense_categories", "sourceId": source_id, "valueFormat": "number", "settings": {"showValues": False},
            "encodings": {
                "x": {"field": "category", "type": "nominal", "label": "Categoria"},
                "y": {"field": "value", "type": "quantitative"},
                "tooltip": [{"field": "rank", "type": "quantitative", "label": "Posição"}],
            },
        },
        {
            "id": "revenue_category_chart", "title": "Categorias com maior receita", "subtitle": "Top 12 no período; ajustes de conciliação excluídos.",
            "type": "horizontalBar", "dataset": "revenue_categories", "sourceId": source_id, "valueFormat": "number", "settings": {"showValues": False},
            "encodings": {
                "x": {"field": "category", "type": "nominal", "label": "Categoria"},
                "y": {"field": "value", "type": "quantitative"},
                "tooltip": [{"field": "rank", "type": "quantitative", "label": "Posição"}],
            },
        },
    ]
    tables = [
        {
            "id": "monthly_table", "title": "Resumo mensal completo", "subtitle": "37 meses, de maio/2023 a maio/2026.",
            "dataset": "monthly", "sourceId": source_id, "defaultSort": {"field": "period_start", "direction": "asc"},
            "columns": [
                {"field": "period_start", "label": "Mês", "type": "date"},
                {"field": "revenue", "label": "Receitas (R$)", "format": "number"},
                {"field": "expense", "label": "Despesas (R$)", "format": "number"},
                {"field": "net", "label": "Resultado (R$)", "format": "number", "movement": True},
                {"field": "ending_balance", "label": "Saldo final (R$)", "format": "number"},
                {"field": "source_file", "label": "PDF", "type": "text"},
            ],
        },
        {
            "id": "annual_table", "title": "Resumo anual", "subtitle": "Anos parciais identificados na coluna de cobertura.",
            "dataset": "annual", "sourceId": source_id, "defaultSort": {"field": "year", "direction": "asc"},
            "columns": [
                {"field": "year", "label": "Ano", "type": "text"},
                {"field": "coverage", "label": "Cobertura", "type": "text"},
                {"field": "revenue", "label": "Receitas (R$)", "format": "number"},
                {"field": "expense", "label": "Despesas (R$)", "format": "number"},
                {"field": "net", "label": "Resultado (R$)", "format": "number", "movement": True},
            ],
        },
        {
            "id": "top_expenses_table", "title": "Maiores lançamentos de despesa", "subtitle": "30 maiores lançamentos individuais com data disponível.",
            "dataset": "top_expenses", "sourceId": source_id, "defaultSort": {"field": "amount", "direction": "desc"},
            "columns": [
                {"field": "date", "label": "Data", "type": "date"},
                {"field": "category", "label": "Categoria", "type": "text"},
                {"field": "description", "label": "Histórico", "type": "text"},
                {"field": "amount", "label": "Valor (R$)", "format": "number"},
                {"field": "source_file", "label": "PDF", "type": "text"},
                {"field": "source_page", "label": "Página", "format": "number"},
            ],
        },
    ]
    blocks = [
        {"id": "metrics", "type": "metric-strip", "cardIds": [x["id"] for x in cards]},
        {"id": "weekly", "type": "chart", "chartId": "weekly_chart"},
        {"id": "monthly", "type": "chart", "chartId": "monthly_chart"},
        {"id": "annual", "type": "chart", "chartId": "annual_chart"},
        {"id": "expense_categories", "type": "chart", "chartId": "expense_category_chart"},
    ]
    return {
        "surface": "dashboard",
        "manifest": {
            "version": 1,
            "surface": "dashboard",
            "title": "Dashboard financeiro — Parque Brasil–Boa Vista",
            "description": "Receitas, despesas, resultado, saldo e categorias com visão semanal, mensal e anual.",
            "generatedAt": generated_at,
            "cards": cards,
            "charts": charts,
            "tables": tables,
            "sources": [source_manifest],
            "blocks": blocks,
        },
        "snapshot": {
            "version": 1,
            "generatedAt": generated_at,
            "status": "ready",
            "datasets": {k: v for k, v in datasets.items() if k != "max_expense_month"},
            "accessIssues": [],
        },
        "sources": [
            {
                "id": source_id,
                "query": {
                    "engine": "duckdb",
                    "language": "sql",
                    "sql": "SELECT * FROM read_csv_auto('resumo_mensal.csv', header = true);",
                    "description": "Leitura do extrato mensal revisado; o CSV e as agregações semanais/categoriais são reproduzidos por build_financial_dashboard.py a partir dos 37 PDFs.",
                    "tables_used": ["resumo_mensal.csv", "transacoes_financeiras.csv", "doc/*.pdf"],
                    "filters": ["Condomínio 1674", "Período de 2023-05-01 a 2026-05-31"],
                    "metric_definitions": {
                        "Receitas": "Créditos mensais consolidados; soma dos lançamentos quando o resumo não possui camada de texto.",
                        "Despesas": "Débitos mensais consolidados; inclui todos os fundos exibidos no demonstrativo.",
                        "Resultado": "Receitas menos despesas no mesmo período.",
                        "Saldo final": "Saldo atual consolidado no fechamento do mês, conforme Resumo Financeiro Contábil.",
                    },
                    "executed_at": generated_at,
                },
            }
        ],
    }


if __name__ == "__main__":
    transactions, months, qa = extract_all()
    write_csv(ROOT / "transacoes_financeiras.csv", transactions)
    write_csv(ROOT / "resumo_mensal.csv", months)
    write_csv(ROOT / "qa_extracao.csv", qa)
    artifact = build_artifact(transactions, months, qa)
    (ROOT / "artifact.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    dashboard_data = {
        "generated_at": artifact["snapshot"]["generatedAt"],
        "coverage": {"start": months[0]["period_start"], "end": months[-1]["period_end"], "months": len(months)},
        "datasets": aggregate_rows(transactions, months),
    }
    (ROOT / "dashboard_data.json").write_text(json.dumps(dashboard_data, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({
        "transactions": len(transactions),
        "months": len(months),
        "revenue_diff_abs": round(sum(abs(x["revenue_diff"] or 0) for x in qa), 2),
        "expense_diff_abs": round(sum(abs(x["expense_diff"] or 0) for x in qa), 2),
        "qa": qa,
    }, ensure_ascii=False, indent=2))
