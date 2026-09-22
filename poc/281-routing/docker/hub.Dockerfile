# cadp278-hub: the UI. One page + a forwarder to the ops API. No Docker access.
FROM python:3.13-alpine
COPY hub/server.py hub/index.html /opt/hub/
EXPOSE 8780
CMD ["python3", "-u", "/opt/hub/server.py"]
