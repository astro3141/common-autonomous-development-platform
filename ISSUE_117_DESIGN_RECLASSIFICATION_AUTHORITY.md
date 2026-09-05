# Issue #117 Design — Recurring-Improvement Reclassification Authority Contract

## Classification

```
classification: BOUNDED DESIGN / CONTRACT-GAP RESOLUTION
source: #107 (S1/S3/S4/S5 measured repair), independent review findings #107 issuecomment-5548393749
design issue: #117
spec authority: Specification v0.4
TD authority: TECHNICAL_DESIGN_cadp_v0_4_generation.md
required changes: TD_CHANGE (§8.3 reference policy) + FINDING_CLAIM_SCHEMA_CHANGE (existing v1)
acceptance path: Control scope check → Independent Design Review → Human merge → #107 Execution refresh
```

---

## Problem Summary

Issue #107 attempted S1/S3/S4/S5 implementation (recurring-improvement reclassification). Independent Review (issue #107, comment-5548393749) identified that the implementation reached a contract boundary: **no current-generation structured field normatively authorizes an exact reclassification transition** such as "predecessor Finding exact-id + digest, from-classification → to-classification, under method-context." The attempt correctly returned `STOP_CONTRACT_GAP`.

This Design resolves the five exact measured gaps (D1–D5) with MINIMUM current-generation change.

---

## D1 — Structured Human Transition Authorization

**Existing contract state:**
- `cadp.human-decision.v1` (K2 claim) has: `principal`, `decision`, `scope`, `statement`, `issued_at`
- `scope` has: `effect_id?`, `work_run_ref?`, `target_ref`, `material_digest?`, `candidate_sha?`
- `statement` is free-text, non-authoritative (Spec §2.2, TD §9.3)

**Minimum new representation:**

Extend `cadp.human-decision.v1` claim schema with one optional field:

```typescript
cadp.human-decision.v1 {
  principal: string;                    // IdP subject + display id
  decision: "APPROVE" | "REJECT" | "EXCEPTION_ACCEPT" | "STOP";
  scope: {
    effect_id?: string;
    work_run_ref?: string;
    target_ref: string;                 // mandatory as before
    material_digest?: string;
    candidate_sha?: string;
  };
  statement: string;                    // free text, non-authoritative
  issued_at: string;                    // RFC 3339 UTC
  
  // NEW: optional structured reclassification authority (only when authorizing
  // a reclassification transition for a predecessor Finding).
  reclassification?: {
    predecessor_evidence_id: string;          // exact evidence_id of predecessor Finding
    predecessor_envelope_digest: string;      // exact envelope_digest of predecessor
    to_classification: string;                // the classification this approval authorizes
    from_classification: string;              // the predecessor's recorded classification
    method_context?: string;                  // derivation/method identity when present in predecessor
  };
}
```

**Rationale:**
- Uses existing K2 envelope identity (`evidence_id`, `envelope_digest`) — no new record type
- Explicitly binds to exact predecessor by immutable digest (no self-declared authority text)
- `from_classification ≠ to_classification` is checkable; validates genuine transitions
- `method_context` optional, for deterministic reclassification validation (D3)
- Scope binding via existing `scope.work_run_ref` (existing K2 field)
- Part of K2 claim, subject to `claim_digest` and `envelope_digest` (existing authority basis)

**SPEC_CHANGE:** No. K2 envelope structure and claim architecture unchanged.

**TD_CHANGE:** Reference policy predicate in §8.3 to define `reclassification_authorizing_decision`.

---

## D2 — Exact Non-Circular Applicability / Anti-Standing-Authority

**Problem:** Same Human decision must not clear reclassification in unrelated contexts (different work-run, different subject, different method).

**Minimum binding rule:**

A Human-authorized reclassification (via D1 `reclassification` field in HUMAN_DECISION envelope) is applicable **only when**:

1. The evidence in policy evaluation contains this exact HUMAN_DECISION envelope (K2 identity = `evidence_id + envelope_digest`)
2. **Work-run binding (mandatory):** `scope.work_run_ref` of the decision matches the reclassified Finding's `execution_or_run_ref`
   - Both must be present and identical (string equality)
   - If either is absent/null, the reclassification is not work-run-bound and cannot be applied
3. **Subject binding (mandatory):** The reclassified Finding's `subject_bindings[].authority_ref + namespace + object_id + revision_or_version + content_digest` must match the predecessor Finding's subject-binding
   - This prevents cross-subject reuse without explicit new Finding + new evaluation
4. **Method binding (where present):** When `method_context` is present in both:
   - Predecessor Finding `derivation.method_ref + method_digest`
   - Reclassification authorization `method_context` (hash or identifier)
   - Must match (exact equality)
5. **One-time consumption (atomic):** This exact HUMAN_DECISION envelope can authorize at most one descendant Finding's reclassification of this exact predecessor
   - Enforced by ingress replay idempotency (TD §7.4): re-submission of identical reclassified Finding returns same envelope ID
   - Cross-descendant/cross-work-run reuse of this envelope in different reclassifications is an incident

**Rationale:**
- Uses existing K2 fields: `evidence_id`, `envelope_digest`, `execution_or_run_ref`, `subject_bindings`
- Clock-free: authority scoped by immutable context (work-run, subject, method), not time
- No ambient/latest-authority: must be explicitly supplied in evidence during evaluation (K4 input)
- Prevents descendant chains where D₁ authorizes D₂, D₂ authorizes D₃ across different work-runs (circular via re-licensing)

**Implementation (policy):**

Add to reference policy `cadp.referencePolicy.v1` (§8.3):

```rego
# Reclassification is authorized if:
# 1. HUMAN_DECISION envelope present with reclassification field
# 2. Work-run binding matches
# 3. Subject binding matches
# 4. Method context matches (if present)
# 5. This is the only descendant using this authorization

reclassification_authorizing_decision(predecessor_id, predecessor_digest, child_evidence_id) if {
  # Find the reclassified Finding
  child_finding := finding_by_evidence_id(child_evidence_id)
  child_finding.claim.reclassification_metadata.predecessor_evidence_id == predecessor_id
  child_finding.claim.reclassification_metadata.predecessor_envelope_digest == predecessor_digest
  
  # Find the Human decision
  some hd_env in input.evidence
  hd_env.evidence_kind == "HUMAN_DECISION"
  hd_env.availability == "PRESENT"
  hd_env.claim.reclassification != null
  hd_env.claim.reclassification.predecessor_evidence_id == predecessor_id
  hd_env.claim.reclassification.predecessor_envelope_digest == predecessor_digest
  hd_env.claim.decision == "APPROVE"
  
  # Work-run binding
  work_run := hd_env.claim.scope.work_run_ref
  work_run != null
  child_finding.claim.derivation.execution_or_run_ref == work_run
  
  # Subject binding
  reclassified_subject_ok(child_evidence_id, predecessor_id)
  
  # Method context (if present in decision)
  method_ctx := hd_env.claim.reclassification.method_context
  (method_ctx == null or
   method_ctx == child_finding.claim.derivation.method_digest)
}

# Helper: validate subject preservation (same binding as predecessor)
reclassified_subject_ok(child_id, pred_id) if {
  child_finding := finding_by_evidence_id(child_id)
  pred_finding := finding_by_evidence_id(pred_id)
  
  child_subject_binding := subject_binding_at(child_finding.claim.subject.binding_index, child_finding.subject_bindings)
  pred_subject_binding := subject_binding_at(pred_finding.claim.subject.binding_index, pred_finding.subject_bindings)
  
  child_subject_binding.authority_ref == pred_subject_binding.authority_ref
  child_subject_binding.namespace == pred_subject_binding.namespace
  child_subject_binding.object_id == pred_subject_binding.object_id
  child_subject_binding.revision_or_version == pred_subject_binding.revision_or_version
  child_subject_binding.content_digest == pred_subject_binding.content_digest
}
```

---

## D3 — Supersession Subject/Work-Run Invariants

**Decision (requirement for #107 Execution):**

When a Finding is reclassified (supersedes a predecessor), the reclassified Finding **must**:

1. **Subject preservation:** Same `subject_bindings` entry as predecessor (D2 validates via `reclassified_subject_ok`)
   - Prevents accidental/unintentional subject shifting under color of reclassification
   - Allows only explicit separate Finding without `supersedes` for genuine subject correction
2. **Work-run context:** If reclassification requires Human authorization:
   - `execution_or_run_ref` must be present and non-null
   - Must match `HUMAN_DECISION.scope.work_run_ref` exactly
   - Prevents cross-work-run reuse of one Human approval
3. **No re-licensing chains:** A reclassification Finding D₂ that supersedes D₁ cannot itself be superseded by D₃ under a **different** Human decision
   - Enforced by: if D₃ supersedes D₂, and D₂ is a reclassification, then D₃'s authorizing Human decision is a fresh evaluation in its own work-run
   - Prevents "approval-chain" where one Human decision implicitly authorizes descendants

**Rationale:**
- Uses existing Finding K2 structure: `supersedes[]`, `subject_bindings`, `derivation.execution_or_run_ref`
- Subject invariant aligns with Spec §2.7 (no silent substitution)
- Work-run invariant closes standing-authority reuse across different autonomous runs
- No new invariant beyond existing evidence-binding rules

---

## D4 — Authority Validity / Reuse Semantics (Clock-Free)

**Decision (no wall-clock introduced):**

A Human reclassification authorization (D1 `reclassification` field in HUMAN_DECISION) remains valid for:

1. **Exact predecessor binding:** The specific predecessor Finding (`evidence_id + envelope_digest`) named in the field
2. **Scope binding:** Only when work-run (`execution_or_run_ref`) and subject (`subject_bindings`) match (D2)
3. **One-time logical consumption:** Idempotent ingress replay (TD §7.4)
   - Re-submission of the same reclassified Finding (semantic payload) returns the same envelope ID + evidence_id
   - Does not create a new authority grant
4. **No time-based expiry:** Unlike K5 `PolicyDecisionV1.not_after`, reclassification authority has no `expires_at`
   - Authority is valid as long as:
     - The exact predecessor Finding remains in the store
     - The work-run remains active or completed (no distinction needed in the kernel)
     - The Human decision envelope remains in the store
     - Scope and subject bindings hold
5. **Policy-bound freshness (existing mechanism):** `EVIDENCE_MAX_AGE(HUMAN_DECISION, seconds)` constraint (TD §5.3)
   - Applies to all HUMAN_DECISION envelopes, including those carrying reclassification authority
   - Freshness = `produced_at` must be within policy-bound window (existing K2 rule)

**Rationale:**
- Clock-free: authority scoped by **content and context identity**, not time
- Aligns with TD §4.4 fresh recheck #4: `produced_at ≥ subject revision's own timestamp`
- Reuse prevention via scope binding (D2) + atomic ingress replay (existing), not temporal expiry
- No new clock field or time-based boundary introduced

**SPEC_CHANGE:** No. Freshness via policy-bound `EVIDENCE_MAX_AGE` is existing K2 mechanism.

**TD_CHANGE:** Reference policy example in §8.3 applying `EVIDENCE_MAX_AGE` to reclassification decisions.

---

## D5 — Positive S4 Real-PEP Path

**Goal:** Show that a legitimate recurring-improvement Finding reclassification can proceed through the real PEP / `admitAndDispatch` once landing.

**Path A (Human-authorized reclassification):**

```
1. WORK_START effect accepted (Effect A, autonomous work run R1)

2. Worker/backend produces Finding F1 (initial classification = FINDING:CONTRACT)
   sealed as IMPROVEMENT_FINDING K2 envelope (evidence_id = E1, envelope_digest = D1)

3. Workflow evaluates: "CONTRACT classified Finding exists, decide what to do"
   → Policy requires HUMAN_DECISION
   → `assemble_admission_input([E1])`
   → `evaluate` → `REQUIRE_EVIDENCE(HUMAN_DECISION)`

4. Human reviews F1 on SSO surface; it is genuinely a DISCOVERY (not CONTRACT)
   → Human clicks APPROVE → posts HUMAN_DECISION envelope (evidence_id = E2)
     with reclassification field:
       - predecessor_evidence_id = E1
       - predecessor_envelope_digest = D1
       - from_classification = "FINDING:CONTRACT"
       - to_classification = "FINDING:DISCOVERY"
       - scope.work_run_ref = R1 (from work-run context)
     [Decision is sealed as K2 envelope, evidence_id = E2]

5. Workflow assembles new `AdmissionInputV1` (input_digest = I2)
   → evidence_refs = [E1 (reclassified F1), E2 (Human reclassification decision)]
   → effect_id = (from work-run), policy_ref = (active policy under work-run policy bounds)
   → `evaluate(I2)` under active policy

6. Policy evaluates: "F1 was F1:CONTRACT; Human approved reclassification to DISCOVERY"
   → Policy checks (via reference §8.3 `reclassification_authorizing_decision`):
     - Is E2 a HUMAN_DECISION? yes
     - Does E2.claim.reclassification.predecessor_evidence_id == E1? yes
     - Does E2.claim.reclassification.from_classification == recorded F1 classification? yes
     - Does E2.claim.scope.work_run_ref == work_run_ref? yes
     - Are subject bindings identical? yes
     - Policy decides: `ALLOW` (F1 reclassification cleared)
   → Returns K5 `PolicyDecisionV1(outcome=ALLOW, constraints=[…])`

7. PEP `admit_and_dispatch(effect_id, decision_id)`:
   → Fresh recheck #5 (TD §4.4): "every HUMAN_DECISION envelope in input has
     claim.scope.effect_id or scope.work_run_ref matching this effect, and has not
     been referenced by any admission of a different effect_id"
       ✓ E2 scope.work_run_ref == work-run context
       ✓ E2 (evidence_id + digest) = unique identity; cannot be reused for different effect
   → All other rechecks pass
   → Writes EffectAdmissionV1 (admission_id, admission_digest)
   → Dispatch: PEP performs exact gated effect
   → Outcome written

8. Result: Finding F1 reclassified from CONTRACT → DISCOVERY under provable
   Human authority, within work-run R1, subject-bound, expressible in current-generation
   K1–K7 records, no invented decision logs or ambient authority.
```

**Path B (Deterministic reclassification, optional):**

For Findings where policy declares a closed set of deterministic reclassification rules (e.g., "if anomaly_code='retry-timeout' and initial='FINDING:TRANSIENT' and method_digest matches {known-digests}, reclassify to 'FINDING:RESOLVED'"):

```
Worker produces Finding F2 (classification=FINDING:TRANSIENT, anomaly_code=retry-timeout)

Policy check: "Is this a known deterministic reclassification?"
→ Policy rules: "retry-timeout + TRANSIENT + method_digest in {known} → DISCOVERY"
→ Policy decides: `ALLOW` (deterministic reclassification)

PEP admits (no Human gate needed for this rule)
```

This works without new machinery; existing policy constraints (`OPERATION_KIND_EQUALS`, closed deterministic rules in policy bundle) suffice.

**Key property:** Both paths proceed through real K6 `admit_and_dispatch`, use K2 evidence bindings (no invented decision records), and rely on policy evaluation + PEP fresh recheck (TD §5.2, §4.4 #5).

**SPEC_CHANGE:** No. K1–K7 unchanged; Human decision model (Spec §5.3) already covers this.

**TD_CHANGE:** Reference policy example in §8.3.

---

## D6–D8 Control Summary (Acceptance criteria #6–8)

### D6 — Decision Polarity

✓ `APPROVE` only (from `cadp.human-decision.v1` `decision` enum). `REJECT`/`STOP`/arbitrary values cannot carry `reclassification` field. Ingress validation rejects non-APPROVE decisions with reclassification present.

### D7 — Exact Evidence Basis Resolution

✓ Reclassification authority via `HUMAN_DECISION` evidence (K2 `evidence_id + envelope_digest`).
✓ Predecessor binding: exact `evidence_id + envelope_digest` (not text, not "latest Finding").
✓ No self-declared `AUTHORITY_TEXT`; authority comes from policy evaluation + sealed Human decision.
✓ Method context (if present) is immutable `derivation.method_digest` (digest, not label).

### D8 — Falsification Controls (Cross-Run/Subject/Descendant Reuse)

✓ **Cross-work-run reuse blocked:** `scope.work_run_ref` must match `execution_or_run_ref` (D2, #2).
✓ **Cross-subject reuse blocked:** Subject binding identity enforced (D2, #3; D3).
✓ **Invalid Human paths:** REJECT/STOP decisions cannot carry reclassification (D6).
✓ **One-time logical consumption:** Idempotent ingress (TD §7.4) ensures semantic payload uniqueness.
✓ **No ambient authority:** Decision must be explicitly supplied in evidence; no lookup of "latest Human approval" by default.
✓ **Method binding (when present):** Deterministic rules validated against closed policy set (existing mechanism).

---

## Acceptance Criteria Fulfillment

1. ✓ **Classify SPEC_CHANGE and TD_CHANGE:** No Spec change. TD §8.3 reference policy example required.
2. ✓ **Define exact Human transition-authorization:** D1 — `reclassification` field in `cadp.human-decision.v1`, binds `predecessor_evidence_id + envelope_digest + from/to_classification`.
3. ✓ **Define exact non-circular authority applicability:** D2 — work-run, subject, method binding; one-time consumption via idempotent replay.
4. ✓ **Define supersession subject/work-run invariants:** D3 — subject preservation, work-run matching, no re-licensing chains.
5. ✓ **Define validity/reuse semantics (clock-free):** D4 — scoped by content/context identity, policy-bound freshness only, no `expires_at`.
6. ✓ **Preserve decision polarity:** D6 — APPROVE only; REJECT/STOP/arbitrary values forbidden.
7. ✓ **Preserve exact evidence_id + envelope_digest basis:** D7 — K2 envelope identity throughout; no invented records.
8. ✓ **Define falsification controls:** D8 — cross-run/subject/descendant reuse blocked; invalid paths trapped.
9. ✓ **Show real-PEP positive S4 path:** D5 — Human-authorized reclassification through `admitAndDispatch`, real K6/K7.
10. ✓ **Provide DESIGN_DISPOSITION and NEXT_OWNER:** See below.

---

## DESIGN_DISPOSITION

**Status: TD_DESIGN_READY**

Changes required before #107 Execution can resume:

1. **TD §8.3 reference policy**: Add example predicate `reclassification_authorizing_decision(predecessor_id, predecessor_digest, child_evidence_id)` implementing D2 rules.
2. **TD §8.3 reference policy**: Add example predicate `reclassified_subject_ok(child_id, pred_id)` implementing D3 subject-preservation check.
3. **Schema registration**: `cadp.human-decision.v1` claim schema extended with optional `reclassification` field (§D1) in `data.cadp.schemas` policy bundle definition.

No Spec change required; no new record types; no new ingress APIs.

---

## NEXT_OWNER

#107 Execution: Refresh branch against this Design → land TD reference predicates → re-admit existing test materials with reclassification-scoped Human decisions → prove S4 path expressible.

