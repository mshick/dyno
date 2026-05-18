# @mshick/dyno

A standalone TypeScript DynamoDB client (originally extracted from the
takeshape monorepo).

## Stack

- **Runtime**: Node.js (`>=24`), ESM-only (`"type": "module"`)
- **Language**: TypeScript with `strict`, `noImplicitOverride`, `isolatedModules`
- **Imports**: Use `.ts` extensions in relative imports
  (`rewriteRelativeImportExtensions: true`). `tsc` rewrites them to `.js` on
  build.
- **Package manager**: `pnpm` only
- **Lint/format**: Biome (no ESLint, no Prettier)
- **Tests**: Vitest, with a local DynamoDB spun up via `docker-compose` in
  `vitest.global-setup.ts`
- **Build**: `tsc --project tsconfig.build.json` emits `dist/`

## Layout

```
src/
  client.ts            # AWS SDK client + HTTP handler config
  dyno.ts              # Main Dyno class
  table.ts             # ensureTable / waitForConnection / killConnection
  stream.ts            # Streaming helpers
  paginated.ts         # Paginated read helper
  responses.ts         # parseResponse / response shape utils
  util.ts              # Misc helpers
  error.ts             # TableNameError + friends
  constants.ts         # AWS region default
  types.ts             # Shared types
  index.ts             # Public entrypoint
  requests/            # Request grouping types and send-all / send-completely
  streams/             # DynoReadableStream / DynoWritableStream / ParallelWritable
  __tests__/           # Vitest specs (need Docker for DynamoDB-local)
```

## Common scripts

| Script             | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `pnpm test`        | `vitest run` (spins up DynamoDB-local via docker-compose)  |
| `pnpm test:watch`  | `vitest`                                                   |
| `pnpm check`       | `tsc --noEmit`                                             |
| `pnpm lint`        | `biome check .`                                            |
| `pnpm lint:fix`    | `biome check --write .`                                    |
| `pnpm format`      | `biome format --write .`                                   |
| `pnpm build`       | `prebuild` cleans, then `tsc --project tsconfig.build.json` |
| `pnpm clean`       | Remove `dist` and `*.tsbuildinfo`                          |

To skip Docker (most integration tests will fail): `VITEST_NO_DOCKER=1 pnpm test`.

## Conventions

- **Strict TS** — fix the type, don't `// @ts-ignore`.
- **`.ts` import suffixes** — keep them; `tsc` rewrites on build.
- **No ESLint/Prettier** — Biome is the only linter/formatter.
- **`noFloatingPromises` stays green** — every promise is awaited, returned,
  or explicitly handled.
- **`noImportCycles` stays green** — break cycles, don't suppress.
- **Conventional Commits** — PR titles (and the first commit on a branch)
  must use Conventional Commits syntax (`feat:`, `fix:`, etc.) so
  release-please can pick them up. Subsequent commits on a branch can use
  plain descriptive messages.

## Release Process

Uses release-please on `main`. Conventional-commit PRs accumulate into a
release PR; merging the release PR cuts a tag and triggers `publish` to npm.
