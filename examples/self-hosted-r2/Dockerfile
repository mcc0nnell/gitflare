FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gitflare
COPY container/git_http.py /opt/gitflare/git_http.py

RUN mkdir -p /data \
    && chmod 0755 /opt/gitflare/git_http.py

EXPOSE 8080
ENTRYPOINT ["python3", "/opt/gitflare/git_http.py"]
