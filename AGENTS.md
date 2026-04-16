# polite-retry

TypeScript library implementing retry strategies with Adaptive Retry Budgeting (ARB).

## Commands

```bash
npm run build    # TypeScript compile → dist/
npm run test     # Jest tests
npm run test:watch
npm run lint     # ESLint
```

**CI order (see `.github/workflows/ci.yml`):** `lint → test → build`

## Project Structure

- `src/` — TypeScript source (index.ts is entry point)
- `dist/` — Build output (CommonJS + declarations)
- `src/*.test.ts` — Test files excluded from build

## Notes

- Tests use Jest with `jest.fn()` mocking
- ESLint allows `_` prefix for unused args/vars: `varsIgnorePattern: "^_"`
- `test:watch` uses `--watch` flag (jest default watch mode)
- Node >=16 required
