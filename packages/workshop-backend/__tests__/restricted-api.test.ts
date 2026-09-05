import { describe, expect, it } from "vitest";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  GadgetMetadataWithTimestamps,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
} from "@gadgets/workshop-shared/api";
import { getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES } from "@gadgets/workshop-shared/api";
import {
  assertRestrictedUsersConfigured,
  isRestrictionActive,
  lookupRestriction,
  makeAuthenticatedApi,
  parseRestrictedUsers,
  RestrictedAuthenticatedApi,
  RestrictedUsersConfigError,
} from "../src/restricted-api.js";

// LOCAL PATCH: restricted-view — remove when fixed upstream
//
// Behavioural gate for the restricted-view patch (ops/upstream-patches.json, patch #6). Covers
// plan rows T1, T2, T4, T5, T6, T8 and T22a of
// agents/PLAN-2026-09-05-mvp-instance-restricted-view.md.
//
// The suite deliberately never mints a real UserDurableObject: this package's vitest pool binds
// only TEST_OVERSEER, and RestrictedAuthenticatedApi's whole contract is "what does it forward to
// `inner`, and what does it refuse before touching it" -- which a recording stand-in answers
// exactly. Same mocking spirit as user-add-model.test.ts / user-verifier.test.ts.

const PINNED = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const FAR_FUTURE = "2099-01-01";
const LONG_PAST = "2000-01-01";

/** Methods that pass straight through to the unrestricted API. */
const DELEGATED = [
  "whoami",
  "getUiFeatureFlags",
  "getAvatar",
  "listGadgets",
  "openGadget",
] as const;

/** Methods answered locally with a safe constant, so the client's mount-time calls resolve. */
const SAFE_CONSTANTS = [
  "hasPasswordLogin",
  "isOnboardingCompleted",
  "listGatekeeperApps",
  "amIAdmin",
  "getAdminApi",
] as const;

/** The one method this patch adds to the interface. */
const RESTRICTION_INFO = ["getRestriction"] as const;

const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Some Model" };

/**
 * Everything else: an explicit #deny() stub, one per interface method.
 *
 * Each entry carries WELL-FORMED arguments on purpose. `@validateRpc()` checks argument shapes
 * before the method body runs, so calling a denied method with no arguments would fail validation
 * and never reach #deny() -- the test would pass for the wrong reason and prove nothing about the
 * denial. With valid arguments, the only thing that can reject is #deny() itself.
 */
const DENIED: [name: string, args: unknown[]][] = [
  ["setOwnDisplayName", ["Some Name"]],
  ["changePassword", [new Uint8Array([1]), new Uint8Array([2])]],
  ["listModels", []],
  ["addModel", [MODEL_PROFILE, { provider: "anthropic", model: "m", apiToken: "t" }]],
  ["deleteModel", ["some-model"]],
  ["setQuickModel", [null]],
  ["getQuickModel", []],
  ["getAiConfig", []],
  ["getPreferredModel", []],
  ["setPreferredModel", [null]],
  ["completeOnboarding", []],
  ["getCloudflareUsage", []],
  ["listCloudflareAccounts", []],
  ["selectCloudflareAccount", ["account-id"]],
  ["setAvatar", [null]],
  ["newGadget", []],
  ["listOutputs", []],
  ["listOutputFormats", []],
  ["listGatekeeperVendors", []],
  ["connectAccount", ["some-vendor"]],
  ["ensureAccountResources", [1, ["https://example.com/*"]]],
  ["listAddableGatekeepers", []],
  ["provisionAmbientAccount", ["some-vendor"]],
  ["subscribeConnectedAccounts", [() => makeSubscriberStub()]],
  ["disconnectAccount", [1]],
  ["startResourceConfigurator", [1, "https://example.com/*"]],
  ["dismissSharedGadget", [OTHER]],
  ["listOwnBlueprints", []],
  ["getOwnBlueprint", ["blueprint-id"]],
  ["listLibraryBlueprints", []],
  ["setBlueprintPinned", ["blueprint-id", true]],
  ["isBlueprintPinned", ["blueprint-id"]],
  ["listFeaturedBlueprints", []],
  ["addBlueprintToLibrary", ["blueprint-id"]],
  ["removeBlueprintFromLibrary", ["blueprint-id"]],
  ["isBlueprintInLibrary", ["blueprint-id"]],
  ["newGadgetFromBlueprint", ["blueprint-id", {}]],
  ["deleteOrphanedBlueprint", ["blueprint-id"]],
  ["importBlueprint", [() => new ReadableStream<Uint8Array>()]],
  ["reconnectAccount", [1]],
  ["getGatekeeperApp", ["some-gatekeeper"]],
];

const DENIED_NAMES = DENIED.map(([name]) => name);

const ALLOWED = [...DELEGATED, ...SAFE_CONSTANTS, ...RESTRICTION_INFO] as readonly string[];

/** Arguments that must be minted fresh per call are written as thunks in the table above. */
function materialize(args: unknown[]): unknown[] {
  return args.map((arg) => (typeof arg === "function" ? (arg as () => unknown)() : arg));
}

class ConnectedAccountsSubscriberStub extends RpcTarget {
  update(): void {}
}

function makeSubscriberStub() {
  return new RpcStub(new ConnectedAccountsSubscriberStub());
}

class ObserverConfigCallbackStub extends RpcTarget implements ObserverConfigCallback {
  configure(_needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    return Promise.resolve([]);
  }
}

type Call = { method: string; args: unknown[] };

/**
 * A stand-in for the unrestricted AuthenticatedApi that records every call. Any method reached
 * through it is, by definition, a method the restricted wrapper did NOT deny -- which is what the
 * "inner was never called" assertions read.
 */
function makeInner(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const target = {} as Record<string, unknown>;
  const inner = new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        const override = overrides[prop];
        return override ? override(...args) : Promise.resolve(`inner:${prop}`);
      };
    },
  }) as unknown as AuthenticatedApi;
  return { inner, calls };
}

function makeRestricted(overrides?: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  const { inner, calls } = makeInner(overrides);
  const api = new RestrictedAuthenticatedApi(inner, { workspace: PINNED, until: FAR_FUTURE });
  return { api: api as unknown as Record<string, (...args: never[]) => Promise<unknown>>, calls };
}

function gadget(id: string, title: string): GadgetMetadataWithTimestamps {
  return {
    id,
    title,
    owner: { type: "user", id: "owner", name: "Owner" },
    role: "use",
    created: new Date(0),
    lastActive: new Date(0),
  } as GadgetMetadataWithTimestamps;
}

describe("RestrictedAuthenticatedApi surface", () => {
  // T1 completeness. This is the assertion that makes the deny table trustworthy: if someone adds
  // a method to AuthenticatedApi, implements a stub for it here, and forgets to classify it in
  // this file, the counts diverge and this test fails. (tsc catches the *missing* stub; only this
  // catches a stub that exists but was never decided about.)
  it("classifies every method the class actually implements", () => {
    const own = Object.getOwnPropertyNames(RestrictedAuthenticatedApi.prototype)
      .filter((name) => name !== "constructor");
    const classified = [...ALLOWED, ...DENIED_NAMES];

    expect(new Set(own)).toEqual(new Set(classified));
    expect(DENIED.length + ALLOWED.length).toBe(own.length);
    // Pins the split, so a silent reclassification (deny -> allow) also fails.
    expect(DENIED.length).toBe(41);
    expect(ALLOWED.length).toBe(11);
  });

  // T1
  it.each(DENIED)("denies %s without touching the unrestricted API", async (method, args) => {
    const { api, calls } = makeRestricted();
    await expect(api[method]!(...(materialize(args) as never[])))
      .rejects.toThrow(/Unauthorized: this account is restricted/);
    expect(calls).toEqual([]);
  });

  // T2 -- delegation
  it("delegates whoami, getUiFeatureFlags and getAvatar to the unrestricted API", async () => {
    const { api, calls } = makeRestricted();

    await expect(api.whoami!()).resolves.toBe("inner:whoami");
    await expect(api.getUiFeatureFlags!()).resolves.toBe("inner:getUiFeatureFlags");
    await expect(api.getAvatar!("someone@example.com" as never)).resolves.toBe("inner:getAvatar");

    expect(calls.map((c) => c.method)).toEqual(["whoami", "getUiFeatureFlags", "getAvatar"]);
    expect(calls[2]!.args).toEqual(["someone@example.com"]);
  });

  // T2 -- safe constants
  it("answers the client's mount-time calls with safe constants", async () => {
    const { api, calls } = makeRestricted();

    await expect(api.hasPasswordLogin!()).resolves.toBe(false);
    await expect(api.isOnboardingCompleted!()).resolves.toBe(true);
    await expect(api.listGatekeeperApps!()).resolves.toEqual([]);
    await expect(api.amIAdmin!()).resolves.toBe(false);
    await expect(api.getAdminApi!()).resolves.toBeNull();

    expect(calls).toEqual([]);
  });

  it("reports its own restriction", async () => {
    const { api } = makeRestricted();
    await expect(api.getRestriction!()).resolves.toEqual({ workspace: PINNED, until: FAR_FUTURE });
  });

  // T4
  it("filters listGadgets down to the pinned workspace", async () => {
    const { api } = makeRestricted({
      listGadgets: () => Promise.resolve([
        gadget(OTHER, "Someone else's"),
        gadget(PINNED, "The pinned one"),
        gadget("aaaa", "A third"),
      ]),
    });

    const listed = await api.listGadgets!() as GadgetMetadataWithTimestamps[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(PINNED);
  });

  it("returns an empty listing when the pinned workspace has not been opened yet", async () => {
    const { api } = makeRestricted({ listGadgets: () => Promise.resolve([]) });
    await expect(api.listGadgets!()).resolves.toEqual([]);
  });

  // T2 -- openGadget on the pinned id, share key and observer callback preserved
  it("opens the pinned workspace, forwarding shareKey and configureObservers", async () => {
    const { api, calls } = makeRestricted();
    const observers = new RpcStub(new ObserverConfigCallbackStub());

    await expect(api.openGadget!(PINNED as never, "sharekey" as never, observers as never))
      .resolves.toBe("inner:openGadget");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("openGadget");
    // shareKey and configureObservers reach the inner API unchanged: the `#share=` link is the
    // documented grant path and has to work on a restricted user's very first login.
    expect(calls[0]!.args[0]).toBe(PINNED);
    expect(calls[0]!.args[1]).toBe("sharekey");
    expect(calls[0]!.args[2]).toBeDefined();
  });

  // T5
  it("refuses another workspace with workspaceAccessDenied and never reaches the inner API",
    async () => {
      const { api, calls } = makeRestricted();

      const error = await api.openGadget!(OTHER as never).catch((err: unknown) => err);
      expect(getOpenGadgetErrorCode(error)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      // No existence oracle, and no forgetSharedGadget() side effect on the user DO: the id is
      // compared before anything is delegated.
      expect(calls).toEqual([]);
    });
});

// T6
describe("parseRestrictedUsers / assertRestrictedUsersConfigured", () => {
  it("treats an absent variable as absent, not as an empty map", () => {
    expect(parseRestrictedUsers(undefined)).toBeNull();
  });

  it("accepts an explicit empty map", () => {
    expect(parseRestrictedUsers("{}")).toEqual({});
  });

  it("accepts a well-formed entry", () => {
    expect(parseRestrictedUsers(`{"a@b.c":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"}}`))
      .toEqual({ "a@b.c": { workspace: PINNED, until: FAR_FUTURE } });
  });

  it.each([
    ["not json", "not json"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a JSON scalar", '"nobody"'],
    ["an entry missing until", `{"a@b.c":{"workspace":"${PINNED}"}}`],
    ["an entry missing workspace", `{"a@b.c":{"until":"${FAR_FUTURE}"}}`],
    ["an entry with a blank workspace", `{"a@b.c":{"workspace":"","until":"${FAR_FUTURE}"}}`],
    ["an entry that is not an object", '{"a@b.c":"pinned"}'],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseRestrictedUsers(raw)).toThrow(RestrictedUsersConfigError);
  });

  // (c) Two keys that collide once lowercased. Keeping either one silently would make the
  // effective restriction depend on JSON property order.
  it("rejects two keys that differ only in case", () => {
    const raw = `{"a@b.c":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"},` +
        `"A@B.C":{"workspace":"${OTHER}","until":"${FAR_FUTURE}"}}`;
    expect(() => parseRestrictedUsers(raw)).toThrow(/differ only in case/);
  });

  it("lowercases keys so the lookup can case-fold both sides", () => {
    expect(parseRestrictedUsers(`{"Viewer@Example.com":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"}}`))
      .toEqual({ "viewer@example.com": { workspace: PINNED, until: FAR_FUTURE } });
  });

  it("throws when Access auth is on and the variable is absent", () => {
    expect(() => assertRestrictedUsersConfigured({ CF_ACCESS_AUD: "aud" }))
      .toThrow(/RESTRICTED_USERS is not set/);
  });

  it("throws when Access auth is on and the variable is unparseable", () => {
    expect(() => assertRestrictedUsersConfigured({ CF_ACCESS_AUD: "aud", RESTRICTED_USERS: "not json" }))
      .toThrow(RestrictedUsersConfigError);
  });

  // The rollback path (empty the map, redeploy) must never brick the deployment.
  it("accepts an explicit empty map under Access auth", () => {
    expect(() => assertRestrictedUsersConfigured({ CF_ACCESS_AUD: "aud", RESTRICTED_USERS: "{}" }))
      .not.toThrow();
  });

  it("stays quiet when Access auth is off and the variable is absent", () => {
    expect(() => assertRestrictedUsersConfigured({})).not.toThrow();
  });
});

// T8 -- a pure function of (entry, now); no fake timers, which do not survive the workerd boundary.
describe("isRestrictionActive", () => {
  const entry = { workspace: PINNED, until: "2026-06-01T00:00:00Z" };

  it("is active before until", () => {
    expect(isRestrictionActive(entry, new Date("2026-05-31T23:59:59Z"))).toBe(true);
  });

  it("is dead at until", () => {
    expect(isRestrictionActive(entry, new Date("2026-06-01T00:00:00Z"))).toBe(false);
  });

  it("is dead after until", () => {
    expect(isRestrictionActive(entry, new Date("2026-06-02T00:00:00Z"))).toBe(false);
  });

  it("is dead when until does not parse", () => {
    expect(isRestrictionActive({ workspace: PINNED, until: "whenever" }, new Date())).toBe(false);
  });
});

describe("lookupRestriction", () => {
  const env = { RESTRICTED_USERS: `{"a@b.c":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"}}` };

  it("finds a listed user", () => {
    expect(lookupRestriction(env, "a@b.c")).toEqual({ workspace: PINNED, until: FAR_FUTURE });
  });

  it("returns null for an unlisted user", () => {
    expect(lookupRestriction(env, "someone@else.com")).toBeNull();
  });

  it("returns null for a nameless user id", () => {
    expect(lookupRestriction(env, undefined)).toBeNull();
  });

  it("returns null when nobody is restricted", () => {
    expect(lookupRestriction({ RESTRICTED_USERS: "{}" }, "a@b.c")).toBeNull();
  });

  // (a) The case that motivated this: nothing between the identity provider and here normalizes
  // the Access email claim (access.ts verifies the JWT without touching case; server.ts passes it
  // straight to users.idFromName()), so a provider echoing "Reviewer@Example.com" would defeat a
  // verbatim comparison -- and a MISS hands the user the FULL API, not less access.
  it("matches a mixed-case Access claim against a lowercase config key", () => {
    expect(lookupRestriction(env, "A@B.C")).toEqual({ workspace: PINNED, until: FAR_FUTURE });
    expect(lookupRestriction(env, "A@b.C")).toEqual({ workspace: PINNED, until: FAR_FUTURE });
  });

  // (b) The other side of the fold. G1 in the wrapper's deploy.ts rejects a capitalised config
  // key, but this must still hold for anyone who bypasses that guard.
  it("matches a lowercase claim against a capitalised config key", () => {
    const shouty = {
      RESTRICTED_USERS: `{"A@B.C":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"}}`,
    };
    expect(lookupRestriction(shouty, "a@b.c")).toEqual({ workspace: PINNED, until: FAR_FUTURE });
  });
});

// T22a -- the factory both authentication paths in server.ts go through. CF_ACCESS_AUD is
// deliberately UNSET here: the map LOOKUP is unconditional, and only the fail-closed throw is
// gated on Access mode. This is what stops server.ts's session-token path from ever handing a
// restricted user the full API.
describe("makeAuthenticatedApi", () => {
  const env = { RESTRICTED_USERS: `{"a@b.c":{"workspace":"${PINNED}","until":"${FAR_FUTURE}"}}` };
  const full = { marker: "full" } as unknown as AuthenticatedApi;

  it("wraps a restricted user even with CF_ACCESS_AUD unset", () => {
    const api = makeAuthenticatedApi(env, { name: "a@b.c" }, () => full);
    expect(api).toBeInstanceOf(RestrictedAuthenticatedApi);
  });

  it("wraps a restricted user whose Access claim arrives in mixed case", () => {
    const api = makeAuthenticatedApi(env, { name: "A@B.C" }, () => full);
    expect(api).toBeInstanceOf(RestrictedAuthenticatedApi);
  });

  it("returns the unrestricted API for an unlisted user", () => {
    expect(makeAuthenticatedApi(env, { name: "someone@else.com" }, () => full)).toBe(full);
  });

  it("returns the unrestricted API when nobody is restricted", () => {
    expect(makeAuthenticatedApi({ RESTRICTED_USERS: "{}" }, { name: "a@b.c" }, () => full))
      .toBe(full);
  });

  it("refuses outright once the grant has expired, rather than falling through", () => {
    const expired = { RESTRICTED_USERS: `{"a@b.c":{"workspace":"${PINNED}","until":"${LONG_PAST}"}}` };
    expect(() => makeAuthenticatedApi(expired, { name: "a@b.c" }, () => full))
      .toThrow(/expired/);
  });

  it("propagates a malformed map instead of silently unrestricting", () => {
    expect(() => makeAuthenticatedApi({ RESTRICTED_USERS: "[]" }, { name: "a@b.c" }, () => full))
      .toThrow(RestrictedUsersConfigError);
  });
});
