import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";

// LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
//
// Mirrors the mocking pattern in user-verifier.test.ts: a bare prototype instance carrying only
// the `env`/`storage` surface addModel() actually touches, not a full Durable Object environment.
function makeUserWithGateway(providers: string) {
  const puts: { profile: AiChatAuthorInfo; config: AiModelConfig }[] = [];
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_PROVIDERS: providers,
    } as Cloudflare.Env,
    storage: {
      aiModels: {
        put: (entry: { profile: AiChatAuthorInfo; config: AiModelConfig }) => puts.push(entry),
      },
    },
  });
  return { user, puts };
}

const PROFILE: AiChatAuthorInfo = { type: "agent", id: "claude-sonnet-4-5", name: "Claude" };

describe("UserDurableObject.addModel", () => {
  it("rejects a gateway-routed model whose provider the gateway doesn't serve", async () => {
    const { user, puts } = makeUserWithGateway("cloudflare");

    await expect(user.addModel(PROFILE, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "ignored-in-gateway-mode",
    })).rejects.toThrow('Provider "anthropic" is not available in AI Gateway mode.');
    expect(puts).toHaveLength(0);
  });

  // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
  // The regression guard's counterpart: gateway provider availability must not block a model
  // that opts out of the gateway entirely.
  it("accepts a direct-routed model even when the gateway doesn't serve its provider", async () => {
    const { user, puts } = makeUserWithGateway("cloudflare");

    await user.addModel(PROFILE, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "direct-api-token",
      apiUrl: "https://access-proxy.example.com/anthropic",
      routing: "direct",
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.config.routing).toBe("direct");
  });
});
