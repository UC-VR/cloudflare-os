# integration-tests

End-to-end tests that drive the Workshop and gatekeepers through the public Cap'n Web API. The package
also exports the small runtime bridge used by live agent evals.

```sh
pnpm --filter @gadgets/integration-tests test:run
```

`workshop-backend/__integration__` runs inside workerd and can use `cloudflare:test` internals. This
package runs from Node and reaches only the same public API as a real client.

## Exported toolkit

- `harness` boots the backend and selected gatekeepers as real Workers with
  `wrangler`'s `createTestHarness()`.
- `rpc-client` opens Cap'n Web sessions, authenticates test users, and supplies observer callbacks.
- `agent-session` drives one production agent chat, waits for it to settle, reads complete history,
  discovers workpieces, connects to Gadget RPCs, and exposes provider usage metadata.
- `network-interceptor` supplies explicit HTTP handlers to gatekeeper suites and rejects unexpected
  external requests.

The toolkit owns transport and lifecycle only. A consuming test or eval owns prompts, scores, and
behavioral assertions.

## Local agent session

Keep Gadget execution enabled and configure the Workshop with existing model credentials:

```ts
const harness = await startHarness({
  enableGadgetExecution: true,
  gatekeepers: [],
  patchWorkshop(config) {
    config.vars = {
      ...config.vars,
      CF_AI_GATEWAY: process.env.CF_AI_GATEWAY,
      CF_AI_GATEWAY_ACCOUNT_ID: process.env.CF_AI_GATEWAY_ACCOUNT_ID,
      CF_AI_GATEWAY_API_TOKEN: process.env.CF_AI_GATEWAY_API_TOKEN,
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    };
  },
});

using session = await AgentSession.create(harness.url, {
  modelId: "@cf/zai-org/glm-5.2",
});
const result = await session.run("Build a small status page.");
```

A caller can also add one directly configured user model through `userModel`. This lets local runs use
existing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` credentials without changing the backend.

## Preview agent session

A deployed preview uses Cloudflare Access instead of password signup. Supply an Access application
JWT. The client sends it on the WebSocket handshake and then calls `authenticateFromCfAccess()`.
For a new Access account, `AgentSession` selects the requested model and completes onboarding before
opening the workspace.

```ts
using session = await AgentSession.create(new URL(previewUrl), {
  accessToken,
  modelId: "@cf/zai-org/glm-5.2",
});
```

The preview supplies its own model catalog and Workers AI binding. The same prompts and Gadget RPC
verifiers can therefore run against local workerd or a deployed preview.

## Test isolation

The local harness keeps storage for its full lifetime. Tests must create fresh identities and unique
resource URLs rather than assume a reset. Dispose every returned RPC stub and close the harness.

[`docs/integration-testing.md`](../../docs/integration-testing.md) describes the in-process and
out-of-process boundaries in more detail.
