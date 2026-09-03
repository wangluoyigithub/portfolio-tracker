FROM python:3.12-slim

WORKDIR /app
COPY server.py index.html app-v2.js styles.css ./
RUN mkdir -p /app/data

ENV PORTFOLIO_HOST=0.0.0.0
ENV PORTFOLIO_PORT=8080
ENV PORTFOLIO_DB=/app/data/portfolio.db
EXPOSE 8080

CMD ["python", "server.py"]
