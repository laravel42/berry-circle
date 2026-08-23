# Third-party notices

Berry's Go server may ship only permissively licensed dependencies. Versions
below were selected with `go get ...@latest` under Go 1.26.6 on 2026-08-22.
The S3 lane's complete newly introduced runtime graph is recorded below.

| Module | Version | Purpose | License | Source |
|---|---:|---|---|---|
| `github.com/aws/aws-sdk-go-v2` | `v1.43.7` | AWS configuration and S3 request primitives | Apache-2.0 | <https://github.com/aws/aws-sdk-go-v2> |
| `github.com/aws/aws-sdk-go-v2/config` | `v1.32.38` | Standard AWS credential/configuration chain | Apache-2.0 | <https://github.com/aws/aws-sdk-go-v2> |
| `github.com/aws/aws-sdk-go-v2/credentials` | `v1.19.37` | Explicit static credential provider | Apache-2.0 | <https://github.com/aws/aws-sdk-go-v2> |
| `github.com/aws/aws-sdk-go-v2/service/s3` | `v1.107.3` | S3 object operations and request presigning | Apache-2.0 | <https://github.com/aws/aws-sdk-go-v2> |
| `github.com/go-chi/chi/v5` | `v5.3.2` | HTTP routing and middleware composition | MIT | <https://github.com/go-chi/chi> |
| `github.com/google/uuid` | `v1.6.0` | Berry-owned UUID generation | BSD-3-Clause | <https://github.com/google/uuid> |
| `github.com/gorilla/websocket` | `v1.5.3` | Authenticated browser WebSocket transport | BSD-2-Clause | <https://github.com/gorilla/websocket> |
| `github.com/jackc/pgx/v5` | `v5.10.0` | PostgreSQL pool, transactions, and migration runner | MIT | <https://github.com/jackc/pgx> |
| `github.com/prometheus/client_golang` | `v1.24.1` | Prometheus HTTP and process metrics | Apache-2.0 | <https://github.com/prometheus/client_golang> |
| `github.com/redis/go-redis/v9` | `v9.22.0` | Valkey-compatible cache and coordination client | BSD-2-Clause | <https://github.com/redis/go-redis> |
| `go.opentelemetry.io/otel` | `v1.45.0` | W3C propagation and tracing API | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-go> |
| `go.opentelemetry.io/otel/trace` | `v1.45.0` | OpenTelemetry trace API module | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-go> |
| `go.opentelemetry.io/otel/sdk` | `v1.45.0` | Exporter-free tracing SDK hooks | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-go> |

This notice summarizes module licensing; it does not replace the license texts
distributed by each upstream project.

## AWS S3 transitive runtime audit

Every module introduced transitively by the AWS SDK packages above was
inspected in the resolved Go module graph. All are from the AWS SDK for Go v2
repository under Apache-2.0, except Smithy Go, which is also Apache-2.0.

| Module | Version | License |
|---|---:|---|
| `github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream` | `v1.7.18` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/feature/ec2/imds` | `v1.18.38` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/configsources` | `v1.4.38` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/endpoints/v2` | `v2.7.38` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/v4a` | `v1.4.39` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding` | `v1.13.17` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/checksum` | `v1.9.31` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/presigned-url` | `v1.13.38` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/s3shared` | `v1.19.39` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/signin` | `v1.5.7` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/sso` | `v1.33.7` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/ssooidc` | `v1.38.7` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/sts` | `v1.45.7` | Apache-2.0 |
| `github.com/aws/smithy-go` | `v1.27.8` | Apache-2.0 |

The AWS SDK distribution carries its required notice:
`AWS SDK for Go; Copyright 2015 Amazon.com, Inc. or its affiliates; Copyright
2014-2015 Stripe, Inc.` AWS SDK core and Smithy Go also contain Go standard
library-derived `singleflight`/JSON helper material under BSD-3-Clause. Both
Apache-2.0 and BSD-3-Clause satisfy Berry's permissive runtime policy. No
copyleft, source-available, unknown-license, or branding-restricted dependency
was introduced by this lane.

## Evaluated development tool not retained

`github.com/sqlc-dev/sqlc/cmd/sqlc` `v1.31.1` is MIT, but its current command
graph blank-imports `github.com/go-sql-driver/mysql` `v1.9.3` (MPL-2.0).
Because MPL-2.0 is outside Berry's permissive-only policy, the sqlc Go tool
directive and that transitive graph are not retained in `go.mod`/`go.sum`.
The checked-in PostgreSQL output was generated during this audit before the
tool graph was removed; no MySQL driver is imported or shipped by Berry.
