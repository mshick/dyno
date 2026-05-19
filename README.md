# @mshick/dyno

A simple DynamoDB client, inspired by [dyno](https://github.com/mapbox/dyno).

## Install

```sh
pnpm add @mshick/dyno
```

## Example

```typescript
import { Dyno } from '@mshick/dyno';

const table = new Dyno({ table: 'my-table', region: 'us-east-1' });

await table.ensureTable({
  AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
  KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
});

await table.batchPutAll([{ id: 'a' }, { id: 'b' }]).sendAll();

const { Items } = await table.scan({ Pages: Infinity });
console.log(Items); // [{id: 'a'}, {id: 'b'}]
```

For supported methods and more examples, see the [`Dyno` tests](./src/__tests__/dyno.test.ts).

## Development

This project uses [pnpm](https://pnpm.io). Tests use a local DynamoDB via
Docker (`docker-compose.yml`), so make sure Docker is running.

```sh
pnpm install
pnpm test          # spins up DynamoDB, runs vitest
pnpm check         # tsc --noEmit
pnpm lint          # biome check
pnpm build         # emits dist/
```

## Release

Releases are driven by [release-please](https://github.com/googleapis/release-please)
on the `main` branch. PR titles and the first commit on a branch must follow
[Conventional Commits](https://www.conventionalcommits.org/) (e.g.
`feat: add new method`, `fix: handle empty batch`). Subsequent commits on a
branch can use plain descriptive messages.

## License

[MIT](./LICENSE)
