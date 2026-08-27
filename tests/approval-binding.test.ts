/**
 * B8-AC20 — `ApprovalBindingView` projection (TD §7.2 rule 7, §17.1f, M0-31).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileProfile } from "../core/profile/compiler.ts";
import { ProfileCompileError } from "../core/profile/errors.ts";
import { lookupApprovalBinding } from "../core/store/approval-binding.ts";
import {
  commitDecisionResolution,
  commitPendingDecision,
} from "../core/statemachine/transition-commit.ts";
import { executionPolicy, projectProfile } from "./support/decision-fixtures.ts";
import { discover, gateDecision, withWorld, ULID } from "./support/domain-fixtures.ts";

const BINDING = {
  kind: "OPTION" as const,
  chosen_option: "APPROVE",
  free_form: null,
  resolved_by: "operator-reference-1",
  resolved_at: "t-resolve",
  approval_binding: { field_path: "auto_merge", approved_value: true },
  applied_transition_ref: null,
};

test("B8-AC20: a resolved decision with an approval binding projects a view", () => {
  withWorld((world) => {
    discover(world);
    commitPendingDecision(world.store, { decision: gateDecision(world), channel: "operations" });

    const sourceSet = { decisions: world.store.pendingDecisions, operatorActions: world.store.operatorActions };
    // While OPEN it authorizes nothing.
    assert.equal(
      lookupApprovalBinding(sourceSet, `human-decision:${ULID.decision}`),
      undefined,
    );

    commitDecisionResolution(world.store, ULID.decision, BINDING);
    const view = lookupApprovalBinding(sourceSet, `human-decision:${ULID.decision}`);

    assert.deepEqual(view, {
      ref: `human-decision:${ULID.decision}`,
      status: "RESOLVED",
      field_path: "auto_merge",
      approved_value: true,
      record_hash: world.store.pendingDecisions.require(ULID.decision).record_hash,
    });
  });
});

test("B8-AC20: an ordinary Human Gate approval is not a Profile-override authority", () => {
  withWorld((world) => {
    discover(world);
    commitPendingDecision(world.store, { decision: gateDecision(world), channel: "operations" });
    commitDecisionResolution(world.store, ULID.decision, {
      ...BINDING,
      approval_binding: null,
    });

    const sourceSet = { decisions: world.store.pendingDecisions, operatorActions: world.store.operatorActions };
    assert.equal(
      lookupApprovalBinding(sourceSet, `human-decision:${ULID.decision}`),
      undefined,
      "approving an execution must not approve a privilege expansion",
    );
    assert.equal(lookupApprovalBinding(sourceSet, "human-decision:missing"), undefined);
    assert.equal(lookupApprovalBinding(sourceSet, "something-else:1"), undefined);
  });
});

test("B8-AC20: an operator action projects the same view shape", () => {
  withWorld((world) => {
    const record = world.store.withTransaction(() =>
      world.store.operatorActions.put({
        action_id: ULID.action,
        field_path: "auto_merge",
        approved_value: true,
        recorded_by: "operator-reference-1",
        recorded_at: "rec-1",
      }),
    );

    const sourceSet = { decisions: world.store.pendingDecisions, operatorActions: world.store.operatorActions };
    assert.deepEqual(lookupApprovalBinding(sourceSet, `operator-action:${ULID.action}`), {
      ref: `operator-action:${ULID.action}`,
      status: "RESOLVED",
      field_path: "auto_merge",
      approved_value: true,
      record_hash: record.record_hash,
    });
  });
});

test("B8-AC20: the Batch 4 compiler consumes the concrete helper", () => {
  withWorld((world) => {
    const record = world.store.withTransaction(() =>
      world.store.operatorActions.put({
        action_id: ULID.action,
        field_path: "auto_merge",
        approved_value: true,
        recorded_by: "operator-reference-1",
        recorded_at: "rec-1",
      }),
    );
    const sourceSet = { decisions: world.store.pendingDecisions, operatorActions: world.store.operatorActions };
    const lookup = (ref: string) => lookupApprovalBinding(sourceSet, ref);

    // A privilege-expanding override now resolves against real durable rows.
    const compiled = compileProfile({
      projectProfile: projectProfile(),
      executionPolicy: executionPolicy({
        capability_requirements: {
          automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } },
        },
        contract_drift_policy: {
          canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" },
        },
      }),
      approvedOverrides: {
        items: [
          {
            field_path: "auto_merge",
            value: true,
            approval_ref: `operator-action:${ULID.action}`,
            approval_hash: record.record_hash,
          },
        ],
      },
      lookupApproval: lookup,
    });
    assert.equal(compiled.body.effective.policy.auto_merge, true);

    // A wrong hash still fails closed.
    assert.throws(
      () =>
        compileProfile({
          projectProfile: projectProfile(),
          executionPolicy: executionPolicy({
            capability_requirements: {
              automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } },
            },
            contract_drift_policy: {
              canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" },
            },
          }),
          approvedOverrides: {
            items: [
              {
                field_path: "auto_merge",
                value: true,
                approval_ref: `operator-action:${ULID.action}`,
                approval_hash: `sha256:${"0".repeat(64)}`,
              },
            ],
          },
          lookupApproval: lookup,
        }),
      (error: unknown) => error instanceof ProfileCompileError,
    );
  });
});
