FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        e2fsprogs \
        python3 \
        shellcheck \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# FireCrab's repository pins its Rust toolchain. Install rustup without choosing
# a global default so the checkout's rust-toolchain file remains authoritative.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH="/root/.cargo/bin:${PATH}"
