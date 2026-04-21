## Decisions

- Adapter type strategy: Option C (per-channel types, duck-typed send). No IMSurfaceAdapter refactor.
- ACK randomization: WITHIN contextual subsets, not replacing selectAckTemplate()
- Feishu if CLI unsupported: stub adapter that returns error, still registered
- Test framework: pnpm test (vitest run), NOT bun test
- Deploy: pnpm build && node tools/install/dist/index.js deploy
