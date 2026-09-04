FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py backup.py index.html app-v2.js styles.css ./
RUN mkdir -p /app/data

ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/wangluoyigithub/portfolio-tracker"
LABEL org.opencontainers.image.description="基金、股票、ETF 与可转债个人账户管理工具"
LABEL org.opencontainers.image.version="${VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORTFOLIO_HOST=0.0.0.0
ENV PORTFOLIO_PORT=8080
ENV PORTFOLIO_DB=/app/data/portfolio.db
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/api/state', timeout=3).read(1)"

CMD ["python", "server.py"]
