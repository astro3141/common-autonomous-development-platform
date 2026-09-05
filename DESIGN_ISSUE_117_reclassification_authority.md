# Issue #117 Design — Recurring-Improvement Reclassification Authority Contract

## Classification

```
classification: BOUNDED DESIGN / CONTRACT-GAP RESOLUTION
source: #107 (S1/S3/S4/S5 repair, round-3 review findings F1/F2/F3)
design issue: #117
spec authority: Common Autonomous Development Platform — Specification v0.4
TD authority: TECHNICAL_DESIGN_cadp_v0_4_generation.md (current, r7)
required changes: TD_CHANGE to §5.13, no SPEC_CHANGE
acceptance path: Design Review → Human merge → #107 Execution refresh
```

---

## Problem statement

Issue #107 attempted to implement Finding reclassification repair (S1/S3/S4/S5 concerns). Round-3 independent review (#107 issuecomment-5548393749) identified three blocking findings:

**F1 — Human reclassification basis generic-approval reuse (core contract gap)**

Current `cadp.human-decision.v1` (TD §9.3, line 635–641):
```
{
  principal        : IdP subject + display id
  decision         : APPROVE | REJECT | EXCEPTION_ACCEPT | STOP
  scope            : { effect_id?, work_run_ref?, target_ref, material_digest?, candidate_sha? }
  statement        : free text
  issued_at
}
```

Has **no structured field** to express:
- Exact Finding being reclassified (predecessor identity)
- Destination classification (target of the transition)
- Subject/work-run context preservation (anti-reuse binding)

The `statement` field is **non-authoritative** (Spec §2.2, TD E2); `material_digest` is policy-undecodable for findings.

**F2 — Test invents authority schema (mechanic symptom)**

The #107 test at `core/execution/apply-resolved-decision.ts` attempted to use a non-existent `cadp.human-design-decision.v1` type to carry the missing authority. This falsifies that no path exists under the current contract.

**F3 — Deterministic authority lacks descendant context binding (circular prevention)**

Same authority cannot authorize reclassifications of both:
- Original finding F₁ (predecessor)
- Its superseding finding F₂ (child)
- Unrelated findings sharing the same subject

Without binding authority to the exact `finding_id + predecessor_content_digest + target_classification + subject_ref`, the same decision could be reused across descendants and subject-correcting reclassifications, breaking non-circularity. Clock-free admission (TD §9.1) forbids wall-clock `not_after` bounds; validity must bind through immutable record structure.

---

## Design solution (D1–D5)

### D1 — Human transition-authorization representation

**Change: Extend `cadp.human-decision.v1` with optional reclassification scope.**

New optional field: `reclassification_authority`:

```
cadp.human-decision.v1 {
  principal        : IdP subject + display id (authenticated)
  decision         : APPROVE | REJECT | EXCEPTION_ACCEPT | STOP
  scope            : { effect_id?, work_run_ref?, target_ref, material_digest?, candidate_sha? }
  
  reclassification_authority?  : {
    predecessor_finding_ref         : string,     // exact finding_id being reclassified
    predecessor_content_digest      : {           // binding to predecessor's immutable bytes
      algorithm : "sha256",                       // matches approved schemes (TD §2.1)
      canonicalization : "cadp-jcs-1",
      value : string                              // lowercase hex
    },
    target_classification : FindingClassification, // destination: one of BUG | IMPLEMENTATION_GAP | ...
    subject_context_binding : {
      required_subject_ref : string                // exact subject that must be preserved
    }
  }
  
  statement       : free text
  issued_at
}
```

**Rationale:**
- Bounded extension of existing Human decision, not a new record type (follows TD pattern for decision polarity extension).
- Immutable field binding (content_digest) prevents authority over post-decision finding mutations.
- Classification field is concrete, not statement-inferred.
- Subject binding prevents reclassification-as-subject-correction.

**Non-goals:**
- No time validity window (clock-free, handled by admission scope binding).
- No "approval_binding" record revival (v0.3 HISTORICAL).
- No general RBAC or staged approval (out of scope for D1).

---

### D2 — Exact applicability and anti-standing-authority binding

**Finding reclassification decision applicability rule:**

A `HUMAN_DECISION` with `reclassification_authority` field populated:

1. **Exact predecessor binding**: The decision authorizes reclassification of **exactly one** `finding_id`, the one named in `predecessor_finding_ref`. No "standing authority" across other findings.

2. **Immutable content binding**: The decision is valid only if the recorded `finding_id` entry has a recorded envelope whose computed content_digest matches `predecessor_content_digest` **exactly**. A finding whose content differs (e.g., evidence_refs changed post-discovery) is a different record; the decision does not apply to it.

3. **Exact transition binding**: The decision authorizes transition from the predecessor's **current recorded classification** to exactly one `target_classification`. If the predecessor's classification differs from what the Human was shown, the transition is falsified and admission refused.

4. **Subject preservation**: The new finding record created via `supersedes_finding_ref` must have `subject_ref` equal to the predecessor finding's `subject_ref`. A reclassification that would correct the subject must not reuse this decision; it must treat the subject correction as a separate, newly evidenced finding without supersession (not applicable to this design's scope).

5. **Non-descendant reuse prevention**: A decision that authorizes F₁ → F₂ (reclassification via supersession) does **not** authorize F₂ → F₃ or F₂ → unrelated F₄. Each descendant reclassification requires a new `HUMAN_DECISION` with its own `reclassification_authority` binding the immediate predecessor.

6. **Scope enforcement**: Ingress validation (admission-time recheck) must verify:
   - `reclassification_authority.predecessor_finding_ref` resolves to a recorded finding entry.
   - The entry's `finding_hash` envelope, when re-canonicalized, produces `predecessor_content_digest`.
   - The recorded finding's `classification` matches what the decision names as the **from** state (to prevent silent reclassifications of already-changed findings).
   - The new finding entry being authorized has `supersedes_finding_ref = predecessor_finding_ref`.
   - The new finding has `subject_ref == recorded_predecessor.subject_ref`.

---

### D3 — Supersession subject/work-run context invariants

**Rule: Reclassification supersession preserves subject context exactly.**

When a Finding is recorded with `supersedes_finding_ref` pointing to another Finding:

1. **Subject preservation (mandatory)**: The new Finding's `subject_ref` **must equal** the superseded Finding's `subject_ref`. No subject correction in the same reclassification chain.

2. **Work-run binding (if present)**: If the superseded Finding has `escaped_from.attempt_key`, the superseding Finding should inherit it (or explicitly document a new escape path). The invariant is: **same subject_ref implies same work context binding unless explicitly corrected by a separate, non-superseding finding**.

3. **Distinct finding for subject correction**: If evidence shows the **subject** was wrong, the corrected classification goes into a **new independent Finding** (no `supersedes_finding_ref`), possibly with `escaped_from` pointing to the same attempt if the error was discovered in the same cycle.

**Rationale**: Allows legitimate reclassification without opening a loophole for subject-flip authority reuse. A Human decision to reclassify a Finding about subject A cannot later be claimed to authorize a reclassification of a Finding about subject B (even if B was mislabeled as A initially).

---

### D4 — Authority validity and reuse under clock-free admission

**Rule: Validity is bounded by immutable record binding, not wall-clock time.**

1. **No `not_after` or time-validity window on `reclassification_authority`**: The policy still enforces `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)` on the envelope's `issued_at` (existing TD rule), but the reclassification field itself carries no additional time constraint.

2. **Binding through immutable reference**: A `reclassification_authority` is "consumed" (spent authority) when:
   - A Finding is recorded with `supersedes_finding_ref = predecessor_finding_ref` AND `classification = target_classification` AND that Finding is sealed in the decision log.
   - The decision envelope (by `evidence_id`) is referenced in the admission input that led to that Finding recording.

3. **Idempotent reuse of same decision**: If the same work-run re-attempts to authorize the exact same reclassification and reuses the same `HUMAN_DECISION` envelope (by `evidence_id`), the admission is idempotent only if the target Finding (superseding the predecessor) already exists and matches the authorization exactly. A second **different** reclassification of the same predecessor requires a new Human decision.

4. **Non-reuse across subjects or descendants**: No ambient or "standing" authority exists. Once a `reclassification_authority` points to `finding_id = F1`, it cannot apply to any other `finding_id`, even if a new reclassification of F1 is attempted (needs a new decision).

5. **Validity check timing**: All checks occur at admission time (when the new Finding is about to be recorded), not at policy evaluation time or work-run initialization time. Stale or expired decisions are refused by the existing `EVIDENCE_MAX_AGE` policy rule.

**Rationale**: Clock-free binding avoids coupling kernel admission to external time services and prevents a revoked/expired key scenario from retroactively invalidating already-recorded decisions. Validity is anchored to the immutable record structure and exact binding.

---

### D5 — Positive S4 path (deterministic authority proof)

**Scenario**: Human approves reclassification of a Finding from classification A to classification B.

**Exact kernel path** (v0.4 TD admission, §3.4–4.4 adapted):

1. **Predecessor Finding exists**: A Finding record is sealed in the decision log:
   - `finding_id = "audit:f-001"`
   - `classification = "BUG"`
   - `subject_ref = "repo:core"`
   - `finding_hash` (envelope) computed and stored in decision log with `content_hash` in CAS.

2. **Human decision issued** (external surface):
   - Human approves the reclassification on an SSO page showing:
     - Exact `finding_id`, `subject_ref`, current `classification`, target `classification`.
   - SSO backend seals a `HUMAN_DECISION` envelope with:
     - `principal = authenticated_human_id`
     - `decision = "APPROVE"`
     - `scope = { target_ref = "cadp-store:findings", … }`
     - `reclassification_authority = { predecessor_finding_ref = "audit:f-001", predecessor_content_digest = <re-computed from stored bytes>, target_classification = "OPERABILITY_GAP", subject_context_binding = { required_subject_ref = "repo:core" } }`
     - `issued_at = <current timestamp>`
   - Decision envelope sealed with `evidence_id`, `envelope_digest`, stored in decision log.

3. **New Finding record assembly** (internal, before admission):
   - Operator (e.g., audit flow) proposes a new Finding:
     - `finding_id = "audit:f-002"` (new id, not reusing predecessor)
     - `classification = "OPERABILITY_GAP"` (target)
     - `subject_ref = "repo:core"` (identical)
     - `supersedes_finding_ref = "audit:f-001"`
     - `evidence_refs = [ "human-decision:f-001-reclassify" ]` (contains the `evidence_id` from step 2)
     - `classifier = "HUMAN"`, `classifier_ref = human_id` (from the Human decision principal)

4. **Admission recheck** (before decision log insertion, TD §4.4 adapted):
   - **#R1**: The new Finding has `supersedes_finding_ref` that resolves to a recorded finding entry with `finding_id = "audit:f-001"`.
   - **#R2**: Fetch the predecessor's stored envelope bytes (by `content_hash`); re-canonicalize and re-digest under `cadp-jcs-1`. Verify `computed_digest == reclassification_authority.predecessor_content_digest`.
   - **#R3**: Verify the recorded predecessor's `classification` (from decision log) equals the **from** state implicit in `reclassification_authority` (currently "BUG"; if it has already been reclassified to something else, the decision is stale and refused).
   - **#R4**: Verify the new Finding's `target_classification` equals `reclassification_authority.target_classification` (both "OPERABILITY_GAP").
   - **#R5**: Verify the new Finding's `subject_ref` equals `reclassification_authority.subject_context_binding.required_subject_ref` (both "repo:core").
   - **#R6**: Fetch the Human decision envelope (by `evidence_id` from new Finding's `evidence_refs`); verify `reclassification_authority` field is populated and all bindings match the new Finding's fields.
   - **#R7**: Verify the Human decision's `decision` field is "APPROVE" (explicit polarity; "REJECT", "STOP", or absent field → no authority).
   - **#R8**: Verify no other recorded finding has `finding_id == "audit:f-002"` (new finding, not a replay). If identical Finding already exists, idempotent no-op.
   - **#R9**: Verify `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)` policy rule on the envelope's `issued_at` (existing rule, unchanged).

5. **Admit and record**:
   - On all checks passing, record the new Finding in the decision log:
     - `kind = "finding_recorded"`, `refKey = "audit:f-002"`, payload with `finding_hash`, `content_hash`, `subject_ref`, `classification`, `supersedes_finding_ref`.
   - Update any presentation projections (`unsupersededFindingFor`) to show the new finding.
   - Return success to the caller.

6. **No re-execution of decision**:
   - A second attempt to authorize the reclassification of F-001 requires a new Human decision envelope (new `evidence_id`).
   - If the same Human decision is presented again in a new Finding (same `evidence_id`, different `finding_id`), recheck #1 catches it: `reclassification_authority.predecessor_finding_ref = "audit:f-001"`, so it cannot authorize a reclassification of any other finding. Admission refused with `RECLASSIFICATION_SCOPE_MISMATCH`.

**Controls closed**:
- **F1 (generic reuse)**: `reclassification_authority` field structures the authority, not left to `statement`.
- **F2 (invented schema)**: Contract uses existing `HUMAN_DECISION` type, no new kind invented.
- **F3 (descendant reuse/circularity)**: Binding to exact `predecessor_finding_ref + content_digest + target_classification + subject_ref` prevents reuse on descendants; non-circular by force.

---

## Changes required

### TD change (required)

**§5.13 — Add to Finding reclassification authority contract.**

Location: After existing Finding description (currently lines 5.13 in the v0.4 generation TD), add:

#### Reclassification authority binding

When a Finding is recorded with `supersedes_finding_ref` (a reclassification):

- **Human-authorized reclassification** requires a `HUMAN_DECISION` evidence envelope whose `reclassification_authority` field is populated with:
  - `predecessor_finding_ref`: The exact `finding_id` being superseded.
  - `predecessor_content_digest`: The `content_digest` of the predecessor Finding's sealed envelope (prevents post-decision mutations).
  - `target_classification`: The destination classification (must match the new Finding's `classification` field).
  - `subject_context_binding.required_subject_ref`: The preserved subject (must match both predecessor and new Finding's `subject_ref`).

- **Admission recheck**: Before recording a Finding with `supersedes_finding_ref`, the admission function must:
  1. Verify the predecessor Finding is recorded and resolve its stored envelope bytes.
  2. Recompute the predecessor's digest and verify byte-for-byte equality with `predecessor_content_digest`.
  3. Verify the Human decision's `decision` field is "APPROVE" (polarity gate).
  4. Verify exact classification match: recorded predecessor classification, target classification in authority, and new Finding classification all equal.
  5. Verify exact subject match: recorded predecessor `subject_ref`, required binding, and new Finding `subject_ref` all equal.
  6. Verify no evidence-producing finding bypasses this binding (no `supersedes_finding_ref` without Human authorization, or with an inactive decision).

- **Non-time validity**: The reclassification authority is valid through immutable record binding, not wall-clock bounds. Existing `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)` policy rule applies (Spec §2.2).

- **Subject preservation rule**: A reclassification via `supersedes_finding_ref` is a change in classification only, not subject. Subject correction requires a separate, independent Finding (no supersession).

- **Policy evaluation**: Policy may require `HUMAN_DECISION` evidence for certain classification transitions (e.g., "BUG → OPERABILITY_GAP requires Human approval"). The Human decision with reclassification authority fulfills this requirement **exactly and only** for the named predecessor and transition.

### Spec change

**None required.** Spec v0.4 §2.2 already establishes:
- Evidence must bind to exact subject identity, producer, provenance, and integrity.
- Authority is not inherited across unrelated effects.
- Human decision is attributed, scoped, and fresh evidence.

The `reclassification_authority` field is a bounded extension of evidence scope binding, consistent with existing authority semantics. No Spec conflict or contradiction.

---

## Design disposition

### Acceptance checklist

1. ✓ **Classify SPEC_CHANGE and TD_CHANGE explicitly**: SPEC_CHANGE = none; TD_CHANGE = §5.13 extension (reclassification authority binding).

2. ✓ **Define exact Human transition-authorization representation**: `reclassification_authority` field on `HUMAN_DECISION`, with `predecessor_finding_ref`, `predecessor_content_digest`, `target_classification`, `subject_context_binding`.

3. ✓ **Define exact non-circular authority applicability**: Binding to exact finding_id + content_digest + target classification + subject preserves non-circularity; descendants require new decisions.

4. ✓ **Define supersession subject/work-run invariants**: Subject preservation rule (same subject_ref in predecessor and successor); subject correction is a separate finding without supersession.

5. ✓ **Define validity/reuse semantics compatible with clock-free admission**: Validity through immutable record binding and exact scope, not time windows; reuse prevention through predecessor binding.

6. ✓ **Preserve decision polarity**: Only "APPROVE" clears; "REJECT", "STOP", "EXCEPTION_ACCEPT" never authorize. Field absent → no authority.

7. ✓ **Preserve evidence_id + envelope_digest basis**: `reclassification_authority` is a field on the same `HUMAN_DECISION` envelope; binding by `evidence_id` and `envelope_digest` as per existing TD rules.

8. ✓ **Define falsification controls**: F1 resolved by structured field (not statement). F2 resolved by landing contract in existing schema (not inventing). F3 resolved by exact binding (no reuse across predecessors/subjects/descendants, no time loop).

9. ✓ **Show positive S4 path**: Nine-step path in D5, from predecessor existence through Human approval to finding recording with all recheck gates.

10. ✓ **Provide DESIGN_DISPOSITION and NEXT_OWNER**:
    - **DESIGN_DISPOSITION**: `TD_DESIGN_READY` (TD change §5.13 landed; no Spec change; no unresolved architecture gaps).
    - **NEXT_OWNER**: Control (scope/authority check) → Independent Design Review (two reviewers, each reviewing D1–D5 + S4 path for circular logic, time coupling, policy coherence) → Human merge if no STOP → on landing, return #107 Execution to refresh and re-attempt.

---

## Non-goals confirmed

- ❌ No #107 implementation in this issue (execution refresh after landing).
- ❌ No #109 ancestry repair changes (independent scope).
- ❌ No #106 observer/reconcile design changes (independent scope).
- ❌ No general RBAC framework (out of scope).
- ❌ No clock added to admission merely for convenience (clock-free design maintained).
- ❌ No automatic Human approval (explicit polarity gate required).
- ❌ No use of free-text `statement` as authority (field remains non-authoritative).
- ❌ No production deployment (design artifact only).

---

## Control handoff notes

**For independent Design Review:**
- Verify D1 field structure is minimal (no over-specification).
- Verify D2 applicability rules prevent all falsification legs of F1/F3.
- Verify D3 subject preservation rule does not accidentally forbid legitimate subject corrections via separate findings.
- Verify D4 clock-free binding is sound (no time loops, no ambient authority, no re-execution holes).
- Verify D5 S4 path gates all nine recheck steps and maps to landing TD changes.
- Confirm no Spec conflict (already per authority semantics).

**For #107 Execution refresh (after landing):**
- Head 01b913a stands as the base implementation (mechanics correct; authority contract was missing).
- Refresh: rebase onto main (post-Design landing), land TD changes, re-run S4 test with real `cadp.human-decision.v1` + `reclassification_authority`, remove invented `cadp.human-design-decision.v1` mock.
- Round-4 review: independent checks F1/F2/F3 are now falsified by the contract; the mechanics are sound; approve to land.

---

## Related issues and evidence

- **#107**: S1/S3/S4/S5 repair, round-3 review (independent, 5 concerns); findings F1–F3 measured and blocking.
- **#98**: Recurring-improvement policy contract (landed; independent scope; not revived v0.3).
- **#106**: Observer/reconciliation design (independent; §5.13 touching is orthogonal).
- **#109**: S2 repair design (independent; this design is not S2 scope).
- **Memory: issue-107-s1-s3-s4-s5-repair-design**: Round-3 findings context; v0.3 approval_binding mentioned as precedent (not imported); exact F1/F2/F3 detail.

---

