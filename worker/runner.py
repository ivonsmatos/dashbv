import csv
import hashlib
import json
import logging
import os
import subprocess
from pathlib import Path

import psycopg
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dashbv-worker")
ROOT = Path(os.environ.get("DATA_ROOT", "/data"))
PDF_DIR = ROOT / "doc"
STATE = ROOT / "pdf-state.json"


def pdf_state():
    return {p.name: {"size": p.stat().st_size, "mtime": int(p.stat().st_mtime)} for p in sorted(PDF_DIR.glob("*.pdf"))}


def fingerprint(row, ordinal):
    values = [row.get(k, "") for k in ("date", "type", "fund", "category", "description", "amount", "source_file", "source_page")]
    return hashlib.sha256(("|".join(values) + f"|{ordinal}").encode()).hexdigest()


def import_csv(conn):
    tx_path = ROOT / "transacoes_financeiras.csv"
    summary_path = ROOT / "resumo_mensal.csv"
    with tx_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    with conn.cursor() as cur:
        cur.execute("INSERT INTO import_runs(status,files_seen) VALUES('running',%s) RETURNING id", (len(pdf_state()),))
        run_id = cur.fetchone()[0]
        for ordinal, row in enumerate(rows):
            cur.execute("""INSERT INTO transactions
                (occurred_at,kind,fund,category,description,amount,estimated_date,source_file,source_page,fingerprint)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(fingerprint) DO NOTHING""",
                (row["date"], row["type"], row["fund"], row["category"], row["description"], row["amount"],
                 row["estimated_date"] == "True", row["source_file"], int(row["source_page"]), fingerprint(row, ordinal)))
        if summary_path.exists():
            with summary_path.open(encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    cur.execute("""INSERT INTO monthly_summaries(month,revenue,expense,net,ending_balance,source_file,balance_page)
                        VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(month) DO UPDATE SET
                        revenue=excluded.revenue,expense=excluded.expense,net=excluded.net,
                        ending_balance=excluded.ending_balance,source_file=excluded.source_file,balance_page=excluded.balance_page""",
                        (row["period_start"], row["revenue"], row["expense"], row["net"], row["ending_balance"], row["source_file"], row["balance_page"]))
        cur.execute("UPDATE import_runs SET status='success',finished_at=now(),rows_imported=%s,message='PDFs processados' WHERE id=%s", (len(rows), run_id))
        cur.execute("DELETE FROM insight_cache")
    conn.commit()
    return len(rows)


def scan(force=False):
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    current = pdf_state()
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    if not current:
        log.info("Nenhum PDF encontrado; mantendo banco atual")
        return
    if not force and current == previous:
        log.info("Nenhuma alteração nos PDFs")
        return
    log.info("Processando %d PDFs", len(current))
    try:
        subprocess.run(["python", "/app/build_financial_dashboard.py"], check=True, env={**os.environ, "DATA_ROOT": str(ROOT)})
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            count = import_csv(conn)
        STATE.write_text(json.dumps(current, indent=2))
        log.info("Importação concluída: %d lançamentos", count)
    except Exception as exc:
        log.exception("Falha na importação")
        try:
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("INSERT INTO import_runs(status,finished_at,message) VALUES('failed',now(),%s)", (str(exc)[:1000],))
                conn.commit()
        finally:
            raise


if __name__ == "__main__":
    if os.environ.get("RUN_ON_START") == "true":
        scan()
    scheduler = BlockingScheduler(timezone="America/Sao_Paulo")
    scheduler.add_job(scan, CronTrigger(day="1,16", hour=2, minute=0), id="pdf-import", max_instances=1, coalesce=True, misfire_grace_time=21600)
    log.info("Agente ativo; próximas execuções nos dias 1 e 16 às 02:00")
    scheduler.start()
