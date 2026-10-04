FROM rust:1.98-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked && cp target/release/pwtools-api target/release/pwtools-storage /usr/local/bin/

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home pwtools
COPY --from=builder /usr/local/bin/pwtools-api /usr/local/bin/pwtools-api
COPY --from=builder /usr/local/bin/pwtools-storage /usr/local/bin/pwtools-storage
USER pwtools
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/pwtools-api"]
