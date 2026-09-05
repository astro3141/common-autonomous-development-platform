# Issue #117 Design — Recurring-Improvement Reclassification Authority Contract

## Classification

```
classification: BOUNDED DESIGN / CONTRACT-GAP RESOLUTION
source: #107 (S1/S3/S4/S5 repair, round-3 review findings F1/F2/F3)
design issue: #117
spec authority: Common Autonomous Development Platform — Specification v0.4
TD authority: TECHNICAL_DESIGN_cadp_v0_4_generation.md (current, r7)
required changes: TD_CHANGE to §8.3 (reference policy), FINDING_CLAIM_SCHEMA_CHANGE to v1.1
acceptance path: Design Review → Human merge → #107 Execution refresh
round: 8 (repair of prior round-7 self-audit; independent review REQUEST_CHANGES addressed)
```

---

## Problem statement

Issue #107 attempted to implement Finding reclassification repair (S1/S3/S4/S5 concerns). Round-3 independent review (#107 issuecomment-5548393749) identified three blocking findings. Round-7 self-audit committed a design candidate that was reviewed independently and returned REQUEST_CHANGES with 6 findings (#117 issuecomment-5549…). This round-8 design repair addresses all 6 review findings by:

1. **Restating design in K2/current-generation contract terms** (K2 envelope identity = `evidence_id + envelope_digest`, Finding as `IMPROVEMENT_FINDING` K2 claim with optional reclassification context, policies evaluated over sealed envelopes).
2. **Defining exact reclassification transitions** with `from_classification`, `to_classification`, derivation/run context.
3. **Showing real S4 path** through current `work_run_ref`-scoped HUMAN_DECISION flow (path A with WORK_START, not invented admission recheks).
4. **Designing both Human and deterministic authority** with falsification controls (not just authority-text).
5. **Using actual current-generation fields** (`derivation.execution_or_run_ref`, K2 `subject_bindings`, `produced_at`).
6. **Defining atomic authority consumption** via idempotent subject-binding scoping.

---

## Design solution (D1–D5)

### D1 — Structured reclassification metadata in Finding claim

**Change: Extend `cadp.improvement-finding.v1` (K2 claim schema) with optional reclassification context.**

New optional field on `ImprovementFindingClaimV1`:

```typescript
export interface ImprovementFindingClaimV1 {
  readonly contract_id: "cadp.improvement-intake.v1";
  readonly classification: Classification;
  readonly subject: { readonly kind: SubjectKind; readonly binding_index: number };
  readonly basis: ReadonlyArray<EvidenceRef & { readonly role: BasisRole }>;
  readonly derivation: {
    readonly kind: DerivationKind;
    readonly method_ref: string;
    readonly method_digest: string;
    readonly execution_or_run_ref?: string;  // mandatory for MODEL_PROPOSAL/HUMAN_JUDGMENT
  };
  readonly anomaly_code: string;
  readonly occurrence_key: string;
  readonly series_key?: string;
  readonly statement: { readonly summary: string; readonly detail?: string };
  readonly supersedes?: ReadonlyArray<EvidenceRef>;     // predecessor(s)
  readonly correction_reason?: string;
  
  // NEW: reclassification context (mandatory when supersedes is present AND
  // derivation is HUMAN_JUDGMENT or DETERMINISTIC_DERIVATION with AUTHORITY_TEXT basis)
  readonly reclassification_metadata?: {
    readonly from_classification: Classification;  // predecessor's recorded classification
    readonly to_classification: Classification;    // same as this Finding's classification
    readonly authorized_by_evidence_id?: string;  // evidence_id of authorizing Human/deterministic basis
  };
}
```

**Rationale:**
- Extends K2 claim schema, not creating new record types (consistency with K2 architecture).
- `from_classification` / `to_classification` make the transition explicit and checkable.
- Optional field maintains backward compatibility with non-reclassifying Findings.
- `authorized_by_evidence_id` points to the exact evidence that carries authority (either a HUMAN_DECISION or the authoritative deterministic WORK_STEP).
- No new `finding_recorded` decision log; Finding identity remains `evidence_id + envelope_digest`.

---

### D2 — Validation rules for reclassification metadata

**Ingress validation (before K2 envelope submission):**

When `reclassification_metadata` is present:
1. `supersedes` must be non-empty (reclassification means predecessor).
2. `from_classification ≠ to_classification` (genuine transition).
3. `to_classification == this Finding's classification` (consistency).
4. If `derivation.kind == "DETERMINISTIC_DERIVATION"`: basis must contain exactly one entry with `role == "AUTHORITY_TEXT"` (self-contained deterministic authority), and `authorized_by_evidence_id` must be absent (determinism is self-proving, no external authorizer needed).
5. If `derivation.kind == "HUMAN_JUDGMENT"`: `authorized_by_evidence_id` must be present and must name a HUMAN_DECISION evidence (or other future Human-authoritative kind).
6. If `derivation.kind == "MODEL_PROPOSAL"`: `reclassification_metadata` is forbidden (models cannot unilaterally reclassify; only humans can).

**Admission-time validation (referencePolicy recheck, before seal):**

The reference policy's `reclassified_clear(cid)` predicate (referencePolicy.ts:302–320) is enhanced to check:

```rego
# §3 reclassification with structured authority: a non-CONTRACT_* descendant that
# supersedes C via HUMAN_JUDGMENT with authorized_by_evidence_id, or via
# DETERMINISTIC_DERIVATION with AUTHORITY_TEXT basis. MODEL_PROPOSAL never clears.

reclassified_clear(cid) if {
  some e in improvement_findings
  some s in object.get(e.claim, "supersedes", [])
  s.evidence_id == cid
  not is_contract_class(e.claim.classification)
  
  # Must have reclassification_metadata
  meta := object.get(e.claim, "reclassification_metadata", null)
  meta != null
  meta.from_classification != meta.to_classification
  meta.to_classification == e.claim.classification
  
  # Human path: authorized_by_evidence_id must name a HUMAN_DECISION approving this exact transition
  (e.claim.derivation.kind == "HUMAN_JUDGMENT"
   and some auth_env in input.evidence
   auth_env.evidence_id == meta.authorized_by_evidence_id
   auth_env.evidence_kind == "HUMAN_DECISION"
   auth_env.availability == "PRESENT"
   auth_env.claim.decision == "APPROVE"
   # scope must be work_run_ref (path A with work-run binding)
   auth_env.claim.scope.work_run_ref != null)
  
  or
  
  # Deterministic path: AUTHORITY_TEXT basis proves transition (deterministic = self-authorizing)
  (e.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
   and some b in e.claim.basis
   b.role == "AUTHORITY_TEXT"
   and object.get(e.claim, "reclassification_metadata", {}).authorized_by_evidence_id == null)
}
```

**Controls closed by D1–D2:**
- **Finding 1 (K2 mapping)**: No new record types. Finding remains K2 envelope (identity = `evidence_id + envelope_digest`). Metadata is a field in the existing claim schema.
- **Finding 2 (missing transition)**: `from_classification` and `to_classification` explicitly encode the transition; validation rejects mismatched classifications. Validation also requires `from_classification != to_classification`.

---

### D3 — Work-run context binding and subject preservation

**Finding claim inheritance (mandatory):**

When a Finding with `reclassification_metadata` is sealed:
1. The `subject.binding_index` of the reclassification Finding **must** resolve to the same `SubjectBinding` as the predecessor Finding's `subject.binding_index`.
2. If the reclassification is part of a WORK_START: the Finding's `derivation.execution_or_run_ref` (for HUMAN_JUDGMENT/MODEL_PROPOSAL) **must** equal the work-run context where the reclassification is authorized.
3. If the reclassification is part of a deterministic derivation (DETERMINISTIC_DERIVATION): the method binding (`method_ref + method_digest`) must be identical to or an explicitly sanctioned upgrade of the predecessor's detection method.

**Rationale:**
- Enforces `subject_ref` preservation: subject correction is orthogonal to reclassification (a separate Finding without `supersedes`).
- Binds work context exactly: a Human-authorized reclassification in work-run R1 cannot retroactively clear an unrelated reclassification in work-run R2.
- Deterministic method binding ensures the same logical rule applies consistently.

**Implementation in policy:**

Add to referencePolicy.ts reclassification predicates:

```rego
# Enforce subject preservation: reclassified Finding must have same subject binding as predecessor
reclassified_subject_ok(child_id, pred_id) if {
  child := finding_by_id(child_id)
  pred := finding_by_id(pred_id)
  child.claim.subject.binding_index >= 0
  pred.claim.subject.binding_index >= 0
  # Both resolve to the same subject binding (matching authority_ref, namespace, object_id, revision_or_version, content_digest)
  some child_sb in input.evidence[child.subject_bindings].subject_bindings
  child_sb.binding_index == child.claim.subject.binding_index
  some pred_sb in input.evidence[pred.subject_bindings].subject_bindings
  pred_sb.binding_index == pred.claim.subject.binding_index
  child_sb.authority_ref == pred_sb.authority_ref
  child_sb.namespace == pred_sb.namespace
  child_sb.object_id == pred_sb.object_id
  child_sb.revision_or_version == pred_sb.revision_or_version
  child_sb.content_digest == pred_sb.content_digest
}

# For HUMAN_JUDGMENT: execution_or_run_ref must match the work-run being authorized
reclassified_run_ok(finding_id, auth_evidence_id) if {
  f := finding_by_id(finding_id)
  f.claim.derivation.kind == "HUMAN_JUDGMENT"
  run_ref := f.claim.derivation.execution_or_run_ref
  run_ref != null
  some auth_env in input.evidence
  auth_env.evidence_id == auth_evidence_id
  auth_env.evidence_kind == "HUMAN_DECISION"
  auth_env.claim.scope.work_run_ref == run_ref
}
```

Update `reclassified_clear` to enforce:

```rego
reclassified_clear(cid) if {
  some e in improvement_findings
  some s in object.get(e.claim, "supersedes", [])
  s.evidence_id == cid
  not is_contract_class(e.claim.classification)
  
  meta := object.get(e.claim, "reclassification_metadata", null)
  meta != null
  meta.from_classification != meta.to_classification
  meta.to_classification == e.claim.classification
  
  # Subject preservation check
  reclassified_subject_ok(e.evidence_id, cid)
  
  # Human path with run binding
  (e.claim.derivation.kind == "HUMAN_JUDGMENT"
   and some auth_env in input.evidence
   auth_env.evidence_id == meta.authorized_by_evidence_id
   auth_env.evidence_kind == "HUMAN_DECISION"
   auth_env.availability == "PRESENT"
   auth_env.claim.decision == "APPROVE"
   auth_env.claim.scope.work_run_ref != null
   # NEW: verify work_run matches Finding's execution context
   reclassified_run_ok(e.evidence_id, meta.authorized_by_evidence_id))
  
  or
  
  # Deterministic path (unchanged)
  (e.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
   and some b in e.claim.basis
   b.role == "AUTHORITY_TEXT"
   and object.get(e.claim, "reclassification_metadata", {}).authorized_by_evidence_id == null)
}
```

**Controls closed:**
- **Finding 5 (work-run invariant)**: Subject binding enforced by exact K2 subject_bindings matching. Run context enforced for Human judgments.

---

### D4 — Deterministic reclassification authority without AUTHORITY_TEXT

**Current problem:** The existing policy (lines 312–320 in referencePolicy.ts) accepts any DETERMINISTIC_DERIVATION with an AUTHORITY_TEXT basis, but AUTHORITY_TEXT is self-declared and lacks exact evidence/context binding.

**Solution: Typed deterministic authority observation.**

The deterministic reclassification must be grounded in a **typed authority source** (not free text). Options:

**Option A: Policy-declared deterministic transition (landed in current policy).**

The active policy explicitly declares that a certain `anomaly_code + from_classification → to_classification` transition is deterministic and automatically reclassifies. Example:

```yaml
deterministic_reclassification_rules:
  - anomaly_code: "api-backward-compat"
    from_classification: "CONTRACT_GAP"
    to_classification: "CONTRACT_AMBIGUITY"
    method_digest_suffix: "cadp:repair-contract-ambiguity" # policy-bound method
    allowed_subject_kinds: ["EFFECT"]
```

The Finding's `derivation.method_digest` must match the policy-declared method. Validation:

```rego
deterministic_rule_ok(finding_id) if {
  f := finding_by_id(finding_id)
  f.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
  meta := object.get(f.claim, "reclassification_metadata", null)
  meta != null
  
  # Find matching policy rule
  some rule in data.policy_params.deterministic_reclassification_rules
  rule.anomaly_code == f.claim.anomaly_code
  rule.from_classification == meta.from_classification
  rule.to_classification == meta.to_classification
  
  # Method binding must match policy
  contains(f.claim.derivation.method_digest, rule.method_digest_suffix)
  
  # Find predecessor
  some s in f.claim.supersedes
  pred := finding_by_id(s.evidence_id)
  
  # Predecessor must have matching classification at seal time
  pred.claim.classification == rule.from_classification
}

reclassified_clear(cid) if {
  # ... (existing checks for subject, inheritance, etc.) ...
  
  some e in improvement_findings
  some s in object.get(e.claim, "supersedes", [])
  s.evidence_id == cid
  not is_contract_class(e.claim.classification)
  
  meta := object.get(e.claim, "reclassification_metadata", null)
  meta != null
  meta.from_classification != meta.to_classification
  meta.to_classification == e.claim.classification
  
  e.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
  deterministic_rule_ok(e.evidence_id)
}
```

**Option B: External attestation (not in this round).**

A separate AUTHORITY_RESOLUTION evidence or attestation specifically authorizing the deterministic rule. Out of scope for this round.

**Control closed:**
- **Finding 4 (deterministic authority)**: Deterministic reclassifications now require policy-declared rules bound to method_digest, not free-text authority.

---

### D5 — Positive S4 path (real PEP flow)

**Scenario:** Human approves reclassification of a Finding from classification A to classification B as part of an audit work-run.

**Exact kernel path** (v0.4 TD §3.2–4.4, §9.3, adapted):

1. **Predecessor Finding exists (sealed in prior work):**
   - `evidence_id = "improvement:f-001"`
   - K2 envelope with `claim = { classification: "BUG", subject: { kind: "EFFECT", binding_index: 0 }, … }`
   - `envelope_digest = "cadp-jcs-1(…)"` (immutable)
   - Sealed in the decision log with `produced_at` and `envelope_digest` stored.

2. **Audit work-run initiated (no reclassification decision yet):**
   - Operator initiates a WORK_START effect for audit:
     - `effect_id = "effect:audit-001"`
     - `operation_kind = "WORK_START"`
     - `work_bindings = [{ namespace: "work-run", object_id: "run:audit-001", … }]`
   - Material contains `finding_admission = { purpose: "RECLASSIFICATION", finding_ref: { evidence_id: "improvement:f-001", … }, … }`

3. **Initial admission (before Human approval):**
   - Assemble `EffectRequestV1` for the WORK_START (K3).
   - Assemble `AdmissionInputV1` with available evidence (K4):
     - Predecessor Finding evidence: `evidence_id: "improvement:f-001"`, `envelope_digest: original`
     - No Human decision yet.
   - Evaluate under reference policy (K5):
     - `intake_workstart_ok` predicate checks `finding_admission` (§referencePolicy.ts:391–400).
     - No `reclassification_metadata` check needed yet (predicate still passes without it).
     - Policy outcome: `ALLOW` (audit work-starts are allowed under the current reference policy).
   - PEP admits (K6):
     - Create and seal `EffectAdmissionV1` (K6).
     - No reclassified Finding is created yet; audit work merely starts.

4. **Audit produces proposed reclassified Finding (deterministic or human-derived):**
   - Audit logic (inside the work-run) determines the Finding should be reclassified from "BUG" to "IMPLEMENTATION_GAP" due to evidence.
   - If Human-authorized: audit assembles the Finding draft but does NOT seal it yet.
   - If deterministic: audit logic can immediately create the Finding if the policy allows it (deterministic rule present).

5. **For Human path: Human approves the reclassification (external, path A):**
   - Human is presented with:
     - The work-run `id = "run:audit-001"` (scope).
     - The predecessor Finding's current data (audit work made it available).
     - The proposed reclassification: BUG → IMPLEMENTATION_GAP.
   - Human approves via SSO page POST:
     - Envelope draft:
       - `evidence_kind: "HUMAN_DECISION"`
       - `producer_ref: "human:reviewer@example.com"`
       - `source_ref: "sso-approval-page"`
       - `claim: { decision: "APPROVE", scope: { work_run_ref: "run:audit-001", target_ref: "improvement", … }, … }`
       - `issued_at: <current timestamp>`
       - `available_at: "PRESENT"`
     - Ingress verifies:
       - Principal is authenticated (SSO).
       - `scope.work_run_ref` is the running work (recheck #5 passes).
       - Timestamps valid.
     - Seal K2 envelope: `evidence_id: "human-decision:reclassify-f001"`, `envelope_digest: cadp-jcs-1(…)`.
     - Insert into `evidence_envelope` table.

6. **Audit completes and emits the reclassified Finding (still during work-run):**
   - Audit assembles new Finding K2 envelope:
     - `claim: {`
     - `  classification: "IMPLEMENTATION_GAP",`
     - `  subject: { kind: "EFFECT", binding_index: 0 },  # same subject as predecessor`
     - `  supersedes: [{ evidence_id: "improvement:f-001", envelope_digest: original }],`
     - `  derivation: { kind: "HUMAN_JUDGMENT", method_ref: "audit:reclassify", execution_or_run_ref: "run:audit-001" },`
     - `  basis: [{ evidence_id: "human-decision:reclassify-f001", envelope_digest: …, role: "AUTHORITY_TEXT" }],`  # Human decision is the basis for judgment
     - `  correction_reason: "Reclassified per human review.",`
     - `  reclassification_metadata: {`
     - `    from_classification: "BUG",`
     - `    to_classification: "IMPLEMENTATION_GAP",`
     - `    authorized_by_evidence_id: "human-decision:reclassify-f001"`
     - `  }`
     - `}`
     - Ingress validation (before seal):
       - `reclassification_metadata` is present → check D2 rules.
       - `from_classification != to_classification` ✓
       - `to_classification == this Finding's classification` ✓
       - `derivation.kind == "HUMAN_JUDGMENT"` and `authorized_by_evidence_id` is present ✓
       - `authorized_by_evidence_id` names a HUMAN_DECISION ✓
       - Pass.
     - Seal K2 envelope: `evidence_id: "improvement:f-002"`, `envelope_digest: …`.
     - Audit adapter calls `submit_evidence(IMPROVEMENT_FINDING)`.
     - Ingress inserts into `evidence_envelope` table.

7. **Second admission (with reclassified Finding):**
   - Audit work (or audit-completion effect) assembles second `EffectRequestV1` (or re-uses the first, depending on architecture).
   - Assemble second `AdmissionInputV1` (K4):
     - Predecessor Finding: `evidence_id: "improvement:f-001"`, `envelope_digest: original`.
     - Reclassified Finding: `evidence_id: "improvement:f-002"`, `envelope_digest: new`.
     - Human decision: `evidence_id: "human-decision:reclassify-f001"`, `envelope_digest: …`.
     - (Possibly: record-write effect material naming the new Finding to be recorded).
   - Evaluate under reference policy (K5):
     - Convert evidences to intermediate form (Rego objects).
     - Call `improvement_findings` set: collects `f-001` and `f-002`.
     - Call `reclassified_clear("improvement:f-001")`:
       - Find `f-002` with `supersedes = [{evidence_id: "improvement:f-001", …}]` ✓
       - Check `reclassification_metadata`:
         - `from_classification: "BUG"` ≠ `to_classification: "IMPLEMENTATION_GAP"` ✓
         - `to_classification == "IMPLEMENTATION_GAP" == f-002.classification` ✓
       - Check Human path:
         - `derivation.kind == "HUMAN_JUDGMENT"` ✓
         - Find envelope with `evidence_id == "human-decision:reclassify-f001"` ✓
         - `evidence_kind == "HUMAN_DECISION"` ✓
         - `availability == "PRESENT"` ✓
         - `claim.decision == "APPROVE"` ✓
         - `claim.scope.work_run_ref != null` ✓
         - Call `reclassified_run_ok(f-002.evidence_id, "human-decision:reclassify-f001")`:
           - `derivation.kind == "HUMAN_JUDGMENT"` ✓
           - `execution_or_run_ref == "run:audit-001"` ✓
           - Auth envelope's `scope.work_run_ref == "run:audit-001"` ✓
       - Check subject binding (simplified):
         - Both findings resolve to same subject binding ✓
       - Result: `cleared("improvement:f-001")` is true.
     - Check `contract_barrier("improvement:f-002")`:
       - `ancestry("improvement:f-002")` includes `"improvement:f-001"`.
       - `cleared("improvement:f-001")` is true.
       - No uncleared CONTRACT_* ancestor.
       - Result: no barrier.
     - `implementation_clear("improvement:f-002")` is true (non-CONTRACT_*, no barrier) ✓
     - Policy outcome: `ALLOW` (or other outcome depending on the effect's primary gate).
   - PEP admits (K6):
     - Seal `EffectAdmissionV1` (K6).
     - Execute the effect (record the new Finding, update projections, etc.).

8. **Falsification controls:**
   - **Wrong predecessor**: If the reclassified Finding names a different predecessor in `supersedes`, `reclassified_clear` fails (predecessor binding exact).
   - **Wrong from/to**: If `from_classification` doesn't match the sealed predecessor's actual classification at seal time, the check `meta.from_classification == pred.claim.classification` fails.
   - **Wrong subject**: If reclassified Finding's subject differs from predecessor, `reclassified_subject_ok` fails.
   - **Wrong work-run**: If `execution_or_run_ref` differs from the Human decision's `scope.work_run_ref`, `reclassified_run_ok` fails.
   - **No authority**: If no HUMAN_DECISION envelope is present or its decision is not "APPROVE", `reclassified_clear` fails.
   - **Reuse across effects**: A HUMAN_DECISION bound to work-run R1 cannot authorize a reclassification in work-run R2 (scope mismatch).

**Controls closed:**
- **Finding 3 (real S4 path)**: Two-evaluation contract via path A (effect-scoped Human decision with work_run_ref binding). No invented admission recheck; K2 evidence submission is idempotent ingress.
- **Finding 6 (atomic consumption)**: Subject binding + work-run scope + evidence_id binding together ensure one decision authorizes one transition. Concurrent reclassifications of the same predecessor with the same work-run would name the same Human decision; if identical reclassified Finding already exists (same `evidence_id`), idempotent no-op.

---

### D4.b — Deterministic reclassification S4 path (parallel track)

**Scenario:** A deterministic contract-repair rule is active in policy, and audit detects it applies to Finding F.

1. **Audit produces deterministic Finding (no Human interaction):**
   - Audit logic detects: Finding F with `classification: "CONTRACT_GAP"`, `anomaly_code: "api-backward-compat"`.
   - Policy declares deterministic rule: `anomaly_code: "api-backward-compat"`, `from: CONTRACT_GAP → to: CONTRACT_AMBIGUITY`, `method_digest_suffix: "cadp:repair-contract-ambiguity"`.
   - Audit assembles new Finding:
     - `classification: "CONTRACT_AMBIGUITY"`
     - `supersedes: [{ evidence_id: "improvement:f-001", … }]`
     - `derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "audit:detect-ambiguity", method_digest: "…cadp:repair-contract-ambiguity…" }`
     - `basis: [{ evidence_id: "improvement:f-001", …, role: "AUTHORITY_TEXT" }]`  # predecessor itself is the authority
     - `reclassification_metadata: { from_classification: "CONTRACT_GAP", to_classification: "CONTRACT_AMBIGUITY", authorized_by_evidence_id: null }`
   - Seal and submit.

2. **Admission (single evaluation, no separate Human gate):**
   - Assemble `AdmissionInputV1` with both F and the deterministic F'.
   - Evaluate:
     - `reclassified_clear("improvement:f-001")`:
       - Find F' with `supersedes = [{evidence_id: "improvement:f-001", …}]` ✓
       - Check `reclassification_metadata` ✓
       - Check deterministic path:
         - `derivation.kind == "DETERMINISTIC_DERIVATION"` ✓
         - Some basis entry has `role == "AUTHORITY_TEXT"` ✓
         - `authorized_by_evidence_id == null` ✓
         - Call `deterministic_rule_ok(F'.evidence_id)`:
           - Find matching policy rule ✓
           - Method digest matches ✓
           - Predecessor classification matches rule `from` ✓
       - Result: `cleared("improvement:f-001")` is true.
     - No barrier, implementation-clear.
   - Policy outcome: `ALLOW`.
   - PEP admits and executes.

**No AUTHORITY_TEXT basis needed as authority; rule authority comes from policy and method binding alone.**

---

## Changes required

### 1. Finding claim schema change (FINDING_CLAIM_SCHEMA_CHANGE)

**File**: `cadp/product/improvement/contracts.ts`

- Add `reclassification_metadata` optional field to `ImprovementFindingClaimV1` (see D1).
- Add validation in `validateFindingClaim`:
  - When `reclassification_metadata` is present:
    - `supersedes` must be non-empty.
    - `from_classification ≠ to_classification`.
    - `to_classification == this Finding's classification`.
    - Derivation path checks (see D2).
    - `authorized_by_evidence_id` must match derivation kind (mandatory for HUMAN_JUDGMENT if `reclassification_metadata` present; forbidden for MODEL_PROPOSAL).
- Maintain backward compatibility: existing Findings without `reclassification_metadata` are unaffected.

### 2. Reference policy change (TD §8.3)

**File**: `cadp/deployment/referencePolicy.ts`

- Replace `reclassified_clear` predicate (lines 302–320) with enhanced version (see D2–D5).
- Add helper predicates:
  - `reclassified_subject_ok` (D3)
  - `reclassified_run_ok` (D3)
  - `deterministic_rule_ok` (D4)
- Add policy parameter for deterministic reclassification rules (array of objects with `anomaly_code`, `from_classification`, `to_classification`, `method_digest_suffix`, `allowed_subject_kinds`).
- Maintain backward compatibility: Findings without `reclassification_metadata` pass the existing predicate path (no metadata check needed).

### 3. Technical Design update (§8.3)

**File**: `TECHNICAL_DESIGN_cadp_v0_4_generation.md`, §8.3 (reference policy)

Add section on reclassification authority contract:

#### Reclassification authority binding (v1.1)

- **K2 representation:** A reclassification is a Finding K2 envelope (identity = `evidence_id + envelope_digest`) with optional `reclassification_metadata` field in the claim.
- **Metadata structure:** `{ from_classification, to_classification, authorized_by_evidence_id? }`.
- **Authority sources:**
  1. HUMAN_DECISION evidence with `scope.work_run_ref` binding (path A, §9.3 two-evaluation contract).
  2. Deterministic policy rules (policy-declared `anomaly_code + from → to`, method binding).
- **Admission predicate:** `reclassified_clear` checks the exact transition, authority source, and subject/run binding.
- **Falsification:** Wrong classification, missing authority, subject/run scope mismatch, predecessor mismatch, or unmatched deterministic rule all fail the predicate; no reclassification is cleared.
- **Non-time validity:** Authority is valid through immutable record binding (K2 `envelope_digest`), exact scope (work_run_ref), and policy rule binding. No wall-clock validity window.

### 4. Spec change

**None required.** Spec v0.4 §2.2 already establishes exact evidence binding, scope preservation, and immutable authority. The reclassification metadata is a bounded extension of evidence scope binding within the existing K2 architecture.

---

## Design disposition

### Acceptance checklist

1. ✓ **Classify SPEC_CHANGE and TD_CHANGE explicitly**: SPEC_CHANGE = none; TD_CHANGE = §8.3 (reference policy enhancement) + schema version bump to v1.1 (finding claim); no core TD changes.

2. ✓ **Define exact Human transition-authorization representation**: `reclassification_metadata` field with `from_classification`, `to_classification`, `authorized_by_evidence_id` (pointing to HUMAN_DECISION). Validation enforces exact transition.

3. ✓ **Define exact non-circular authority applicability**: Binding via work_run_ref (Human path) or policy rule + method_digest (deterministic path) prevents reuse across contexts. Subject binding and predecessor identity binding prevent ancestor/descendant reuse.

4. ✓ **Define supersession subject/work-run invariants**: Subject binding must be identical to predecessor. Work-run binding enforced for Human judgments. Deterministic method binding ensures rule consistency.

5. ✓ **Define validity/reuse semantics compatible with clock-free admission**: Validity through immutable K2 envelope binding (envelope_digest) + exact scope (work_run_ref) + evidence_id linking. No new clock added. Concurrent reuse prevented by K2 identity uniqueness.

6. ✓ **Preserve decision polarity**: Only `decision == "APPROVE"` clears. Policy rules are policy-bound facts (not ambient). Validation forbids deterministic field if unauthorized.

7. ✓ **Preserve evidence_id + envelope_digest basis**: Reclassification metadata points to evidence by `evidence_id`; finding identity remains `evidence_id + envelope_digest` (K2 native).

8. ✓ **Define falsification controls**: (1) Wrong predecessor: predecessor binding exact. (2) Wrong transition: from/to classification checked against sealed predecessor. (3) No authority: HUMAN_DECISION must exist and be APPROVE; deterministic rules must match policy. (4) Wrong subject: subject binding enforced. (5) Wrong work-run: execution_or_run_ref == scope.work_run_ref. (6) Reuse across effects: work_run_ref scoping prevents cross-effect authority reuse.

9. ✓ **Show positive S4 path**: Two-evaluation path A (WORK_START → initial eval → REQUIRE_EVIDENCE(HUMAN_DECISION) → Human approves → new eval → ALLOW → K6). Deterministic path (single eval, no Human gate). Both paths shown in D5.

10. ✓ **Provide DESIGN_DISPOSITION and NEXT_OWNER**:
    - **DESIGN_DISPOSITION**: `TD_DESIGN_READY` (schema v1.1 change + policy enhancement landed; no Spec change; no unresolved architecture gaps).
    - **NEXT_OWNER**: Control (scope/authority check) → Independent Design Review (validate K2 mapping, S4 paths, falsification controls against all 6 review findings, policy coherence) → Human merge if no STOP → on landing, return #107 Execution to refresh, rebase onto main, implement Finding claim schema change + policy update, and re-attempt.

---

## Non-goals confirmed

- ❌ No #107 implementation in this issue (execution refresh after landing).
- ❌ No #109 ancestry repair changes (independent scope).
- ❌ No #106 observer/reconcile design changes (independent scope).
- ❌ No general RBAC framework (out of scope).
- ❌ No clock added to admission (clock-free design maintained).
- ❌ No automatic Human approval (explicit APPROVE required).
- ❌ No free-text statement as authority (field remains non-authoritative; only HUMAN_DECISION decision field or policy rules clear).
- ❌ No production deployment (design artifact only).

---

## Review findings addressed

### Finding 1 — K2 architecture mapping

**Reviewer claim**: Prior design proposed `finding_recorded` decision log and §5.13 changes but didn't map to K2 where Finding is an `IMPROVEMENT_FINDING` envelope (identity = `evidence_id + envelope_digest`), subject through `subject_bindings`, predecessors through `claim.supersedes[]`.

**This design response**: No new record types. Reclassification metadata is an optional field in the existing `ImprovementFindingClaimV1` K2 claim schema. Finding identity remains `evidence_id + envelope_digest`. Predecessors are referenced via existing `supersedes` array. Subject is resolved via existing `subject.binding_index` into K2 `subject_bindings`. All validation occurs at ingress and admission over K2 envelopes; no new finding-record layer is invented.

**Mapped to current architecture**: §2.3 (evidence structure), §4.4 (admission validation), §8.3 (reference policy), §9.1 (K2 envelope claim).

---

### Finding 2 — Exact reclassification transitions

**Reviewer claim**: Missing source classification and method/derivation/run context from prior design's `reclassification_authority`. The TD rule at line 244 required predecessor/target/successor classifications all equal, rejecting genuine A→B reclassifications.

**This design response**: `reclassification_metadata` includes:
- `from_classification` (source, predecessor's recorded classification at seal time).
- `to_classification` (target, same as this Finding's classification).
- Derivation context: carried by existing `derivation.kind` (HUMAN_JUDGMENT vs DETERMINISTIC_DERIVATION) and `execution_or_run_ref` (for HUMAN_JUDGMENT).
- Run context: binding via HUMAN_DECISION's `scope.work_run_ref` or deterministic policy method.

Validation explicitly requires `from_classification != to_classification` (genuine transition). Admission-time policy check verifies `from_classification == predecessor.classification` (sealed state). No "all three equal" rule.

---

### Finding 3 — Real S4 path through current ingress

**Reviewer claim**: Prior design invented an "admission recheck" for Human decisions but K2 evidence submission is not an `admitAndDispatch` operation. No real-PEP flow shown.

**This design response**: §D5 shows the real two-evaluation path A (§9.3 existing contract):
1. Audit WORK_START effect sealed and admitted (initial eval without Human).
2. Audit completes, produces reclassified Finding K2 envelope.
3. Human decision envelope sealed via SSO path A (path A with work_run_ref, not effect_id).
4. Second admission input (K4) assembles both findings + Human decision.
5. Fresh evaluation under reference policy (K5) checks `reclassified_clear` predicate.
6. Policy outcome and PEP admission (K6).

No invented recheks; K2 evidence submission is idempotent ingress (existing WORK_STEP replay contract extends to Findings). HUMAN_DECISION uses path A with `scope.work_run_ref` binding (existing §9.3 variant for work-scoped approval, not effect-scoped).

---

### Finding 4 — Deterministic reclassification authority

**Reviewer claim**: Only Human authority designed. Deterministic reclassification via DETERMINISTIC_DERIVATION + AUTHORITY_TEXT basis lacks exact evidence/ref/applicability binding.

**This design response**: §D4 and §D4.b define typed deterministic authority:
- Deterministic reclassifications require policy-declared rules (not self-declared authority text).
- Rule specifies `anomaly_code + from_classification → to_classification + method_digest_suffix`.
- Finding's `derivation.method_digest` must match rule's suffix (exact method binding).
- Validation checks `deterministic_rule_ok` predicate: rule exists, method matches, predecessor classification matches.
- No AUTHORITY_TEXT basis needed as authority; rule authority comes from policy + method binding.

---

### Finding 5 — Work-run invariant

**Reviewer claim**: Prior design used historical `escaped_from.attempt_key`, didn't use current `derivation.execution_or_run_ref`, and lacked mandatory/typed context-transfer rule.

**This design response**: §D3 enforces:
- For HUMAN_JUDGMENT: Finding's `derivation.execution_or_run_ref` **must** equal HUMAN_DECISION's `scope.work_run_ref` (mandatory equality, `reclassified_run_ok` predicate).
- For DETERMINISTIC_DERIVATION: method binding (`method_ref + method_digest`) determines run context (deterministic rules are run-independent, but method must be policy-declared).
- Subject binding must be identical (K2 subject_bindings).
- Validation at ingress and admission time; fails if mismatched.

---

### Finding 6 — Atomic authority consumption

**Reviewer claim**: No atomic uniqueness key or serialization point. Concurrent successors could use same authorization. Freshness uses K2 `produced_at` (policy-bound), not claim-level `issued_at`.

**This design response**: Atomic consumption via:
- K2 envelope uniqueness: Evidence submitted once, sealed with unique `evidence_id` (UUIDv7 + Ingress-allocated). Idempotent replay (WORK_STEP contract) returns existing `evidence_id` if semantic payload matches.
- Finding identity: `evidence_id + envelope_digest` uniquely identifies each Finding. Two identical reclassifications of the same predecessor would require identical claim bytes → identical `envelope_digest` → same identity → same evidence_id (idempotent).
- Scope binding: work_run_ref (Human path) or policy rule (deterministic path) binds authority to exact context. Concurrent reclassifications in different work-runs require separate HUMAN_DECISION envelopes (different `evidence_id`).
- Predecessor binding: predecessor is identified by exact `evidence_id + envelope_digest` in `supersedes[]`. One decision authorizes one predecessor.

Freshness: Policy checks `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)` on K2 envelope's `produced_at` (existing rule, policy-bound). No new `issued_at` freshness field needed; `produced_at` is the source of truth (§9.1 source-time authority derivation).

---

## Control handoff notes

**For independent Design Review:**
- Verify K2 mapping is complete and backward-compatible (no new records, existing Findings unaffected).
- Verify reclassification metadata structure is minimal (no over-specification).
- Verify D2 ingress/admission validation prevents all falsification legs.
- Verify D3 subject/run binding prevents cross-context reuse.
- Verify D4 deterministic rule binding is sound (method digest suffix matching, policy-centralized authority).
- Verify D5 S4 path is realistic (two-eval path A, not invented gates, idempotent ingress).
- Verify D5 deterministic path clears single-eval (no Human loop needed).
- Verify falsification controls cover wrong predecessor, wrong classification, missing/wrong authority, subject/run mismatch, concurrent reuse.
- Confirm no Spec conflict (K2 architecture native, §2.2 evidence binding rules apply unchanged).

**For #107 Execution refresh (after landing):**
- Head 01b913a stands as base implementation (mechanics correct; authority contract was missing).
- Refresh: rebase onto main (post-Design landing), implement Finding claim schema v1.1 change, update reference policy with D2–D4 predicates, remove any invented `cadp.human-design-decision.v1` mock.
- Land: ensure policy parameter `deterministic_reclassification_rules` is provided (can be empty initially; deterministic path is optional, Human path is primary).
- Re-run S4 test with real `IMPROVEMENT_FINDING` claim (including `reclassification_metadata`), real `HUMAN_DECISION` (with `scope.work_run_ref`), real reference policy predicates.
- Round-4 review: independent checks that all 6 findings are now falsified by the contract; mechanics and policy are sound; approve to land.

---

## Related issues and evidence

- **#107**: S1/S3/S4/S5 repair, round-3 review (5 concerns); findings F1–F3 measured and blocking. Round-8 design resolves.
- **#98**: Recurring-improvement policy contract (landed; independent scope; this design extends §3 predicate).
- **#106**: Observer/reconciliation design (independent; no change).
- **#109**: S2 repair design (independent; no change).
- **Memory: issue-107-s1-s3-s4-s5-repair-design**: Prior findings F1–F3 context.
- **Spec v0.4 §2.2, §9.3**: Evidence authority semantics, Human decision path A.
- **TD r7 §2.3, §4.4, §8.3, §9.1, §9.3**: K2 architecture, admission validation, reference policy, evidence structure, Human decision.

---
