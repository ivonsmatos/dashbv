FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd -g 10001 app && useradd -u 10001 -g app -s /usr/sbin/nologin app
COPY worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY build_financial_dashboard.py ./build_financial_dashboard.py
COPY worker/runner.py ./runner.py
RUN mkdir -p /data/doc && chown -R app:app /app /data
USER app
CMD ["python", "runner.py"]
