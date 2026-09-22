# MLflow pinned to the same version already proven on the host (F1).
FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir mlflow==3.16.1
ENV MLFLOW_DISABLE_AGENT_HINT=1
EXPOSE 5000
