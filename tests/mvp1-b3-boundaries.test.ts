/**
 * M1B3-AC29 ~ M1B3-AC46 — the LocalGit adapter stays a primitive surface: no policy, no Store, no
 * lifecycle, no Repository Gate, no remote and no destructive repair.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { openDatabase } from "../core/store/database.ts";
import { FakeRepositoryAdapter } from "../testdoubles/fake-repository-adapter.ts";
import { LocalGitRepositoryAdapter } from "../adapters/local-git/local-git-repository-adapter.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL_GIT = join(ROOT, "adapters/local-git");
const CORE = join(ROOT, "core");

/** Terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const adapterSources = (): string[] =>
  readdirSync(LOCAL_GIT)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(LOCAL_GIT, name));

const coreSources = (): string[] =>
  readdirSync(CORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(CORE, entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(CORE, entry.name, name)),
    );

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const scan = (files: readonly string[], label: string, patterns: readonly RegExp[]): void => {
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${label}: ${match?.[0] ?? ""}`);
    }
  }
};

/** Every argv the adapter can hand to git, read from the helper call sites themselves. */
const gitArgv = (): string[][] =>
  adapterSources().flatMap((file) =>
    [
      ...stripComments(readFileSync(file, "utf8")).matchAll(
        /\b(?:runGit|git|gitLine)\(\s*[^,]+,\s*(?:"[^"]*",\s*)?\[([\s\S]*?)\]/g,
      ),
    ].map((match) =>
      [...(match[1] as string).matchAll(/"([^"]*)"/g)].map((piece) => piece[1] as string),
    ),
  );

// --- policy, store and lifecycle -------------------------------------------------------

test("M1B3-AC29 / AC30 / AC31: the adapter carries no policy, no Store and no lifecycle", () => {
  scan(adapterSources(), "policy", [
    /auto_merge|accepted_assurance|verification_profile|capability_requirements/,
    /CapabilityGrant|VerificationEvidence|AuditVerdict|audit_decide/,
    /repository_policy|ExecutionPolicy|CompiledProfile|classification/,
    /REPOSITORY_CONFLICT|POLICY_REJECTED|HUMAN_REQUIRED|FIX_REQUIRED/,
  ]);
  scan(adapterSources(), "a Store dependency", [
    /PlatformStore|node:sqlite|decisions\.append|withTransaction|adapter_metadata/,
    /from "\.\.\/\.\.\/core/,
  ]);
  scan(adapterSources(), "a lifecycle transition", [
    /AttemptFact|TaskState|AttemptState|PendingHumanDecision|state_reason/,
    /DISCOVERED|SELECTED|IMPLEMENTING|VERIFYING|AUDITING|READY_TO_MERGE|MERGED\b/,
  ]);

  // The adapter imports only its own module and Node built-ins.
  for (const file of adapterSources()) {
    for (const specifier of [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1] as string,
    )) {
      assert.equal(
        specifier.startsWith("node:") ||
          specifier.startsWith("./") ||
          specifier === "../interfaces/repository-adapter.ts",
        true,
        `${relative(ROOT, file)} reaches for ${specifier}`,
      );
    }
  }
});

test("M1B3-AC30: no Core module imports the production adapter", () => {
  for (const file of coreSources()) {
    const content = readFileSync(file, "utf8");
    assert.equal(content.includes("local-git"), false, `${relative(ROOT, file)} imports local-git`);
    assert.equal(
      /LocalGitRepositoryAdapter/.test(content),
      false,
      `${relative(ROOT, file)} names the production adapter`,
    );
  }
});

// --- Repository Gate absence -------------------------------------------------------------

test("M1B3-AC32 ~ AC35 / §55: no Gate, no automatic merge and no merge INTENT exist yet", () => {
  const core = coreSources();
  // Every Gate-side primitive stays unreachable from Core. `snapshot_canonical` is the one
  // exception, and only in the file whose job is to observe the canonical head for V8 (§12 of
  // MVP1-B4): reading a fact is not merging, and no other Core file may even do that.
  const FACT_READERS = [
    "core/admission/fact-assembly.ts",
    // TD §12.7 step 0 (M1-7) — activation re-reads the canonical head to check the selection
    // binding. Reading a fact is still not merging, and the merge primitives stay unreachable.
    "core/admission/activate-task.ts",
    // TD §19.3e steps 1–3 (MVP1-B6) — the workspace's durable reference records which repository
    // it was cut from, so the canonical ref is read. Still a fact, still not a merge.
    "core/execution/start-implementation.ts",
    // MVP1-B7/M1-9 — the verification request carries the canonical snapshot, which is the
    // RepositoryAdapter's own fact. Reading it is still not merging.
    "core/execution/start-verification.ts",
    // M1-11 — §11.4's `canonical_head` target compares the current canonical head against the
    // Attempt's frozen base. At every boundary before the merge it is observed and nothing else:
    // no rebase, no change of base, and the merge primitives below stay unreachable.
    "core/execution/assemble-drift-observation.ts",
    // MVP1-B12 — §19.4e observes whether a *person* merged. Reading canonical is the whole point
    // of that observation, and the merge primitives below stay unreachable from it too.
    "core/execution/human-merge.ts",
    // MVP 2 — the Gate's recovery decides between "effect exists" and "effect provably absent"
    // by reading canonical (§21). Observation before actuation, exactly as everywhere else.
    "core/execution/automatic-merge.ts",
    // v1.5 §5.11 — the diagnostic packet may carry a *fresh* canonical observation with explicit
    // provenance. A read presented as a read, never a merge and never authority.
    "core/operability/diagnostics.ts",
    // MVP 4 §22.2/§22.3 — the recovery pass queries the repository as one of the authoritative
    // owners (canonical reachability under merge-pending states). Observation, never mutation.
    "core/coordinator/production-recovery.ts",
    // MVP 4 §22.5 — TERMINAL_DIVERGENCE compares canonical lineage against the Platform's
    // projection. A lineage read for an anomaly *observation*; the monitor mutates nothing.
    "core/coordinator/monitor.ts",
    // §17.4 (D22) — the RECOVERY_DECISION mapping row re-observes "candidate still not canonical"
    // fresh at application time. A canonical read; the merge primitives stay unreachable.
    "core/execution/apply-resolved-decision.ts",
    // §13.4 (D23) — the Supervisor decision context carries the fresh canonical head as the
    // turn's freshness basis. A model-facing projection read; still not merging.
    "core/execution/supervisor-decision-context.ts",
  ];
  // MVP1-B6 — creating the feature workspace is the one repository *mutation* Core may now reach,
  // and only from the module that owns READY→IMPLEMENTING. It is not a Gate primitive: the merge
  // and verification primitives below stay unreachable from every Core file without exception.
  const WORKSPACE_CREATORS = ["core/execution/start-implementation.ts"];
  scan(
    core.filter((file) => !WORKSPACE_CREATORS.includes(relative(ROOT, file))),
    "a workspace primitive",
    [/create_feature_workspace/],
  );
  // MVP1-B7 — IMPLEMENTING→VERIFYING asks the repository what the Actor actually produced, so the
  // three *candidate observation* facts are reachable from the module that owns that transition.
  // They are not Gate primitives: no merge, no canonical CAS, no repository-scope path check.
  const CANDIDATE_OBSERVERS = [
    "core/execution/start-verification.ts",
    // MVP1-B9 — TD §15.2 has the Coordinator re-confirm the candidate with the RepositoryAdapter
    // before evidence may bind to it. Reading that fact is still not merging.
    "core/execution/complete-verification.ts",
    // MVP1-B10 — the Auditor may only be shown a workspace that still holds the candidate under
    // review, and that is a repository fact. Still not merging.
    "core/execution/start-auditing.ts",
    // MVP1-B12 — §19.4e/§19.4h ask whether the candidate reached canonical history, and whether
    // the attempt's own base is still in it. Both are lineage *reads*; neither merges anything.
    "core/execution/human-merge.ts",
    // MVP 2 — the Repository Gate's own preconditions are lineage/cleanliness *facts* (§14.4).
    "core/execution/automatic-merge.ts",
    // MVP 4 §22.5 — TERMINAL_DIVERGENCE reads canonical lineage as an observation. The monitor
    // owns no transition and no mutation; it may not even recommend one.
    "core/coordinator/monitor.ts",
    // §17.4 (D22) — the RECOVERY_DECISION mapping row re-observes "candidate still not canonical"
    // fresh at application time. A lineage read; the merge primitives stay unreachable.
    "core/execution/apply-resolved-decision.ts",
  ];
  scan(
    core.filter((file) => !CANDIDATE_OBSERVERS.includes(relative(ROOT, file))),
    "a candidate observation primitive",
    [/inspect_candidate/, /verify_lineage/, /verify_tracked_clean/],
  );
  // MVP 2 (TD §14.4) — the Repository Gate now exists, and it is the *only* Core module that may
  // reach a merge or gate primitive. The original "no Gate exists yet" reading of this guard is
  // superseded by the stronger one: exactly one Gate, nowhere else.
  const REPOSITORY_GATE = ["core/execution/automatic-merge.ts"];
  scan(
    core.filter((file) => !REPOSITORY_GATE.includes(relative(ROOT, file))),
    "a merge or gate primitive",
    [/prepare_merge|commit_merge/, /verify_canonical_head|verify_expected_files/, /get_diff\(/],
  );
  for (const file of core) {
    if (!stripComments(readFileSync(file, "utf8")).includes("snapshot_canonical")) continue;
    assert.equal(
      FACT_READERS.includes(relative(ROOT, file)),
      true,
      `${relative(ROOT, file)} reads a repository fact directly`,
    );
  }
  scan(core, "a git invocation", [/execFile|spawnSync|execSync|child_process|["'`]git["'`]/]);
  // `automatic_merge` itself is the Profile's operation id from TD §12.2 and predates this batch;
  // MVP 2 added exactly one module that acts on it — the Repository Gate. Everything else stays
  // clear of gate orchestration, which is the invariant that actually matters (TD §14.4 G1).
  scan(
    core.filter((file) => !REPOSITORY_GATE.includes(relative(ROOT, file))),
    "gate orchestration",
    [/RepositoryGate|MergeGate|merge --ff-only|commitMerge/, /mergeIntent|merge_intent|:merge:/],
  );

  // The Coordinator in particular gained nothing.
  const coordinator = readFileSync(join(ROOT, "core/coordinator/coordinator.ts"), "utf8");
  for (const term of ["Repository", "merge", "git", "local-git", "workspace"]) {
    assert.equal(
      coordinator.toLowerCase().includes(term.toLowerCase()),
      false,
      `the Coordinator now references ${term}`,
    );
  }
});

test("M1B3-AC33: no production Repository Gate module was added", () => {
  const modules = readdirSync(CORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // `admission` is MVP1-B4's front half — a fact assembler, not a Repository Gate.
  // `execution` is MVP1-B6's READY→IMPLEMENTING use-case: it creates a feature workspace and
  // starts the Actor, and reaches no merge, candidate or verification primitive at all.
  assert.deepEqual(modules, [
    "admission",
    "capability",
    "contract",
    "coordinator",
    "decision",
    "discovery",
    "execution",
    "humandecision",
    // v1.5 §5.11–§5.14 — read-only derivations (diagnostics, measurement, findings, routing).
    // None of them is a Gate: the Repository Gate lives in `execution/automatic-merge.ts` and is
    // held to its own guards (B14).
    "operability",
    "profile",
    "schemas",
    "statemachine",
    "store",
    "tasksource",
  ]);
  for (const name of ["gate", "merge", "repository"]) {
    assert.equal(modules.includes(name), false, `core/${name} must not exist yet`);
  }
});

// --- git usage hygiene ---------------------------------------------------------------------

test("M1B3-AC40 / AC41: no remote, network or destructive git operation is reachable", () => {
  const forbiddenSubcommands = [
    "fetch",
    "pull",
    "push",
    "remote",
    "clone",
    "rebase",
    "reset",
    "clean",
    "checkout",
    "switch",
    "tag",
    "update-ref",
    "gc",
    "prune",
  ];
  const used = new Set(gitArgv().map((argv) => argv[0] ?? ""));
  for (const subcommand of forbiddenSubcommands) {
    assert.equal(used.has(subcommand), false, `the adapter can run git ${subcommand}`);
  }
  assert.deepEqual(
    [...used].filter((value) => value !== "").sort(),
    ["diff", "merge", "merge-base", "rev-parse", "status", "symbolic-ref", "worktree"],
  );

  // No dangerous flag anywhere, and the one merge that exists is fast-forward only.
  scan(adapterSources(), "a dangerous flag", [
    /"--force"|"-f"|"--hard"|"--no-ff"|"--allow-unrelated-histories"|"--rebase"/,
    /"origin"|"--set-upstream"|"https?:\/\//,
  ]);
  const merges = gitArgv().filter((argv) => argv[0] === "merge");
  assert.equal(merges.length, 1, "exactly one merge invocation exists");
  assert.deepEqual(merges[0]?.slice(0, 2), ["merge", "--ff-only"]);
});

test("M1B3-AC42: git is always invoked with an argument vector and never through a shell", () => {
  scan(adapterSources(), "a shell", [
    /\bexec\(|execSync|\bspawn\(|shell\s*:\s*true|\/bin\/(sh|bash)/,
    /"git [^"]/,
    /`git /,
  ]);
  const helper = readFileSync(join(LOCAL_GIT, "git.ts"), "utf8");
  assert.match(helper, /execFileSync\("git", \[\.\.\.argv\]/);
  assert.equal(/shell/.test(stripComments(helper)), false, "no shell option is ever passed");
});

// --- schema and neighbouring batches ---------------------------------------------------------

test("M1B3-AC36 ~ AC39: the schema and the MVP1-B1/B2 surfaces are untouched", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })),
    [
      { version: 1, name: "foundation" },
      { version: 2, name: "domain" },
      { version: 3, name: "mvp1-artifacts" },
      { version: 4, name: "selection-scope" },
      { version: 5, name: "selection-binding" },
      { version: 6, name: "audit-decision-category" },
      { version: 7, name: "subflow-parent" },
      { version: 8, name: "subflow-succeeded" },
    ],
  );
  assert.deepEqual(
    [...((MIGRATIONS[2] as Migration).statements.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g))]
      .map((match) => match[1] as string)
      .sort(),
    ["adapter_metadata", "audit_record", "verification_evidence"],
  );

  const temp = tempStore();
  const store = temp.open();
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  store.close();
  try {
    const database = openDatabase(temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));
      assert.equal(names.length, 17);
      for (const forbidden of ["workspace", "repository_state", "merge_intent"]) {
        assert.equal(names.includes(forbidden), false);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }

  // MVP1-B2's discovery seam did not gain a repository dependency.
  scan(
    readdirSync(join(CORE, "discovery")).map((name) => join(CORE, "discovery", name)),
    "a repository dependency",
    [/Repository|git|merge/i],
  );
});

// --- test doubles and vocabulary ----------------------------------------------------------------

test("M1B3-AC46: the FakeRepositoryAdapter still exists and runs no git", () => {
  const fake = new FakeRepositoryAdapter();
  assert.deepEqual(
    Object.getOwnPropertyNames(FakeRepositoryAdapter.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    Object.getOwnPropertyNames(LocalGitRepositoryAdapter.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    "both implementations expose exactly the Spec §42 operation set",
  );
  assert.equal(fake.calls.length, 0);

  const source = readFileSync(join(ROOT, "testdoubles/fake-repository-adapter.ts"), "utf8");
  assert.equal(/child_process|execFile|node:fs|"git"/.test(source), false);
  assert.equal(source.includes("LocalGit"), false, "the fake was not replaced by the production one");
});

test("M1B3-AC44 / AC45: no backend or project vocabulary entered the adapter", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${fragment("a", "cp")}\\b`, "i"),
    new RegExp(fragment("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("sl", "ack"), "i"),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("PROJECT", "_STATUS")),
    new RegExp(fragment("Runtime", "Session")),
    new RegExp(fragment("spawn", "_agent")),
    new RegExp(fragment("managed", "-worktree")),
    new RegExp(fragment("work", "flow"), "i"),
    /\bU-\d\d\b/,
    // A canonical branch name must come from config, never from the source.
    /"(main|master)"/,
  ];
  for (const file of [...adapterSources(), join(ROOT, "tests/support/temp-git-repo.ts")]) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});
