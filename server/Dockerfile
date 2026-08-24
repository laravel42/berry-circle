# syntax=docker/dockerfile:1

FROM golang:1.26.6-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/berry-api ./cmd/api \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/berry-migrate ./cmd/migrate \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/berry-seed ./cmd/seed \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/berry-worker ./cmd/worker

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && addgroup -S berry \
    && adduser -S -G berry -h /home/berry berry \
    && mkdir -p /data/uploads \
    && chown -R berry:berry /data

COPY --from=build /out/berry-api /usr/local/bin/berry-api
COPY --from=build /out/berry-migrate /usr/local/bin/berry-migrate
COPY --from=build /out/berry-seed /usr/local/bin/berry-seed
COPY --from=build /out/berry-worker /usr/local/bin/berry-worker

USER berry
WORKDIR /home/berry
ENV API_ADDR=0.0.0.0:4000
ENV STORAGE_LOCAL_ROOT=/data/uploads
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:4000/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/berry-api"]
