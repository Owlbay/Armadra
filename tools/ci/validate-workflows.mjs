/**
 * Structural checks over .github/workflows.
 *
 *   node tools/ci/validate-workflows.mjs
 *
 * A workflow is only exercised when it runs, and the release workflow runs
 * when a tag is pushed — which is the worst possible moment to discover that a
 * job depends on one that does not exist, or that a step names an output no
 * job produces. These are the mistakes a YAML file makes silently, so they are
 * checked here where a pull request sees them.
 *
 * This is not a schema validator and does not try to be GitHub. It asserts the
 * relationships between jobs, which is what actually breaks.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./workflow-yaml.mjs";
import { TARGETS } from "../release/artifacts.mjs";
import { loadManifest } from "./e2e.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_DIR = join(root, ".github/workflows");

/**
 * The runner labels GitHub actually offers.
 *
 * A label nobody serves is not an error: the job queues forever and the run
 * shows as pending, which is the one failure mode a person waits out instead of
 * reading. Kept explicit rather than pattern-matched so a retired image has to
 * be removed here deliberately.
 */
export const RUNNERS = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
  "macos-latest",
  "macos-15",
  "macos-14",
  "macos-15-intel",
  "windows-latest",
  "windows-2025",
  "windows-2022",
  "windows-11-arm",
]);

/** The runner label prefix of each `process.platform` a tier B entry may name. */
const RUNNER_PREFIX = { linux: "ubuntu-", darwin: "macos-", win32: "windows-" };

/** Every value a matrix gives one key, across both `include` and list form. */
function matrixValues(job, key) {
  const matrix = job?.strategy?.matrix;
  if (!matrix || typeof matrix !== "object") return [];
  const values = [];
  const direct = matrix[key];
  if (Array.isArray(direct)) values.push(...direct);
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (entry && typeof entry === "object" && entry[key] !== undefined)
        values.push(entry[key]);
    }
  }
  return values.map(String);
}

/** The labels a job can end up running on, matrix expressions resolved. */
function runnerLabels(job) {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return [];
  const expression = runsOn.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/);
  if (expression) return matrixValues(job, expression[1]);
  return /\$\{\{/.test(runsOn) ? [] : [runsOn];
}

/** Every ${{ needs.<job>. }} reference in a value, however deeply nested. */
function neededJobs(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/needs\.([A-Za-z0-9_-]+)/g))
      found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) neededJobs(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) neededJobs(item, found);
  }
  return found;
}

/** Check one parsed workflow, returning problems as plain sentences. */
export function checkWorkflow(name, document) {
  const problems = [];
  const say = (message) => problems.push(`${name}: ${message}`);
  if (!document || typeof document !== "object") {
    say("is not a mapping");
    return problems;
  }
  if (typeof document.name !== "string" || document.name === "")
    say("has no name");
  // YAML 1.1 readers turn a bare `on:` into `true`; the parser here keeps it a
  // key, and either way a workflow with no trigger never runs.
  const triggers = document.on ?? document[true];
  if (!triggers) say("has no trigger");
  const jobs = document.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    say("has no jobs");
    return problems;
  }
  const names = new Set(Object.keys(jobs));
  if (names.size === 0) say("has no jobs");

  for (const [jobName, job] of Object.entries(jobs)) {
    const where = `${name}: job ${jobName}`;
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      problems.push(`${where} is not a mapping`);
      continue;
    }
    if (!job["runs-on"] && !job.uses)
      problems.push(`${where} names no runner and reuses no workflow`);
    for (const label of runnerLabels(job)) {
      if (!RUNNERS.has(label))
        problems.push(`${where} runs on ${label}, which GitHub does not offer`);
    }
    // A build matrix names the same "<os>-<arch>" a release publishes. A
    // spelling only one side knows is discovered at tag time, in the job that
    // was supposed to produce the artifact.
    for (const target of matrixValues(job, "target")) {
      if (!TARGETS.includes(target))
        problems.push(
          `${where} builds ${target}, which is not a target in tools/release/artifacts.mjs`,
        );
    }
    const declared = new Set(
      job.needs === undefined
        ? []
        : Array.isArray(job.needs)
          ? job.needs
          : [job.needs],
    );
    for (const dependency of declared) {
      if (!names.has(dependency))
        problems.push(
          `${where} needs ${dependency}, which is not a job in this workflow`,
        );
      if (dependency === jobName) problems.push(`${where} needs itself`);
    }
    // A job that reads needs.<other> without declaring it does not wait for it,
    // so the value is empty at exactly the moment it matters.
    for (const referenced of neededJobs({ ...job, needs: undefined })) {
      if (!declared.has(referenced))
        problems.push(
          `${where} reads needs.${referenced} without declaring it in needs`,
        );
    }
    const steps = job.steps;
    if (steps === undefined) {
      if (!job.uses) problems.push(`${where} has no steps`);
      continue;
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      problems.push(`${where} has no steps`);
      continue;
    }
    const stepIds = new Set();
    for (const [index, step] of steps.entries()) {
      const stepWhere = `${where} step ${index + 1}`;
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        problems.push(`${stepWhere} is not a mapping`);
        continue;
      }
      if (!step.run && !step.uses)
        problems.push(`${stepWhere} neither runs nor uses anything`);
      if (step.run && step.uses)
        problems.push(`${stepWhere} both runs and uses something`);
      if (step.uses && !/@/.test(String(step.uses)))
        problems.push(
          `${stepWhere} uses ${step.uses} without pinning a version`,
        );
      // On Windows the default shell is pwsh, and GitHub's wrapper only checks
      // the exit code of the *last* command in a multi-line `run`. A step that
      // installs and then verifies would report success when the install
      // failed, so a Windows-capable job has to name its shell.
      if (
        typeof step.run === "string" &&
        step.run.trimEnd().includes("\n") &&
        !step.shell &&
        !job.defaults?.run?.shell &&
        runnerLabels(job).some((label) => label.startsWith("windows-"))
      ) {
        problems.push(
          `${stepWhere} runs several commands on Windows without naming a shell, so only the last exit code counts`,
        );
      }
      if (step.id) {
        if (stepIds.has(step.id))
          problems.push(`${stepWhere} repeats the id ${step.id}`);
        stepIds.add(step.id);
      }
    }
    // A step output can only come from a step that has an id, and a typo here
    // reads as an empty string rather than as an error.
    for (const match of JSON.stringify(job).matchAll(
      /steps\.([A-Za-z0-9_-]+)\.outputs/g,
    )) {
      if (!stepIds.has(match[1]))
        problems.push(
          `${where} reads steps.${match[1]}.outputs, but no step has that id`,
        );
    }
  }

  // Detect a cycle: needs must be a directed acyclic graph, and GitHub reports
  // one as a workflow that simply never starts.
  const state = new Map();
  const visit = (jobName, trail) => {
    if (state.get(jobName) === "done") return;
    if (state.get(jobName) === "open") {
      say(`jobs form a cycle: ${[...trail, jobName].join(" -> ")}`);
      return;
    }
    state.set(jobName, "open");
    const job = jobs[jobName];
    const needs =
      job?.needs === undefined
        ? []
        : Array.isArray(job.needs)
          ? job.needs
          : [job.needs];
    for (const dependency of needs) {
      if (names.has(dependency)) visit(dependency, [...trail, jobName]);
    }
    state.set(jobName, "done");
  };
  for (const jobName of names) visit(jobName, []);
  return problems;
}

/** Every `run` line of a job, joined; empty for a job that is not a mapping. */
function jobRuns(job) {
  if (!job || !Array.isArray(job.steps)) return "";
  return job.steps
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
}

/**
 * The end-to-end tiers (docs/guides/ci-release.md §1.1): tier A runs on every
 * push as ci.yml's `e2e` job, tier B nightly. A tier that silently stops being
 * scheduled looks exactly like a tier that passes, so its wiring is asserted.
 *
 * For tier B that means: every system a tier B entry names in `platforms` has a
 * nightly job on that system running `--tier b`; a failure opens an issue (a
 * job gated on `failure()` that needs every tier B job and may write issues);
 * and the workflow reads no secret but the default GITHUB_TOKEN, because a
 * scheduled run on a fork or a broken probe must not be able to spend one.
 */
export function checkE2eTiers(documents, entries = loadManifest().entries) {
  const problems = [];
  const ci = documents["ci.yml"];
  // The tiers hang off ci.yml; a directory without it is not this repository's.
  if (!ci || typeof ci !== "object") return problems;
  {
    const job = ci.jobs?.e2e;
    if (!job) problems.push("ci.yml: has no e2e job running tier A");
    else {
      if (!/tools\/ci\/e2e\.mjs\s+--tier\s+a\b/.test(jobRuns(job)))
        problems.push(
          "ci.yml: job e2e does not run node tools/ci/e2e.mjs --tier a",
        );
      if (!runnerLabels(job).every((label) => label.startsWith("ubuntu-")))
        problems.push("ci.yml: job e2e must run on ubuntu (tmux, xvfb)");
    }
  }
  const nightly = documents["nightly.yml"];
  if (!nightly || typeof nightly !== "object")
    problems.push("nightly.yml: is missing; tier B has nowhere to run");
  else {
    const triggers = nightly.on ?? nightly[true] ?? {};
    if (!Array.isArray(triggers.schedule) || triggers.schedule.length === 0)
      problems.push("nightly.yml: has no schedule trigger");
    if (!("workflow_dispatch" in triggers))
      problems.push("nightly.yml: cannot be run by hand (workflow_dispatch)");
    const jobs = Object.entries(nightly.jobs ?? {});
    const tierB = jobs.filter(([, job]) =>
      /tools\/ci\/e2e\.mjs\s+--tier\s+b\b/.test(jobRuns(job)),
    );
    if (tierB.length === 0)
      problems.push("nightly.yml: no job runs node tools/ci/e2e.mjs --tier b");
    else {
      const wanted = new Map();
      for (const entry of entries.filter((item) => item.tier === "b"))
        for (const platform of entry.platforms ?? [])
          wanted.set(platform, [...(wanted.get(platform) ?? []), entry.id]);
      for (const [platform, ids] of wanted) {
        const prefix = RUNNER_PREFIX[platform];
        if (
          !tierB.some(([, job]) =>
            runnerLabels(job).some((label) => label.startsWith(prefix)),
          )
        )
          problems.push(
            `nightly.yml: no job runs --tier b on ${platform}, where ${ids.join(", ")} must run`,
          );
      }
      const reporter = jobs.find(
        ([, job]) =>
          /\bfailure\(\)/.test(String(job?.if ?? "")) &&
          /gh issue (create|comment)/.test(jobRuns(job)),
      );
      if (!reporter)
        problems.push(
          "nightly.yml: no job opens an issue when a tier B job fails",
        );
      else {
        const [name, job] = reporter;
        const needs = [job.needs ?? []].flat();
        const unwatched = tierB
          .map(([jobName]) => jobName)
          .filter((jobName) => !needs.includes(jobName));
        if (unwatched.length > 0)
          problems.push(
            `nightly.yml: job ${name} does not need ${unwatched.join(", ")}, so their failures open no issue`,
          );
        if (job.permissions?.issues !== "write")
          problems.push(
            `nightly.yml: job ${name} opens issues without permissions: issues: write`,
          );
      }
    }
    const secrets = [
      ...new Set(
        [...JSON.stringify(nightly).matchAll(/secrets\.([A-Za-z0-9_]+)/g)]
          .map((match) => match[1])
          .filter((name) => name !== "GITHUB_TOKEN"),
      ),
    ];
    if (secrets.length > 0)
      problems.push(
        `nightly.yml: reads ${secrets.join(", ")}; tier B may use only the default GITHUB_TOKEN`,
      );
  }
  return problems;
}

/** Check every workflow in the repository. */
export function checkWorkflowDirectory(directory = WORKFLOW_DIR) {
  const problems = [];
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  if (files.length === 0) problems.push(`${directory} holds no workflows`);
  const documents = {};
  for (const file of files.sort()) {
    let document;
    try {
      document = parseYaml(readFileSync(join(directory, file), "utf8"));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
      continue;
    }
    documents[file] = document;
    problems.push(...checkWorkflow(file, document));
  }
  problems.push(...checkE2eTiers(documents));
  return { files, problems };
}

function main() {
  const { files, problems } = checkWorkflowDirectory();
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nWorkflow validation failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(`${files.length} workflow(s) validated: ${files.join(", ")}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
