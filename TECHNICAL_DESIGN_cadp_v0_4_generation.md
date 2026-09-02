# Common Autonomous Development Platform — Technical Design v2.0 (v0.4 generation) — CANDIDATE

| Field | Value |
|---|---|
| Status | **TD CANDIDATE while unmerged; v0.4-generation TD authority upon independent Review + Human merge** |
| Generation | `TD v2.0` — first Technical Design of the **v0.4 execution generation**. Not a revision of TD v1.5. |
| Spec authority | `Common Autonomous Development Platform — Specification v0.4` — blob `01ce0e787f7a6dcf283dc3e7bdacbced8c265201` |
| Canonical main at design time | `e531f030cd923523d831b74f9f60c21b30165210` |
| Design issue / control | #94 / #65 |
| Source Spec Design / landed PR | #92 / #93 |
| Measured design inputs | #89 `issuecomment-5507827981` + matrix `5507814549`; #90 `issuecomment-5508002386`; #91 `issuecomment-5508009180`; Control syncs `5507911324`, `5508030417`, `5508032252` |
| Old-generation evidence | `TECHNICAL_DESIGN_autonomous_development_platform.md` (TD v1.5, blob `95af9e73c5c526e0bed6254482dce1047b906510`), Spec v0.3, Route-A/OpenClaw, fixed-point implementation — **HISTORICAL_OLD_GENERATION**, not architecture authority |
| Production implementation | **NOT AUTHORIZED** by this document |

이 문서는 landed Spec v0.4의 K1–K7 constitutional kernel과 §8.2 autonomous-work product outcome을 구현 가능한 수준으로 닫는 최소 Technical Design이다.

이 문서는 다음을 하지 않는다.

- TD v1.5의 Task/Attempt/Project Profile/Supervisor/Actor/Auditor/lifecycle을 v0.4에 이식하지 않는다.
- workflow state를 constitutional authority로 만들지 않는다.
- policy evaluator output을 permit으로 만들지 않는다.
- production TypeScript, OpenClaw, durable-jobs를 수정하지 않는다.

TD가 소유하는 것은 Spec이 commoditize하지 않은 **네 가지 측정된 irreducible 경계**(#89 `CADP_SURVIVING_KERNEL`)와 그것을 durable하게 만드는 최소 machinery뿐이다.

```text
1. one decision bound to ONE exact effect identity + an enforcement point that refuses any other effect
2. an effect-identity ledger written BEFORE the external call, reconciled against a target-authoritative read
3. evidence bound to the artifact it was executed against, not merely labelled with its id
4. custody of every governed mutating credential outside every worker/reviewer/verifier/workflow context
```

---

## 0. Reading guide and terminology

| Term | Meaning in this TD |
|---|---|
| **Kernel Service** | 이 TD가 소유하는 하나의 deployable unit. PEP, effect/evidence ingress, admission assembler, decision sealer, reconciler, constitutional store access를 포함한다. 한 process에 co-locate되지만 §3의 authority는 합쳐지지 않는다. |
| **PEP** | Kernel Service 안에서 governed credential을 보유하고 `EffectAdmissionV1`을 쓰고 dispatch하는 유일한 component. |
| **Ingress** | Kernel Service의 write API. `EffectRequestV1`, `EvidenceEnvelopeV1`, `AdmissionInputV1`를 봉인(seal)한다. Seal = identity allocation + canonicalization + digest + store insert. |
| **Constitutional Store** | K1–K7 record와 activation log, CAS material만 보관하는 durable store. workflow state는 절대 여기에 없다. |
| **Commodity** | Spec §8이 kernel 밖으로 둔 모든 것. 이 TD의 reference composition에서는 OPA, Temporal, codex-cli/Claude Code, GitHub/Actions, 그리고 #89 Vertical B record service. |
| **Work run** | §8.2 product 층에서 `WORK_START` governed effect로 시작된 하나의 bounded autonomous work. identity = 그 effect의 `effect_id`. kernel primitive가 아니다. |

모든 identifier는 `namespace:kind:value` 형태의 opaque string이다. `authority_ref`는 identity를 발급한 authority(예: `github.com`, `temporal:cadp-v04`, `cadp-store:k04`)를 가리킨다.

---

## 1. K1–K7 → implementation ownership map (Acceptance §2)

| Primitive | Who allocates identity | Who computes digest | Durable representation | Mutability | Commodity involvement |
|---|---|---|---|---|---|
| K1 `PolicyRefV1` | root authority (genesis) 또는 `POLICY_ACTIVATE` effect (§9) | Ingress: `content_digest` over OPA bundle bytes (`raw-bytes-1`) | `policy_ref` table + `policy_activation` append-only log; bundle bytes in CAS | immutable; activation is a new log row | OPA bundle **is** the policy content; OPA never writes this table |
| K2 `EvidenceEnvelopeV1` | Ingress (`evidence_id` UUIDv7) | Ingress: `claim_digest`, `envelope_digest` (`cadp-jcs-1`) | `evidence_envelope` table; large claim in CAS by `claim_digest` | immutable | adapters (CI, review, backend, Human UI, target reconciler) submit drafts; Ingress stamps producer/integrity from authenticated identity |
| K3 `EffectRequestV1` | Ingress (`effect_id` UUIDv7, sealed; requester correlation → idempotent allocation key, §7.4) | Ingress: `material_digest` over material bytes, `request_digest` | `effect_request` table (PK `effect_id`); material bytes in CAS | immutable; second insert with different `request_digest` = conflict incident | worker/workflow propose material only |
| K4 `AdmissionInputV1` | Ingress (`input_digest` is the identity) | Ingress | `admission_input` table (PK `input_digest`) | immutable | orchestrator asks Ingress to assemble; never assembles itself |
| K5 `PolicyDecisionV1` | Decision Sealer (`decision_id` UUIDv7) | Sealer: `decision_digest` | `policy_decision` table | immutable; evaluator failure produces **no** decision | OPA computes outcome/reasons/constraints; Sealer binds evaluator identity/integrity |
| K6 `EffectAdmissionV1` | PEP (`admission_id` UUIDv7) | PEP: `admission_digest` | `effect_admission` table, `UNIQUE(effect_id, dispatch_ordinal)` — the row **is** the reservation | immutable | none. Written before any external call |
| K7 `EffectOutcomeV1` | PEP / Reconciler (`outcome_id` UUIDv7) | PEP/Reconciler | `effect_outcome` table, append-only, many per admission | append-only; `UNKNOWN` never deleted | target adapters return observations; only PEP/Reconciler may insert |

Seven records, one store, one writer process (the Kernel Service). No Task/Attempt/Project/Batch/Grant table exists in the Constitutional Store.

---

## 2. D1 — Constitutional record representation

### 2.1 Canonical serialization

- Wire and storage form: JSON (UTF-8).
- Canonicalization scheme `cadp-jcs-1` = RFC 8785 JSON Canonicalization Scheme with two additional rules: (a) the record's own digest field (`envelope_digest`, `request_digest`, `input_digest`, `decision_digest`, `admission_digest`, `outcome_digest`) is **omitted** before canonicalization; (b) every timestamp is RFC 3339 UTC with millisecond precision and `Z` suffix.
- Raw byte content (policy bundle, material bytes, claim payload > inline limit) uses scheme `raw-bytes-1` = the bytes as stored, no transformation.
- Digest object is always `{ algorithm, canonicalization, value }`. Approved in this generation: `algorithm = sha256`, `canonicalization ∈ { cadp-jcs-1, raw-bytes-1 }`, `value` = lowercase hex.
- The approved-scheme set is **policy-bound configuration**: it is carried inside the genesis policy bundle as `data.cadp.approved_digest_schemes` and re-read from the active `PolicyRefV1` content. A digest with an unapproved scheme is invalid input, never a different-but-equal identity.

### 2.2 Identity allocation

| Identity | Allocator | Format | Rule |
|---|---|---|---|
| `effect_id` | Ingress | `cadp-v04:effect:<uuidv7>` | requester never chooses it. A requester-supplied `allocation_key` (§7.4) maps idempotently to one `effect_id` in `effect_allocation(allocation_key PK, effect_id)`. |
| `evidence_id` | Ingress | `cadp-v04:evidence:<uuidv7>` | source-side ids (run id, review id) live inside `source_ref`/`execution_or_run_ref`, never replace `evidence_id`. |
| `decision_id`, `admission_id`, `outcome_id` | Sealer / PEP / Reconciler | `cadp-v04:<kind>:<uuidv7>` | |
| `policy_id` | root authority | `cadp-v04:policy:<name>` | `revision` = monotonically increasing integer per `policy_id`; `content_digest` identifies content. Alias `active` is resolved only through the activation log (§3.3). |
| `input_digest` | Ingress | digest | `AdmissionInputV1` is content-addressed; identical inputs collapse to one row. |

UUIDv7 is chosen for monotonic insertion locality; uniqueness is enforced by the store, not by the generator.

### 2.3 Content-addressed material and evidence references

- `material_ref` and large `claim` references are `cas://sha256/<hex>`. The CAS is the `cas_blob(digest PK, bytes, size, created_at)` table in the Constitutional Store (reference), replaceable by object storage with the same key contract.
- CAS writes are insert-only and verify `sha256(bytes) == key` on write **and on every read**. A mismatch on read is a corruption incident (§2.6).
- Inline limit: `claim` ≤ 64 KiB inline in the envelope row; larger claims are CAS-only with `claim_digest` in the row. `material` is always CAS (never inline) so that `EffectRequestV1` rows stay small and the PEP always re-reads bytes by digest at dispatch.

### 2.4 Append-only vs replaceable

There are **no replaceable fields** in any K1–K7 record. Every record is written once. State that changes over time is expressed only by appending new records:

| Changing fact | Expressed as |
|---|---|
| active policy | new `policy_activation` row |
| new evidence about the same subject | new `EvidenceEnvelopeV1` |
| new attempt at the same logical effect | new `EffectAdmissionV1` with next `dispatch_ordinal` |
| new observation about an effect | new `EffectOutcomeV1` |
| new information for the same effect request | new `AdmissionInputV1` + new `PolicyDecisionV1` (the request itself is unchanged) |
| changed material/target | **new `EffectRequestV1` with new `effect_id`** (§6.2 of Spec) |

The Kernel Service's database role has `INSERT` and `SELECT` only on all constitutional tables. `UPDATE`/`DELETE` are not granted to any runtime role. Retention/archival is a root operation (§9.5) and produces its own signed evidence.

### 2.5 Validation

On every write, in order:

1. JSON Schema validation against the versioned schema (`schemas/k1..k7.v1.json`, embedded in the Kernel Service build and digested; schema digest recorded in `pep_ref`).
2. Digest scheme approval check (§2.1).
3. Recompute every digest the record carries and compare byte-for-byte.
4. Referential integrity: every `*_ref` + `*_digest` pair must resolve to an existing row **whose stored digest equals the referenced digest**. Dangling or mismatched references are rejected.
5. Kind-specific invariants (e.g., `availability=UNKNOWN` ⇒ `claim` and `claim_digest` absent, `unknown_reason` present; `single_dispatch = true`).

On every read used for admission, steps 3–4 are repeated ("verify-on-read"). The store is not trusted to be uncorrupted; the PEP proves it at commit time.

### 2.6 Corruption and conflict handling

No new primitive is introduced. A fail-closed safety event (Spec §6.4) is recorded as an `EvidenceEnvelopeV1`:

```text
evidence_kind      = KERNEL_INCIDENT
claim_schema       = cadp.incident.v1
claim              = { incident_kind, detail, offending_refs[] }
subject_bindings   = every effect_id / evidence_id / admission_digest involved
producer_ref       = the Kernel Service instance (pep_ref)
provenance         = { INDEPENDENT_OBSERVATION, AUTHENTICATED_SOURCE }
```

`incident_kind ∈ { REQUEST_DIGEST_CONFLICT, ADMISSIONLESS_COMMIT_OBSERVED, RECEIPT_MATERIAL_MISMATCH, DIGEST_CORRUPTION, ALTERNATE_CREDENTIAL_PATH, OUTCOME_CONTRADICTION, EVALUATOR_INTEGRITY_FAILURE, UNSUPPORTED_CONSTRAINT }`.

**Scope hold rule (kernel-enforced):** the PEP refuses any new `EffectAdmissionV1` whose `effect_id`, `target_ref` or `work_bindings` intersect the `subject_bindings` of a `KERNEL_INCIDENT` envelope that has no later `INCIDENT_RELEASE` envelope signed under §9.4. Incident UI, paging, and triage workflow are commodity.

---

## 3. D2 — Durable record store and atomicity

### 3.1 Store choice

- Reference: **PostgreSQL 16**, schema `k04`, single logical database for one deployment namespace. Single-host development/conformance harness: **SQLite** with the identical DDL subset (WAL mode, `BEGIN IMMEDIATE`). Both are commodity databases; the store contract below is what matters, and any store providing it is acceptable.
- Required store contract: (a) transactional insert with unique-constraint enforcement; (b) per-row exclusive lock (`SELECT … FOR UPDATE`) or an equivalent single-writer primitive per `effect_id`; (c) durable commit before acknowledgement (`synchronous_commit = on`); (d) no runtime `UPDATE`/`DELETE` privilege.

### 3.2 Tables (constitutional only)

```text
policy_ref            (policy_id, revision) PK, content_digest, issuer_ref, bundle_cas_key
policy_activation     seq PK (bigserial), policy_id, revision, content_digest,
                      activated_by_ref, activation_evidence_id, activated_at        -- append-only
evidence_envelope     evidence_id PK, envelope_digest UNIQUE, envelope_json(jsonb), subject index
effect_allocation     allocation_key PK, effect_id UNIQUE
effect_request        effect_id PK, request_digest UNIQUE, request_json, material_cas_key
admission_input       input_digest PK, effect_id FK, policy_id, revision, input_json
policy_decision       decision_id PK, decision_digest UNIQUE, admission_input_digest FK, outcome, not_after, decision_json
effect_admission      admission_id PK, admission_digest UNIQUE,
                      (effect_id, dispatch_ordinal) UNIQUE, effect_request_digest, policy_decision_ref, admission_json
effect_outcome        outcome_id PK, outcome_digest UNIQUE, effect_id, admission_digest FK, result, observed_at, outcome_json
cas_blob              digest_key PK, bytes, size, created_at
```

Every `*_json` column stores the canonical JSON so that re-digesting the column reproduces the stored digest.

### 3.3 Settled semantics

| Question (#94 D2) | Answer |
|---|---|
| PolicyRef activation / genesis | `policy_activation` is append-only; the **active** policy is the row with the highest `seq`. Genesis is `seq = 1`, `activated_by_ref = root key id`, `activation_evidence_id` → the signed `GENESIS` envelope (§9.4). Every later row references either an `EffectOutcomeV1(COMMITTED)` of a `POLICY_ACTIVATE` effect or a signed root/break-glass envelope (§9.4). |
| EffectRequest identity uniqueness | `effect_request.effect_id` PK. Insert of an existing `effect_id`: if `request_digest` equals the stored one → idempotent no-op (returns stored row); if it differs → insert rejected, `REQUEST_DIGEST_CONFLICT` incident written, scope hold. |
| AdmissionInput / PolicyDecision exact binding | `policy_decision.admission_input_digest` FK → `admission_input.input_digest`; `admission_input.effect_request_digest` must equal `effect_request.request_digest` of the referenced `effect_id` (verified on write and on read). |
| Atomic `(effect_id, dispatch_ordinal)` reservation + admission write | One transaction (§3.4). The unique constraint on `(effect_id, dispatch_ordinal)` makes the admission row itself the reservation; no separate reservation table. |
| Append-only EffectOutcome | insert-only; several outcomes per admission are expected (`UNKNOWN` at timeout, later `COMMITTED` from reconciliation). The **conclusive** outcome of an admission is: any `COMMITTED` or `NO_EFFECT_CONFIRMED` row for that `admission_digest`; contradiction (both present) = `OUTCOME_CONTRADICTION` incident. |
| Restart reads | On start the Kernel Service (a) verifies-on-read the active policy row and bundle bytes; (b) enumerates admissions with no conclusive outcome → hands each to the Reconciler (§6.5); (c) holds all new admissions for scopes with open incidents. No process-memory state is consulted. |
| Conflict detection | Unique constraints + verify-on-read + Spec §6.4 rules mapped to incident kinds (§2.6). |
| Transaction/CAS requirements | §3.1(a)–(d), §2.3. CAS = content-addressed blob store; "CAS" in the compare-and-set sense is provided by the unique constraint + row lock, not by an application-level version field. |

### 3.4 Admission transaction (the constitutional effect gate, Spec §5.2)

```text
BEGIN (SERIALIZABLE on PostgreSQL; BEGIN IMMEDIATE on SQLite)
  SELECT effect_request WHERE effect_id = ? FOR UPDATE           -- per-effect mutex
  read + verify-on-read: request, admission_input, policy_decision, referenced evidence, active policy row
  fresh recheck (§4.4 list) entirely from rows read inside this transaction
  determine next dispatch_ordinal:
      prev = max(dispatch_ordinal) for effect_id, or none
      allowed iff prev is none
              or conclusive(prev) = NO_EFFECT_CONFIRMED
              or adapter.describe().idempotency = NATIVE_KEY proven for this target_type (§6.2)
      else abort (reason PRIOR_DISPATCH_UNRESOLVED)
  INSERT effect_admission (…, dispatch_ordinal = prev+1 or 1, prior_admission_ref = prev admission)
COMMIT
```

Only after `COMMIT` returns does the PEP touch material bytes for dispatch. Two concurrent PEP instances (or one instance racing its own restart) cannot both succeed: the row lock serializes them and the unique constraint rejects the loser. The loser reports `ADMISSION_LOST_RACE` to the orchestrator, which must re-read the store rather than retry blindly.

---

## 4. D3 — PEP topology and credential isolation

### 4.1 Process and identity topology

```text
┌──────────────────────── kernel pod / host ────────────────────────┐
│  cadp-kernel   (workload identity: spiffe://…/cadp/pep)           │
│    ├─ Ingress / Assembler / Sealer / PEP / Reconciler (one binary)│
│    ├─ target adapters (in-process, loaded by digest)              │
│    └─ unix socket ──► opa sidecar (bundle = active policy content)│
│  secrets: mounted ONLY here, from secret-manager path              │
│           secret/cadp-v04/pep/*   (ACL: pep identity only)        │
└───────────────────────────────────────────────────────────────────┘
        ▲ HTTPS (mTLS or IdP-signed JWT), API-only               ▲ dispatch
        │                                                          ▼
┌── temporal server ──┐  ┌── worker pods (spiffe://…/cadp/worker/*) ──┐  ┌── governed targets ──┐
│ namespace cadp-v04  │  │ codex-cli / Claude Code / CI runners        │  │ GitHub repo, record  │
│ workflow state only │  │ NO secret mount; egress to targets DENIED   │  │ service, temporal    │
└─────────────────────┘  └─────────────────────────────────────────────┘  └──────────────────────┘
```

- **Credential owner:** the `cadp-kernel` process, and only it, reads governed credentials (GitHub App installation token or fine-grained PAT scoped to the governed repositories; record-service API key; Temporal namespace client cert for `WORK_START`). Credentials are never serialized into any K1–K7 record, Temporal payload, log, or environment of another process.
- **Isolation is enforced by deployment mechanism, not by label:** (1) secret-manager ACL binds the secret path to the PEP workload identity; (2) network policy denies worker/reviewer/verifier/Temporal-worker egress to every governed target host (the #89 A1 measurement — `gh` → `http 000` — is the required observable); (3) GitHub branch protection on governed repositories requires the PEP App as the only pusher/merger of governed refs; (4) CI workflows run with `permissions: contents: read` and no repository secrets; (5) worker sandboxes run with the network denied except the Kernel API endpoint.

### 4.2 Proof of actual target identity

The PEP proves, not assumes, what its credential reaches:

- On credential load and at most every `identity_probe_max_age` (policy-bound; reference 10 min), each target adapter's `prove_identity(credential)` performs a **read-only** target-native self-identification and returns a `TargetIdentityClaim` — GitHub: `GET /user` (or `/app`), `GET /repos/{owner}/{repo}` → `{account_id, repo_id, permissions}`; record service: `GET /whoami` → `{tenant, principal}`; Temporal: `DescribeNamespace` → `{namespace_id}`.
- The claim is sealed as `EvidenceEnvelopeV1(evidence_kind = PEP_TARGET_IDENTITY, provenance = {TARGET_AUTHORITY_OBSERVATION, AUTHENTICATED_SOURCE})` with `subject_bindings` = the proven `target_ref`. Policy may require it in `evidence_refs`; independently of policy, the PEP fresh recheck (§4.4) refuses admission unless the most recent `PEP_TARGET_IDENTITY` envelope for `target_ref` is within `identity_probe_max_age` and its claim matches `target_ref.target_id` (repo id / tenant, not the human-readable name).
- Caller-supplied target text is compared to the proven id; a name that resolves to a different id is `TARGET_MISMATCH`.

### 4.3 Bounded capability representation

- **Reference: directly consumed.** `bounded_capability` is a record inside `EffectAdmissionV1`, not a bearer token. The PEP performs the dispatch in-process through the adapter with its own held credential immediately after the admission commit. Nothing leaves the PEP.
- **Alternative (not reference, deferred contract):** out-of-process adapters would require a one-time, `admission_digest`-bound, short-lived token minted by the PEP and verified by the adapter. This TD records the requirement and does not define the token format (Unresolved U3).
- Bounded capability validity: exactly one transport dispatch; `expires_at` = `admitted_at + dispatch_window` (policy-bound; reference 120 s). After `expires_at` without a dispatch attempt the PEP appends `EffectOutcomeV1(UNKNOWN, reason=DISPATCH_WINDOW_EXPIRED)` and hands the admission to the Reconciler. It never re-uses the capability.

### 4.4 Commit-time fresh recheck (implementation of Spec §5.2)

All checks run inside the admission transaction (§3.4) against rows read in that transaction:

1. active policy (`policy_activation` max seq) `== decision.policy_ref` (id, revision, content_digest) and bundle bytes in CAS re-digest to `content_digest`;
2. `decision.admission_input_digest == input.input_digest`; `input.effect_request_digest == request.request_digest`; `decision.outcome == ALLOW`; `now < decision.not_after` if present;
3. every `input.evidence_refs[]` resolves with equal `envelope_digest`; for each mutable `subject_binding` with `revision_or_version`/`content_digest`, the adapter's `current_revision(subject)` read-only probe (GitHub: `GET ref` / `GET pull`) equals the bound value — drift ⇒ refuse;
4. required freshness: each envelope's `produced_at` within the policy `max_age` constraint (§5.3) and `produced_at ≥` the subject revision's own timestamp where the source reports one;
5. every `HUMAN_DECISION` envelope in the input has `claim.scope.effect_id == effect_id` (or `work_run_ref` for `WORK_START`) and has not been referenced by any admission of a **different** `effect_id`;
6. `effect_request.effect_id` has exactly one `request_digest` (guaranteed by §3.3, re-verified);
7. no open `KERNEL_INCIDENT` intersecting the scope (§2.6); `prior_effect_refs[]` each resolve and their latest outcome is included in the input as evidence (`TARGET_RECONCILIATION` or the outcome record) — otherwise refuse with `PRIOR_EFFECT_STATE_NOT_PRESENTED`;
8. credential-reach attestation: the most recent `CREDENTIAL_REACH_ATTESTATION` envelope (§9.2) for this deployment is within `reach_attestation_max_age` and reports `alternate_path_found = false`;
9. `PEP_TARGET_IDENTITY` fresh and matching (§4.2);
10. every `decision.constraints[]` is in the supported vocabulary (§5.3) and satisfiable now;
11. material bytes at `material_ref` re-digest to `material_digest` (read here so that a CAS corruption refuses admission, not just dispatch);
12. next ordinal admissible (§3.4).

Any failure ⇒ no admission row, a structured refusal to the caller, and — for failures 6–8 and digest/corruption cases — a `KERNEL_INCIDENT` envelope.

### 4.5 Restart / crash reconciliation around dispatch

| Crash point | Durable state after restart | Action |
|---|---|---|
| before admission commit | no admission row | nothing was dispatched; orchestrator may request admission again (fresh recheck) |
| after admission commit, before transport send | admission, no outcome | Reconciler: adapter `reconcile()` → `COMMITTED` / `NO_EFFECT_CONFIRMED` / `UNKNOWN` (§6.3). The PEP cannot distinguish this from the next row and does not try. |
| after transport send, before outcome write | admission, no outcome | same as above; a receipt lost in memory is recovered only from the target. |
| after outcome write | admission + outcome | conclusive ⇒ nothing; `UNKNOWN` ⇒ Reconciler continues under policy bounds |

There is no dispatch journal; the admission row is the pre-effect intent (Spec K6) and the target is the only authority about what happened after it.

---

## 5. D4 — Policy evaluator integration

### 5.1 Seam

```text
EvaluatorPort {
  evaluate(bundle: ResolvedAdmissionBundle) -> RawDecision | EvaluatorFailure
  identity() -> { evaluator_ref, evaluator_version, loaded_policy_content_digest }
}

ResolvedAdmissionBundle = {
  admission_input      : AdmissionInputV1 (canonical)
  effect_request       : EffectRequestV1
  evidence             : EvidenceEnvelopeV1[] (full envelopes incl. inline claims; CAS claims resolved)
  policy_ref           : PolicyRefV1
  active_policy_ref    : PolicyRefV1  (what the store says is active now)
  now                  : timestamp (from the Kernel Service clock; also carried into decided_at)
}

RawDecision = { outcome: ALLOW|DENY|REQUIRE_EVIDENCE, reason_codes: string[], constraints: Constraint[] }
```

The evaluator receives exactly the sealed `AdmissionInputV1` and the records it references — nothing else, and nothing resolved from mutable URLs. Any fact the evaluator needs must be an envelope in `evidence_refs`.

### 5.2 Reference implementation: OPA sidecar

- OPA (measured 1.20.1, #89) runs as a sidecar in the kernel pod, listening on a unix domain socket owned by the PEP identity. Only the Kernel Service can connect.
- **Policy content = the OPA bundle bytes.** `PolicyRefV1.content_digest = sha256(raw-bytes-1, bundle.tar.gz)`. The bundle embeds `data.cadp.policy_digest` equal to its own content digest (computed at bundle build, verified by the Ingress at `policy_ref` insert).
- Query: `POST /v1/data/cadp/admission` with `input = ResolvedAdmissionBundle`; result object must contain `outcome`, `reason_codes`, `constraints`, and `policy_digest_echo`.
- **Integrity proof** (`PolicyDecisionV1.evaluator.integrity_ref`): `opa:<opa_version>;bundle:<sha256 of bundle loaded, from OPA status API>;channel:unix:<socket path>;echo:<policy_digest_echo>`. The Sealer refuses to seal unless (a) status-API bundle digest, (b) `policy_digest_echo`, and (c) `decision.policy_ref.content_digest` are all equal. Signed-bundle verification (OPA `signing`) is the stronger option for remote evaluators (Unresolved U4).
- Transport alternative (non-reference): mTLS with SPIFFE ids on both ends plus signed bundles; the integrity string then carries the peer SPIFFE id instead of the socket path.

### 5.3 Decision sealing, failure, and constraints

- The Sealer wraps `RawDecision` into `PolicyDecisionV1` with `decided_at = now`, `not_after = decided_at + decision_ttl` (policy-bound; reference 30 min), evaluator identity from `identity()`.
- `EvaluatorFailure` (timeout, transport error, malformed output, unknown `outcome`, digest echo mismatch, unknown policy revision) produces **no `PolicyDecisionV1`**. It produces a `KERNEL_INCIDENT(EVALUATOR_INTEGRITY_FAILURE)` only for integrity mismatch; ordinary unavailability is returned to the orchestrator as a retryable `EVALUATION_UNAVAILABLE` (retrying evaluation has no external effect and is allowed).
- `REQUIRE_EVIDENCE` is a sealed decision; it is returned to the orchestrator with `reason_codes` naming the missing evidence kinds. No pending lifecycle in the kernel.
- **Constraint vocabulary v1** (closed set the PEP can enforce; anything else ⇒ `UNSUPPORTED_CONSTRAINT` incident, no admission):

```text
MAX_DISPATCH_ORDINAL(n)              admission refused if next ordinal > n
NOT_AFTER(ts)                        tighter than decision.not_after
REQUIRE_TARGET_IDEMPOTENCY_PROOF     next ordinal > 1 only with NATIVE_KEY proof (also the default rule)
REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE    refuse if any prior effect in work_bindings scope has open UNKNOWN
MATERIAL_SIZE_MAX(bytes)
OPERATION_KIND_EQUALS(kind)
TARGET_REF_EQUALS(target_ref)
EVIDENCE_MAX_AGE(evidence_kind, seconds)
MAX_EFFECTS_IN_WORK_RUN(n)           counts effect_requests bound to the same work_run_ref (§7.3)
```

- **Freshness/activation:** `PolicyDecisionV1.policy_ref` must equal the active row at commit time (§4.4 #1). A decision made under a superseded revision is simply not admissible; a new evaluation is required (Spec §9.3).
- **Worker-submitted decision documents** are not accepted by any API; the only path into `policy_decision` is the Sealer.

---

## 6. D5 — Effect-target adapter and reconciliation contract

### 6.1 Port

```text
TargetAdapterV1 {
  describe() -> {
    target_type,
    operations[]: { operation_kind, material_schema,
                    idempotency: NONE | NATIVE_KEY | NATIVE_PRECONDITION,
                    reconcile:   NONE | BY_OPERATION_REF | BY_QUERY_PREDICATE,
                    no_effect_proof_supported: bool }
  }
  prove_identity(credential) -> TargetIdentityClaim                         (read-only)
  current_revision(subject_binding) -> { revision_or_version?, content_digest?, availability }  (read-only)
  dispatch(effect_id, dispatch_ordinal, target_ref, operation_kind, material_bytes)
      -> ACCEPTED { target_operation_ref, receipt_claim }
       | REJECTED_NO_EFFECT { proof_claim }          -- target-authoritative rejection (e.g. 422 with validated body)
       | AMBIGUOUS { raw_observation }               -- timeout, 5xx, connection reset, unparseable
  reconcile(effect_id, dispatch_ordinal, target_ref, operation_kind, material_bytes)
      -> COMMITTED { target_operation_ref, receipt_claim }
       | NO_EFFECT_CONFIRMED { proof_claim }
       | UNKNOWN { unknown_reason }
}
```

`describe()` is a **declaration that must be proven** by the adapter conformance suite (§13.3) before policy may rely on it. A declared `NATIVE_KEY` without a passing double-dispatch test is treated as `NONE`.

### 6.2 Idempotency binding

- Native idempotency key (where the target supports one) = `cadp-v04:<effect_id>` — the **ordinal is excluded** so that every dispatch of the same logical effect carries the same key and the target deduplicates. The key is carried in the material at Ingress time (the Ingress injects it; the requester cannot set it) so that `material_digest` covers it.
- `NATIVE_PRECONDITION` (e.g., git ref update with `expected_old_sha`): the same material re-applied is a no-op at the target; reconcile reads the ref.
- `NONE`: the next ordinal is never admissible after an ambiguous dispatch; only `NO_EFFECT_CONFIRMED` (if `no_effect_proof_supported`) or a new `effect_id` with `prior_effect_refs` and, if policy says so, a Human exception decision.

### 6.3 Outcome truth rules (implementation of Spec K7/§6)

| Adapter result | Outcome written | Requirement |
|---|---|---|
| `ACCEPTED` with receipt whose target-native fields match material (§6.4) | `COMMITTED` | `target_operation_ref` recorded; receipt sealed as `TARGET_RECONCILIATION` evidence and referenced by `evidence_ref` |
| `ACCEPTED` but receipt does not bind to material | `UNKNOWN(RECEIPT_UNBOUND)` + `RECEIPT_MATERIAL_MISMATCH` incident | never `COMMITTED` |
| `REJECTED_NO_EFFECT` with authoritative proof | `NO_EFFECT_CONFIRMED` | only if `no_effect_proof_supported` and the proof is the target's explicit statement, not a client-side inference |
| `AMBIGUOUS` | `UNKNOWN(<raw reason>)` immediately | then Reconciler (§6.5) |
| `reconcile()` → `NO_EFFECT_CONFIRMED` | `NO_EFFECT_CONFIRMED` | predicate rules of §6.4 per target; **ordinary lookup absence is never sufficient** |
| `reconcile()` → `UNKNOWN` | new `UNKNOWN` row with the reason (append) | |

### 6.4 Reference adapters and their proof rules

**GitHub (development target)** — operations and what counts as authoritative:

| operation_kind | material (schema) | idempotency | COMMITTED proof | NO_EFFECT_CONFIRMED proof |
|---|---|---|---|---|
| `GIT_PUSH` | `{repo_id, ref, new_sha, expected_old_sha, bundle_cas_key}` | `NATIVE_PRECONDITION` | `GET /repos/{id}/git/ref/{ref}` returns `new_sha` | ref read (200) returns `expected_old_sha` **and** the target rejected the update with a validated reason (non-fast-forward / expected mismatch). A ref read alone showing the old sha is `UNKNOWN(REF_UNCHANGED_UNPROVEN)` unless the push transport returned a definitive rejection. |
| `PR_CREATE` | `{repo_id, base_ref, head_ref, head_sha, title_digest, body_digest}` | `NONE` (GitHub has no create-PR idempotency key) | `POST` returned 201 with `head.sha == head_sha`, or reconcile `GET /pulls?head=owner:head_ref&state=all` (fully paginated, 200) finds exactly one PR with `head.sha == head_sha` created after `admitted_at` | list read succeeded (200, complete pagination), performed ≥ `pr_settle_window` (reference 30 s, Unresolved U5) after the last dispatch attempt, finds **zero** PRs for that head_ref created after `admitted_at`, **and** the head_ref currently exists (otherwise `UNKNOWN(HEAD_MISSING)`) |
| `PR_MERGE` | `{repo_id, pr_number, expected_head_sha, merge_method}` | `NATIVE_PRECONDITION` (`sha` field of merge API) | `GET /pulls/{n}` → `merged == true` and `merge_commit_sha` present and PR head at merge == `expected_head_sha` | `GET /pulls/{n}` (200) → `merged == false` **and** the PR head is still `expected_head_sha` **and** no merge commit contains it on `base_ref` |

**Record service (non-development target, the #89 Vertical B service or any API with the same contract):**

| operation_kind | material | idempotency | COMMITTED | NO_EFFECT_CONFIRMED |
|---|---|---|---|---|
| `RECORD_WRITE` | `{tenant, resource_id, body_digest, body_cas_key, idempotency_key = cadp-v04:<effect_id>}` | `NATIVE_KEY` (must pass the double-dispatch test) | `GET /records?idempotency_key=` (authoritative store read, 200) returns one record whose `body_digest` matches | same read returns none **and** the service's write log query for the key returns none **and** the read is not served from a replica (service must expose `X-Read-Authority: primary` or equivalent; otherwise `UNKNOWN`) |

**Temporal (continuation target, §7):**

| operation_kind | material | idempotency | COMMITTED | NO_EFFECT_CONFIRMED |
|---|---|---|---|---|
| `WORK_START` | `{namespace, workflow_type, workflow_id = cadp-work-<effect_id>, task_queue, args_digest, bounds, work_bindings, policy_ref}` | `NATIVE_KEY` (`WorkflowIdReusePolicy = REJECT_DUPLICATE`; `StartWorkflow` returns the existing run for the same id) | `DescribeWorkflowExecution` returns a run whose start args digest == `args_digest` | `DescribeWorkflowExecution` → `NOT_FOUND` from the namespace's persistence (not a visibility index) |

Receipt binding rule (all targets): a receipt is bound only if at least one target-native field in it is a function of the material (`head_sha`, `merge_commit_sha`, `body_digest`, `args_digest`, `new_sha`). A receipt without such a field cannot produce `COMMITTED`.

### 6.5 Reconciler

- Runs inside the Kernel Service; triggered on start, on dispatch timeout, on `UNKNOWN` write, and by an orchestrator `request_reconcile(effect_id)` call (Temporal timers may schedule the request; the Reconciler decides what to write).
- Bounds are policy-bound: `reconcile_max_attempts`, `reconcile_backoff`. After the bound, the effect remains `UNKNOWN`, a `RECONCILE_EXHAUSTED` envelope is written, and the orchestrator is told to route to a policy-defined Human exception branch (§7.5). The Reconciler never dispatches.

---

## 7. D7 — Autonomous-work product composition

### 7.1 Principle

Autonomous continuation is owned by the commodity orchestrator (reference: Temporal). The kernel sees exactly three things from it: (1) a `WORK_START` governed effect that releases work into the orchestrator, (2) ordinary `EffectRequestV1`/evidence submissions during the run, (3) `WORK_STEP` / `WORK_BOUND_STOP` evidence that makes the run reconstructable. Temporal history is never read as authority; kernel rows are.

### 7.2 Work start as a governed effect (Spec §8.2)

```text
EffectRequestV1 {
  operation_kind = WORK_START
  target_ref     = { authority_ref: temporal:cadp-v04, target_type: WORKFLOW, target_id: <workflow_type>@<task_queue> }
  work_bindings  = exact input identity + revision (e.g. github issue #n + issue body content_digest; or business record id + version)
  material       = { workflow_id: cadp-work-<effect_id>, args_digest,
                     bounds: { max_steps, max_effects, deadline, budget? },
                     policy_ref, worker_profile_digest, continuation_target }
}
```

The PEP admits it like any effect (§3.4/§4.4) and dispatches `StartWorkflow` with the PEP's Temporal client credential. The workflow's start argument **is** the admitted material (Temporal receives the material bytes by digest). Workers have no Temporal *start* permission; they only execute activities on `cadp-worker` task queues.

### 7.3 Where the bound lives and who enforces it

- The bound is constitutional: it is part of the immutable `WORK_START` material.
- Enforced twice, by different owners: the workflow (commodity) stops at `max_steps`/`deadline` and emits `WORK_BOUND_STOP`; the PEP (kernel) enforces `MAX_EFFECTS_IN_WORK_RUN` by counting `effect_request` rows whose `work_bindings` include `work_run_ref`, and `NOT_AFTER(deadline)` on every effect of that run. A workflow that ignores its bound cannot obtain further effects.

### 7.4 Continuation identity and restart without duplicate effects

- `work_run_ref = effect_id(WORK_START)`. Every ordinary step is a Temporal activity with a deterministic `step_ordinal`.
- Each step emits `EvidenceEnvelopeV1(evidence_kind = WORK_STEP)` with `subject_bindings = [work_run_ref, step input digest, step output digest]` and `claim.prior_step_envelope_digest` — a causal chain reconstructable from the store alone.
- Effect identity across replay: the workflow requests `allocate_effect_id(allocation_key)` with `allocation_key = sha256(work_run_ref || step_ordinal || purpose)`. The Ingress returns the same `effect_id` for the same key (§2.2). After a restart, replayed code asks for the same key and receives the same `effect_id`; the store then tells it whether a request, decision, admission, or outcome already exists. **No step ever creates a second logical effect for the same purpose.**
- Before requesting any admission, the workflow's activity reads `get_effect_state(effect_id)` from the kernel and branches on durable rows (Spec §6.3 restated): `COMMITTED` → continue with the committed result; `NO_EFFECT_CONFIRMED` → may request the next admission; `UNKNOWN`/unresolved → wait for reconcile / policy exception. Temporal retry policies are configured to retry **activities that read**, never the dispatch (dispatch is not an activity of the worker at all; it happens inside the PEP).

### 7.5 Human appears only where policy says so

`REQUIRE_EVIDENCE` with a `HUMAN_DECISION` reason code makes the workflow wait on a signal; the Human interaction product (§9.3) submits the envelope; the workflow assembles a new `AdmissionInputV1`. No Human relays messages, SHAs, run ids, receipts or next-step data: all of those are kernel rows or target facts the workflow reads itself.

---

## 8. D8 — Worker / reviewer / verifier integration

### 8.1 Worker (implementation) boundary

- Runs as a Temporal activity in a worker pod (identity `spiffe://…/cadp/worker/<product>`), sandboxed, network denied except the Kernel API.
- Input: `work_bindings` (exact input identity + digest), base revision (`base_sha`), workspace materialized **by the activity harness at exactly `base_sha`** (fresh clone/checkout; never a reused dirty tree — the #89 dirty-tree lesson), worker profile (pinned argv; #89 recorded the `--sandbox`/profile trap, so the exact argv is part of `worker_profile_digest`).
- Output: candidate artifact identity (`candidate_sha`) in the **worker-local** repository + a `WORK_STEP` envelope. The worker cannot push: pushing the candidate to the governed repository is a `GIT_PUSH` governed effect requested by the workflow and performed by the PEP from a `git bundle` placed in CAS. This closes #89 finding 2 (push outside the gate).
- Execution identity: the backend-identity adapter (§9.2 / #91) scans the worker's session log and emits `BACKEND_EXECUTION` evidence with per-field `{availability, value, locator}`; absent facts are `UNKNOWN`.

### 8.2 Verifier boundary

- Reference: GitHub Actions workflow triggered on the pushed candidate ref, `permissions: contents: read`, checkout **by sha**. The verification adapter reads the run via API and emits `VERIFICATION` evidence with `subject_bindings = [repo_id + candidate_sha]` from the run's `head_sha` **as reported by GitHub**, not from the workflow's own log.
- Single-host harness alternative (measured in #89): `node --test` executed by a verifier process on a fresh clone at `candidate_sha`; the adapter records the clone's `HEAD` and `git status --porcelain` emptiness as part of the claim; a dirty tree ⇒ `UNKNOWN(DIRTY_WORKSPACE)`, never PASS.

### 8.3 Reviewer boundary

- Reference: a second product surface (measured #90: Claude Code plan-mode, read-only, network denied) reviewing the exact committed diff at `candidate_sha`; the review adapter emits `REVIEW` evidence with `subject_bindings = [repo_id + candidate_sha]`, `claim = { verdict, body_digest, reviewer_product, reviewer_run_id }`, `producer_ref` = reviewer identity.
- GitHub-native review (human or app) is read via API: `commit_id` becomes the subject binding; the PEP compares it to the effect's candidate (#90: the product does not do this comparison; the gate must).

### 8.4 Independence and separation

Policy expresses separation as predicates over `producer_ref` and the evidence's `claim.identity_class` (vendor/product/account/process): e.g., `producer_ref(REVIEW) ≠ producer_ref(WORK_STEP implementation)` and `identity_class.product ≠`. The kernel supplies the exact identities; it does not rank or score them. A single-product deployment that cannot satisfy the predicate fails closed (the case #90 did not measure).

No fixed Supervisor/Actor/Auditor role exists. "Requester", "implementer", "reviewer", "verifier" are just distinct `producer_ref`s in evidence.

---

## 9. D6 + D9 — Evidence ingress, provenance, Human decision, genesis, break-glass

### 9.1 Evidence ingress

- API: `submit_evidence(draft)` over the Kernel API. Authentication: workload identity (mTLS/SPIFFE) for machine adapters; IdP-signed JWT (SSO) for Human decision submissions. The Ingress **stamps** `producer_ref` from the authenticated identity; a draft whose declared producer differs is rejected.
- `provenance.integrity` is set by the Ingress, never by the submitter: `AUTHENTICATED_SOURCE` for authenticated channels; `SIGNED_ATTESTATION` only when the draft carries a signature/attestation the Ingress verifies against a key listed in the active policy bundle (`data.cadp.attestation_keys`; e.g., GitHub artifact attestations, Sigstore); `UNATTESTED` otherwise.
- `provenance.source_relation` is declared by the adapter class and checked against the **adapter registry**, a policy-bound document (`data.cadp.adapter_registry`) mapping `producer_ref` patterns → allowed `source_relation` and `evidence_kind`s. A producer claiming a relation the registry does not allow is rejected. The registry is configuration under policy digest, not a trust score.
- `produced_at` comes from the source where the source reports it (GitHub timestamps, Temporal event time); otherwise the Ingress uses its own receipt time and records `claim.produced_at_authority = INGRESS`.

### 9.2 Reference evidence adapters (thin conformance edges)

| evidence_kind | source | subject bindings | claim schema (native, not flattened) | relation |
|---|---|---|---|---|
| `VERIFICATION` | GitHub Actions run / harness run | `repo_id + sha` | `cadp.verification.github-actions.v1` `{run_id, head_sha, conclusion, workflow_file_digest, started_at, completed_at}` | `INDEPENDENT_OBSERVATION` |
| `REVIEW` | GitHub PR review / second-surface reviewer | `repo_id + commit_id` | `cadp.review.v1` `{verdict, body_digest, reviewer_identity_class, reviewer_run_id?}` | `INDEPENDENT_OBSERVATION` or `SELF_REPORT` (if producer == implementer) |
| `BACKEND_EXECUTION` | worker session logs (#91 method: scan, don't address) | `work_run_ref + step` | `cadp.backend.v1` `{ requested: {...}, observed: { model: {availability, value?, locator?}, provider: {...}, run_id: {...}, version: {...}, effort: {...} } }` | `SELF_REPORT` (backend self-reports; #91 U1) |
| `HUMAN_DECISION` | Human interaction product (§9.3) | exact `effect_id` or `work_run_ref` + `target_ref` + `material_digest` | `cadp.human-decision.v1` (§9.3) | `INDEPENDENT_OBSERVATION` |
| `TARGET_RECONCILIATION` | target adapters (§6) | `effect_id + admission_digest` | target-native receipt/proof | `TARGET_AUTHORITY_OBSERVATION` |
| `PEP_TARGET_IDENTITY`, `CREDENTIAL_REACH_ATTESTATION`, `KERNEL_INCIDENT`, `WORK_STEP`, `WORK_BOUND_STOP`, `GENESIS`, `BREAK_GLASS`, `INCIDENT_RELEASE`, `LEGACY_V03_ARTIFACT` | kernel / deployment control / importer | as defined in their sections | | |

**Requested ≠ observed (mechanical rule):** in `cadp.backend.v1`, `observed.*` fields with `availability = PRESENT` must carry a `locator` (file + offset, or API path) into the raw source; the adapter conformance test replays the locator and checks the value. A `PRESENT` observed value without a locator is rejected by the Ingress. `requested` is a separate sub-object and is never consulted to fill `observed` (the #91 T5 harm).

**Credential-reach attestation:** deployment control (not the worker) runs a periodic negative probe **inside a worker identity** attempting each governed target (expected: connection refused / `http 000` / 401 with no repository scope) and submits `CREDENTIAL_REACH_ATTESTATION` with `{alternate_path_found, probes[], network_policy_digest, secret_acl_digest}`. Policy sets its `max_age`. This is the deployment's proof of Spec §2.3; without it the PEP fails closed (§4.4 #8).

### 9.3 Human decision

```text
cadp.human-decision.v1 {
  principal        : IdP subject + display id (authenticated, not typed)
  decision         : APPROVE | REJECT | EXCEPTION_ACCEPT | STOP
  scope            : { effect_id? , work_run_ref? , target_ref , material_digest? , candidate_sha? }
  statement        : free text
  issued_at
}
```

- Reference Human interaction products (both commodity): (a) development — a GitHub PR review by a human account listed in policy; the adapter binds `commit_id` and the PR's `target_ref`; (b) generic — a minimal SSO-protected approval page that posts the envelope to the Ingress and signals Temporal. Slack buttons or issue comments without authenticated principal binding are not accepted as `HUMAN_DECISION` (they may be `UNATTESTED` context evidence at most).
- Scope is mandatory; the PEP check §4.4 #5 makes a decision unusable for any other effect. Idempotent recovery of the **same** `effect_id` may reference the same decision; a new `effect_id` needs a new decision.
- Freshness: policy `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)`.

### 9.4 Genesis, policy change, break-glass

**Genesis (out-of-band, root authority):**
1. Root operator creates namespace resources: DB schema `k04`, Temporal namespace `cadp-v04`, secret path `secret/cadp-v04/pep/*`, PEP workload identity, network policies.
2. Builds the genesis OPA bundle; computes `content_digest`; writes `policy_ref(policy_id=cadp-v04:policy:root, revision=1)`.
3. Signs a genesis document `{policy_ref, issuer_ref = root key id, pep_identity, secret_path, created_at}` with the offline root key; stores it in CAS; the Ingress (bootstrapped with the root public key) seals it as `GENESIS` evidence (`SIGNED_ATTESTATION`).
4. Inserts `policy_activation seq=1` referencing that envelope.
5. Places PEP credentials in the secret path. No agent/model participates.

**Policy change (ordinary):** new bundle → new `policy_ref` row (revision+1) → `EffectRequestV1(operation_kind = POLICY_ACTIVATE, target_ref = cadp-store:k04 activation log, material = new PolicyRefV1)` evaluated under the **current** policy → admission → the PEP's "store adapter" inserts the `policy_activation` row (this insert is the dispatch; `NATIVE_KEY` = `(policy_id, revision)` uniqueness; reconcile = read the log) → `COMMITTED`. Policy may require a `HUMAN_DECISION` for it.

**Root/break-glass:** a `BREAK_GLASS` envelope signed by the root key (`SIGNED_ATTESTATION`) with `{principal, reason, scope, prior_policy_ref, new_policy_ref?, release_incident_refs?, expires_at}`. Its only powers: (a) insert a `policy_activation` row referencing it; (b) act as `INCIDENT_RELEASE` for named incidents. It **cannot** admit an ordinary effect, rewrite any outcome, or be used by workers. It is append-only evidence like everything else.

### 9.5 Retention / archival (root operation)

Deleting or moving constitutional rows is never a runtime capability. Archival is a root procedure that exports rows to immutable storage with a signed manifest and is itself recorded as evidence; it is out of scope for the reference deployment.

---

## 10. D10 — Generation boundary and cutover

| Item | Decision |
|---|---|
| Execution namespace | New everywhere: DB schema `k04`, Temporal namespace `cadp-v04`, secret path `secret/cadp-v04/`, identifier prefix `cadp-v04:`. The v0.3 `PLATFORM_STORE`, `durable-jobs`, and OpenClaw state are neither read nor written by the Kernel Service. |
| Genesis policy | §9.4. The genesis bundle is the first v0.4 artifact; no v0.3 profile/policy is compiled into it. |
| v0.3 execution completion | The v0.3 composition root's start path is disabled by configuration at cutover (no new Attempt/Batch); in-flight Attempts complete or are stopped under frozen v0.3/TD v1.5 authority; the v0.3 store is then set read-only and archived. This is an operational procedure under #65, not a kernel function. |
| No promotion | No v0.3 `CapabilityGrant`, decision, `TaskContract`, `INTENT`/`DONE` row, or manifest is readable by the Kernel Service. There is no import API for them. |
| Old artifacts as evidence | Commits, PRs, CI runs, receipts from the v0.3 era may be sealed as `LEGACY_V03_ARTIFACT` evidence only via a read-only importer with `producer_ref = importer`, `source_relation = SELF_REPORT` (or `TARGET_AUTHORITY_OBSERVATION` when the artifact is re-read live from GitHub), original immutable identity in `subject_bindings`, and only if the v0.4 policy's adapter registry lists the importer. |
| Adapter/backend code reuse | Any code from `adapters/`, `core/`, OpenClaw or durable-jobs may be reused only after it passes the §13.3 adapter conformance suite and the credential-reach attestation shows it holds no governed credential. Reuse is an implementation decision, never inherited conformance. |
| TD v1.5 | Remains at its path unchanged as **HISTORICAL_OLD_GENERATION** evidence. This TD does not edit it. `Authority order.md` and `README.md` still name Spec v0.3/TD v1.5 as authority; updating them to name Spec v0.4 + this TD for the new generation is a **separate docs-only change** after Human merge (Unresolved U6). |

---

## 11. D11 — Reference deployment composition

One concrete composition sufficient to prove the Spec. Every row is replaceable by anything satisfying the same port (§5.1, §6.1, §9.1) and the store contract (§3.1). Product versions are those **measured** in #89/#90/#91; anything not measured is marked.

| Component class | Reference choice | Why (evidence) | Replaceability |
|---|---|---|---|
| Constitutional record store + CAS | PostgreSQL 16 (SQLite for single-host harness) | commodity RDBMS; #89 used SQLite via Temporal dev server on one host; row lock + unique constraint give §3.4 atomicity | any store with §3.1(a)–(d) |
| Kernel Service (Ingress/PEP/Sealer/Reconciler) | one process; implementation language is an implementation choice (Node.js 22 is the natural default because the #89 broker gate — 51 of 182 lines — was measured in `.mjs`) | the only non-commodity code; kept minimal | n/a — this is the kernel |
| Policy evaluator | OPA 1.20.1 sidecar, unix socket, bundle digest = policy content digest | #89: 46 decisions, structured reasons, policy sha recorded | any `EvaluatorPort` with an integrity proof |
| Commodity orchestrator | Temporal Server 1.31.2 / CLI 1.8.2, namespace `cadp-v04` | #89: durable across activities, retry policies real; Control caveat: single-worker scale only | any durable orchestrator that can be a `WORK_START` target and read kernel state |
| Autonomous worker | codex-cli 0.151.0, pinned argv, network denied | #89: completed candidate under sandbox; Devin surface unavailable (UNKNOWN, not inferred) | any worker producing a candidate + session log |
| Reviewer | Claude Code 2.1.221, plan mode, read-only | #90: R1–R6 controls passed on a second product surface | any second-surface producer satisfying policy separation |
| Verification | GitHub Actions (or `node --test` harness on fresh clone at sha) | #89 (harness), clean-checkout requirement measured | any CI emitting `head_sha`-bound results |
| Development target path | GitHub REST API; `GIT_PUSH` → `PR_CREATE` → (`PR_MERGE` when policy requires Human decision) | #89 Vertical A: PR #2 opened from the exact decided SHA; push must be gated | any repository host with ref/PR receipts |
| Non-development target path | the #89 Vertical B record service contract (`RECORD_WRITE` with idempotency key + authoritative read) | #89 B1–B7, AMB1–AMB3 measured | any API with key-based dedup and authoritative read |
| Secret manager / identity | HashiCorp Vault or cloud secret manager + SPIFFE/SPIRE (or K8s SA) | not measured in spikes; commodity | any ACL-bound secret store |
| Human interaction | GitHub PR review (dev); SSO approval page (generic) | #89 B3 approval bound to resource | any product producing §9.3 envelopes |

**Explicitly unavailable / unmeasured capabilities** (stay `UNKNOWN`, never assumed): Devin's own surface; signed/attested backend identity (both backends self-report, #91); OPA signed-bundle verification path; Temporal multi-worker/parallel semantics; GitHub PR-create idempotency (none exists; handled as `NONE`).

---

## 12. Kernel API surface (for completeness; not a new lifecycle)

```text
allocate_effect_id(allocation_key)                        -> effect_id                (idempotent)
seal_effect_request(draft)                                -> EffectRequestV1          (or conflict)
submit_evidence(draft)                                    -> EvidenceEnvelopeV1
assemble_admission_input(effect_id, policy_ref, evidence_refs[]) -> AdmissionInputV1
evaluate(input_digest)                                    -> PolicyDecisionV1 | REQUIRE_EVIDENCE | EVALUATION_UNAVAILABLE
admit_and_dispatch(effect_id, decision_id)                -> { admission, outcome } | refusal(reason)
get_effect_state(effect_id)                               -> { request, admissions[], outcomes[] }
request_reconcile(effect_id)                              -> ack
list_effects(work_run_ref)                                -> effect_ids[]
```

Nine read/write calls. There is no task, attempt, batch, pending-decision or profile endpoint. `admit_and_dispatch` is the only call that can cause an external effect, and it is the only path that inserts `effect_admission`.

---

## 13. D12 — Conformance / falsification plan

All tests are executed against the reference composition (§11) on a disposable target repository and a disposable record service (the #89 method). Observables are **counted at the target** (PR delta, ref sha, record count, workflow run count) and **read from the store** (row counts by kind), never from component self-reports.

### 13.1 Constitutional negative controls (Spec §13.1–13.3; #94 minimum list)

| ID | Control | Setup | Expected observable |
|---|---|---|---|
| C1 | wrong/stale policy binding | decision under revision r, activate r+1, request admission | refusal `POLICY_NOT_ACTIVE`; PR delta 0; no admission row |
| C2 | wrong work revision | evidence bound to `sha_a`, candidate moved to `sha_b` | refusal at §4.4 #3; PR delta 0 |
| C3 | wrong effect binding | present `decision_x` with `effect_y` | refusal `DECISION_INPUT_MISMATCH`; no admission |
| C4 | stale/tampered evidence | flip one byte in a stored claim | verify-on-read `DIGEST_CORRUPTION` incident; scope hold; PR delta 0 |
| C5 | decision replayed onto another effect | reuse `decision_id` for a second `EffectRequestV1` | refusal (input digest differs); no admission |
| C6 | worker alternate credential path | from worker identity: `gh pr create`, `curl` to record service | `http 000`/refused; `CREDENTIAL_REACH_ATTESTATION.alternate_path_found = false`; then **inject** a token into the worker → attestation becomes `true` → next admission refused §4.4 #8 |
| C7 | admission missing before effect | call adapter `dispatch()` directly (test-only hook) without admission | build forbids in production; test asserts PEP refuses; any externally observed commit without admission ⇒ `ADMISSIONLESS_COMMIT_OBSERVED` incident |
| C8 | same `effect_id` + different material | second `seal_effect_request` with same allocation key but changed material | `REQUEST_DIGEST_CONFLICT` incident; no second request row; scope hold |
| C9 | ambiguous accepted call + blind retry attempt | inject 100% timeout on `PR_CREATE` response after server accepted; orchestrator requests admission again | first: `UNKNOWN`; second admission refused `PRIOR_DISPATCH_UNRESOLVED` (idempotency `NONE`); reconcile finds 1 PR → `COMMITTED`; PR delta **1** (the #89 AMB1 duplicate must not reproduce) |
| C9b | same with `RECORD_WRITE` (`NATIVE_KEY`) | same injection | second ordinal admitted after fresh recheck; record count **1** |
| C10 | `NO_EFFECT_CONFIRMED` without target-authoritative proof | reconcile with a 404/empty list served from a replica / before settle window | outcome `UNKNOWN`, never `NO_EFFECT_CONFIRMED` (#89 AMB3) |
| C11 | dirty/mutable candidate verification | run harness verification on a dirty tree | `VERIFICATION` availability `UNKNOWN(DIRTY_WORKSPACE)`; policy denies; PR delta 0 (the #89 false-PASS must not reproduce) |
| C12 | self-review where independence required | reviewer `producer_ref` == implementer | policy `reviewer_is_the_implementer`; PR delta 0 (#90 R5) |
| C13 | requested backend identity copied into actual | adapter draft with `observed.model.value = requested.model`, no locator | Ingress rejects; with a locator that does not replay → adapter conformance FAIL (#91 T5) |
| C14 | required observed fact = `UNKNOWN` | policy requires `observed.effort` | decision `DENY required_fact_unknown`; no admission |
| C15 | concurrent admission race | two Kernel Service instances admit the same `effect_id` simultaneously | exactly one `effect_admission` row; the other gets `ADMISSION_LOST_RACE` |
| C16 | unsupported constraint | policy emits `FOO(1)` | `UNSUPPORTED_CONSTRAINT` incident; no admission |
| C17 | target identity mismatch | point credential at repo A, request target repo B (same name, different id) | refusal `TARGET_MISMATCH` |
| C18 | Human decision reuse | approve `effect_x`, present for `effect_y` | refusal §4.4 #5 |
| C19 | break-glass misuse | present a `BREAK_GLASS` envelope as evidence for an ordinary effect | not accepted as `HUMAN_DECISION`; admission refused |

Guard-bite check (from #89): for C1, C2, C3, C6, C9, C10, C11 the test additionally removes the corresponding kernel check and asserts the prohibited effect **does** occur (delta 1). A control whose removal changes nothing is reported as defence-in-depth, not as load-bearing.

### 13.2 Product controls (Spec §13.4–13.5, §8.2)

| ID | Control | Expected |
|---|---|---|
| P1 | development repeated autonomous-work path | `WORK_START` admitted → step 1 (candidate) → `GIT_PUSH` effect → step 2 (address CI failure, new candidate) → `GIT_PUSH` → verification + review evidence → `PR_CREATE` admitted → `COMMITTED`; PR delta 1 |
| P2 | non-development repeated path | `WORK_START` → step 1 (`RECORD_WRITE` A) → step 2 (`RECORD_WRITE` B depending on A's receipt) → reconciliation evidence → completion; record count 2 |
| P3 | ≥ 2 causally bound ordinary steps | `WORK_STEP` envelopes for step 2 reference step 1's envelope digest; reconstructable from store alone |
| P4 | restart/recovery without Human data re-entry | kill Temporal worker **and** Kernel Service between step 1 and step 2 (and, separately, between admission commit and outcome write); after restart: continuation converges, effect ids unchanged (allocation key), no duplicate effect, Human actions = 0 |
| P5 | Human only on policy branch | policy requires `HUMAN_DECISION` for `PR_MERGE` only; trace shows exactly one Human envelope, bound to the merge effect; all other steps have zero Human transport actions |
| P6 | manual relay must fail the product claim | run the same scenario with a Human copying SHAs/receipts between steps; the conformance report classifies it `KERNEL_CONFORMANT_ONLY`, not `CADP_PRODUCT_CONFORMANT` |
| P7 | bound stop | set `max_steps = 2`, give a task needing 3 → `WORK_BOUND_STOP` evidence, workflow HOLD, third effect refused `MAX_EFFECTS_IN_WORK_RUN` |

### 13.3 Adapter conformance suite (per target adapter, per operation)

- `describe()` vs behaviour: `NATIVE_KEY` ⇒ double dispatch yields one effect; `NATIVE_PRECONDITION` ⇒ re-apply is a no-op; `no_effect_proof_supported` ⇒ the proof predicate is demonstrated on a known-absent effect **and** shown to return `UNKNOWN` under replica/partial reads.
- receipt binding: every `COMMITTED` receipt contains a material-derived field.
- evidence adapters: every `PRESENT` observed field replays from its locator.

### 13.4 Conformance report format

Two separate claims, never merged (Spec §13): `CONSTITUTIONAL_KERNEL_CONFORMANCE: PASS|FAIL` over C1–C19 + adapter suite; `CADP_PRODUCT_CONFORMANCE: PASS|FAIL|KERNEL_CONFORMANT_ONLY` over P1–P7. Each line cites store row ids, target observables and the exact composition digests (kernel build digest, policy `content_digest`, adapter registry digest).

---

## 14. Old TD v1.5 disposition and non-goals

- `TECHNICAL_DESIGN_autonomous_development_platform.md` (TD v1.5) is **HISTORICAL_OLD_GENERATION**. It is not patched, not partially imported, and not the ancestor of this document. Its D1–D19, MVP seals, ImprovementFinding, monitoring, WorkflowProfile and Backend Capability Manifest designs govern only already-started v0.3 executions until they are completed/stopped (§10).
- Where this TD and TD v1.5 use the same word (INTENT, reconciliation, mutation reach, evidence binding), only the **semantic invariant** proven by negative controls is preserved (Spec §12.3); no schema or state machine is carried over.
- This TD does not: implement OPA/Temporal integrations; modify production TypeScript, tests, OpenClaw or durable-jobs; perform #52 replay; touch PR #83/#88; rewrite v0.3 or TD v1.5; define a task graph, scheduler, retry engine, project profile, or role lifecycle.

---

## 15. Unresolved (implementation-contract; none architecture-blocking)

| # | Question | Effect on architecture |
|---|---|---|
| U1 | Signed/attested backend identity is unavailable from both measured backends (#91). Reference policies must not require `SIGNED_ATTESTATION` for `BACKEND_EXECUTION`. | none — fail-closed assurance requirement; kernel manufactures no trust |
| U2 | Human reviewer decision provenance equivalence to machine reviewer (#90 unresolved). Design §9.3 covers it; not yet measured. | none — same envelope contract; if a Human product cannot bind scope, policy fails closed |
| U3 | Out-of-process target adapter capability token format (§4.3 alternative). | none — reference consumes capability in-process |
| U4 | OPA signed-bundle verification vs status-API + digest-echo as the integrity proof for remote evaluators. | none — reference uses local socket + triple digest equality |
| U5 | `pr_settle_window` value and GitHub list-read authority guarantees for `PR_CREATE` `NO_EFFECT_CONFIRMED`. Until measured, the adapter declares `no_effect_proof_supported = false` for `PR_CREATE` and ambiguity stays `UNKNOWN`. | none — conservative default already fail-closed |
| U6 | `Authority order.md` / `README.md` still name Spec v0.3 + TD v1.5; docs-only update to name the v0.4 generation after Human merge. | none — documentation of authority, not authority itself |
| U7 | Temporal multi-worker/parallel semantics unmeasured (Control caveat, #89). Reference product proof runs single worker. | none — product conformance claim is scoped to what is measured |

Architecture-blocking unresolved questions: **0**.

---

## 16. Acceptance mapping (#94)

| # | Acceptance item | Where |
|---|---|---|
| 1 | one coherent TD candidate at exact branch/PR/head/blob | this file; receipt on #94 |
| 2 | K1–K7 → ownership + durable representation | §1 |
| 3 | storage/atomicity/restart | §3, §4.5 |
| 4 | PEP/credential/target-binding topology | §4 |
| 5 | evaluator integration, fail-closed constraints/integrity | §5 |
| 6 | target dispatch/idempotency/reconciliation preserving UNKNOWN | §6 |
| 7 | evidence/provenance/assurance, requested ≠ observed | §9.1–9.2 |
| 8 | commodity orchestration → product conformance without authority | §7 |
| 9 | worker/reviewer/verifier/Human boundaries, no fixed roles | §8, §9.3 |
| 10 | genesis/break-glass, v0.3→v0.4 boundary | §9.4, §10 |
| 11 | reference deployment composition | §11 |
| 12 | dev + non-dev conformance/falsification plan | §13 |
| 13 | TD v1.5 disposition historical | §14 |
| 14 | no production code changes | scope proof in PR |
| 15 | unresolved explicit; architecture-blocking = 0 | §15 |
