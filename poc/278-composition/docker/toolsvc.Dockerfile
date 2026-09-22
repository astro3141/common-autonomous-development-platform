FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir "mcp>=1.28,<2"
COPY toolsvc/server.py /app/server.py
WORKDIR /app
EXPOSE 8000
CMD ["python", "server.py"]
