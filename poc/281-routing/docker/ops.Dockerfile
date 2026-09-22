# cadp278-ops: the one component holding Docker control. Docker CLI + Python stdlib only.
FROM docker:27.5.1-cli
RUN apk add --no-cache python3
COPY ops/server.py /opt/ops/server.py
EXPOSE 8781
CMD ["python3", "-u", "/opt/ops/server.py"]
