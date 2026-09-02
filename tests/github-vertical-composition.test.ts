/**
 * #78 — Profile-selected GitHub vertical composition (#52 replay preparation).
 *
 * The frozen Compiled Profile — never a deployment default, never an installed-adapter
 * inference — selects the TaskSource; the D24 materializer exists only where the Profile binds
 * one; the PR-projection ingress is a thin entrypoint over the sealed use-case; and the push
 * target must be proven bound to the configured repository before any external effect.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GitHubIssuesChildMaterializer, GitHubIssuesTaskSource } from "../adapters/github/index.ts";
import { GitHubPullRequestProjection } from "../adapters/github/github-pr-projection.ts";
import { PullRequestProjectionFailedError } from "../adapters/interfaces/pull-request-projection.ts";
import { ProjectDocumentTaskSource } from "../core/tasksource/index.ts";
import { compose } from "../deployment/compose.ts";
import { ConfigError } from "../deployment/config.ts";
import { startIngress } from "../deployment/ingress.ts";
import type { ProductionCoordinatorDependencies } from "../core/coordinator/production-coordinator.ts";
import { projectPullRequest, prProjectionOp } from "../core/execution/project-pull-request.ts";
import { withWorld, world as makeWorld } from "./support/domain-fixtures.ts";
import {
  PILOT_TASK_REF,
  pilotProjectProfile,
  pilotWorld,
  ScriptedGateway,
  type PilotWorld,
} from "./support/deployment-fixtures.ts";
import { humanMergeWorld } from "./support/execution-fixtures.ts";

const GH_OWNER = "acme";
const GH_REPO = "widgets";

function withProfileTaskSources(world: PilotWorld, task_sources: unknown): void {
  const profile = pilotProjectProfile() as Record<string, unknown>;
  profile["task_sources"] = task_sources;
  writeFileSync(join(world.base, "project-profile.json"), JSON.stringify(profile));
}

const githubSourceEntry = (child_materializer?: unknown) => ({
  id: "gh",
  adapter: "GitHubIssuesTaskSource",
  config: { owner: GH_OWNER, repo: GH_REPO },
  ...(child_materializer === undefined ? {} : { child_materializer }),
});

test("GHV-1: the frozen Profile selects the TaskSource; unknown adapters fail closed", () => {
  const world = pilotWorld();
  try {
    // Acceptance 1 — a document Profile still composes the document source.
    const documents = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    try {
      assert.ok(documents.deps.taskSource instanceof ProjectDocumentTaskSource);
      assert.equal(documents.deps.materializer, undefined, "no Profile binding, no materializer");
      assert.equal(documents.projection, undefined);
    } finally {
      documents.dispose();
    }

    // Acceptance 2/4 — a GitHub Profile composes the production GitHub TaskSource with the
    // target taken only from the frozen Profile config (the deployment config carries no GitHub
    // facts at all, and its document paths are ignored for selection — no silent fallback).
    withProfileTaskSources(world, [githubSourceEntry()]);
    const github = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    try {
      assert.ok(github.deps.taskSource instanceof GitHubIssuesTaskSource);
      assert.equal(github.deps.materializer, undefined, "acceptance 6: absent binding, no materializer");
      assert.ok(github.projection instanceof GitHubPullRequestProjection);
      assert.equal(github.projection_base_branch, "trunk", "resolved from the configured canonical ref, not caller text");
    } finally {
      github.dispose();
    }

    // Acceptance 3 — an unregistered adapter is a fail-closed composition, never a fallback.
    withProfileTaskSources(world, [
      { id: "x", adapter: "SomeUnknownSource", config: {} },
    ]);
    assert.throws(() => compose(world.config, { runtime_gateway: new ScriptedGateway() }), ConfigError);

    // A GitHub entry without its Profile-owned target is incomplete, not defaultable.
    withProfileTaskSources(world, [
      { id: "gh", adapter: "GitHubIssuesTaskSource", config: { owner: GH_OWNER } },
    ]);
    assert.throws(() => compose(world.config, { runtime_gateway: new ScriptedGateway() }), ConfigError);
  } finally {
    world.dispose();
  }
});

test("GHV-2: the D24 materializer composes only from the frozen Profile binding, same target", () => {
  const world = pilotWorld();
  try {
    // Acceptance 5 — a declared binding composes the production materializer through the
    // existing Coordinator seam.
    withProfileTaskSources(world, [
      githubSourceEntry({ adapter: "GitHubIssuesChildMaterializer", config: {} }),
    ]);
    const bound = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    try {
      assert.ok(bound.deps.materializer instanceof GitHubIssuesChildMaterializer);
    } finally {
      bound.dispose();
    }

    // An unknown materializer adapter fails closed; no deployment default may stand in.
    withProfileTaskSources(world, [
      githubSourceEntry({ adapter: "SomethingElse", config: {} }),
    ]);
    assert.throws(() => compose(world.config, { runtime_gateway: new ScriptedGateway() }), ConfigError);

    // §7.1e — the materializer is bound to the task source's target; a contradicting target in
    // its config is a refused contradiction, never a second route.
    withProfileTaskSources(world, [
      githubSourceEntry({
        adapter: "GitHubIssuesChildMaterializer",
        config: { owner: "someone-else" },
      }),
    ]);
    assert.throws(() => compose(world.config, { runtime_gateway: new ScriptedGateway() }), ConfigError);
  } finally {
    world.dispose();
  }
});

test("GHV-3: the projection ingress is thin — gated, and the destination is never caller-selectable", async () => {
  const created = makeWorld();
  try {
    const merge = humanMergeWorld(created);
    const calls: { head_branch: string; candidate: string }[] = [];
    const projection = {
      publish_candidate_pull_request(request: { head_branch: string; candidate_commit: string }) {
        calls.push({ head_branch: request.head_branch, candidate: request.candidate_commit });
        return {
          status: "COMMITTED" as const,
          receipt: {
            pr_ref: "501",
            url: "https://github.com/acme/widgets/pull/501",
            head_branch: request.head_branch,
            candidate_commit: request.candidate_commit,
          },
        };
      },
      reconcile_pull_request() {
        return { status: "NO_EFFECT_CONFIRMED" as const };
      },
    };
    // Only the store and the projection option are supplied; every other dependency slot is
    // deliberately absent so any reach beyond the thin contract would crash loudly.
    const deps = { store: created.store } as unknown as ProductionCoordinatorDependencies;
    const ingress = await startIngress(deps, {
      host: "127.0.0.1",
      port: 0,
      report_channel: "operations",
      projection: projection as never,
      projection_base_branch: "trunk",
    });
    try {
      const base = `http://127.0.0.1:${ingress.port()}`;

      // Acceptance 10 (ingress side) — a caller-supplied destination is refused outright.
      const steered = await fetch(`${base}/v1/attempts/${encodeURIComponent(merge.attempt_key)}/project-pr`, {
        method: "POST",
        body: JSON.stringify({ head_branch: "main", base_branch: "release" }),
      });
      assert.equal(steered.status, 400);
      assert.equal(calls.length, 0);

      // Acceptance 8 — before READY_TO_MERGE there is zero external effect.
      created.store.withTransaction(() => {
        created.store.attempts.write(merge.attempt_key, { state: "AUDITING" });
      });
      const early = await fetch(`${base}/v1/attempts/${encodeURIComponent(merge.attempt_key)}/project-pr`, {
        method: "POST",
      });
      assert.equal(early.status, 409);
      assert.equal(calls.length, 0, "zero GitHub/push effect before the gate");
      assert.equal(created.store.idempotency.get(prProjectionOp(merge.attempt_key)), undefined);

      // Acceptance 9/10 — at the eligible state the sealed use-case runs with the exact
      // candidate and the Core-generated adp/candidate/<attempt> head ref.
      created.store.withTransaction(() => {
        created.store.attempts.write(merge.attempt_key, { state: "READY_TO_MERGE" });
      });
      const projected = await fetch(`${base}/v1/attempts/${encodeURIComponent(merge.attempt_key)}/project-pr`, {
        method: "POST",
      });
      assert.equal(projected.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.candidate, merge.candidate_commit, "exact candidate binding preserved");
      assert.match(calls[0]!.head_branch, /^adp\/candidate\//u);

      // No projection composed → the surface is absent, fail-closed, zero effect.
      const bare = await startIngress(deps, { host: "127.0.0.1", port: 0, report_channel: "operations" });
      try {
        const absent = await fetch(
          `http://127.0.0.1:${bare.port()}/v1/attempts/${encodeURIComponent(merge.attempt_key)}/project-pr`,
          { method: "POST" },
        );
        assert.equal(absent.status, 409);
      } finally {
        await bare.close();
      }
    } finally {
      await ingress.close();
    }
  } finally {
    created.dispose();
  }
});

test("GHV-5 (blocker 1): the crash-window reconcile path refuses a wrong-target INTENT through Core", () => {
  withWorld((created) => {
    const merge = humanMergeWorld(created);
    // A durable INTENT already exists for this projection op — the exact crash window the Core
    // recovery path enters through reconcile, bypassing publish.
    const op = prProjectionOp(merge.attempt_key);
    created.store.withTransaction(() => {
      created.store.idempotency.beginIntent(op);
    });

    // The wrong repository actually contains a PR at this head + exact candidate SHA.
    const seen: string[] = [];
    const transport = {
      api(request: { method: string; path: string }): unknown {
        seen.push(`${request.method} ${request.path}`);
        return [
          {
            number: 999,
            html_url: "https://github.com/someone-else/other-repo/pull/999",
            head: { sha: merge.candidate_commit },
          },
        ];
      },
      push_commit(): void {
        seen.push("PUSH");
      },
      remote_url(): string {
        // The canonical clone pushes to acme/widgets, not the configured someone-else/other-repo.
        return "https://github.com/acme/widgets.git";
      },
    };
    const projection = new GitHubPullRequestProjection(transport as never, {
      owner: "someone-else",
      repo: "other-repo",
      canonical_repo_path: "/tmp/canonical",
    });

    const outcome = projectPullRequest(
      { store: created.store, projection },
      { attempt_key: merge.attempt_key, base_branch: "main" },
    );

    assert.notEqual(outcome.kind, "PROJECTED", "a wrong-target INTENT must not project");
    assert.notEqual(created.store.idempotency.get(op)?.state, "DONE");
    assert.equal(
      created.store.adapterMetadata.get(merge.attempt_key, "pull-request-projection", "candidate_pull_request"),
      undefined,
      "no receipt persisted",
    );
    assert.deepEqual(seen, [], "zero list/push/create over an unbound target");
  });
});

test("GHV-6 (blocker 2): the document source is defined by the frozen Profile, never deployment config", () => {
  const world = pilotWorld();
  try {
    // Two distinct documents: the Profile declares A; the deployment installation block names B.
    const docA = readFileSync(join(world.repo.root, "TASKS.md"), "utf8");
    writeFileSync(join(world.repo.root, "TASK-A.md"), docA);
    writeFileSync(join(world.repo.root, "TASK-B.md"), docA.replace(`task-ref: ${PILOT_TASK_REF}`, "task-ref: B-ONLY"));
    withProfileTaskSources(world, [
      { id: "docs", adapter: "ProjectDocumentTaskSource", config: { paths: ["TASK-A.md"], parser: "markdown-sections-v1" } },
    ]);
    // The deployment legacy field deliberately points at B.
    const config = { ...world.config, task_source: { paths: [join(world.repo.root, "TASK-B.md")] } };

    const composition = compose(config, { runtime_gateway: new ScriptedGateway() });
    try {
      const source = composition.deps.taskSource;
      const candidates = source.discover_tasks({ observed_at: "2026-09-02T00:00:00Z" });
      const refs = candidates.map((c) => c.task_ref);
      assert.ok(refs.includes(PILOT_TASK_REF), "A (the Profile's document) is observed");
      assert.ok(!refs.includes("B-ONLY"), "B (the deployment document) is never silently executed");
      // The Profile's adapter config, not the deployment field, must fail closed on its own errors.
    } finally {
      composition.dispose();
    }
  } finally {
    world.dispose();
  }
});

test("GHV-4: the push target must be proven bound to the configured repository before any effect", () => {
  const seen: string[] = [];
  const transport = {
    api(request: { method: string; path: string }): unknown {
      seen.push(`${request.method} ${request.path}`);
      return [];
    },
    push_commit(): void {
      seen.push("PUSH");
    },
    remote_url(): string {
      return "https://github.com/someone-else/other-repo.git";
    },
  };
  const projection = new GitHubPullRequestProjection(transport as never, {
    owner: GH_OWNER,
    repo: GH_REPO,
    canonical_repo_path: "/tmp/canonical",
  });
  // Acceptance 11 — a canonical clone pushing somewhere other than the configured owner/repo is
  // refused definitively before reconcile listing, push and PR creation alike.
  assert.throws(
    () =>
      projection.publish_candidate_pull_request({
        op_key: "op:a:pr-projection",
        head_branch: "adp/candidate/a",
        candidate_commit: "9a8b7c6d5e4f30211203344556677889900aabbc",
        base_branch: "main",
        title: "t",
        body: "b",
      }),
    PullRequestProjectionFailedError,
  );
  assert.deepEqual(seen, [], "zero external effect on target mismatch");

  // The measured remote forms (https and ssh, with and without .git) satisfy the binding.
  for (const url of [
    `https://github.com/${GH_OWNER}/${GH_REPO}.git`,
    `https://github.com/${GH_OWNER}/${GH_REPO}`,
    `git@github.com:${GH_OWNER}/${GH_REPO}.git`,
    `ssh://git@github.com/${GH_OWNER}/${GH_REPO}`,
  ]) {
    const okTransport = {
      api(): unknown {
        return [];
      },
      push_commit(): void {},
      remote_url(): string {
        return url;
      },
    };
    const okProjection = new GitHubPullRequestProjection(okTransport as never, {
      owner: GH_OWNER,
      repo: GH_REPO,
      canonical_repo_path: "/tmp/canonical",
    });
    // A bound target passes the check and reaches the reconcile read; a create envelope the
    // fake does not model then surfaces as an ordinary error — but never a binding refusal,
    // which is what this control proves.
    let reachedReconcile = false;
    const boundProjection = new GitHubPullRequestProjection(
      {
        api(request: { method: string; path: string }): unknown {
          if (request.method === "GET" && /\/pulls\?/u.test(request.path)) {
            reachedReconcile = true;
            return [];
          }
          throw new Error("create not modeled");
        },
        push_commit(): void {},
        remote_url(): string {
          return url;
        },
      } as never,
      { owner: GH_OWNER, repo: GH_REPO, canonical_repo_path: "/tmp/canonical" },
    );
    void okProjection;
    assert.throws(
      () =>
        boundProjection.publish_candidate_pull_request({
          op_key: "op:a:pr-projection",
          head_branch: "adp/candidate/a",
          candidate_commit: "9a8b7c6d5e4f30211203344556677889900aabbc",
          base_branch: "main",
          title: "t",
          body: "b",
        }),
      (error: unknown) => !(error instanceof PullRequestProjectionFailedError),
      `bound target ${url} must not be a binding refusal`,
    );
    assert.equal(reachedReconcile, true, `binding passed for ${url}`);
  }
});
