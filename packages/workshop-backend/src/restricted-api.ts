// LOCAL PATCH: restricted-view — remove when fixed upstream
//
// Pins a named set of users to exactly one workspace.
//
// Motivation: a deployment wants to show a single stakeholder one gadget and nothing else. The
// "use"-role collaborator tier (UseOverseerInterface in overseer.ts) already restricts what a
// collaborator may do INSIDE a workspace, but it says nothing about the Workshop around it — a
// "use" collaborator still gets the full AuthenticatedApi: their own model catalog and AI Gateway
// spend, blueprints, connected accounts, the ability to create workspaces, and so on. This patch
// adds the missing outer tier: a restricted user's whole account surface is one pinned workspace.
//
// Two rules make this safe, and both are deliberate:
//
// 1. DEFAULT-DENY, ENFORCED AT COMPILE TIME. `RestrictedAuthenticatedApi implements
//    AuthenticatedApi`, and every denied method is written out as an EXPLICIT stub. No Proxy, no
//    generated loop, no index signature — because any of those would satisfy the interface
//    automatically and silently pass a newly-added upstream method straight through. As written,
//    adding a method to `AuthenticatedApi` fails to compile here until a developer consciously
//    decides whether restricted callers may invoke it. This mirrors the rationale on
//    UseOverseerInterface (overseer.ts).
//
// 2. FAIL-CLOSED CONFIGURATION. `RESTRICTED_USERS` absent or unparseable is a misconfiguration,
//    not "nobody is restricted" — the inverse of how ADMINS fails. `assertRestrictedUsersConfigured`
//    is called from the /api request path and throws in that case. The deploy script therefore
//    ALWAYS emits the var, as "{}" when nobody is restricted, so that ABSENT and EMPTY stay
//    distinguishable; emptying the map is the supported rollback and must not brick the Worker.
//
// Known, accepted wrinkles:
//
// - `until` is evaluated when a session is minted, not continuously. An already-open session
//   outlives its own expiry until the client reconnects or the workspace DO aborts. Revocation
//   that must take effect immediately still goes through the Overseer's own revocation path
//   (scheduleRevocationRestart in overseer.ts), exactly as it does for share links.
// - The map is keyed on DurableObjectId.name, i.e. the Cloudflare Access `email` claim verbatim —
//   the same key ADMINS matches. Casing is not normalized here, deliberately, so that the two
//   lists behave identically; the deploy-side guard requires lowercase keys instead.
// - `getAvatar()` is delegated because it already accepts any user id by design and the "use" tier
//   (UseOverseerInterface.subscribeToPresence) already reveals co-viewers' names and profile ids.
//   It is not a new disclosure.

import { RpcTarget, RpcStub } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AdminApi,
  AiChatAuthorInfo,
  AiGatewayInfo,
  AiModelConfig,
  AuthenticatedApi,
  BlueprintBindingAssignment,
  BlueprintLibrarySummary,
  BlueprintPublicInfo,
  BlueprintUserSummary,
  CloudflareAccountOption,
  CloudflareUsageInfo,
  ConnectedAccountsFilter,
  ConnectedAccountsSubscriber,
  GadgetMetadataWithTimestamps,
  GatekeeperAppInfo,
  GatekeeperVendorFilter,
  GatekeeperVendorInfo,
  ListOutputsResult,
  ObserverConfigCallback,
  OutputFormatOffer,
  Overseer,
  RestrictionInfo,
} from "@gadgets/workshop-shared/api";
import { createOpenGadgetError, OPEN_GADGET_ERROR_CODES } from "@gadgets/workshop-shared/api";
import type { GatekeeperUiFrame, ResourceConfiguratorFrame } from "@gadgets/workshop-shared/gatekeeper";
import type { UiFeatureFlags } from "@gadgets/workshop-shared/feature-flags";

/** One entry of the `RESTRICTED_USERS` map. Same shape as the client-facing `RestrictionInfo`. */
export type RestrictedEntry = RestrictionInfo;

/** The env surface this module reads. Kept structural so tests can pass a plain object. */
export type RestrictedUsersEnv = { RESTRICTED_USERS?: string; CF_ACCESS_AUD?: string };

/** Thrown when `RESTRICTED_USERS` is absent or malformed while Access auth is in force. */
export class RestrictedUsersConfigError extends Error {}

function isEntry(value: unknown): value is RestrictedEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.workspace === "string" && entry.workspace.length > 0 &&
      typeof entry.until === "string" && entry.until.length > 0;
}

/**
 * Parses the raw `RESTRICTED_USERS` var. Returns null for ABSENT, and throws for anything present
 * but not a well-formed map — the two failure modes must stay distinguishable, because only one of
 * them ("{}", a valid empty map) is a legitimate deployment state.
 */
export function parseRestrictedUsers(raw: string | undefined): Record<string, RestrictedEntry> | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RestrictedUsersConfigError(
        `RESTRICTED_USERS is set but is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RestrictedUsersConfigError(
        "RESTRICTED_USERS must be a JSON object mapping user name to {workspace, until}.");
  }
  const result: Record<string, RestrictedEntry> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isEntry(value)) {
      throw new RestrictedUsersConfigError(
          `RESTRICTED_USERS entry for ${JSON.stringify(name)} must be ` +
          `{workspace: string, until: string} with both non-empty.`);
    }
    result[name] = { workspace: value.workspace, until: value.until };
  }
  return result;
}

/**
 * Fail-closed configuration check, called from the /api request path (see server.ts).
 *
 * Throws when Cloudflare Access authentication is in force but `RESTRICTED_USERS` is absent or
 * malformed. A deployment that means "nobody is restricted" must say so explicitly with "{}" —
 * dropping the var entirely would otherwise quietly promote every restricted user to the full API.
 */
export function assertRestrictedUsersConfigured(env: RestrictedUsersEnv): void {
  const map = parseRestrictedUsers(env.RESTRICTED_USERS);
  if (map === null && env.CF_ACCESS_AUD) {
    throw new RestrictedUsersConfigError(
        "RESTRICTED_USERS is not set. On a Cloudflare Access deployment this variable is " +
        "mandatory: it must be an explicit JSON map (\"{}\" when nobody is restricted), so that " +
        "an accidentally dropped binding cannot silently grant every restricted user the full API.");
  }
}

/** Whether a grant is still live at `now`. Unparseable or expired `until` means dead. */
export function isRestrictionActive(entry: RestrictedEntry, now: Date): boolean {
  const until = Date.parse(entry.until);
  if (Number.isNaN(until)) return false;
  return now.getTime() < until;
}

/**
 * The restriction in force for `userName`, or null when the user is unrestricted.
 *
 * The lookup is unconditional — it does NOT depend on CF_ACCESS_AUD. Only the fail-closed THROW
 * above is conditioned on Access mode. Restriction must apply on every authentication path,
 * including the session-token path, which is otherwise reachable by any future config change that
 * revives password or gatekeeper sign-in.
 */
export function lookupRestriction(
    env: RestrictedUsersEnv, userName: string | null | undefined): RestrictedEntry | null {
  if (!userName) return null;
  const map = parseRestrictedUsers(env.RESTRICTED_USERS);
  if (!map) return null;
  const entry = map[userName];
  return entry ?? null;
}

/**
 * The single factory both authentication paths in server.ts go through.
 *
 * `makeFullApi` is a callback rather than a constructor argument so that this module never imports
 * AuthenticatedApiImpl (which lives in server.ts and imports half the backend) — no import cycle,
 * and the file stays trivially rebasable onto a new upstream.
 */
export function makeAuthenticatedApi(
    env: RestrictedUsersEnv,
    userId: { readonly name?: string },
    makeFullApi: () => AuthenticatedApi): AuthenticatedApi {
  // Keyed on userId.name verbatim, exactly as AuthenticatedApiImpl.#isAdmin() keys ADMINS -- both
  // paths in server.ts derive that name from the same Access email, and neither normalizes it.
  const entry = lookupRestriction(env, userId.name);
  if (!entry) return makeFullApi();
  if (!isRestrictionActive(entry, new Date())) {
    // Fail closed, never fall through to the full API: an expired grant is a lapsed one, and the
    // deploy guard treats a past `until` as a config error, so this state is transient by design.
    throw new Error("This account's access to this deployment has expired.");
  }
  return new RestrictedAuthenticatedApi(makeFullApi(), entry);
}

/**
 * The capability handed to a restricted user. Everything except the pinned workspace is denied.
 *
 * Default-deny is enforced at compile time: because this class `implements AuthenticatedApi` and
 * every denied method is an explicit stub, adding any new method to the interface will fail to
 * compile here until a developer consciously decides whether restricted callers may invoke it.
 * Do not replace the stubs with a Proxy or a generated loop — either would satisfy the interface
 * automatically and silently pass new methods through.
 */
@validateRpc()
export class RestrictedAuthenticatedApi extends RpcTarget implements AuthenticatedApi {
  // `inner` is a plain private instance property, which capnweb never exposes over RPC (reading a
  // non-method property of an RpcTarget throws) -- same idiom as AuthenticatedApiImpl's own
  // private fields.
  constructor(private inner: AuthenticatedApi, private restriction: RestrictedEntry) {
    super();
  }

  #deny(): never {
    throw new Error(
        "Unauthorized: this account is restricted to a single workspace on this deployment.");
  }

  // --- Allowed: delegated to the full API ---

  whoami(): Promise<AiChatAuthorInfo> {
    return this.inner.whoami();
  }
  getUiFeatureFlags(): Promise<UiFeatureFlags> {
    return this.inner.getUiFeatureFlags();
  }
  getAvatar(userId: string): Promise<Uint8Array | null> {
    return this.inner.getAvatar(userId);
  }

  /**
   * Only the pinned workspace, and only ever the pinned workspace. The listing is filtered rather
   * than replaced so an entry the user has not yet opened simply does not appear -- the pinned id
   * is not recorded in their own listing until the first successful open.
   */
  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    const all = await this.inner.listGadgets();
    return all.filter((gadget) => gadget.id === this.restriction.workspace);
  }

  /**
   * The pinned workspace only. The id is compared BEFORE the inner API is touched, so a restricted
   * caller cannot use this as an existence oracle for other workspaces, and cannot trigger the
   * inner path's forgetSharedGadget() side effect. `shareKey` and `configureObservers` are passed
   * through unchanged: the share link is the documented grant path, and it must work on first login.
   */
  async openGadget(id: string, shareKey?: string,
                   configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<RpcStub<Overseer>> {
    if (id !== this.restriction.workspace) {
      throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    }
    return this.inner.openGadget(id, shareKey, configureObservers);
  }

  /** The client needs this to route: see the interface doc comment in workshop-shared/src/api.ts. */
  async getRestriction(): Promise<RestrictionInfo | null> {
    return { workspace: this.restriction.workspace, until: this.restriction.until };
  }

  // --- Allowed, but answered locally with a constant ---
  //
  // These five are called unconditionally by the frontend at mount. Denying them would surface as
  // spurious client-side errors on a page the restricted user is allowed to see, so each returns
  // the safest possible constant instead: no password login, onboarding already done, no
  // gatekeeper apps, not an admin, no admin capability. Same reasoning as UseOverseerInterface's
  // inert subscriptions.

  async hasPasswordLogin(): Promise<boolean> { return false; }
  async isOnboardingCompleted(): Promise<boolean> { return true; }
  async listGatekeeperApps(): Promise<GatekeeperAppInfo[]> { return []; }
  async amIAdmin(): Promise<boolean> { return false; }
  async getAdminApi(): Promise<RpcStub<AdminApi> | null> { return null; }

  // --- Denied (explicit stubs; see the class comment before adding a shortcut) ---

  async setOwnDisplayName(_name: string): Promise<void> { this.#deny(); }
  async changePassword(_oldHash: Uint8Array, _newHash: Uint8Array): Promise<void> { this.#deny(); }
  async listModels(): Promise<AiChatAuthorInfo[]> { this.#deny(); }
  async addModel(_profile: AiChatAuthorInfo, _config: AiModelConfig): Promise<void> { this.#deny(); }
  async deleteModel(_id: string): Promise<void> { this.#deny(); }
  async setQuickModel(_id: string | null): Promise<void> { this.#deny(); }
  async getQuickModel(): Promise<null | string> { this.#deny(); }
  async getAiConfig(): Promise<AiGatewayInfo> { this.#deny(); }
  async getPreferredModel(): Promise<string | null> { this.#deny(); }
  async setPreferredModel(_id: string | null): Promise<void> { this.#deny(); }
  async completeOnboarding(): Promise<void> { this.#deny(); }
  async getCloudflareUsage(): Promise<CloudflareUsageInfo> { this.#deny(); }
  async listCloudflareAccounts(): Promise<CloudflareAccountOption[]> { this.#deny(); }
  async selectCloudflareAccount(_accountId: string): Promise<void> { this.#deny(); }
  async setAvatar(_data: Uint8Array | null): Promise<void> { this.#deny(); }
  async newGadget(): Promise<RpcStub<Overseer>> { this.#deny(); }
  async listOutputs(): Promise<ListOutputsResult> { this.#deny(); }
  async listOutputFormats(): Promise<OutputFormatOffer[]> { this.#deny(); }
  async listGatekeeperVendors(_filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]> {
    this.#deny();
  }
  async connectAccount(_vendorId: string, _resourceUrlPatterns?: string[]): Promise<{url: string}> {
    this.#deny();
  }
  async ensureAccountResources(_accountId: number, _resourceUrlPatterns: string[])
      : Promise<{url?: string}> {
    this.#deny();
  }
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> { this.#deny(); }
  async provisionAmbientAccount(_vendorId: string): Promise<void> { this.#deny(); }
  async subscribeConnectedAccounts(
      _subscriber: RpcStub<ConnectedAccountsSubscriber>, _filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    this.#deny();
  }
  async disconnectAccount(_accountId: number): Promise<void> { this.#deny(); }
  async startResourceConfigurator(_accountId: number, _resourceUrlPattern: string)
      : Promise<ResourceConfiguratorFrame> {
    this.#deny();
  }
  async dismissSharedGadget(_gadgetId: string): Promise<void> { this.#deny(); }
  async listOwnBlueprints(): Promise<BlueprintUserSummary[]> { this.#deny(); }
  async getOwnBlueprint(_blueprintId: string): Promise<BlueprintUserSummary | null> { this.#deny(); }
  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> { this.#deny(); }
  async setBlueprintPinned(_blueprintId: string, _pinned: boolean): Promise<void> { this.#deny(); }
  async isBlueprintPinned(_blueprintId: string): Promise<boolean> { this.#deny(); }
  async listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]> { this.#deny(); }
  async addBlueprintToLibrary(_blueprintId: string): Promise<void> { this.#deny(); }
  async removeBlueprintFromLibrary(_blueprintId: string): Promise<void> { this.#deny(); }
  async isBlueprintInLibrary(_blueprintId: string): Promise<{ uploaded: boolean } | null> {
    this.#deny();
  }
  async newGadgetFromBlueprint(
      _blueprintId: string, _bindings: Record<string, BlueprintBindingAssignment>)
      : Promise<RpcStub<Overseer>> {
    this.#deny();
  }
  async deleteOrphanedBlueprint(_blueprintId: string): Promise<void> { this.#deny(); }
  async importBlueprint(_archive: ReadableStream<Uint8Array>): Promise<string> { this.#deny(); }
  async reconnectAccount(_accountId: number): Promise<{url: string}> { this.#deny(); }
  async getGatekeeperApp(_id: string): Promise<GatekeeperUiFrame | null> { this.#deny(); }
}
