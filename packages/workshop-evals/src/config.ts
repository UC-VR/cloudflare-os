import { execFileSync } from "node:child_process";

/** Models and repetitions expanded with native Vitest case tables. */
export type EvalMatrix = {
  models: string[];
  trials: number;
};

/** Git revisions needed to reproduce the runner and deployed target. */
export type EvalCommits = {
  harnessCommit: string;
  targetCommit: string;
};

const DEFAULT_MODELS = ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"];

/** Budget shared by all agent turns and verification inside one trial. */
export const EVAL_RUN_BUDGET_MS = 30 * 60_000;
/** Outer Vitest deadline; cleanup gets two minutes after the run budget expires. */
export const EVAL_TEST_TIMEOUT_MS = EVAL_RUN_BUDGET_MS + 2 * 60_000;

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
    readLocalCommit: () => string = localGitCommit): EvalCommits {
  const harnessCommit = requireGitCommit(
      environment.WORKSHOP_EVAL_COMMIT?.trim() || environment.GITHUB_SHA?.trim() || readLocalCommit(),
      "WORKSHOP_EVAL_COMMIT");
  const targetCommit = requireGitCommit(
      environment.WORKSHOP_EVAL_TARGET_COMMIT?.trim() || harnessCommit,
      "WORKSHOP_EVAL_TARGET_COMMIT");
  return { harnessCommit, targetCommit };
}

/** Parse non-secret eval controls. Model credentials belong to the selected target. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env): EvalMatrix {
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
