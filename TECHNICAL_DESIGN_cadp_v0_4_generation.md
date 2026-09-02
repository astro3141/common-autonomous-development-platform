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
| Revision | **r6 — bounded TD repair** after independent r5 re-review #94 `issuecomment-5518070272` (r5 head `1795b54ea539eaee153c5026449db92277dc8ace`, blob `2821c7ecc9e243f475f54dc498ae148f528db4ee`). Architecture unchanged. r6 changed sections: §2.3, §5.1, §6.4, §6.6, §9.1, §9.4, §13.1, §15. Prior: **r5 — bounded TD repair** after independent r4 re-review #94 `issuecomment-5517653053` (r4 head `e65f95edf06f31c393c0f30050874012dd4a4e22`, blob `2a2290e114cae6e73210218aa84d45db54479218`). Architecture unchanged. r5 changed sections: §1, §2.6, §3.2, §4.4 (#16), §5.1, §5.4, §8.4, §9.1, §9.4, §12, §13.1, §15. Prior: **r4 — bounded TD repair** after independent r3 re-review #94 `issuecomment-5511584832` (r3 head `09a4d9024dfc5d1988e61854ed9f139f8a08af91`, blob `8618b4160021f99a6d10d6c55fd6817a69237fdb`). Architecture unchanged. r4 changed sections: §1, §2.6, §3.2, §4.4, §4.6, §5.2, §5.4, §6.4, §6.6, §7.4, §8.4, §9.1, §9.2, §9.3, §9.4, §12, §13.1, §15. Prior: **r3 — bounded TD repair** after independent re-review #94 `issuecomment-5511028194` and Control exactness sweep `issuecomment-5511164208` (r2 head `597bf1beff3b5377f9656f52faa3f38e745a1648`, blob `873b8dbc6584b0b9f6293f3f5c4ccd0886f55fba`; r1 head `2ac11fe4…`). Architecture unchanged. r3 changed sections: §1, §2.2, §3.2, §3.3, §3.4, §4.4, §4.6, §5.4 (new), §6.1, §6.4, §7.3, §7.4, §8.1, §9.1, §9.2, §9.3, §9.4, §11, §12, §13.1, §13.2, §13.3, §15. |

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
| K1 `PolicyRefV1` | **published only** by the store adapter inside a `POLICY_ACTIVATE` dispatch (publish-if-absent + activation append in one transaction, §9.4), by the root genesis procedure, or by the root listener executing a root-signed `BREAK_GLASS(ACTIVATE_POLICY)` with the same checks and the same one-transaction publish + activation (§9.4); there is no other publication path or API | Ingress at `POLICY_ACTIVATE` recheck: `content_digest` over the CAS bundle bytes (`raw-bytes-1`), `payload_digest`, manifest, `cadp.kernel-config.v1` | `policy_ref` table + `policy_activation` append-only log; bundle bytes in CAS | immutable; activation is a new log row | OPA bundle **is** the policy content; OPA never writes this table |
| K2 `EvidenceEnvelopeV1` | Ingress (`evidence_id` UUIDv7) | Ingress: `claim_digest`, `envelope_digest` (`cadp-jcs-1`) | `evidence_envelope` table; large claim in CAS by `claim_digest` | immutable | adapters (CI, review, backend, Human UI, target reconciler) submit drafts; Ingress stamps producer/integrity from authenticated identity |
| K3 `EffectRequestV1` | Ingress (`effect_id` UUIDv7, sealed; requester correlation → idempotent allocation key, §7.4) | Ingress: `material_digest` over material bytes, `request_digest` | `effect_request` table (PK `effect_id`); material bytes in CAS | immutable; second insert with different `request_digest` = conflict incident | worker/workflow propose material only |
| K4 `AdmissionInputV1` | Ingress (`input_digest` is the identity; every assembly is a new exact record — `assembled_at` is inside the digest) | Ingress | `admission_input` table (PK `input_digest`) | immutable | orchestrator asks Ingress to assemble, or references an existing `input_digest`; never assembles itself |
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
- Policy bundle payload uses scheme `cadp-bundle-payload-1` (defined in §5.2): a deterministic serialization of every bundle entry **except** `.manifest`, so that a bundle can carry its own payload identity without self-reference.
- Digest object is always `{ algorithm, canonicalization, value }`. Approved in this generation: `algorithm = sha256`, `canonicalization ∈ { cadp-jcs-1, raw-bytes-1, cadp-bundle-payload-1 }`, `value` = lowercase hex.
- **Bootstrap trust set (pre-genesis, fixed).** Before `policy_activation seq = 1` exists there is no active policy to consult, so the Kernel Service build carries a fixed, versioned bootstrap set `cadp-bootstrap-1` = `{ algorithms: [sha256], canonicalizations: [raw-bytes-1, cadp-jcs-1, cadp-bundle-payload-1], schema_digests: sha256 of the embedded k1..k7.v1 + genesis.v1 schemas, root_public_keys: read once from `secret/cadp-v04/root/pubkeys` at genesis }`. The bootstrap set is used **only** to (a) validate and seal the genesis `PolicyRefV1`, (b) verify the root signature on and seal the `GENESIS` envelope, (c) insert `policy_activation seq = 1`. Its digest is recorded in the `GENESIS` envelope claim (`bootstrap_set_digest`).
- **After activation seq = 1** the approved-scheme set is **policy-bound configuration**: `data.cadp.approved_digest_schemes` in the active `PolicyRefV1` content governs every new write. It may extend but never remove `cadp-bootstrap-1` schemes while any stored row still carries them (verify-on-read must remain computable); a policy that attempts removal is refused at `POLICY_ACTIVATE` recheck #17 (§4.4). A digest with an unapproved scheme is invalid input, never a different-but-equal identity.

### 2.2 Identity allocation

| Identity | Allocator | Format | Rule |
|---|---|---|---|
| `effect_id` | Ingress | `cadp-v04:effect:<uuidv7>` | requester never chooses it. A requester-supplied `allocation_key` (§7.4) maps idempotently to one `effect_id` in `effect_allocation(allocation_key PK, effect_id)`. |
| `evidence_id` | Ingress | `cadp-v04:evidence:<uuidv7>` | source-side ids (run id, review id) live inside `source_ref`/`execution_or_run_ref`, never replace `evidence_id`. |
| `decision_id`, `admission_id`, `outcome_id` | Sealer / PEP / Reconciler | `cadp-v04:<kind>:<uuidv7>` | |
| `policy_id` | root authority | `cadp-v04:policy:<name>` | `revision` = monotonically increasing integer per `policy_id`; `content_digest` identifies content. Alias `active` is resolved only through the activation log (§3.3). |
| `input_digest` | Ingress | digest | `AdmissionInputV1` is content-addressed **including `assembled_at`**: two assemblies of the same refs at different times are two records with two digests. There is no collapse rule. A caller that wants to reuse an existing input presents its `input_digest` (from `get_effect_state`) instead of calling `assemble_admission_input` again; the Sealer and PEP bind to whichever exact digest the decision names. |

UUIDv7 is chosen for monotonic insertion locality; uniqueness is enforced by the store, not by the generator.

### 2.3 Content-addressed material and evidence references

- `material_ref` and large `claim` references are `cas://sha256/<hex>`. The CAS is the `cas_blob(digest PK, bytes, size, created_at)` table in the Constitutional Store (reference), replaceable by object storage with the same key contract.
- CAS writes are insert-only and verify `sha256(bytes) == key` on write **and on every read**. A mismatch on read is a corruption incident (§2.6).
- Inline limit: `claim` ≤ 64 KiB inline in the envelope row; larger claims are CAS-only with `claim_digest` in the row. `material` is always CAS (never inline, for every `operation_kind` including `POLICY_ACTIVATE`) so that `EffectRequestV1` rows stay small and the PEP always re-reads bytes by digest at dispatch.

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

`incident_kind ∈ { REQUEST_DIGEST_CONFLICT, ADMISSIONLESS_COMMIT_OBSERVED, RECEIPT_MATERIAL_MISMATCH, DIGEST_CORRUPTION, ALTERNATE_CREDENTIAL_PATH, OUTCOME_CONTRADICTION, EVALUATOR_INTEGRITY_FAILURE, UNSUPPORTED_CONSTRAINT, WORK_STEP_CONFLICT, BREAK_GLASS_REJECTED }`.

**Scope hold rule (kernel-enforced):** the PEP refuses any new `EffectAdmissionV1` whose `effect_id`, `target_ref` or `work_bindings` intersect the `subject_bindings` of a `KERNEL_INCIDENT` envelope that has not been released by a later root-signed `BREAK_GLASS` envelope whose `release_incident_refs` names it (§9.4). There is no standalone release document. Incident UI, paging, and triage workflow are commodity.

---

## 3. D2 — Durable record store and atomicity

### 3.1 Store choice

- Reference: **PostgreSQL 16**, schema `k04`, single logical database for one deployment namespace. Single-host development/conformance harness: **SQLite** with the identical DDL subset (WAL mode, `BEGIN IMMEDIATE`). Both are commodity databases; the store contract below is what matters, and any store providing it is acceptable.
- Required store contract: (a) transactional insert with unique-constraint enforcement; (b) per-row exclusive lock (`SELECT … FOR UPDATE`) or an equivalent single-writer primitive per `effect_id`; (c) durable commit before acknowledgement (`synchronous_commit = on`); (d) no runtime `UPDATE`/`DELETE` privilege.

### 3.2 Tables (constitutional only)

```text
policy_ref            (policy_id, revision) PK, content_digest, issuer_ref, bundle_cas_key,
                      payload_digest, manifest_revision                  -- impl columns, see §5.2
policy_activation     seq BIGINT PK (explicitly supplied, never sequence-generated),
                      expected_prev_seq BIGINT NOT NULL UNIQUE,                -- one successor per predecessor
                      CHECK (seq = expected_prev_seq + 1),
                      policy_id, revision, content_digest,
                      activated_by_ref, activation_evidence_id, activated_at        -- append-only
evidence_envelope     evidence_id PK, envelope_digest UNIQUE, envelope_json(jsonb), subject index
effect_allocation     allocation_key PK, effect_id UNIQUE
evidence_envelope     + impl column: received_at (operational only; NEVER policy-visible — §9.1)
                      + UNIQUE partial index (evidence_kind='WORK_STEP', work_run_ref, step_ordinal)  -- §7.4
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
| PolicyRef activation / genesis | `policy_activation` is append-only; the **active** policy is the row with the highest `seq`. Genesis is `seq = 1`, `expected_prev_seq = 0`, `activated_by_ref = root key id`, `activation_evidence_id` → the signed `GENESIS` envelope (§9.4). Every later row references either an `EffectOutcomeV1(COMMITTED)` of a `POLICY_ACTIVATE` effect or a signed root/break-glass envelope (§9.4). **Activation CAS (explicit predecessor+1, no sequence object):** `seq` is not `bigserial`; a PostgreSQL sequence is not rolled back on a failed insert and would leave gaps that break `CHECK(seq = expected_prev_seq + 1)` for the next fresh activation. Instead the store adapter, holding the `policy_activation` serialization lock (§4.6), executes in one transaction: `SELECT seq FROM policy_activation ORDER BY seq DESC LIMIT 1 FOR UPDATE` → require `current.seq == expected_prev_seq` → `INSERT (seq = expected_prev_seq + 1, expected_prev_seq = expected_prev_seq, …)`. `UNIQUE(expected_prev_seq)` remains the constraint-level one-successor guarantee against any writer that bypasses the lock; `CHECK` guards the arithmetic. A rejected stale activation consumes nothing, so the next fresh activation (`expected_prev_seq = new current`) inserts cleanly (C22b). This is what makes `POLICY_ACTIVATE` a target-native precondition (§6.4, §9.4). |
| EffectRequest identity uniqueness | `effect_request.effect_id` PK. Insert of an existing `effect_id`: if `request_digest` equals the stored one → idempotent no-op (returns stored row); if it differs → insert rejected, `REQUEST_DIGEST_CONFLICT` incident written, scope hold. |
| AdmissionInput / PolicyDecision exact binding | `policy_decision.admission_input_digest` FK → `admission_input.input_digest`; `admission_input.effect_request_digest` must equal `effect_request.request_digest` of the referenced `effect_id` (verified on write and on read). |
| Atomic `(effect_id, dispatch_ordinal)` reservation + admission write | One transaction (§3.4). The unique constraint on `(effect_id, dispatch_ordinal)` makes the admission row itself the reservation; no separate reservation table. |
| Append-only EffectOutcome | insert-only; several outcomes per admission are expected (`UNKNOWN` at timeout, later `COMMITTED` from reconciliation). The **conclusive** outcome of an admission is: any `COMMITTED` or `NO_EFFECT_CONFIRMED` row for that `admission_digest`; contradiction (both present) = `OUTCOME_CONTRADICTION` incident. |
| Restart reads | On start the Kernel Service (a) verifies-on-read the active policy row and bundle bytes; (b) enumerates admissions with no conclusive outcome → hands each to the Reconciler (§6.5); (c) holds all new admissions for scopes with open incidents. No process-memory state is consulted. |
| Conflict detection | Unique constraints + verify-on-read + Spec §6.4 rules mapped to incident kinds (§2.6). |
| Transaction/CAS requirements | §3.1(a)–(d), §2.3. CAS = content-addressed blob store; "CAS" in the compare-and-set sense is provided by the unique constraint + row lock, not by an application-level version field. |

### 3.4 Admission transaction (the constitutional effect gate, Spec §5.2)

```text
acquire serialization-domain lock D = adapter.serialization_domain(material)      -- §4.6 item 3; held until outcome write
run dispatch precondition read for mutable subjects (§4.6 item 1)                 -- BEFORE K6; failure = refusal, no admission
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

Only after `COMMIT` returns does the PEP send the transport call, still inside lock D, using material bytes already verified inside the transaction. Two concurrent PEP instances (or one instance racing its own restart) cannot both succeed: the row lock serializes them and the unique constraint rejects the loser. The loser reports `ADMISSION_LOST_RACE` to the orchestrator, which must re-read the store rather than retry blindly.

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
7. no open `KERNEL_INCIDENT` intersecting the scope (§2.6); `prior_effect_refs[]` each resolve to an `effect_id` that has at least one `EffectAdmissionV1`, and their latest outcome is included in the input as evidence (`TARGET_RECONCILIATION` or the outcome record) — otherwise refuse with `PRIOR_EFFECT_STATE_NOT_PRESENTED`; a `prior_effect_refs` entry naming a request with no admission (a pre-K6 refusal, §4.6 item 5) is refused as `PRIOR_REF_NOT_AN_EFFECT`;
8. credential-reach attestation: the most recent `CREDENTIAL_REACH_ATTESTATION` envelope (§9.2) for this deployment is within `reach_attestation_max_age` and reports `alternate_path_found = false`;
9. `PEP_TARGET_IDENTITY` fresh and matching (§4.2);
10. every `decision.constraints[]` is in the supported vocabulary (§5.3) and satisfiable now;
11. material bytes at `material_ref` re-digest to `material_digest` (read here so that a CAS corruption refuses admission, not just dispatch);
12. next ordinal admissible (§3.4);
13. for `operation_kind = POLICY_ACTIVATE`: `material.expected_active_policy_ref` (policy_id, revision, content_digest, seq) equals the active row read in this transaction — otherwise refuse `ACTIVATION_BASE_STALE`;
14. for every operation whose material names a mutable target subject (§4.6), the adapter's `dispatch_precondition` for that material is well-formed; where the target offers no native CAS, the subject is a PEP-owned write-once reference **and** a fresh `TARGET_IMMUTABILITY_ATTESTATION` for that target (§4.6 item 2) is present — otherwise refuse `MUTABLE_TARGET_WITHOUT_PRECONDITION`; the pre-K6 precondition read (§3.4 first lines) has already passed inside the same serialization lock;
15. every material byte the adapter will send is reachable from the sealed material — inline or by `cas://` ref whose bytes re-digest correctly (§6.6) — otherwise refuse `MATERIAL_INCOMPLETE`;
16. every `EvidenceEnvelopeV1` freshness requirement is evaluated against source-authoritative time only: `produced_at` counts for `EVIDENCE_MAX_AGE` only when `source_time_authority(envelope, active_policy) = SOURCE` (§9.1 — a pure function of the K2 envelope and the active policy's `adapter_registry`); an envelope whose authority derives to `NONE` never satisfies `EVIDENCE_MAX_AGE`. No value outside K1–K7 (in particular no `received_at`) participates in this or any other policy check;
17. for `operation_kind = POLICY_ACTIVATE`: the CAS bytes at `material.bundle_cas_ref` re-digest to `proposed_policy_ref.content_digest`; `payload_digest` and `.manifest.revision` match `proposed_policy_ref` (§5.2); `data.cadp` validates against `cadp.kernel-config.v1` (§5.4); and either no `policy_ref(policy_id, revision)` row exists, or the existing row has the identical `content_digest` — a different digest for the same `(policy_id, revision)` is refused `POLICY_REF_CONFLICT` with a `KERNEL_INCIDENT`.

Any failure ⇒ no admission row, a structured refusal to the caller, and — for failures 6–8 and digest/corruption cases — a `KERNEL_INCIDENT` envelope.

### 4.5 Restart / crash reconciliation around dispatch

| Crash point | Durable state after restart | Action |
|---|---|---|
| before admission commit | no admission row | nothing was dispatched; orchestrator may request admission again (fresh recheck) |
| after admission commit, before transport send | admission, no outcome | Reconciler: adapter `reconcile()` → `COMMITTED` / `NO_EFFECT_CONFIRMED` / `UNKNOWN` (§6.3). The PEP cannot distinguish this from the next row and does not try. |
| after transport send, before outcome write | admission, no outcome | same as above; a receipt lost in memory is recovered only from the target. |
| after outcome write | admission + outcome | conclusive ⇒ nothing; `UNKNOWN` ⇒ Reconciler continues under policy bounds |

There is no dispatch journal; the admission row is the pre-effect intent (Spec K6) and the target is the only authority about what happened after it.

### 4.6 Dispatch-time precondition and serialization (admission→dispatch TOCTOU)

Admission proves the world as of the admission transaction; the external call happens after commit. For **mutable** target subjects the PEP therefore adds a precondition **before K6** and a serialization lock that spans precondition → admission → dispatch → outcome. K7 truth stays target-authoritative: a failed precondition produces a refusal, never an outcome.

1. **Precondition contract.** Every adapter operation declares in `describe()` a `dispatch_precondition ∈ { NATIVE_CAS, PEP_READ_THEN_ACT, NONE }` and, per material, the exact precondition it will apply:
   - `NATIVE_CAS` — the target itself refuses the write unless a caller-supplied expected value matches (git ref update with `expected_old_sha`; the activation log `expected_prev_seq`; Temporal `REJECT_DUPLICATE`). Preferred; nothing can interleave. A `NATIVE_CAS` rejection by the target after send is `REJECTED_NO_EFFECT` (§6.1) and follows §6.3 — the target, not the PEP, is the observer.
   - `PEP_READ_THEN_ACT` — the target has no CAS for this operation. **Ordering:** inside lock D (item 3) the PEP performs the read-only `current_revision` read **before** opening the K6 admission transaction (§3.4). If the read differs from the admitted binding, `admit_and_dispatch` returns the deterministic refusal `DISPATCH_PRECONDITION_FAILED` with the read attached; **no `EffectAdmissionV1` and no `EffectOutcomeV1` are written**, and the orchestrator must re-read `get_effect_state` and, if the subject has moved, seal a new request. If it passes, K6 is committed and the call is sent while still holding D. Permitted **only** when the subject is a PEP-owned write-once reference whose target-side immutability is attested (item 2); then the only principal that could move the subject between read and act is another PEP instance, and item 3 excludes it.
   - `NONE` — no mutable subject in the material (e.g. `RECORD_WRITE` on an idempotency-keyed resource).
2. **Immutable candidate references (GitHub reference path) — conformance prerequisite, not defence in depth.** Candidates are pushed to `refs/heads/cadp/candidate/<candidate_sha>`; the PEP's `GIT_PUSH` refuses any `ref` under `cadp/candidate/*` whose `new_sha ≠ <sha in ref name>` or whose `expected_old_sha ≠ 0000…` (write-once: no update, no delete). `PR_CREATE.head_ref` must be such a candidate ref. Because a database lock cannot stop an out-of-band GitHub principal, the write-once property must be **proven at the target**: deployment control periodically (a) reads the repository rulesets (`GET /repos/{id}/rulesets` and each ruleset's rules) and verifies an `active` ruleset targeting `refs/heads/cadp/candidate/**` with `update`, `non_fast_forward` and `deletion` rules and `bypass_actors` = the PEP App only, and (b) runs a negative probe with a non-PEP admin-scoped token attempting to move and to delete a probe candidate ref (expected: rejected by the ruleset), and seals both as `TARGET_IMMUTABILITY_ATTESTATION` evidence (`TARGET_AUTHORITY_OBSERVATION`). The GitHub adapter reports `PR_CREATE` as **unavailable** (`describe().operations[PR_CREATE].available = false`) unless a fresh attestation (`target_immutability_attestation_max_age_s`, §5.4) exists for that `repo_id`, and recheck #14 refuses admission without it. If the deployed GitHub surface cannot express this ruleset, the reference development path is `KERNEL_CONFORMANT_ONLY` for `PR_CREATE` until a target-native immutable-ref mechanism exists (U8 closed as prerequisite; see §15).
3. **Serialization domain.** Each adapter declares `serialization_domain(material)` (GitHub: `repo_id`; record service: `tenant`; Temporal: `namespace`; store adapter: `policy_activation`). Lock D = `pg_advisory_lock(hash(domain))` (session-level, released after the outcome write or on connection loss; process mutex on SQLite) is acquired **before** the precondition read and held through K6 commit, transport send and outcome write. Two governed effects on the same domain never interleave, in-process or across Kernel Service instances.
4. **Residual (explicit).** With items 1–3, a wrong-subject effect can arise only if a principal violates the attested target property during the attestation window (e.g. an organization administrator edits the ruleset and moves the ref between the GET and the POST). Such an effect is detected by receipt binding (§6.3, `RECEIPT_MATERIAL_MISMATCH` incident, scope hold) and is outside the deployment's stated trust boundary; it is recorded, not hidden.
5. **After a precondition refusal** the requested material is stale by definition (the bound revision moved). A pre-K6 refusal is **not an external-effect attempt**: no admission, no outcome, no ordinal. Therefore a successor `EffectRequestV1` (new `effect_id`, new material) **must not** name the refused request in `prior_effect_refs` — that field is reserved for logical effects that have K6/K7 history (§4.4 #7 requires their latest outcome). The refused request row simply remains in the store as an unadmitted request; the successor references the same `work_bindings`/`work_run_ref` and, where useful, the same allocation tuple with a new `purpose` or `step_ordinal`. No separate request-lineage field is introduced.

Dispatch-time checks apply the admitted binding only. They do not re-evaluate policy, read new evidence, or accept a "newer" revision as equivalent.

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
  -- nothing else: identity_class and source_time_authority are derived by the policy itself (and by the PEP
  -- for recheck) as pure functions of these envelopes + data.cadp registries (§9.1); no ingress metadata is supplied
  policy_ref           : PolicyRefV1  (the K4-bound policy; the Kernel has already verified it IS the active row — see below)
  now                  : timestamp (from the Kernel Service clock; recorded verbatim as K5.decided_at)
}

RawDecision = { outcome: ALLOW|DENY|REQUIRE_EVIDENCE, reason_codes: string[], constraints: Constraint[] }
```

`active_policy_ref` is **not** an evaluator input (removed in r6): before invoking the evaluator the Kernel checks `admission_input.policy_ref == active policy_activation row` (id, revision, content_digest) and returns `POLICY_NOT_ACTIVE` without evaluating if they differ — a Kernel fail-closed check, not a policy-visible authority input; the same equality is re-verified at commit (recheck #1). The evaluator receives exactly the sealed `AdmissionInputV1` and the records it references — nothing else, and nothing resolved from mutable URLs. Any fact the evaluator needs must be an envelope in `evidence_refs` (or the policy content itself, bound by `policy_ref`). **Complete-input rule:** every policy-visible non-derived fact is K4-bound material; the only derived facts are pure functions of that material and the active policy content (§9.1). The single deliberate exception is `now`: the Kernel Service clock, never caller- or Ingress-supplied, recorded verbatim in K5 as `decided_at` and re-applied by the PEP at commit (`not_after`, recheck #2/#4). Changing anything else that is not K1–K7 material cannot change a decision; replaying the evaluation with the same `input_digest`, `policy_ref` and `now` reproduces the same `RawDecision` byte for byte (C38).

### 5.2 Reference implementation: OPA sidecar

- OPA (measured 1.20.1, #89) runs as a sidecar in the kernel pod, listening on a unix domain socket owned by the PEP identity. Only the Kernel Service can connect.
- **Policy content = the OPA bundle bytes; identity is external, not embedded.** `PolicyRefV1.content_digest = sha256(raw-bytes-1, bundle.tar.gz)` is computed by the Ingress over the exact bytes stored in CAS. **The bundle does not contain its own raw digest** (a raw digest cannot be embedded in the bytes it digests).
- **Non-self-referential payload identity.** `payload_digest = sha256(cadp-bundle-payload-1, bundle)` where `cadp-bundle-payload-1` = for every tar entry except `.manifest`, ordered by path (bytewise), the concatenation of `path || 0x00 || uint64-BE(len(bytes)) || bytes`. Because `.manifest` is excluded, the manifest may carry a value derived from `payload_digest` without circularity.
- **Manifest revision string.** The bundle's `.manifest` `revision` field is set at build time to `manifest_revision = "cadp-v04:policy:<policy_id>@<revision>#<payload_digest hex>"`. At publication (the `POLICY_ACTIVATE` admission recheck, §4.4 #15/#17, or the root genesis procedure) the Ingress unpacks the CAS bytes, recomputes `payload_digest`, parses `.manifest.revision`, and refuses unless the parsed `policy_id`/`revision`/`payload_digest` all match `proposed_policy_ref`. Both `payload_digest` and `manifest_revision` are stored as implementation columns of `policy_ref` (§3.2); K1's four semantic fields are unchanged.
- **Loading.** The PEP, not an external bundle server, serves the bundle to its OPA sidecar: it reads the CAS bytes for the active `content_digest`, verifies `sha256 == content_digest`, writes them to a PEP-owned local path, and OPA is configured with a `bundles.cadp` resource pointing at that path (`persist: false`). OPA never fetches policy from anywhere else.
- **What OPA actually reports.** OPA's Status API (`GET /v1/status`) reports, per bundle, `active_revision` — the `revision` string of the currently activated bundle manifest — together with activation timestamps and errors. OPA also exposes the loaded manifest under `data.system.bundles["cadp"].manifest.revision`. OPA does **not** report a hash of the raw bundle bytes; that is why the raw `content_digest` is verified by the PEP at load time (previous bullet), not queried from OPA.
- Query: `POST /v1/data/cadp/admission` with `input = ResolvedAdmissionBundle`; the policy's result object must contain `outcome`, `reason_codes`, `constraints`, and `revision_echo := data.system.bundles["cadp"].manifest.revision` (read from the manifest OPA loaded, not from a constant in the payload).
- **Integrity proof** (`PolicyDecisionV1.evaluator.integrity_ref`): `opa:<opa_version>;bundle_revision:<active_revision from /v1/status>;content:<content_digest verified by PEP at load>;channel:unix:<socket path>`. The Sealer refuses to seal unless all four hold: (a) `/v1/status` shows `bundles.cadp.active_revision == policy_ref.manifest_revision` with no activation error; (b) `revision_echo == policy_ref.manifest_revision`; (c) the bytes the PEP last served to OPA re-digest to `decision.policy_ref.content_digest`; (d) `policy_ref.content_digest` is the active row's `content_digest`. Signed-bundle verification (OPA `bundles.<name>.signing` with a key from the active policy's `data.cadp.attestation_keys`) is the stronger option for remote evaluators (Unresolved U4).
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

### 5.4 Kernel-consumed policy configuration — `cadp.kernel-config.v1`

Everything the Kernel Service itself reads from the policy bundle lives under `data.cadp` and is validated against one versioned JSON Schema at publication — i.e. inside the `POLICY_ACTIVATE` admission recheck (§4.4 #17) or the root genesis procedure. A bundle whose `data.cadp` is missing, has an unknown `schema`, fails type/bounds validation, or omits any required key is **refused before K6** (it is never published and can never become active). There are no implementation defaults: every reference value below is data in the bundle.

```text
data.cadp = {
  schema: "cadp.kernel-config.v1"                                   (required, exact)
  approved_digest_schemes: [{algorithm, canonicalization}]          (required; ⊇ cadp-bootstrap-1 while rows carry them)
  root_public_keys:      [{key_id, alg:"Ed25519", public_key, valid_from, valid_to?}]   (required ≥1)
  attestation_keys:      [{key_id, alg, public_key, purpose, valid_from, valid_to?}]     (required, may be [])
  identity_registry:     [{principal (exact SPIFFE ID | IdP subject), producer_ref,
                           identity_class:{vendor, product, account, process_class}}]    (required; exact match only, no patterns)
  adapter_registry:      [{producer_ref (exact), evidence_kinds:[...], source_relation,
                           produced_at_source: { kind: SOURCE, claim_pointer: <RFC 6901 pointer> } | { kind: NONE } }]
                                                                    (required; exact match only; produced_at_source per entry)
  allocation_purposes:   [string]                                    (required ≥1; closed vocabulary for §7.4)
  decision_ttl_s:                         int  60..86400            (required; reference 1800)
  dispatch_window_s:                      int  10..3600             (required; reference 120)
  identity_probe_max_age_s:               int  60..86400            (required; reference 600)
  reach_attestation_max_age_s:            int  60..86400            (required; reference 3600)
  target_immutability_attestation_max_age_s: int 60..86400          (required; reference 3600)
  reconcile_max_attempts:                 int  1..1000              (required; reference 20)
  reconcile_backoff_s:                    int  1..3600              (required; reference 30)
  pr_settle_window_s:                     int  0..3600              (required; reference 30; only meaningful when no_effect_proof_supported)
  temporal_idempotency_horizon_s:         int  60..31536000         (required; must equal the namespace retention, verified by prove_identity)
  cas_upload_max_bytes:                   int  1024..1073741824     (required; reference 268435456; hard cap at put_blob, §6.6)
  break_glass_max_lifetime_s:             int  60..86400            (required; reference 3600; max expires_at − created_at, §9.4)
}
```

Rules: unknown keys under `data.cadp` are rejected (closed schema); bounds are inclusive; a value outside bounds is invalid; `identity_registry` and `adapter_registry` entries are matched by **exact string equality** on `principal` / `producer_ref` — no regex, glob or precedence. Rego-private data outside `data.cadp` is not read by the Kernel Service and is unconstrained. The schema digest is part of `cadp-bootstrap-1` (§2.1) so the genesis bundle is validated identically.

---

## 6. D5 — Effect-target adapter and reconciliation contract

### 6.1 Port

```text
TargetAdapterV1 {
  describe() -> {
    target_type,
    operations[]: { operation_kind, material_schema, available: bool,   -- false ⇒ admission refused (§4.6 item 2)
                    idempotency: NONE | NATIVE_KEY | NATIVE_PRECONDITION,
                    idempotency_horizon?: duration,      -- NATIVE_KEY valid only within this window (§6.4 Temporal)
                    dispatch_precondition: NATIVE_CAS | PEP_READ_THEN_ACT | NONE,   -- §4.6
                    reconcile:   NONE | BY_OPERATION_REF | BY_QUERY_PREDICATE,
                    no_effect_proof_supported: bool }
  }
  serialization_domain(material) -> string                                   (§4.6 item 3)
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

Serialization domain for all GitHub operations: `repo_id` (§4.6). Candidate references are write-once `refs/heads/cadp/candidate/<sha>` (§4.6 item 2).

| operation_kind | material (schema) | idempotency / dispatch_precondition | COMMITTED proof | NO_EFFECT_CONFIRMED proof |
|---|---|---|---|---|
| `GIT_PUSH` | `{repo_id, ref, new_sha, expected_old_sha, bundle_cas_key}`; for `ref` under `cadp/candidate/*` the PEP requires `ref == refs/heads/cadp/candidate/<new_sha>` and `expected_old_sha == 0000…`; bundle validation per §6.6 | `NATIVE_PRECONDITION` / `NATIVE_CAS` — git receive-pack with `expected_old_sha` (`--force-with-lease=<ref>:<expected_old_sha>` semantics; the update is rejected by the target if the ref moved) | `GET /repos/{id}/git/ref/{ref}` returns `new_sha` | the push transport returned a definitive `expected-old-sha mismatch`/`non-fast-forward` rejection **and** a subsequent ref read (200) does not return `new_sha`. A ref read alone is `UNKNOWN(REF_UNCHANGED_UNPROVEN)`. |
| `PR_CREATE` | `{repo_id, base_ref, head_ref = refs/heads/cadp/candidate/<head_sha>, head_sha, title_cas_key, body_cas_key}` — title/body **bytes** are CAS objects named by digest (§6.6); admission refuses any other `head_ref` shape (§4.4 #14) and refuses unless `available = true` (fresh `TARGET_IMMUTABILITY_ATTESTATION`, §4.6 item 2) | `NONE` (GitHub has no create-PR idempotency key) / `PEP_READ_THEN_ACT` — inside the `repo_id` lock and **before K6**: `GET ref head_ref` must equal `head_sha`; then K6; then `POST /pulls` with title/body bytes read from CAS | `POST` returned 201 with `head.sha == head_sha`, or reconcile `GET /pulls?head=owner:head_ref&state=all` (fully paginated, 200) finds exactly one PR with `head.sha == head_sha` created after `admitted_at` | list read succeeded (200, complete pagination), performed ≥ `pr_settle_window_s` after the last dispatch attempt, finds **zero** PRs for that head_ref created after `admitted_at`, **and** the head_ref currently exists at `head_sha` (otherwise `UNKNOWN(HEAD_MISSING)`); reference adapter declares `no_effect_proof_supported = false` for this operation until measured (U5), so ambiguity after a sent call stays `UNKNOWN` |
| `PR_MERGE` | `{repo_id, pr_number, expected_head_sha, merge_method}` | `NATIVE_PRECONDITION` / `NATIVE_CAS` — the merge API `sha` field; GitHub rejects (409) if the PR head moved | `GET /pulls/{n}` → `merged == true` and `merge_commit_sha` present and PR head at merge == `expected_head_sha` | the merge call returned the target's definitive `409 head mismatch` **and** `GET /pulls/{n}` (200) → `merged == false`; a bare `merged == false` read is `UNKNOWN` |

A PR whose receipt `head.sha ≠ head_sha` can arise only through the §4.6 item 4 residual; if observed it is a `RECEIPT_MATERIAL_MISMATCH` incident (§6.3) and the created PR is left for a policy-governed compensation effect.

**Record service (non-development target, the #89 Vertical B service or any API with the same contract):**

| operation_kind | material | idempotency | COMMITTED | NO_EFFECT_CONFIRMED |
|---|---|---|---|---|
| `RECORD_WRITE` | `{tenant, resource_id, body_digest, body_cas_key, idempotency_key = cadp-v04:<effect_id>}` | `NATIVE_KEY` (must pass the double-dispatch test) | `GET /records?idempotency_key=` (authoritative store read, 200) returns one record whose `body_digest` matches | same read returns none **and** the service's write log query for the key returns none **and** the read is not served from a replica (service must expose `X-Read-Authority: primary` or equivalent; otherwise `UNKNOWN`) |

**Temporal (continuation target, §7)** — exact reference contract:

| operation_kind | material | idempotency | COMMITTED | NO_EFFECT_CONFIRMED |
|---|---|---|---|---|
| `WORK_START` | `{namespace, workflow_type, workflow_id = cadp-work-<effect_id>, task_queue, args_cas_key, args_digest = sha256(cadp-jcs-1(args)), bounds, work_bindings, policy_ref}` — the exact workflow args are the CAS object at `args_cas_key`, read by the PEP at dispatch and passed as the single workflow input; start request also sets memo `{cadp_effect_id, cadp_args_digest}` | `NATIVE_KEY` with `idempotency_horizon = namespace retention` / `NATIVE_CAS` (see below) | **only after** `DescribeWorkflowExecution(workflow_id, run_id)` (persistence-backed, not visibility) returns an execution whose **target-returned** memo has `cadp_effect_id == effect_id` and `cadp_args_digest == args_digest`; the `StartWorkflow` response alone never yields `COMMITTED`; `run_id` is the `target_operation_ref` | `DescribeWorkflowExecution` → `NOT_FOUND` **and** `now < admitted_at + retention` (inside the horizon Temporal's answer is authoritative); outside the horizon `NOT_FOUND` is `UNKNOWN(RETENTION_EXPIRED)` |

Start parameters (Temporal Server 1.31 / SDK semantics):

```text
WorkflowIdReusePolicy    = WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE
                           -> a closed execution with the same workflow_id (within retention) blocks any new start
WorkflowIdConflictPolicy = WORKFLOW_ID_CONFLICT_POLICY_FAIL
                           -> a running execution with the same workflow_id makes StartWorkflow fail;
                              the PEP never uses USE_EXISTING, because "the existing run" must be proven
                              to be this effect via memo, not assumed
```

`StartWorkflow` response mapping:

```text
success (run_id)                                   -> ACCEPTED_TRANSPORT { target_operation_ref = run_id }; NOT yet COMMITTED.
                                                      The PEP then calls DescribeWorkflowExecution(workflow_id, run_id):
                                                        memo matches                  -> COMMITTED (receipt = the Describe response)
                                                        memo differs                  -> RECEIPT_MATERIAL_MISMATCH incident, UNKNOWN(RECEIPT_UNBOUND)
                                                        Describe fails/timeout        -> UNKNOWN -> Reconciler
                                                      The requested memo is never copied into the receipt (requested != observed).
WorkflowExecutionAlreadyStartedFailure             -> AMBIGUOUS; Reconciler: Describe -> memo match ? COMMITTED
                                                      : RECEIPT_MATERIAL_MISMATCH incident (same id, other effect)
gRPC UNAVAILABLE / DEADLINE_EXCEEDED / conn reset  -> AMBIGUOUS -> UNKNOWN -> Reconciler (Describe)
INVALID_ARGUMENT / PERMISSION_DENIED / NOT_FOUND(ns)-> REJECTED_NO_EFFECT { proof = the gRPC status }, since the
                                                      service rejected the request before creating any execution
```

Retention and authority: the namespace `workflowExecutionRetentionPeriod` (reference 30 d) bounds how long Temporal remembers a closed `workflow_id`. After it expires, `REJECT_DUPLICATE` no longer protects and a second `StartWorkflow` with the same id would succeed. Therefore Temporal's dedupe is **only** a within-horizon transport safeguard; the CADP ledger remains the authority: the PEP never admits a next ordinal of a `WORK_START` whose `effect_id` has a `COMMITTED` outcome (regardless of Temporal state), and outside `idempotency_horizon` the operation is treated as `NONE` for §3.4 purposes (no re-dispatch after ambiguity without `NO_EFFECT_CONFIRMED`). Temporal history is likewise never consulted as effect authority (§7.1).

**Constitutional store (policy activation target, §9.4):**

| operation_kind | material | idempotency / dispatch_precondition | COMMITTED | NO_EFFECT_CONFIRMED |
|---|---|---|---|---|
| `POLICY_ACTIVATE` | `{proposed_policy_ref{policy_id, revision, content_digest, issuer_ref}, bundle_cas_ref, expected_active_policy_ref{policy_id, revision, content_digest, seq}}` — a CAS object (`material_schema = cadp.policy-activate.v1`, §6.6) like every other material; `issuer_ref` is set by the Ingress to the effect's stamped `requester_ref` | `NATIVE_PRECONDITION` / `NATIVE_CAS` — **one store transaction**: (1) `INSERT policy_ref … ON CONFLICT (policy_id, revision) DO NOTHING` then verify the row's `content_digest == proposed` (publish-if-absent; a differing existing row aborts as `REJECTED_NO_EFFECT` + incident); (2) `SELECT max seq FOR UPDATE`, require `== expected.seq`, `INSERT policy_activation(seq = expected.seq + 1, expected_prev_seq = expected.seq, …)`; the `UNIQUE(expected_prev_seq)` + `CHECK` constraints reject any insert whose base is no longer the active row | the activation row exists with `seq = expected.seq + 1` and `content_digest = proposed_policy_ref.content_digest` and the `policy_ref` row exists with the same digest | the transaction was rejected (constraint or digest check) **and** a read shows `max(seq) ≠ expected.seq`, a different successor already present, or a conflicting `policy_ref` |

Serialization domain: `policy_activation` (one activation dispatch at a time per deployment). An activation admitted under policy Pₙ carries `expected_active = seq(Pₙ)`; if any other activation lands first, this one can never insert, so a superseded constitution can never be reinstated by a late dispatch.

Receipt binding rule (all targets): a receipt is bound only if at least one target-native field in it is a function of the material (`head_sha`, `merge_commit_sha`, `body_digest`, `args_digest`, `new_sha`). A receipt without such a field cannot produce `COMMITTED`.

### 6.5 Reconciler

- Runs inside the Kernel Service; triggered on start, on dispatch timeout, on `UNKNOWN` write, and by an orchestrator `request_reconcile(effect_id)` call (Temporal timers may schedule the request; the Reconciler decides what to write).
- Bounds are policy-bound: `reconcile_max_attempts`, `reconcile_backoff_s`. After the bound, the effect remains `UNKNOWN`, a `RECONCILE_EXHAUSTED` envelope is written, and the orchestrator is told to route to a policy-defined Human exception branch (§7.5). The Reconciler never dispatches.

### 6.6 Exact material → dispatch bytes (CAS completeness)

Rule: **every byte an adapter sends is reachable from the sealed material — the material object itself is always a CAS object named by K3 `material_ref`/`material_digest` (§2.3; there is no inline material in K3), and any further bytes are `cas://sha256/<hex>` references contained in it.** After sealing, no adapter may consult a mutable URL, a caller workspace, a worker filesystem, or a "latest" lookup to fill effect bytes; recheck #15 (§4.4) verifies that every referenced CAS object exists and re-digests, and the adapter's `dispatch()` receives only `material_bytes` plus the resolved CAS objects.

- **CAS ingress.** `put_blob(bytes)` (§12) is the only way bytes enter CAS: authenticated caller (workflow or worker identity), content-addressed key returned, insert-only, hard-capped at upload by the kernel config `cas_upload_max_bytes` (§5.4; no policy decision exists yet at upload time). The effect-specific `MATERIAL_SIZE_MAX(bytes)` decision constraint is enforced again at admission (§4.4 #10) over the sealed material and every CAS object it references. Uploading a blob confers no authority; a blob becomes effect material only by being referenced from a sealed `EffectRequestV1`.
- **`PR_CREATE`:** `title_cas_key`, `body_cas_key` → exact UTF-8 bytes posted verbatim.
- **`GIT_PUSH`:** the worker's activity harness runs `git bundle create` for `new_sha` (against the admitted `base_sha` boundary) and `put_blob`s it; the material names `bundle_cas_key`. At dispatch the PEP, in an ephemeral bare repository: `git bundle verify`, fetch the bundle, require that the bundle's single tip object **is** `new_sha` and that `new_sha` is a commit whose ancestry reaches `base_sha` (or that the bundle is complete for the ref), then pushes exactly `new_sha:ref` with `expected_old_sha`. Any other object in the bundle is never pushed; a bundle whose tip ≠ `new_sha` is `MATERIAL_INCOMPLETE` (refusal, no admission — the check runs pre-K6 with the precondition read).
- **`WORK_START`:** `args_cas_key` names the exact workflow args; `args_digest` is their `cadp-jcs-1` digest; the PEP passes the CAS bytes as the single workflow input, and the workflow may verify its input against `get_effect_state(work_run_ref).material.args_digest`.
- **`RECORD_WRITE`:** `body_cas_key` → exact bytes.
- **`POLICY_ACTIVATE`:** no exception to the K3 rule. The material object `{proposed_policy_ref, bundle_cas_ref, expected_active_policy_ref}` is serialized as `cadp-jcs-1` bytes, stored in CAS by `put_blob`, and bound through K3 `material_schema = cadp.policy-activate.v1`, `material_ref = cas://…`, `material_digest`. The evaluator and the PEP (recheck #11/#15/#17) re-read those exact bytes from CAS; the nested `bundle_cas_ref` is a second CAS object holding the OPA bundle bytes. Both objects must exist and re-digest, otherwise `MATERIAL_INCOMPLETE` before K6 (C30).

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
- Enforced twice, by different owners, on different quantities: the workflow (commodity) enforces `max_steps` and `deadline` and emits `WORK_BOUND_STOP`; the PEP (kernel) enforces `max_effects` via `MAX_EFFECTS_IN_WORK_RUN` (counting `effect_request` rows whose `work_bindings` include `work_run_ref`) and `deadline` via `NOT_AFTER`. `max_steps` and `max_effects` are distinct bounds (a step may produce zero or several effect requests); a workflow that ignores its step bound can still be starved of effects by the PEP, but the kernel does not count steps.

### 7.4 Continuation identity and restart without duplicate effects

- `work_run_ref = effect_id(WORK_START)`. Every ordinary step is a Temporal activity with a deterministic `step_ordinal`.
- Each step emits `EvidenceEnvelopeV1(evidence_kind = WORK_STEP)` with `subject_bindings = [work_run_ref, step input digest, step output digest]` and `claim.prior_step_envelope_digest` — a causal chain reconstructable from the store alone. **Replay-idempotent ingress contract:** `submit_evidence(WORK_STEP)` does **not** allocate an `evidence_id` first. Under a short lock on `(work_run_ref, step_ordinal)` the Ingress (1) looks up the existing `WORK_STEP` for that tuple (§3.2 partial index); (2) if one exists and its **semantic payload** equals the submission — semantic payload = `cadp-jcs-1({subject_bindings, claim_schema, claim, availability, unknown_reason})`, i.e. everything except Ingress-allocated identity and times — it returns the existing `EvidenceEnvelopeV1` and `evidence_id` unchanged (no new row, no incident); (3) if one exists and the semantic payload differs, it rejects with `WORK_STEP_CONFLICT`, writes `KERNEL_INCIDENT(WORK_STEP_CONFLICT)` bound to `work_run_ref`, and the scope hold (§2.6) stops further effects of that run until released; (4) only if none exists does it allocate `evidence_id` and insert. A Temporal replay or activity retry that re-submits the same logical step therefore converges on the same envelope and never produces an incident (C33). Reconstruction reads exactly one envelope per ordinal.
- Effect identity across replay: the workflow requests `allocate_effect_id(allocation_key)` where

  ```text
  allocation_key = "cadp-v04:alloc:" + sha256( cadp-jcs-1( {
      "schema":        "cadp.allocation-key.v1",
      "work_run_ref":  <string, the WORK_START effect_id>,
      "step_ordinal":  <integer, no leading zeros, ≥ 1>,
      "purpose":       <string from the closed vocabulary declared in the policy bundle: data.cadp.allocation_purposes>
  } ) )
  ```

  Raw concatenation is prohibited: the tuple is a versioned canonical JSON object (RFC 8785 field ordering, typed values), so component boundaries and types are unambiguous and a future `v2` tuple cannot collide with `v1`. The Ingress recomputes the key from the submitted tuple (the caller sends the tuple, not the hash) and rejects unknown `purpose` values. The Ingress returns the same `effect_id` for the same key (§2.2). After a restart, replayed code asks for the same key and receives the same `effect_id`; the store then tells it whether a request, decision, admission, or outcome already exists. **No step ever creates a second logical effect for the same purpose.**
- Before requesting any admission, the workflow's activity reads `get_effect_state(effect_id)` from the kernel and branches on durable rows (Spec §6.3 restated): `COMMITTED` → continue with the committed result; `NO_EFFECT_CONFIRMED` → may request the next admission; `UNKNOWN`/unresolved → wait for reconcile / policy exception. Temporal retry policies are configured to retry **activities that read**, never the dispatch (dispatch is not an activity of the worker at all; it happens inside the PEP).

### 7.5 Human appears only where policy says so

`REQUIRE_EVIDENCE` with a `HUMAN_DECISION` reason code makes the workflow wait on a signal; the Human interaction product (§9.3) submits the envelope; the workflow assembles a new `AdmissionInputV1`. No Human relays messages, SHAs, run ids, receipts or next-step data: all of those are kernel rows or target facts the workflow reads itself.

---

## 8. D8 — Worker / reviewer / verifier integration

### 8.1 Worker (implementation) boundary

- Runs as a Temporal activity in a worker pod (identity `spiffe://…/cadp/worker/<product>`), sandboxed, network denied except the Kernel API.
- Input: `work_bindings` (exact input identity + digest), base revision (`base_sha`), workspace materialized **by the activity harness at exactly `base_sha`** (fresh clone/checkout; never a reused dirty tree — the #89 dirty-tree lesson), worker profile (pinned argv; #89 recorded the `--sandbox`/profile trap, so the exact argv is part of `worker_profile_digest`).
- Output: candidate artifact identity (`candidate_sha`) in the **worker-local** repository + a `WORK_STEP` envelope. The worker cannot push: the activity harness `put_blob`s a `git bundle` of `candidate_sha` (§6.6) and the workflow seals a `GIT_PUSH` request naming `bundle_cas_key`; the PEP verifies the bundle reproduces exactly `candidate_sha` and pushes only that. This closes #89 finding 2 (push outside the gate).
- Execution identity: the backend-identity adapter (§9.2 / #91) scans the worker's session log and emits `BACKEND_EXECUTION` evidence with per-field `{availability, value, locator}`; absent facts are `UNKNOWN`.

### 8.2 Verifier boundary

- Reference: GitHub Actions workflow triggered on the pushed candidate ref, `permissions: contents: read`, checkout **by sha**. The verification adapter reads the run via API and emits `VERIFICATION` evidence with `subject_bindings = [repo_id + candidate_sha]` from the run's `head_sha` **as reported by GitHub**, not from the workflow's own log.
- Single-host harness alternative (measured in #89): `node --test` executed by a verifier process on a fresh clone at `candidate_sha`; the adapter records the clone's `HEAD` and `git status --porcelain` emptiness as part of the claim; a dirty tree ⇒ `UNKNOWN(DIRTY_WORKSPACE)`, never PASS.

### 8.3 Reviewer boundary

- Reference: a second product surface (measured #90: Claude Code plan-mode, read-only, network denied) reviewing the exact committed diff at `candidate_sha`; the review adapter emits `REVIEW` evidence with `subject_bindings = [repo_id + candidate_sha]`, `claim = { verdict, body_digest, reviewer_product, reviewer_run_id }`, `producer_ref` = reviewer identity.
- GitHub-native review (human or app) is read via API: `commit_id` becomes the subject binding; the PEP compares it to the effect's candidate (#90: the product does not do this comparison; the gate must).

### 8.4 Independence and separation

Policy expresses separation as predicates over `producer_ref` and `identity_class(envelope) := identity_registry[envelope.producer_ref].identity_class` (vendor/product/account/process_class; §9.1 — a pure function of the K2 envelope and the active policy content, never read from the claim and never supplied by the Ingress): e.g., `producer_ref(REVIEW) ≠ producer_ref(WORK_STEP implementation)` and `identity_class.product ≠`. The kernel supplies the exact identities; it does not rank or score them. A single-product deployment that cannot satisfy the predicate fails closed (the case #90 did not measure).

No fixed Supervisor/Actor/Auditor role exists. "Requester", "implementer", "reviewer", "verifier" are just distinct `producer_ref`s in evidence.

---

## 9. D6 + D9 — Evidence ingress, provenance, Human decision, genesis, break-glass

### 9.1 Evidence ingress

- API: `submit_evidence(draft)` over the Kernel API. Authentication: workload identity (mTLS/SPIFFE) for machine adapters; IdP-signed JWT (SSO) for Human decision submissions. The Ingress **stamps** `producer_ref` from the authenticated identity; a draft whose declared producer differs is rejected.
- `provenance.integrity` is set by the Ingress, never by the submitter: `AUTHENTICATED_SOURCE` for authenticated channels; `SIGNED_ATTESTATION` only when the draft carries a signature/attestation the Ingress verifies against a key listed in the active policy bundle (`data.cadp.attestation_keys`; e.g., GitHub artifact attestations, Sigstore); `UNATTESTED` otherwise.
- `provenance.source_relation` is declared by the adapter class and checked against the **adapter registry**, a policy-bound document (`data.cadp.adapter_registry`) mapping each exact `producer_ref` (string equality, no patterns — §5.4) → allowed `source_relation` and `evidence_kind`s. A producer claiming a relation the registry does not allow is rejected. The registry is configuration under policy digest, not a trust score.
- **K2 `claim` is never touched by the Ingress.** `claim` is the source-native payload exactly as the adapter submitted it (`PRESENT`), or absent (`UNKNOWN`, with `unknown_reason`). The Ingress adds nothing to it and reserves no keys inside it. Everything the Ingress knows about an envelope is carried by K2's own top-level fields (`producer_ref`, `provenance`, `produced_at`, `source_ref`) or by **implementation metadata columns** on `evidence_envelope` (§3.2) that are outside the K2 record and outside its digests.
- **Source-time authority is a derivation, not metadata (S1, r5 option A).** K2 `produced_at` is the only time policy ever sees. Whether it is source-authoritative is decided by the **policy-bound adapter contract**: `adapter_registry[producer_ref].produced_at_source` is either `{kind: SOURCE, claim_pointer}` — the claim field (RFC 6901 pointer into the source-native `claim`, e.g. `/completed_at` for `cadp.verification.github-actions.v1`) that *is* the source's own timestamp — or `{kind: NONE}`. **Ingress rule at seal time:** for a `SOURCE` contract and `availability = PRESENT`, the draft is rejected unless `claim[claim_pointer]` exists and `produced_at == claim[claim_pointer]` exactly; the source timestamp therefore lives inside the source-native claim, untouched, and `produced_at` is a copy of it, both under `claim_digest`/`envelope_digest`. For `NONE`, or for `availability = UNKNOWN` (no claim), the Ingress fills `produced_at` with its receipt time. **Derivation:** `source_time_authority(envelope, active_policy) := SOURCE` iff the active `adapter_registry` entry for `envelope.producer_ref` declares `SOURCE` **and** the envelope is `PRESENT` **and** `produced_at == claim[claim_pointer]`; otherwise `NONE`. The policy computes this itself from `input.evidence[]` and `data.cadp.adapter_registry`; the PEP computes it identically for recheck #16. Nothing is stored for it and nothing is passed for it. That the claim field faithfully reflects the raw source is an adapter-conformance property (locator replay, §13.3), not an Ingress assertion.
- **`received_at` is never policy material.** The Ingress records its receipt time only in the implementation column `evidence_envelope.received_at` for operations/forensics. It is not in K2, not in any digest, not in the `ResolvedAdmissionBundle`, and there is no constraint or predicate over it (the r3/r4 `INGRESS_MAX_AGE` idea is withdrawn). Re-ingesting an old artifact under a `SOURCE` contract yields its old `produced_at`; under a `NONE` contract it yields a fresh `produced_at` that derives to `NONE` and satisfies no freshness requirement (C27). Corrupting `received_at` changes no decision (C38).
- **`identity_class` is a derivation, not metadata (S2).** K2 `producer_ref` is stamped from the authenticated principal (exact match in the active policy's `identity_registry`; unregistered principals cannot submit). `identity_class(envelope) := identity_registry[envelope.producer_ref].identity_class` under the **active** policy — computed by the policy from `data.cadp.identity_registry` and by the PEP identically; it is not a field of any record and is not supplied by the Ingress. Adapters and drafts cannot set, override or supplement the class; any class-shaped field at a draft's top level is rejected, and anything inside `claim` is opaque source payload with no kernel meaning (C28). The former draft field `reviewer_identity_class` is removed.
- **K4 completeness (r5).** The evaluator's input is exactly `{AdmissionInputV1, EffectRequestV1, EvidenceEnvelopeV1[]}` (§5.1) under the K4-bound `policy_ref`. Both derivations above are pure functions of that input plus policy content; there is no other channel. Hence a decision is a function of exactly `input_digest` + `policy_ref.content_digest` + Kernel `now` (reflected in K5 `decided_at`) — nothing else (C38).
- **Requester provenance (S3).** `EffectRequestV1.requester_ref` is likewise stamped by the Ingress from the authenticated caller of `seal_effect_request`; a draft whose declared `requester_ref` differs is rejected.

### 9.2 Reference evidence adapters (thin conformance edges)

| evidence_kind | source | subject bindings | claim schema (native, not flattened) | relation |
|---|---|---|---|---|
| `VERIFICATION` | GitHub Actions run / harness run | `repo_id + sha` | `cadp.verification.github-actions.v1` `{run_id, head_sha, conclusion, workflow_file_digest, started_at, completed_at}` | `INDEPENDENT_OBSERVATION` |
| `REVIEW` | GitHub PR review / second-surface reviewer | `repo_id + commit_id` | `cadp.review.v1` `{verdict, body_digest, reviewer_run_id?}` (identity class derived from `producer_ref`, §9.1) | `INDEPENDENT_OBSERVATION` or `SELF_REPORT` (if producer == implementer) |
| `BACKEND_EXECUTION` | worker session logs (#91 method: scan, don't address) | `work_run_ref + step` | `cadp.backend.v1` `{ requested: {...}, observed: { model: {availability, value?, locator?}, provider: {...}, run_id: {...}, version: {...}, effort: {...} } }` | `SELF_REPORT` (backend self-reports; #91 U1) |
| `HUMAN_DECISION` | SSO approval surface (§9.3 path A; the only reference path) | exact `effect_id` or `work_run_ref` + `target_ref` + `material_digest` | `cadp.human-decision.v1` (§9.3) | `INDEPENDENT_OBSERVATION` |
| `TARGET_RECONCILIATION` | target adapters (§6) | `effect_id + admission_digest` | target-native receipt/proof | `TARGET_AUTHORITY_OBSERVATION` |
| `PEP_TARGET_IDENTITY`, `CREDENTIAL_REACH_ATTESTATION`, `TARGET_IMMUTABILITY_ATTESTATION`, `KERNEL_INCIDENT`, `WORK_STEP`, `WORK_BOUND_STOP`, `GENESIS`, `BREAK_GLASS`, `LEGACY_V03_ARTIFACT` | kernel / deployment control / importer | as defined in their sections | | |

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

- **Effect-scoped approval requires the effect to exist first.** An effect-scoped `HUMAN_DECISION` is accepted only if the `EffectRequestV1` it names was sealed **before** the decision was issued and the Human was shown that exact identity. The adapter never post-fills `scope.effect_id` from context; a decision whose surface did not present the effect id is at most `UNATTESTED` context evidence and cannot satisfy §4.4 #5.
- **Reference path A (conformance path for effect-scoped approvals): SSO approval surface.** Exact order (K4 requires the effect to exist before any evaluation): `seal_effect_request` (the merge/other effect now has an `effect_id` and `request_digest`) → `assemble_admission_input` **without** Human evidence → `evaluate` → `REQUIRE_EVIDENCE(HUMAN_DECISION)` → the approval page renders, from the kernel's `get_effect_state`, the `effect_id`, `request_digest`, `target_ref`, `material_digest`, `candidate_sha` and a link to the candidate diff → the Human approves → the page POSTs the envelope with `scope = {effect_id, target_ref, material_digest, candidate_sha}` copied from what was rendered, plus `presented_request_digest` → the Ingress verifies the authenticated principal, that `effect_request(effect_id).request_digest == presented_request_digest`, and that `issued_at > effect_request.requested_at`; otherwise reject → the workflow assembles a **new** `AdmissionInputV1` including this envelope → fresh `evaluate` → `ALLOW` → `admit_and_dispatch` (K6). The Human decision thus binds an `effect_id`/`request_digest` that already existed before the first evaluation; nothing about the effect changes between the two evaluations except the added evidence.
- **GitHub-native review is not an effect-scoped Human decision in the reference path.** A GitHub PR review natively binds `commit_id`, not a CADP effect, and posting a binding notice onto the PR would itself be an external repository mutation outside `admit_and_dispatch`. Therefore in r3 the reference path has **exactly one** effect-scoped Human surface, path A. GitHub reviews by humans continue to enter as `REVIEW` evidence (§9.2, subject = `commit_id`), which policy may require in addition to the path-A decision. A future "binding notice as its own governed effect" (`GH_CHECK_RUN_POST` with its own `EffectRequestV1`, admission and receipt) is a non-reference option recorded as U9; it is not designed here.
- Slack buttons or issue comments without authenticated principal binding are not accepted as `HUMAN_DECISION`.
- Scope is mandatory; the PEP check §4.4 #5 makes a decision unusable for any other effect. Idempotent recovery of the **same** `effect_id` may reference the same decision; a new `effect_id` needs a new decision.
- Freshness: policy `EVIDENCE_MAX_AGE(HUMAN_DECISION, …)`.

### 9.4 Genesis, policy change, break-glass

**Genesis (out-of-band, root authority):**
1. Root operator creates namespace resources: DB schema `k04`, Temporal namespace `cadp-v04`, secret path `secret/cadp-v04/pep/*`, PEP workload identity, network policies.
2. Builds the genesis OPA bundle with `.manifest.revision = manifest_revision` (§5.2); computes `content_digest` and `payload_digest` under the fixed bootstrap set `cadp-bootstrap-1` (§2.1); writes `policy_ref(policy_id=cadp-v04:policy:root, revision=1, issuer_ref = root key id)` — the root genesis procedure is the only publication path other than `POLICY_ACTIVATE` dispatch (§1, §9.4).
3. Signs a genesis document `{policy_ref, issuer_ref = root key id, pep_identity, secret_path, bootstrap_set_digest, created_at}` with the offline root key; stores it in CAS; the Ingress, validating with the bootstrap set and the root public key(s) loaded from `secret/cadp-v04/root/pubkeys`, seals it as `GENESIS` evidence (`SIGNED_ATTESTATION`).
4. Inserts `policy_activation(seq=1, expected_prev_seq=0)` referencing that envelope. From this row on, scheme approval comes from the active policy (§2.1).
5. Places PEP credentials in the secret path. No agent/model participates.

**Policy change (ordinary) — publication and activation are one governed effect.** There is no API that inserts an inactive `policy_ref` row; the only ordinary publication path is the `POLICY_ACTIVATE` dispatch itself:

```text
build bundle (offline or in a workflow)             -> put_blob(bundle bytes) -> bundle_cas_ref        (no authority conferred)
seal EffectRequestV1(operation_kind = POLICY_ACTIVATE,
     target_ref = cadp-store:k04 policy_activation,
     material = { proposed_policy_ref{policy_id, revision = active.revision+1, content_digest, issuer_ref := requester_ref},
                  bundle_cas_ref,
                  expected_active_policy_ref = active row incl. seq })
evaluate under the CURRENT policy (may REQUIRE_EVIDENCE(HUMAN_DECISION))
admit: recheck #13 (expected_active still active) + #17 (bundle re-digests, manifest/payload match, kernel-config valid, no conflicting policy_ref)
dispatch (store adapter, one transaction, §6.4): publish-if-absent policy_ref  +  activation predecessor+1
COMMITTED  -> the new policy is active; the policy_ref row and the activation row were written together
```

Who may publish: the store adapter inside K6 → dispatch; the root genesis procedure (seq = 1); and the root listener executing a signed `BREAK_GLASS(ACTIVATE_POLICY)` (same checks, same one-transaction publish + activation, below). Nothing else. `issuer_ref` = the stamped `requester_ref` of the admitted effect (genesis: root key id). Duplicate `(policy_id, revision)` with identical bytes is idempotent; with different bytes it is `POLICY_REF_CONFLICT` (refused pre-K6 by #17, or `REJECTED_NO_EFFECT` + incident if raced). Two activations admitted under the same base cannot both land; the loser gets `REJECTED_NO_EFFECT` and needs a new effect against the new base. A bundle that is never activated is never published — there is no inactive `policy_ref` state to reason about.

**Reference root signature profile (`cadp-sig-1`).** Algorithm Ed25519 (RFC 8032). `key_id = "ed25519:" + sha256(public_key_bytes)[:32 hex]`. Signed bytes = `"cadp-v04:sig-1:" || <document_kind ∈ {GENESIS, BREAK_GLASS}> || 0x00 || cadp-jcs-1(document)` — the domain separator prevents cross-kind replay. The signature travels in the envelope draft as `signature = {profile:"cadp-sig-1", key_id, sig_base64}`; the Ingress verifies against `root_public_keys` (§5.4; at genesis, against the bootstrap set) selecting the key by `key_id`. **Two distinct checks (r6):**

- **Historical verification** (re-verifying an already-recorded `GENESIS`/`BREAK_GLASS` envelope, e.g. verify-on-read, audit, reconstruction): the key that signed it must have been valid at the document's time — `valid_from ≤ document.created_at ≤ valid_to` against the `root_public_keys` set that was active **when the envelope was recorded**. This never confers authority to do anything new.
- **Execution authorization** (accepting a **new** root operation on the root listener): the signing key must be authorized **at execution time**, not merely at the claimed document time. Required, all of: (a) `key_id` exists in the **currently active** policy's `root_public_keys`; (b) `valid_from ≤ document.created_at ≤ now`; (c) `now ≤ key.valid_to` when `valid_to` exists; (d) `created_at ≤ now < expires_at`; (e) `expires_at − created_at ≤ break_glass_max_lifetime_s` (§5.4). A backdated `created_at` therefore cannot revive a revoked or expired key: (c) is evaluated against `now`, never against `created_at` (C40).

**Rotation:** a new root key is added and an old one given a `valid_to` by an ordinary `POLICY_ACTIVATE` (or a `BREAK_GLASS` signed by a key that passes the execution-authorization check at that moment); historical envelopes remain verifiable under the historical rule. **Revocation** = `valid_to` in the past or removal from `root_public_keys`; from that instant the key authorizes no new root operation regardless of any `created_at` a document claims. Root signing never happens inside the Kernel Service process.

**Root surfaces are not workload APIs.** `GENESIS` and `BREAK_GLASS` — the only two signed document kinds in `cadp-sig-1`; there is no standalone `INCIDENT_RELEASE` document — are accepted only by the root listener (§12: separate mTLS listener bound to the root identity, disabled by default and enabled only during a root operation); the ordinary API rejects those evidence kinds regardless of caller.

**Root/break-glass — signed document `cadp.break-glass.v1`:**

```text
cadp.break-glass.v1 {
  principal, reason, scope, created_at, expires_at
  actions: subset of { ACTIVATE_POLICY, RELEASE_INCIDENTS }        (non-empty)
  -- ACTIVATE_POLICY:
  proposed_policy_ref      { policy_id, revision, content_digest }   (issuer_ref := signing key_id, set by the root listener)
  bundle_cas_ref                                                     (bytes already put_blob'd; any caller may upload)
  expected_active_policy_ref { policy_id, revision, content_digest, seq }
  -- RELEASE_INCIDENTS:
  release_incident_refs[]  { evidence_id, envelope_digest }
}
```

Root listener procedure (§12), on receipt of the envelope draft with its `cadp-sig-1` signature:

1. apply the **execution-authorization** check of `cadp-sig-1` (above): `key_id` present in the **currently active** policy's `root_public_keys` (the key set the proposed bundle may change is never used to authorize its own introduction), `valid_from ≤ created_at ≤ now`, `now ≤ valid_to` if present, `created_at ≤ now < expires_at`, lifetime ≤ `break_glass_max_lifetime_s`; a key expired or revoked at `now` fails here whatever `created_at` claims (C40);
2. if `ACTIVATE_POLICY`: run **exactly the ordinary publication checks** of recheck #17 on `bundle_cas_ref`/`proposed_policy_ref` — raw re-digest, `payload_digest` and `.manifest.revision` match, `cadp.kernel-config.v1` validation, bootstrap-scheme retention (§2.1), no conflicting `policy_ref(policy_id, revision)`; and require `expected_active_policy_ref` (incl. `seq`) to equal the active row;
3. if `RELEASE_INCIDENTS`: every ref must resolve to an open `KERNEL_INCIDENT` with matching `envelope_digest`;
4. execute **one store transaction** under the `policy_activation` serialization lock: seal the `BREAK_GLASS` `EvidenceEnvelopeV1` (`SIGNED_ATTESTATION`, `producer_ref` = root key_id) → if `ACTIVATE_POLICY`: publish-if-absent `policy_ref` (`issuer_ref` = root key_id; an existing row with a different digest aborts) → `SELECT max seq FOR UPDATE`, require `== expected.seq`, `INSERT policy_activation(seq = expected.seq + 1, expected_prev_seq = expected.seq, activated_by_ref = root key_id, activation_evidence_id = this envelope)` → commit;
5. on any failure in 1–4 the transaction rolls back **entirely** (no `BREAK_GLASS` envelope, no `policy_ref` row, no activation row — no inactive `PolicyRefV1` can remain) and the root listener writes a `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)` envelope naming the signed document's digest and the reason; a stale `expected_active`/`seq` or a digest mismatch is therefore fail-closed with zero publication (C39).

Properties: the new policy's identity and content are exactly what the root signed (`proposed_policy_ref.content_digest` over the CAS bytes); root-key rotation is just an `ACTIVATE_POLICY` whose bundle carries a new `root_public_keys` set, signed by a key valid under the outgoing set; reactivating an already-published `PolicyRefV1` is the same action with `publish-if-absent` idempotently finding the identical row. This is a root operation, **not** a governed effect: no `EffectRequestV1`, no K6, no K7, no policy evaluation — the activation row's `activated_by_ref = root key_id` distinguishes it from ordinary `POLICY_ACTIVATE` rows (`activated_by_ref = pep_ref`). `BREAK_GLASS` **cannot** admit an ordinary effect, rewrite any outcome, or be used by workers. It is append-only evidence like everything else.

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
| Human interaction | SSO approval page (path A) for every effect-scoped `HUMAN_DECISION`; GitHub PR review enters only as `REVIEW` evidence | #89 B3 approval bound to resource | any product producing §9.3 envelopes with pre-sealed effect identity |

**Explicitly unavailable / unmeasured capabilities** (stay `UNKNOWN`, never assumed): Devin's own surface; signed/attested backend identity (both backends self-report, #91); OPA signed-bundle verification path; Temporal multi-worker/parallel semantics; GitHub PR-create idempotency (none exists; handled as `NONE`).

---

## 12. Kernel API surface and caller contract (not a new lifecycle)

```text
put_blob(bytes)                                           -> cas_key                  (content-addressed, insert-only)
allocate_effect_id(allocation_tuple)                      -> effect_id                (idempotent on the canonical tuple)
seal_effect_request(draft)                                -> EffectRequestV1          (requester_ref stamped; or conflict)
submit_evidence(draft)                                    -> EvidenceEnvelopeV1       (producer_ref stamped; produced_at rule §9.1; WORK_STEP idempotent, §7.4)
assemble_admission_input(effect_id, policy_ref, evidence_refs[]) -> AdmissionInputV1
evaluate(input_digest)                                    -> PolicyDecisionV1 | REQUIRE_EVIDENCE | EVALUATION_UNAVAILABLE
admit_and_dispatch(effect_id, decision_id)                -> { admission, outcome } | refusal(reason)
get_effect_state(effect_id)                               -> { request, inputs[], decisions[], admissions[], outcomes[] }
request_reconcile(effect_id)                              -> ack
list_effects(work_run_ref)                                -> effect_ids[]
```

Ten calls. There is no task, attempt, batch, pending-decision, profile or **policy-publication** endpoint (a `PolicyRefV1` is published only inside a `POLICY_ACTIVATE` dispatch, by root genesis, or by a root-signed `BREAK_GLASS(ACTIVATE_POLICY)` on the root listener, §9.4 — the latter two are root operations, not effects). `admit_and_dispatch` is the only call that can cause an external effect, and it is the only path that inserts `effect_admission`.

**Caller / authentication / reach matrix (reference deployment, S3).** Every call is authenticated by workload identity (mTLS/SPIFFE) or, for Human surfaces, an IdP-signed JWT; the Ingress maps the principal through `identity_registry` (§5.4) and rejects unregistered principals. Reach is enforced by the Kernel Service, not by network position.

| Method | workflow / orchestrator identity | worker / reviewer / verifier identity | evidence adapters (CI, target reconciler, deployment control) | Human SSO surface | root identity |
|---|---|---|---|---|---|
| `put_blob` | yes | yes | yes | no | no |
| `allocate_effect_id` | yes | no | no | no | no |
| `seal_effect_request` | yes (`requester_ref` = caller) | no | no | no | no |
| `submit_evidence` | `WORK_STEP`, `WORK_BOUND_STOP` | `BACKEND_EXECUTION`, `REVIEW`, `VERIFICATION` (as registered) | kinds as registered (`VERIFICATION`, `TARGET_RECONCILIATION`, `CREDENTIAL_REACH_ATTESTATION`, `TARGET_IMMUTABILITY_ATTESTATION`, `LEGACY_V03_ARTIFACT`) | `HUMAN_DECISION` only | `GENESIS`, `BREAK_GLASS` — **root listener only**; a `BREAK_GLASS(ACTIVATE_POLICY)` is the sole non-effect path that publishes a `PolicyRefV1` (§9.4 procedure, one transaction) |
| `assemble_admission_input` | yes | no | no | no | no |
| `evaluate` | yes | no | no | no | no |
| `admit_and_dispatch` | yes | **no** | no | no | no |
| `get_effect_state` | yes | yes (read-only) | yes (read-only) | yes (read-only, for rendering) | yes |
| `request_reconcile` | yes | no | yes (deployment control) | no | yes |
| `list_effects` | yes | yes (own `work_run_ref` only) | no | no | yes |

Why this is safe even where callers are untrusted: no method grants authority. A worker that could call `admit_and_dispatch` would still need a sealed request, an evaluator decision under the active policy, fresh evidence and the PEP's fresh recheck; the matrix removes the *ordering* ambiguity (a worker cannot seal requests or ask for admission at all), not the constitutional gate. `requester_ref`, `producer_ref` and `identity_class` are always stamped from the authenticated principal, never accepted from the body. The root listener is a separate mTLS endpoint bound to the root identity certificate, disabled by default and enabled only for the duration of a root operation; ordinary listeners reject `GENESIS`/`BREAK_GLASS` unconditionally (C29).

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
| C20 | admission→dispatch drift (GitHub) | request `PR_CREATE` for candidate ref at SHA A; (i) a governed `GIT_PUSH` attempts to move that candidate ref to SHA B; (ii) an admin-scoped non-PEP token attempts to move/delete it; (iii) the test pauses the PEP **after** the precondition GET and **before** `POST /pulls` and again attempts (ii) | (i) refused at admission (write-once rule); (ii) rejected by the attested ruleset, probe recorded in `TARGET_IMMUTABILITY_ATTESTATION`; (iii) rejected by the ruleset — POST proceeds with `head.sha == A`; then the test **edits the ruleset** to allow the move: the next attestation reports failure → `PR_CREATE.available = false` → admission refused, **no POST**, PR delta 0. If the ruleset is edited inside the attestation window and the move succeeds during the pause, the created PR shows `head.sha == B` and a `RECEIPT_MATERIAL_MISMATCH` incident + scope hold is asserted (§4.6 item 4 residual, reported as such, not as PASS) |
| C21 | admission→dispatch drift (generic CAS) | admit `GIT_PUSH` with `expected_old_sha = X`; move the ref to Y out-of-band; dispatch | target rejects (`NATIVE_CAS`) → `REJECTED_NO_EFFECT`; ref remains Y; no admission of a next ordinal without new material |
| C22 | policy activation reorder | active P1 (seq 1); admit A: P1→P2 (`expected seq=1`) and B: P1→P3 (`expected seq=1`); dispatch B then A | B: `COMMITTED`, seq 2 = P3; A: `current.seq (2) ≠ expected (1)` → `REJECTED_NO_EFFECT`; `max(seq)` stays 2, active remains P3 |
| C22b | activation recovery after a rejected stale insert (positive control) | after C22, seal fresh A′: P3→P2 with `expected seq=2`, evaluate under P3, dispatch | inserted as **seq 3**, `expected_prev_seq = 2`; no gap; active = P2. (With a sequence-generated `seq` this control fails — the r2 `bigserial` defect.) |
| C23 | allocation key ambiguity | tuples `{run R, step 12, purpose "a"}` vs `{run R, step 1, purpose "2a"}`; malformed `step_ordinal` (`"01"`, float); unknown purpose | distinct keys; malformed tuples rejected by the Ingress; no `effect_allocation` row for rejects |
| C24 | Human approval without effect binding | (i) SSO POST whose `presented_request_digest` ≠ current; (ii) a GitHub PR review (human) presented as `HUMAN_DECISION`; (iii) an adapter attempts to post-fill `scope.effect_id` | (i) Ingress rejects; (ii) sealed only as `REVIEW` evidence, never as `HUMAN_DECISION`; admission requiring `HUMAN_DECISION` refused; (iii) adapter conformance FAIL — no envelope with `scope.effect_id` exists that the Human surface did not present |
| C25 | Temporal dedupe horizon | `WORK_START` `COMMITTED`, workflow closed, retention expired (test namespace with 1 min retention); orchestrator requests a next ordinal | admission refused: `effect_id` already `COMMITTED`; no second execution created; `Describe NOT_FOUND` recorded as `UNKNOWN(RETENTION_EXPIRED)`, never `NO_EFFECT_CONFIRMED` |
| C26 | OPA revision mismatch | `POLICY_ACTIVATE` whose bundle `.manifest.revision` does not match its recomputed `payload_digest`, or a query while OPA still reports the previous `active_revision` | admission refused at recheck #17 (no `policy_ref` row written); Sealer refuses (`EVALUATOR_INTEGRITY_FAILURE` incident); no `PolicyDecisionV1` sealed |
| C27 | re-ingested stale evidence (S1) | a CI run completed 10 days ago submitted now (a) by a producer whose registry entry is `produced_at_source = NONE`, (b) by a producer with `SOURCE /completed_at` and `produced_at` copied from the claim, (c) as (b) but with `produced_at` set to now; policy `EVIDENCE_MAX_AGE(VERIFICATION, 3600)` | (a) sealed, derives to `NONE` → freshness `UNKNOWN` → `DENY required_fact_unknown`; (b) sealed, derives to `SOURCE`, age 10 d → `DENY`; (c) Ingress rejects (`produced_at ≠ claim[/completed_at]`); K2 `claim` bytes identical in (a)/(b); PR delta 0 |
| C28 | identity_class self-assertion (S2) | reviewer principal P (registry: product X) submits a draft with a top-level `identity_class.product = Y` and another with the same inside `claim`; separately, the implementer principal submits a review draft | top-level class field rejected; the in-claim value is stored as opaque payload and ignored — `identity_class(envelope)` for P is derived as product X from the active registry by policy and PEP alike; independence predicate `product ≠` evaluates on derived classes → `reviewer_is_the_implementer` when P is the implementer; PR delta 0 |
| C29 | API reach (S3) | worker identity calls `seal_effect_request`, `admit_and_dispatch`; a workflow identity submits `GENESIS`; a draft carries a foreign `requester_ref` | all rejected (`FORBIDDEN_FOR_PRINCIPAL`); `GENESIS` rejected on the ordinary listener even with a valid root signature; `requester_ref` mismatch rejected; store row counts unchanged |
| C30 | material completeness (S4) | `PR_CREATE` whose `body_cas_key` was never uploaded; `GIT_PUSH` whose bundle tip ≠ `new_sha`; `WORK_START` whose `args_cas_key` bytes re-digest ≠ `args_digest`; `POLICY_ACTIVATE` whose material CAS object (`material_ref`) is deleted or corrupted, and separately whose nested `bundle_cas_ref` object is deleted | refusal `MATERIAL_INCOMPLETE` before K6 in all five; no admission; PR delta 0, ref unchanged, no workflow; **no `policy_ref` publication and no `policy_activation` append** |
| C31 | kernel config fail-closed (S5) | `POLICY_ACTIVATE` with a bundle missing `reach_attestation_max_age_s`; with `decision_ttl_s = 0`; with unknown key `data.cadp.extra`; with a registry entry using a wildcard principal | admission refused at recheck #17 in all four; no `policy_ref` row; active policy unchanged |
| C32 | AdmissionInput exactness (S6) | assemble twice with identical refs 1 s apart; evaluate the first; present the second `input_digest` to `admit_and_dispatch` with the first decision | two `admission_input` rows, two digests; refusal `DECISION_INPUT_MISMATCH`; admission only with the matching pair |
| C33 | WORK_STEP replay vs conflict | (i) Temporal replays the activity and re-submits the same logical step `(R, 2)` with the same semantic payload; (ii) a different payload for `(R, 2)` | (i) the same `evidence_id`/envelope is returned, exactly one row, **no incident**, the run continues (P4 restart path depends on this); (ii) `WORK_STEP_CONFLICT`, incident bound to R, next effect of R refused (scope hold) |
| C35 | PolicyRef publication authority | (i) attempt to insert a `policy_ref` row through any API other than `POLICY_ACTIVATE` dispatch/genesis; (ii) `POLICY_ACTIVATE` with a `bundle_cas_ref` whose bytes re-digest ≠ `proposed_policy_ref.content_digest`; (iii) two `POLICY_ACTIVATE`s proposing the same `(policy_id, revision)` with different bytes | (i) no such API — 404/`FORBIDDEN_FOR_PRINCIPAL`, row count unchanged; (ii) refused pre-K6 (#17); (iii) first `COMMITTED` (row published + activated atomically), second `POLICY_REF_CONFLICT`; never an inactive `policy_ref` row |
| C36 | pre-K6 refusal succession | after a `DISPATCH_PRECONDITION_FAILED` refusal, seal a successor (a) without `prior_effect_refs`, (b) naming the refused request in `prior_effect_refs` | (a) admitted normally; (b) refused `PRIOR_REF_NOT_AN_EFFECT` — the refused request has no admission and is not an effect |
| C37 | UNKNOWN envelope stays claim-less | submit a `BACKEND_EXECUTION` draft with `availability = UNKNOWN` | stored envelope has no `claim`/`claim_digest`, has `unknown_reason`; `received_at` exists only as an impl column; `source_time_authority` derives to `NONE`; K2 schema validation passes |
| C38 | K4 complete-input binding | take an admitted input I with decision D; (i) overwrite `evidence_envelope.received_at` for every referenced envelope (test-only DB write); (ii) overwrite any other non-K1–K7 row/column the harness can reach; (iii) change a K4-bound fact (re-seal one envelope with a different `produced_at`) | (i)(ii) re-evaluation of the same `input_digest` under the same `policy_ref` with the same `now` yields a byte-identical `RawDecision` and the PEP recheck outcome is unchanged; (iii) the changed envelope has a new `envelope_digest`, the old input's `evidence_refs` still names the old digest (verify-on-read passes, decision unchanged), and using the new envelope requires a **new** `AdmissionInputV1` with a new `input_digest` — no decision ever changes without `input_digest`, `policy_ref.content_digest` or `now` changing |
| C39 | BREAK_GLASS emergency policy publication | (a) brand-new bundle (never published), `cadp.break-glass.v1` with `ACTIVATE_POLICY`, `expected_active = current`, signed by a still-valid root key → root listener; (b) same document with a stale `expected_active.seq`; (c) same with `bundle_cas_ref` bytes ≠ `proposed_policy_ref.content_digest`; (d) same signed by a key whose `valid_to` has passed; (e) same submitted to the ordinary listener | (a) one transaction: `policy_ref` row + `policy_activation seq = expected+1` (`activated_by_ref` = root key_id) + `BREAK_GLASS` envelope; active policy = proposed; (b)(c)(d) **zero** `policy_ref` rows, zero activation rows, zero `BREAK_GLASS` envelopes; one `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)` each; (e) rejected `FORBIDDEN_FOR_PRINCIPAL`, nothing written |
| C40 | root-key revocation at execution time | K_old valid until T0; at T1 > T0 a `BREAK_GLASS(ACTIVATE_POLICY)` is signed with K_old and **backdated** to `created_at = T0 − ε`, `expires_at = T1 + 1 h` (historically valid signature); submit at T1 to the root listener; separately, a document signed at T0 − ε by K_old but submitted after a `POLICY_ACTIVATE` that removed K_old from `root_public_keys` | rejected at execution-authorization (`now > valid_to` / key absent from active set) → `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)`; `policy_ref` delta 0, `policy_activation` delta 0, `BREAK_GLASS` envelope delta 0; historical verify-on-read of envelopes K_old signed **before** T0 still passes |
| C34 | Temporal receipt provenance | `StartWorkflow` succeeds but `DescribeWorkflowExecution` is made to fail (fault injection); separately, Describe returns a memo with a different `cadp_args_digest` | first: `UNKNOWN`, reconcile later → `COMMITTED` only when Describe returns matching memo; second: `RECEIPT_MATERIAL_MISMATCH` incident, never `COMMITTED` |

Guard-bite check (from #89): for C1, C2, C3, C6, C9, C10, C11, C20, C22, C27, C28, C30, C35, C38, C39, C40 the test additionally removes the corresponding kernel check and asserts the prohibited effect **does** occur (delta 1). A control whose removal changes nothing is reported as defence-in-depth, not as load-bearing.

### 13.2 Product controls (Spec §13.4–13.5, §8.2)

| ID | Control | Expected |
|---|---|---|
| P1 | development repeated autonomous-work path | `WORK_START` admitted → step 1 (candidate) → `GIT_PUSH` effect → step 2 (address CI failure, new candidate) → `GIT_PUSH` → verification + review evidence → `PR_CREATE` admitted → `COMMITTED`; PR delta 1 |
| P2 | non-development repeated path | `WORK_START` → step 1 (`RECORD_WRITE` A) → step 2 (`RECORD_WRITE` B depending on A's receipt) → reconciliation evidence → completion; record count 2 |
| P3 | ≥ 2 causally bound ordinary steps | `WORK_STEP` envelopes for step 2 reference step 1's envelope digest; reconstructable from store alone |
| P4 | restart/recovery without Human data re-entry | kill Temporal worker **and** Kernel Service between step 1 and step 2 (and, separately, between admission commit and outcome write); after restart: continuation converges, effect ids unchanged (allocation key), no duplicate effect, Human actions = 0 |
| P5 | Human only on policy branch | policy requires `HUMAN_DECISION` for `PR_MERGE` only, obtained via SSO path A on the pre-sealed merge effect; trace shows exactly one Human envelope, bound to the merge effect; all other steps have zero Human transport actions |
| P6 | manual relay must fail the product claim | run the same scenario with a Human copying SHAs/receipts between steps; the conformance report classifies it `KERNEL_CONFORMANT_ONLY`, not `CADP_PRODUCT_CONFORMANT` |
| P7a | step bound (workflow-enforced) | `max_steps = 2`, task needing 3 steps → after step 2 the workflow emits `WORK_BOUND_STOP` and completes with HOLD; no third `WORK_STEP`; no Human action |
| P7b | effect bound (kernel-enforced) | `max_effects = 2`, workflow requests a third effect (or a test workflow ignoring `max_steps` requests effects) → third `admit_and_dispatch` refused `MAX_EFFECTS_IN_WORK_RUN`; target delta 2 |

### 13.3 Adapter conformance suite (per target adapter, per operation)

- `describe()` vs behaviour: `NATIVE_KEY` ⇒ double dispatch yields one effect; `NATIVE_PRECONDITION` ⇒ re-apply is a no-op; `no_effect_proof_supported` ⇒ the proof predicate is demonstrated on a known-absent effect **and** shown to return `UNKNOWN` under replica/partial reads.
- `dispatch_precondition` vs behaviour: `NATIVE_CAS` ⇒ a stale expected value is rejected by the target with no effect; `PEP_READ_THEN_ACT` ⇒ a fresh `TARGET_IMMUTABILITY_ATTESTATION` exists (ruleset read + admin-token negative probe), the precondition read runs before K6, and the read-then-act window is covered by the serialization lock (two Kernel Service instances cannot interleave on the same domain); without the attestation the operation must report `available = false`.
- material completeness: for every operation the suite deletes one referenced CAS object and asserts `MATERIAL_INCOMPLETE` pre-K6; for `GIT_PUSH` it asserts the bundle-tip = `new_sha` check and that no extra object from the bundle reaches the target.
- Temporal: the suite asserts `COMMITTED` is written only after a `DescribeWorkflowExecution` whose memo is target-returned (mock a Describe outage and assert `UNKNOWN`).
- `idempotency_horizon` ⇒ the adapter proves that after the horizon its `NATIVE_KEY` protection lapses (C25) and that `NO_EFFECT_CONFIRMED` is never emitted outside it.
- receipt binding: every `COMMITTED` receipt contains a material-derived field.
- evidence adapters: every `PRESENT` observed field replays from its locator.

### 13.4 Conformance report format

Two separate claims, never merged (Spec §13): `CONSTITUTIONAL_KERNEL_CONFORMANCE: PASS|FAIL` over C1–C40 + adapter suite; `CADP_PRODUCT_CONFORMANCE: PASS|FAIL|KERNEL_CONFORMANT_ONLY` over P1–P7. Each line cites store row ids, target observables and the exact composition digests (kernel build digest, policy `content_digest`, adapter registry digest).

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
| U2 | Human reviewer decision provenance equivalence to machine reviewer (#90 unresolved). Reference: Human decisions enter only via SSO path A; human GitHub reviews are `REVIEW` evidence. Not yet measured. | none — same envelope contract; policy fails closed if a surface cannot bind scope |
| U3 | Out-of-process target adapter capability token format (§4.3 alternative). | none — reference consumes capability in-process |
| U4 | OPA signed-bundle verification for **remote** evaluators. The reference (local socket, PEP-served bundle, `active_revision` + `revision_echo` + PEP-verified raw digest) is fully specified in §5.2. | none — non-reference option |
| U5 | `pr_settle_window_s` value and GitHub list-read authority guarantees for `PR_CREATE` `NO_EFFECT_CONFIRMED` after a **sent** call. Reference adapter declares `no_effect_proof_supported = false`; ambiguity after send stays `UNKNOWN`. | none — conservative default already fail-closed |
| U6 | `Authority order.md` / `README.md` still name Spec v0.3 + TD v1.5; docs-only update after Human merge. | none — documentation of authority, not authority itself |
| U7 | Temporal multi-worker/parallel semantics unmeasured (Control caveat, #89). Reference product proof runs single worker. | none — product conformance claim is scoped to what is measured |
| U9 | GitHub "binding notice" as its own governed effect (`GH_CHECK_RUN_POST`) so that GitHub-native human reviews could become effect-scoped `HUMAN_DECISION`s. Not in the reference path (§9.3). | none — non-reference option; path A is sufficient for conformance |
| U10 | Whether the deployed GitHub surface's rulesets API exposes `bypass_actors` and `update`/`deletion`/`non_fast_forward` rules exactly as §4.6 item 2 requires. If not, `PR_CREATE` is unavailable and the development route is `KERNEL_CONFORMANT_ONLY` until an immutable-ref mechanism is proven — this is a measured outcome, not an assumption. | none — fail closed by `available = false` |

Closed in r6 (r5 re-review `issuecomment-5518070272`): root-key revocation applies at execution time — `cadp-sig-1` now separates historical verification (document-time validity of recorded envelopes) from execution authorization of a new root operation (key in the currently active `root_public_keys`, `valid_from ≤ created_at ≤ now`, `now ≤ valid_to`, `created_at ≤ now < expires_at`, lifetime ≤ `break_glass_max_lifetime_s`); a backdated `created_at` cannot revive a revoked/expired key (§9.4, §5.4, C40). `POLICY_ACTIVATE` material is one exact K3 representation — a `cadp-jcs-1` CAS object bound by `material_schema = cadp.policy-activate.v1` / `material_ref` / `material_digest`, re-read by evaluator and PEP; the nested `bundle_cas_ref` remains the OPA bundle bytes; the inline exception is removed (§2.3, §6.4, §6.6, C30). Cleanup: `active_policy_ref` removed from evaluator input (Kernel fail-closed `POLICY_NOT_ACTIVE` pre-check + recheck #1, §5.1); decision-function wording aligned to `input_digest + policy_ref.content_digest + now(decided_at)` (§5.1, §9.1, §15, C38).

Closed in r5 (r4 re-review `issuecomment-5517653053`): K4 complete-input binding — option A: `source_time_authority` and `identity_class` are pure functions of the K2 envelope + active policy registries (`adapter_registry.produced_at_source` with claim pointer, Ingress enforces `produced_at == claim[pointer]` at seal); `ResolvedAdmissionBundle` carries no ingress metadata; `received_at` is operational only, `INGRESS_MAX_AGE` withdrawn; a decision is a function of `input_digest` + `policy_ref.content_digest` + Kernel `now` (K5 `decided_at`) only (§3.2, §4.4 #16, §5.1, §5.4, §8.4, §9.1, C27/C37/C38). BREAK_GLASS policy publication — `cadp.break-glass.v1` binds `proposed_policy_ref`, `bundle_cas_ref`, `expected_active_policy_ref` (incl. seq), reason/scope/expires; root listener verifies `cadp-sig-1` against the currently active key set, runs the ordinary #17 publication checks, and executes one store transaction (envelope + publish-if-absent + predecessor+1); any failure rolls back entirely and leaves a `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)`; no inactive PolicyRef can remain; root operation stays outside K6 (§1, §2.6, §9.4, §12, C39).

Closed in r4 (r3 re-review `issuecomment-5511584832`): #1 K2 `claim` untouched, `$ingress` removed, `identity_class` derived at evaluation from `producer_ref` + active registry, source-time authority as verified implementation metadata outside K2, UNKNOWN envelopes claim-less (§9.1, §5.1, §8.4, §3.2, C27/C28/C37); #2 `WORK_STEP` lookup-before-allocate replay idempotency on semantic payload (§7.4, C33); #3 Human path A sequencing seal → assemble → evaluate → REQUIRE_EVIDENCE → decision → new input → fresh evaluation → K6 (§9.3); #4 pre-K6 refusal is not an effect; successor never uses `prior_effect_refs`; `PRIOR_REF_NOT_AN_EFFECT` (§4.6 item 5, §4.4 #7, C36); #5 `PolicyRefV1` publication only inside `POLICY_ACTIVATE` dispatch (publish-if-absent + activation, one transaction) or genesis; material `{proposed_policy_ref, bundle_cas_ref, expected_active_policy_ref}`; `issuer_ref` = stamped `requester_ref`; #17 recheck; no publication API (§1, §4.4, §5.2, §5.4, §6.4, §9.4, §12, C35); #6 standalone `INCIDENT_RELEASE` removed — `BREAK_GLASS(release_incident_refs)` only (§2.6, §9.2, §9.4, §12); #7 `adapter_registry` exact-match wording (§9.1); #8 `cas_upload_max_bytes` hard cap at `put_blob`, `MATERIAL_SIZE_MAX` re-enforced at admission (§5.4, §6.6).

Closed in r3: r2-review #1 activation sequence (§3.2/§3.3, C22b); #2 pre-K6 precondition, no PEP-observed `NO_EFFECT_CONFIRMED` (§3.4, §4.6); #3 candidate-ref immutability as attested conformance prerequisite, after-GET/before-POST falsification (§4.6 item 2, C20; former U8 absorbed); #4 Temporal `COMMITTED` only after target-returned memo (§6.4, C34); #5 path B removed from reference (§9.3, U9). Control S1 source vs ingress time (§9.1, §4.4 #16, C27); S2 Ingress-derived `identity_class`, exact-match registries (§9.1, §5.4, C28); S3 `requester_ref` stamping + per-method caller matrix + root listener (§9.1, §12, C29); S4 CAS completeness incl. `put_blob`, bundle→`new_sha` proof, `args_cas_key`, title/body CAS refs (§6.6, §4.4 #15, C30); S5 `cadp.kernel-config.v1` (§5.4, C31); S6 `assembled_at` inside `input_digest`, no collapse (§1, §2.2, C32). Hardening: `cadp-sig-1` root signature profile with key-id/rotation/revocation (§9.4); `WORK_STEP` conflict rule (§7.4, C33); P7 split into workflow step bound vs kernel effect bound (§7.3, P7a/P7b).

Architecture-blocking unresolved questions: **0**.

---

## 16. Acceptance mapping (#94)

| # | Acceptance item | Where |
|---|---|---|
| 1 | one coherent TD candidate at exact branch/PR/head/blob | this file; receipt on #94 |
| 2 | K1–K7 → ownership + durable representation | §1 |
| 3 | storage/atomicity/restart | §3, §4.5, §4.6 |
| 4 | PEP/credential/target-binding topology | §4 (incl. §4.6 dispatch-time precondition) |
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
