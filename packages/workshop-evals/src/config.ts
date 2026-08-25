import { execFileSync } from "node:child_process";

const DEFAULT_MODELS = ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"];

/** Time reserved for non-agent work inside a run and for cleanup outside it. */
export const EVAL_OVERHEAD_BUDGET_MS = 2 * 60_000;
/** Budget shared by all agent turns and verification inside one trial. */
export const EVAL_RUN_BUDGET_MS = 30 * 60_000;
/** Outer Vitest deadline includes the cleanup reserve. */
export const EVAL_TEST_TIMEOUT_MS = EVAL_RUN_BUDGET_MS + EVAL_OVERHEAD_BUDGET_MS;

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function localGitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function requireGitCommit(value: string, name: string): string {
  if (!GIT_SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a full 40-character Git SHA`);
  }
  return value;
}

/** Resolve self-contained runner and target revisions before shard artifacts leave the checkout. */
export function resolveEvalCommits(
    environment: NodeJS.ProcessEnv = process.env,
    readLocalCommit: () => string = localGitCommit) {
  const harnessCommit = requireGitCommit(
      environment.WORKSHOP_EVAL_COMMIT?.trim() || environment.GITHUB_SHA?.trim() || readLocalCommit(),
      "WORKSHOP_EVAL_COMMIT");
  const targetCommit = requireGitCommit(
      environment.WORKSHOP_EVAL_TARGET_COMMIT?.trim() || harnessCommit,
      "WORKSHOP_EVAL_TARGET_COMMIT");
  return { harnessCommit, targetCommit };
}

/** Code and task identities attached to every eval result. */
export type EvalIdentity = ReturnType<typeof resolveEvalCommits> & { taskVersion: string };

/** Parse non-secret eval controls. Model credentials belong to the selected target. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env) {
  const models = (environment.WORKSHOP_EVAL_MODELS ?? "")
    .split(",")
    .map(model => model.trim())
    .filter(Boolean);
  const rawTrials = environment.WORKSHOP_EVAL_TRIALS?.trim();
  const trials = rawTrials === undefined || rawTrials === "" ? 1 : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  return { models: models.length > 0 ? models : [...DEFAULT_MODELS], trials };
}
