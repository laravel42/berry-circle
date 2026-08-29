# Third-party notices

Berry is MIT licensed (see `LICENSE`). It is built on open-source work that
carries its own terms, and two kinds of that work need naming here: code that
was copied into this repository, and packages it depends on at run time or
build time.

## Code in this repository

### Circle template — MIT

Berry's web interface began as the Circle template by lndev-ui and still
carries its layout, shell and component conventions. The MIT licence requires
its notice to travel with the code, so it is reproduced in full:

```
MIT License

Copyright (c) 2025 lndev-ui | Circle Template

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies

554 distinct packages are resolved into `node_modules` across the
workspaces. Every one is under a licence that permits redistribution; there is
no copyleft obligation on Berry's own source.

| Licence | Packages |
| --- | --- |
| MIT | 476 |
| ISC | 31 |
| Apache-2.0 | 20 |
| BSD-2-Clause | 10 |
| BSD-3-Clause | 7 |
| MPL-2.0 | 3 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| MIT AND ISC | 1 |
| MIT OR Apache-2.0 | 1 |
| Python-2.0 | 1 |
| Unlicense | 1 |

The full text of each licence travels with the package that carries it, inside
`node_modules`. `pnpm-lock.yaml` pins the exact versions this table was taken
from, so the list can be regenerated for any commit.

### Weak copyleft — MPL-2.0

`axe-core`, `lightningcss`, `lightningcss-darwin-arm64`

MPL-2.0 is file-level copyleft: modifications *to those files* must be
published under MPL-2.0. Berry uses all three as unmodified dependencies, so
the obligation does not reach Berry's own source. `lightningcss` is Next.js's
CSS transformer and `axe-core` is a development-only accessibility checker.

### Attribution-only and public domain

- `caniuse-lite` — CC-BY-4.0. A browser-support dataset; attribution is this
  notice.
- `argparse` — Python-2.0.
- `type-fest` and similar — CC0-1.0 / Unlicense, effectively public domain.

## What Berry does *not* bundle

The Cloudflare Worker under `runtime-worker/` depends on `@cloudflare/sandbox`
and `workerd`, which are only installed when that optional substrate is built.
A self-hosted Berry runs its agents on the local Docker runtime under
`runtime/` and never resolves them.
