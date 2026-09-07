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
| Revision | **r8 — bounded TD amendment (single-owner restart)**: resolve the #96/#106 read-authority gap (Review root defect B1) by adding the read-only constitutional caller class `observer` and two K2 read calls (`get_evidence`, `list_evidence`) to §12. `observer` reach is exactly the four read methods — never `evaluate`/`assemble_admission_input`, which write K5/K4 rows (B2). No new record kind, no reconcile reach, no snapshot-ordering claim (the withdrawn i106 amendment surface). Changed sections: §12, §15. Prior: **r7 — bounded TD repair** after independent r6 re-review #94 `issuecomment-5520332855` (r6 head `caef88690499611fa689363b9a1dbb2b30f89105`, blob `4f1c74e27c69103850075527e894d52c95cfbfba`). Architecture unchanged. r7 changed sections: §8.3, §9.4 (`cadp-sig-1`, `cadp.break-glass.v1`, root listener), §13.1 (C39, C41, C42 new), §13.4, §15. Prior: **r6 — bounded TD repair** after independent r5 re-review #94 `issuecomment-5518070272` (r5 head `1795b54ea539eaee153c5026449db92277dc8ace`, blob `2821c7ecc9e243f475f54dc498ae148f528db4ee`). Architecture unchanged. r6 changed sections: §2.3, §5.1, §6.4, §6.6, §9.1, §9.4, §13.1 (C40, C41), §13.4, §15. Prior: **r5 — bounded TD repair** after independent r4 re-review #94 `issuecomment-5517653053` (r4 head `e65f95edf06f31c393c0f30050874012dd4a4e22`, blob `2a2290e114cae6e73210218aa84d45db54479218`). Architecture unchanged. r5 changed sections: §1, §2.6, §3.2, §4.4 (#16), §5.1, §5.4, §8.4, §9.1, §9.4, §12, §13.1, §15. Prior: **r4 — bounded TD repair** after independent r3 re-review #94 `issuecomment-5511584832` (r3 head `09a4d9024dfc5d1988e61854ed9f139f8a08af91`, blob `8618b4160021f99a6d10d6c55fd6817a69237fdb`). Architecture unchanged. r4 changed sections: §1, §2.6, §3.2, §4.4, §4.6, §5.2, §5.4, §6.4, §6.6, §7.4, §8.4, §9.1, §9.2, §9.3, §9.4, §12, §13.1, §15. Prior: **r3 — bounded TD repair** after independent re-review #94 `issuecomment-5511028194` and Control exactness sweep `issuecomment-5511164208` (r2 head `597bf1beff3b5377f9656f52faa3f38e745a1648`, blob `873b8dbc6584b0b9f6293f3f5c4ccd0886f55fba`; r1 head `2ac11fe4…`). Architecture unchanged. r3 changed sections: §1, §2.2, §3.2, §3.3, §3.4, §4.4, §4.6, §5.4 (new), §6.1, §6.4, §7.3, §7.4, §8.1, §9.1, §9.2, §9.3, §9.4, §11, §12, §13.1, §13.2, §13.3, §15. |

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
- **Review-to-effect subject equality (reference conformance policy contract, r7).** A required `REVIEW` envelope satisfies the requirement for an effect only if its bound candidate (`subject_bindings` `repo_id + commit_id`/`candidate_sha`) equals the exact candidate the sealed material names (`head_sha` / `expected_head_sha`). Both sides are K4-bound facts, so the **evaluator** decides the equality: inequality = required evidence does not satisfy the request → `DENY` / requirement unsatisfied, no K6 (C41 leg 1). A review bound to immutable commit A remains valid evidence **about A** even if the visible PR head later becomes B — subject inequality, not evidence invalidity, is what refuses its reuse for a request naming B; the PEP's fresh rechecks (§4.4 #3/#5) and the target-native merge `sha` precondition separately guard post-decision mutable-target drift.

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

- **Historical verification** (re-verifying an already-recorded `GENESIS`/`BREAK_GLASS` envelope, e.g. verify-on-read, audit, reconstruction): the authorizing key set is resolved **from the signed document itself**, never from operational context — for `GENESIS`, the bootstrap set whose digest the envelope claim records (§2.1); for `BREAK_GLASS`, the `root_public_keys` of the exact `PolicyRefV1` content named by the document's signed `authorization_policy_ref` (below): the activation row and content digest it names are immutable rows, so the resolution is deterministic after any number of later rotations and across restarts. Against that exact set the signing key must have been valid at the document's time: `valid_from ≤ document.created_at ≤ valid_to`. No operational value participates: `received_at` is non-constitutional (§9.1), `created_at` is document time rather than an immutable authority pointer, and activation history is never scanned by ambient timestamp to select a set (C42). This never confers authority to do anything new.
- **Execution authorization** (accepting a **new** root operation on the root listener): the signing key must be authorized **at execution time**, not merely at the claimed document time. Required, all of: (a) `key_id` exists in the **currently active** policy's `root_public_keys`; (b) `valid_from ≤ document.created_at ≤ now`; (c) `now ≤ key.valid_to` when `valid_to` exists; (d) `created_at ≤ now < expires_at`; (e) `expires_at − created_at ≤ break_glass_max_lifetime_s` (§5.4); (f) for `BREAK_GLASS`, the document's `authorization_policy_ref` equals the **currently active** `policy_activation` row — `policy_id`, `revision`, `content_digest` and `seq` all exact (§9.4) — so the constitution the document claims authority under is exactly the one in force. A backdated `created_at` therefore cannot revive a revoked or expired key: (c) is evaluated against `now`, never against `created_at` (C40); and a document signed against a superseded constitution cannot execute: (f) fails whatever its timestamps claim (C42).

**Rotation:** a new root key is added and an old one given a `valid_to` by an ordinary `POLICY_ACTIVATE` (or a `BREAK_GLASS` signed by a key that passes the execution-authorization check at that moment); historical envelopes remain verifiable under the historical rule. **Revocation** = `valid_to` in the past or removal from `root_public_keys`; from that instant the key authorizes no new root operation regardless of any `created_at` a document claims. Root signing never happens inside the Kernel Service process.

**Root surfaces are not workload APIs.** `GENESIS` and `BREAK_GLASS` — the only two signed document kinds in `cadp-sig-1`; there is no standalone `INCIDENT_RELEASE` document — are accepted only by the root listener (§12: separate mTLS listener bound to the root identity, disabled by default and enabled only during a root operation); the ordinary API rejects those evidence kinds regardless of caller.

**Root/break-glass — signed document `cadp.break-glass.v1`:**

```text
cadp.break-glass.v1 {
  principal, reason, scope, created_at, expires_at
  authorization_policy_ref { policy_id, revision, content_digest, seq }
                           (REQUIRED in EVERY document, whatever `actions` contains — the exact
                            `policy_activation` row under whose authority this root operation
                            claims to execute; inside the signed bytes)
  actions: subset of { ACTIVATE_POLICY, RELEASE_INCIDENTS }        (non-empty)
  -- ACTIVATE_POLICY:
  proposed_policy_ref      { policy_id, revision, content_digest }   (issuer_ref := signing key_id, set by the root listener)
  bundle_cas_ref                                                     (bytes already put_blob'd; any caller may upload)
  -- RELEASE_INCIDENTS:
  release_incident_refs[]  { evidence_id, envelope_digest }
}
```

`authorization_policy_ref` is the document's **authorization base**: the constitution — policy content, and therefore `root_public_keys` set — the signer claims to act under, as an immutable pointer signed into the document (r7). At execution time it MUST equal the exact currently active `policy_activation` row before any action is accepted (procedure step 2 below). For `ACTIVATE_POLICY` it **is** the expected-active/base concept: the activation CAS predecessor (`seq + 1` insert) uses it directly, and there is no second authority pointer (the former per-action `expected_active_policy_ref` field of this document is subsumed by it; the ordinary `POLICY_ACTIVATE` K3 material of §6.4 is unchanged). For a `RELEASE_INCIDENTS`-only document it is what makes historical reconstruction deterministic (C42): neither `created_at` (signer-chosen document time), nor `received_at` (operational, non-constitutional, §9.1), nor ambient activation history may be consulted to infer which policy authorized a recorded root operation — the signed ref resolves it exactly.

Root listener procedure (§12), on receipt of the envelope draft with its `cadp-sig-1` signature:

1. apply the **execution-authorization** check of `cadp-sig-1` (above): `key_id` present in the **currently active** policy's `root_public_keys` (the key set the proposed bundle may change is never used to authorize its own introduction), `valid_from ≤ created_at ≤ now`, `now ≤ valid_to` if present, `created_at ≤ now < expires_at`, lifetime ≤ `break_glass_max_lifetime_s`; a key expired or revoked at `now` fails here whatever `created_at` claims (C40);
2. require the document's `authorization_policy_ref` — `policy_id`, `revision`, `content_digest` **and** `seq`, all exact — to equal the currently active `policy_activation` row, **whatever `actions` contains**; a mismatch is a stale authorization base: reject (reason `AUTHORIZATION_BASE_STALE`), no release, no activation, no envelope (C42); passing this also pins the key set step 1 consulted to the exact constitution the document names;
3. if `ACTIVATE_POLICY`: run **exactly the ordinary publication checks** of recheck #17 on `bundle_cas_ref`/`proposed_policy_ref` — raw re-digest, `payload_digest` and `.manifest.revision` match, `cadp.kernel-config.v1` validation, bootstrap-scheme retention (§2.1), no conflicting `policy_ref(policy_id, revision)`; the activation base **is** `authorization_policy_ref` (already proven active in step 2 — no second pointer);
4. if `RELEASE_INCIDENTS`: every ref must resolve to an open `KERNEL_INCIDENT` with matching `envelope_digest`;
5. execute **one store transaction** under the `policy_activation` serialization lock: `SELECT max seq FOR UPDATE`, require `== authorization_policy_ref.seq` (the base must still be active at commit, whatever the actions) → seal the `BREAK_GLASS` `EvidenceEnvelopeV1` (`SIGNED_ATTESTATION`, `producer_ref` = root key_id) → if `ACTIVATE_POLICY`: publish-if-absent `policy_ref` (`issuer_ref` = root key_id; an existing row with a different digest aborts) → `INSERT policy_activation(seq = authorization_policy_ref.seq + 1, expected_prev_seq = authorization_policy_ref.seq, activated_by_ref = root key_id, activation_evidence_id = this envelope)` → commit;
6. on any failure in 1–5 the transaction rolls back **entirely** (no `BREAK_GLASS` envelope, no `policy_ref` row, no activation row — no inactive `PolicyRefV1` can remain) and the root listener writes a `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)` envelope naming the signed document's digest and the reason; a stale `authorization_policy_ref`/`seq` or a digest mismatch is therefore fail-closed with zero publication and no successful root-authority record (C39, C42).

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
get_evidence(evidence_id)                                 -> { envelope }               (r8; verify-on-read — a row that does not re-digest is refused DIGEST_CORRUPTION, never served)
list_evidence(work_run_ref)                               -> { evidence[] summaries }   (r8; an empty COMPLETE list is this store's answer, not universal absence)
```

Twelve calls (r8 added the two K2 reads). There is no task, attempt, batch, pending-decision, profile or **policy-publication** endpoint (a `PolicyRefV1` is published only inside a `POLICY_ACTIVATE` dispatch, by root genesis, or by a root-signed `BREAK_GLASS(ACTIVATE_POLICY)` on the root listener, §9.4 — the latter two are root operations, not effects). `admit_and_dispatch` is the only call that can cause an external effect, and it is the only path that inserts `effect_admission`.

**Caller / authentication / reach matrix (reference deployment, S3).** Every call is authenticated by workload identity (mTLS/SPIFFE) or, for Human surfaces, an IdP-signed JWT; the Ingress maps the principal through `identity_registry` (§5.4) and rejects unregistered principals. Reach is enforced by the Kernel Service, not by network position.

| Method | workflow / orchestrator identity | worker / reviewer / verifier identity | evidence adapters (CI, target reconciler, deployment control) | Human SSO surface | read-only observer (r8) | delegated agent-surface (r9) | root identity |
|---|---|---|---|---|---|---|---|
| `put_blob` | yes | yes | yes | no | **no** | **no** | no |
| `allocate_effect_id` | yes | no | no | no | **no** | **no** | no |
| `seal_effect_request` | yes (`requester_ref` = caller) | no | no | no | **no** | **no** | no |
| `submit_evidence` | `WORK_STEP`, `WORK_BOUND_STOP` | `BACKEND_EXECUTION`, `REVIEW`, `VERIFICATION` (as registered) | kinds as registered (`VERIFICATION`, `TARGET_RECONCILIATION`, `CREDENTIAL_REACH_ATTESTATION`, `TARGET_IMMUTABILITY_ATTESTATION`, `LEGACY_V03_ARTIFACT`) | `HUMAN_DECISION` only | **no** | `AGENT_DECISION` only | `GENESIS`, `BREAK_GLASS` — **root listener only**; a `BREAK_GLASS(ACTIVATE_POLICY)` is the sole non-effect path that publishes a `PolicyRefV1` (§9.4 procedure, one transaction) |
| `assemble_admission_input` | yes | no | no | no | **no** (writes a K4 row — B2) | **no** (writes a K4 row — B2) | no |
| `evaluate` | yes | no | no | no | **no** (writes a K5 row — B2) | **no** (writes a K5 row — B2) | no |
| `admit_and_dispatch` | yes | **no** | no | no | **no** | **no** | no |
| `get_effect_state` | yes | yes (read-only) | yes (read-only) | yes (read-only, for rendering) | yes | yes (read-only, to render the exact sealed effect) | yes |
| `request_reconcile` | yes | no | yes (deployment control) | no | **no** (observation never triggers reconciliation attempts) | **no** | yes |
| `list_effects` | yes | yes (own `work_run_ref` only) | no | no | yes (unscoped) | **no** | yes |
| `get_evidence` (r8) | yes | no | yes (read-only) | yes (read-only) | yes | **no** | yes |
| `list_evidence` (r8) | yes | no | deployment control only | no | yes | **no** | yes |

The `observer` class exists so a diagnostic/operability surface never has to borrow `workflow` reach (the #96 Review B1 defect) and never gains a write or evaluation path (B2). Its projections — chain continuity, human-wait, failure attribution — are derived read-only output over exact stored K1–K7 rows; they are not records, not authority, and a completed empty read is one store's answer, never proof of universal absence (B3).

**Delegated `agent-surface` class (r9).** A deployment's Human may delegate specific merge decisions to an owner-agent. That agent authenticates as its own registered principal (`process_class = agent-surface`) with reach exactly `{ submit_evidence(AGENT_DECISION only), get_effect_state }` — and, like `observer`, **never** `evaluate`, `assemble_admission_input`, `admit_and_dispatch`, `seal_effect_request` or `allocate_effect_id`. Its `AGENT_DECISION` satisfies a gate only where the active policy's `delegated_merge_producers` names its producer, and only the merge gate: `POLICY_ACTIVATE` and every human-judgment transition gate keep requiring a `HUMAN_DECISION`. The decision is recorded as what it is — an agent's, honestly attributed — never disguised as a Human's. The delegation is per-deployment opt-in (reference default: empty list, no delegation). **Independence (r9, Spec §5.3a):** the reference policy's `agent_merge_ok` additionally requires the `AGENT_DECISION` producer to be independent of the run's implementer — `not implementer_refs[producer]` and `identity_class.product` differing from every implementer's, the exact §8.4 predicate applied to the decision. A delegate that shares the implementer's product, or that also drove the work, is refused with `agent_merge_not_independent`; self-approval is structurally impossible. The decision itself is formed by a **fresh isolated reviewer context** fed only the governed evidence (candidate sha, diff, verification conclusion, review verdict) — the reference `ctl agent-approve` seals `AGENT_DECISION(APPROVE)` only if that isolated reviewer approves, so a build-contaminated caller cannot rubber-stamp its own run.

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
| C39 | BREAK_GLASS emergency policy publication | (a) brand-new bundle (never published), `cadp.break-glass.v1` with `ACTIVATE_POLICY`, `authorization_policy_ref` = current active row, signed by a still-valid root key → root listener; (b) same document with a stale `authorization_policy_ref.seq`; (c) same with `bundle_cas_ref` bytes ≠ `proposed_policy_ref.content_digest`; (d) same signed by a key whose `valid_to` has passed; (e) same submitted to the ordinary listener | (a) one transaction: `policy_ref` row + `policy_activation seq = authorization_policy_ref.seq + 1` (`activated_by_ref` = root key_id) + `BREAK_GLASS` envelope; active policy = proposed; (b)(c)(d) **zero** `policy_ref` rows, zero activation rows, zero `BREAK_GLASS` envelopes; one `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)` each; (e) rejected `FORBIDDEN_FOR_PRINCIPAL`, nothing written |
| C40 | root-key revocation at execution time | K_old valid until T0; at T1 > T0 a `BREAK_GLASS(ACTIVATE_POLICY)` is signed with K_old and **backdated** to `created_at = T0 − ε`, `expires_at = T1 + 1 h` (historically valid signature); submit at T1 to the root listener; separately, a document signed at T0 − ε by K_old but submitted after a `POLICY_ACTIVATE` that removed K_old from `root_public_keys` | rejected at execution-authorization (`now > valid_to` / key absent from active set) → `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)`; `policy_ref` delta 0, `policy_activation` delta 0, `BREAK_GLASS` envelope delta 0; historical verify-on-read of envelopes K_old signed **before** T0 still passes |
| C41 | review-to-effect provenance continuity (end-to-end; Control intake `issuecomment-5518636858`; see U2 for exactly what this closes) | one development scenario proven as a chain of existing K1–K7 checks in **K3 → K4 → K5 → K6 order** (K4 carries `effect_request_ref`/`effect_request_digest`, so the `EffectRequestV1` always exists before any `AdmissionInputV1` that cites the evidence), no new record. **REVIEW path:** `REVIEW` envelope about candidate A (`subject_bindings = repo_id + A`, `envelope_digest` E) — may pre-exist the request → seal `EffectRequestV1`(A) whose material names candidate A / `expected_head_sha` A → assemble `AdmissionInputV1` naming E → evaluate: the reference policy requires exact review-subject == exact request-candidate equality over the sealed material (§8.3) → `PolicyDecisionV1(ALLOW)` bound to that `input_digest` → fresh PEP rechecks (§4.4 #3/#5) → K6 → target-authoritative receipt. **HUMAN_DECISION path (§9.3 two-evaluation contract, unchanged):** seal `EffectRequestV1`(A) → initial K4 → evaluate → `REQUIRE_EVIDENCE(HUMAN_DECISION)` → Human sees/approves the exact already-sealed effect → seal `HUMAN_DECISION`(A) → **new** K4 → fresh evaluation → `ALLOW` → K6. Falsifications: (1) wrong-subject evidence: candidate/PR head moves to B, a new `EffectRequestV1` names B, review(A) presented in its K4; (1b) post-decision drift: valid review(A) + valid `EffectRequestV1`(A) + valid K5 `ALLOW`, then the target/PR head moves to B before the effect; (2) Human approves merge of A, `PR_MERGE` material re-sealed for B, decision(A) reused; (3) review body says APPROVE but the producer is not in `identity_registry` / reviewer identity cannot be established; (4) K6 admitted for A but the target receipt (`head.sha`, `merge_commit_sha` ancestry) corresponds to B (fault-injected); (5) same PR number, candidate rebased to byte-different B, old review(A) presented | (1) **evaluator** `DENY` / review requirement unsatisfied — `REVIEW` subject candidate A ≠ request candidate/`expected_head_sha` B, decided over K4-bound facts (§8.3); **not** recheck #3: review(A) binds the immutable commit A and remains valid evidence about A after the visible head moves — it is simply not the required evidence for request(B); no K5 `ALLOW`, no K6, merge delta 0; (1b) target-native `PR_MERGE` `sha` precondition (`NATIVE_CAS`, 409 → `REJECTED_NO_EFFECT`) or, where the material names a mutable subject, the fresh pre-K6 precondition read / recheck #3 refuses — no wrong effect either way; (2) `scope.material_digest`/`candidate_sha` ≠ new request → refusal at #5 (`DECISION_INPUT_MISMATCH` if the old input is presented), delta 0; (3) Ingress rejects the envelope (unregistered principal) or `identity_class` derives to nothing → required-fact `UNKNOWN` → `DENY`; (4) receipt binding fails → no `COMMITTED`, `UNKNOWN(RECEIPT_UNBOUND)` + `RECEIPT_MATERIAL_MISMATCH` incident + scope hold; (5) `subject_bindings` are `repo_id + commit_id`, never PR number — review(A) does not satisfy the requirement for B: same evaluator refusal as (1), delta 0. Positive leg: with A unchanged both paths admit once and the receipt's `head.sha == A`; the conformance report lists the exact `evidence_id → input_digest → decision_id → admission_id → outcome_id` tuple as a **derived, read-only projection** of stored K1–K7 rows — no `AUTHORIZATION_CHAIN_COMPLETE` or other authority record exists |
| C42 | BREAK_GLASS historical authorization binding (r7) | (a) open `KERNEL_INCIDENT` scope hold; `RELEASE_INCIDENTS`-only `cadp.break-glass.v1` with `authorization_policy_ref` = active row A, signed by a root key valid under A → root listener → accepted, scope released; then rotate policy/root set to B (`POLICY_ACTIVATE` whose bundle drops A's signing key from `root_public_keys`); restart the Kernel Service; verify-on-read the recorded `BREAK_GLASS` envelope and re-derive the release; the test additionally corrupts the impl column `received_at` and shifts the host clock before the re-verification; (b) after the rotation, a **new** `RELEASE_INCIDENTS`-only document with `authorization_policy_ref` = A (stale base), and separately an `ACTIVATE_POLICY` document with the same stale ref, each signed by a key valid under the current set | (a) historical verification succeeds **solely** from the signed envelope: `authorization_policy_ref`(A) → immutable `policy_activation`/`policy_ref` rows → policy A content → its `root_public_keys` → signature + document-time validity; no `received_at`, no `created_at`-selected key set, no activation-history scan by ambient timestamp (the corrupted column and shifted clock change nothing); the released scope stays released after restart; (b) both rejected at the authorization-base check (`AUTHORIZATION_BASE_STALE`, listener step 2) → no release, no `policy_ref` row, no activation row, no successful root-authority record; one `KERNEL_INCIDENT(BREAK_GLASS_REJECTED)` each |
| C34 | Temporal receipt provenance | `StartWorkflow` succeeds but `DescribeWorkflowExecution` is made to fail (fault injection); separately, Describe returns a memo with a different `cadp_args_digest` | first: `UNKNOWN`, reconcile later → `COMMITTED` only when Describe returns matching memo; second: `RECEIPT_MATERIAL_MISMATCH` incident, never `COMMITTED` |

Guard-bite check (from #89): for C1, C2, C3, C6, C9, C10, C11, C20, C22, C27, C28, C30, C35, C38, C39, C40, C41, C42 the test additionally removes the corresponding kernel check and asserts the prohibited effect **does** occur (delta 1). A control whose removal changes nothing is reported as defence-in-depth, not as load-bearing.

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

Two separate claims, never merged (Spec §13): `CONSTITUTIONAL_KERNEL_CONFORMANCE: PASS|FAIL` over C1–C42 + adapter suite; `CADP_PRODUCT_CONFORMANCE: PASS|FAIL|KERNEL_CONFORMANT_ONLY` over P1–P7. Each line cites store row ids, target observables and the exact composition digests (kernel build digest, policy `content_digest`, adapter registry digest). Provenance continuity (C41) is reported as a projection over those row ids; the report format introduces no authority record such as an `AUTHORIZATION_CHAIN_COMPLETE` primitive.

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
| U2 | Human reviewer decision provenance equivalence to machine reviewer (#90 unresolved). Reference: Human decisions enter only via SSO path A; human GitHub reviews are `REVIEW` evidence. **C41 is the closure criterion for the binding behavior only**: it proves that once an acceptable provenance-bearing review/decision envelope exists (registered producer, bound subject), its exact subject is bound end-to-end to the exact effect. Whether a Human GitHub reviewer surface can *produce* such an envelope with sufficient provenance remains **unmeasured** (#90); C41 does not measure that surface, and passing C41 does not claim to. | none — same envelope contract; policy fails closed if a surface cannot bind scope |
| U3 | Out-of-process target adapter capability token format (§4.3 alternative). | none — reference consumes capability in-process |
| U4 | OPA signed-bundle verification for **remote** evaluators. The reference (local socket, PEP-served bundle, `active_revision` + `revision_echo` + PEP-verified raw digest) is fully specified in §5.2. | none — non-reference option |
| U5 | `pr_settle_window_s` value and GitHub list-read authority guarantees for `PR_CREATE` `NO_EFFECT_CONFIRMED` after a **sent** call. Reference adapter declares `no_effect_proof_supported = false`; ambiguity after send stays `UNKNOWN`. | none — conservative default already fail-closed |
| U6 | `Authority order.md` / `README.md` still name Spec v0.3 + TD v1.5; docs-only update after Human merge. | none — documentation of authority, not authority itself |
| U7 | Temporal multi-worker/parallel semantics unmeasured (Control caveat, #89). Reference product proof runs single worker. | none — product conformance claim is scoped to what is measured |
| U9 | GitHub "binding notice" as its own governed effect (`GH_CHECK_RUN_POST`) so that GitHub-native human reviews could become effect-scoped `HUMAN_DECISION`s. Not in the reference path (§9.3). | none — non-reference option; path A is sufficient for conformance |
| U10 | Whether the deployed GitHub surface's rulesets API exposes `bypass_actors` and `update`/`deletion`/`non_fast_forward` rules exactly as §4.6 item 2 requires. If not, `PR_CREATE` is unavailable and the development route is `KERNEL_CONFORMANT_ONLY` until an immutable-ref mechanism is proven — this is a measured outcome, not an assumption. | none — fail closed by `available = false` |

Closed in r8 (single-owner restart): the #96/#106 read-authority gap. §12 gains the `observer` caller class and the `get_evidence`/`list_evidence` K2 reads with verify-on-read; the operability layer is thereby reachable without `workflow` reach (B1), without any K4/K5-writing method (B2), and with explicit completed-empty ≠ absence semantics (B3). Deliberately NOT adopted from the withdrawn i106 amendment candidate: observer-triggered `request_reconcile` (and with it the reconcile-scope/entitlement/budget questions — observation never spends reconcile attempts), and `snapshot_position` ordering claims (no backend-portable snapshot token was provable; the projection makes no ordering claim beyond per-row facts).

Closed in r7 (r6 re-review `issuecomment-5520332855`): **C41 made exact.** The positive chain is ordered K3 → K4 → K5 → K6 (the `EffectRequestV1` is sealed before any `AdmissionInputV1` that cites the evidence, since K4 carries `effect_request_ref`/`effect_request_digest`; `REVIEW` evidence may pre-exist the request; effect-scoped Human approval keeps the §9.3 two-evaluation contract). Review-to-effect subject equality is an explicit reference-policy predicate over K4-bound facts (§8.3), and the wrong-subject falsification is attributed to the correct guard: review(A) presented for request(B) is refused by the **evaluator** as required-evidence-unsatisfied — review(A) remains valid evidence about immutable A — while post-decision head drift after a valid decision is separately refused by the target-native merge precondition / fresh pre-K6 mutable-target guard (C41 legs 1/1b); the audit projection stays derived read-only output, no `AUTHORIZATION_CHAIN_COMPLETE` record; U2 rewritten to be honest that C41 closes the binding behavior only, not the unmeasured Human GitHub reviewer provenance surface. **BREAK_GLASS historical authorization binding.** `cadp.break-glass.v1` now carries a signed document-level `authorization_policy_ref{policy_id, revision, content_digest, seq}` required in **every** document (`RELEASE_INCIDENTS`-only included); execution requires it to equal the exact currently active `policy_activation` row before any action (re-verified under the serialization lock at commit), and for `ACTIVATE_POLICY` it *is* the activation base — no second authority pointer; historical verify-on-read resolves the authorizing `root_public_keys` deterministically from the signed ref alone, never from `created_at`/`received_at`/ambient activation history (§9.4 `cadp-sig-1`, root listener steps 2/5; C39 updated, C42 new).

Closed in r6 (r5 re-review `issuecomment-5518070272`): root-key revocation applies at execution time — `cadp-sig-1` now separates historical verification (document-time validity of recorded envelopes) from execution authorization of a new root operation (key in the currently active `root_public_keys`, `valid_from ≤ created_at ≤ now`, `now ≤ valid_to`, `created_at ≤ now < expires_at`, lifetime ≤ `break_glass_max_lifetime_s`); a backdated `created_at` cannot revive a revoked/expired key (§9.4, §5.4, C40). `POLICY_ACTIVATE` material is one exact K3 representation — a `cadp-jcs-1` CAS object bound by `material_schema = cadp.policy-activate.v1` / `material_ref` / `material_digest`, re-read by evaluator and PEP; the nested `bundle_cas_ref` remains the OPA bundle bytes; the inline exception is removed (§2.3, §6.4, §6.6, C30). Cleanup: `active_policy_ref` removed from evaluator input (Kernel fail-closed `POLICY_NOT_ACTIVE` pre-check + recheck #1, §5.1); decision-function wording aligned to `input_digest + policy_ref.content_digest + now(decided_at)` (§5.1, §9.1, §15, C38). Hardening (Control intake `issuecomment-5518636858`, classified `TD_HARDENING`): C41 review-to-effect provenance continuity as an end-to-end falsification over existing K1–K7 checks — no new primitive, no Spec change; U2 closure criterion (§13.1, §13.4, §15).

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

---

## 17. Model-surface provider adapters

Product-layer closed registries for the CLI surfaces that implement, review, and plan autonomous work. This is not a kernel primitive and does not change K1–K7, `identity_class` derivation (§9.1), or the §8.4 independence predicate: the kernel still stamps `producer_ref` from the authenticated principal and derives class from the active `identity_registry`. What this section records is the adapter that now exists in the implementation — the exact argv, auth injection, and product string a named surface runs under — so a provider capability is declared only after a live container probe has measured it, and an unmeasured fact stays `UNKNOWN` rather than guessed.

Independence consequences now enforced, because they were measured not to be. The implementer set the policy compares against includes `BACKEND_EXECUTION` producers (the model that implemented the candidate is attributed there, not by the orchestrator's `WORK_STEP`) and fails closed when empty (`count(implementer_refs) > 0` — a vacuous universal quantifier is not a proof of independence). The merge admission input carries the run's `BACKEND_EXECUTION` and `WORK_STEP` evidence so that comparison can see who implemented the candidate. Because the claude worker shares product `claude-code` with both the claude reviewer and the delegated merge agent, a claude-implemented run requires a grok or codex review and always a `HUMAN` merge decision.

### 17.1 Closed union keyed registries

Three registries, each a `Record` keyed by a closed provider-name union. Unknown names fail closed at `resolveWorkerProvider` / `resolveReviewProvider` / `resolvePlanProvider` with no filesystem, process, docker, or network side effect; those resolvers never default. An omitted `review_product` / `plan_product` keeps the measured claude path; an omitted worker selection is not a silent fallback inside `resolveWorkerProvider`.

| Registry | File | Closed union | Prompt sentinel | Surfaces |
|---|---|---|---|---|
| `WORKER_PROVIDERS` | `cadp/product/workerProviders.ts` | `"codex" \| "grok" \| "claude"` | `{{WORK_ITEM}}` | `/implement` worker container |
| `REVIEW_PROVIDERS` | `cadp/product/reviewProviders.ts` | `"claude" \| "grok" \| "codex"` | `{{DIFF_PROMPT}}` | `/review` reviewer container |
| `PLAN_PROVIDERS` | `cadp/product/planProviders.ts` | `"claude" \| "grok" \| "codex"` | `{{PLAN_PROMPT}}` | `/plan` planner container (proposal-only) |

Every profile carries three load-bearing fields:

- **argv template, not a prefix.** The provider's exact argv after the binary name, with the sentinel replaced by the prompt. A template so a provider whose prompt is not the last token — grok worker `-p <prompt> --output-format streaming-json`, grok reviewer/planner `-p <prompt> --permission-mode plan …` — is expressible without special-casing.
- **auth descriptor, never a credential.** Worker profiles declare `auth_files` + `auth_subdir`. Reviewer and planner profiles declare `auth_method` as the closed union in §17.3. Host keychain material is resolved at injection time by the broker, not stored in the registry.
- **`identity_class_product`.** The product-side declaration of `identity_class.product` (TD §8.4). It must match the policy identity registry's product string for that surface's `producer_ref`. Adapters cannot self-assert a different class at submit time (C28).

Pinned measured entries (argv identity is the profile; permission posture is part of argv, not a separate switch):

| Provider | `identity_class_product` | Auth | Distinctive argv (measured) |
|---|---|---|---|
| worker `codex` | `codex-cli` | `auth_files` `.codex/auth.json` | `exec --sandbox danger-full-access … {{WORK_ITEM}}` |
| worker `grok` | `grok` | `auth_files` `.grok/auth.json` | `-p {{WORK_ITEM}} --output-format streaming-json --permission-mode bypassPermissions` (headless autonomous-edit; container isolation is the real boundary) |
| worker `claude` | `claude-code` | env-injected `auth_env` `CLAUDE_CODE_OAUTH_TOKEN` plus measured static env `IS_SANDBOX=1` (claude refuses `bypassPermissions` as root without it) | `-p {{WORK_ITEM}} --permission-mode bypassPermissions`; sessions written to `~/.claude/projects` so the profile carries `sessions_container_dir` `'projects'` |
| reviewer `claude` | `claude-code` | `oauth_env` `CLAUDE_CODE_OAUTH_TOKEN` | `-p --model claude-sonnet-5 --permission-mode plan --disallowedTools=… {{DIFF_PROMPT}}` |
| reviewer `grok` | `grok` | `auth_files` `.grok/auth.json` | `-p {{DIFF_PROMPT}} --permission-mode plan --disable-web-search --tools read_file,list_dir,grep --json-schema <verdict schema>` |
| reviewer `codex` | `codex-cli` | `auth_files` `.codex/auth.json` | `exec --sandbox read-only --skip-git-repo-check {{DIFF_PROMPT}}` (measured: read-only sandbox blocks writes in-container; stdout with stderr discarded is the final message only, hence `verdict_format` `first-line`) |
| planner `claude` | `claude-code` | `oauth_env` `CLAUDE_CODE_OAUTH_TOKEN` | plan-mode, mutating/external tools disallowed; reading the checkout remains allowed |
| planner `grok` | `grok` | `auth_files` `.grok/auth.json` | same measured read-only argv as the grok reviewer, without `--json-schema` (proposal parse is a closed JSON schema of its own) |
| planner `codex` | `codex-cli` | `auth_files` `.codex/auth.json` | same measured read-only argv as the codex reviewer, with `{{PLAN_PROMPT}}` |

The grok **worker** must never share the reviewer/planner argv: `bypassPermissions` is grok's analogue of codex `--sandbox danger-full-access` and is forbidden on the read-only surfaces.

### 17.2 Measurement-first capabilities

A provider capability is a field on the profile that is present only after a live container probe has measured the corresponding fact. The scan, the parser, and the isolation argv consume that field; they do not infer a sibling provider's shape. An unmeasured or unmatched fact stays `UNKNOWN` (or fails closed to the conservative verdict). Guessing is the defect this rule exists to prevent.

Three capabilities, each with the grok measurement that forced the field into the spec rather than a hardcoded assumption:

**`model_scan` (worker; #91).** `WORKER_PROVIDERS[p].model_scan` is optional. Absent ⇒ `scanBackendModel` returns no model and no locator; `BACKEND_EXECUTION` records `observed.model.availability = UNKNOWN` (requested is a separate sub-object and is never consulted to fill observed). Both regexes carry exactly one capture group. Codex was measured as `"model":"…"` in `rollout-*.jsonl`. Grok was measured (2026-09-06 container probe, grok 1.0.13): the mounted `/root/.grok/sessions` tree writes `<urlencoded-cwd>/<session-id>/chat_history.jsonl` carrying `"model_id":"grok-4.6-build"` (the serving model; `updates.jsonl`'s `"modelId"` is the coarser alias). Headless stdout ends with an `end` event carrying `"modelUsage":{"grok-4.6-build":{…}}` — the fallback capture. A hardcoded `"model"` capture after a prefix match would have reported UNKNOWN on a live grok session; the capture now lives in the measured spec. Claude was measured: `~/.claude/projects/<slug>/<uuid>.jsonl` carries a plain `"model"` field (measured `claude-sonnet-5`) — same field shape as codex.

**`verdict_format` (reviewer).** `first-line` is the measured claude `-p` contract (verdict is the first stdout line starting with `APPROVE`/`REQUEST_CHANGES`, reason on the next). `json-schema-text` is the measured grok contract. The 9th-pilot measurement: in plain `-p` output grok concatenates tool-use narration and the final verdict **without a newline** (`…file.APPROVE`), so the first-line contract is unparseable and would fail closed as `REQUEST_CHANGES` even on an approval. The grok reviewer therefore runs under `--json-schema` with `{verdict ∈ {APPROVE, REQUEST_CHANGES}, reason}`. Measured wrapper shape: stdout is `{"text": "…"}` whose text concatenates one JSON object per turn (tool-use narration is coerced into the schema too); the **last** object is the final verdict. Anything outside that shape fails closed to `REQUEST_CHANGES` — a verdict is never guessed from prose (`parseReviewVerdict`).

**Read-only posture (reviewer and planner argv).** Declared as the argv that the probe held, not as a named mode. Measured (2026-09-06 container probes, grok 1.0.13): `--permission-mode plan` blocks the `write` tool (auto-cancelled, no file created) but does **not** block `run_terminal_command` (a `touch` executed and the file appeared), so plan mode alone is not read-only for grok. `--tools read_file,list_dir,grep` (allow-list) held: a direct "run the terminal command" prompt could not execute it and no file was created. That allow-list — not plan mode — is the enforced read-only boundary; plan mode stays as defence in depth. `--disable-web-search` removes `web_search`/`web_fetch`. Claude's measured boundary remains `--permission-mode plan` plus `--disallowedTools=…`.

### 17.3 Auth injection (`oauth_env` vs `auth_files`)

Descriptors only. The broker (`surfaceProviderAuth` in `cadp/product/surfaceBroker.ts`) resolves the descriptor into container injection (`reviewerAuthArgs` in `cadp/product/isolation.ts`). Exactly one provider's auth enters the container; the host keychain and every other provider stay unreachable.

| Kind | Injection | Reference path |
|---|---|---|
| `oauth_env` | `-e <env_var>=<token>` — operator-extracted token, never the keychain itself | claude: `CLAUDE_CODE_OAUTH_TOKEN` from `claudeProviderToken()` |
| `auth_files` | named files copied from host `~/<auth_subdir>/` into a fresh per-run dir, mounted **read-only** at `/root/<auth_subdir>/<file>:ro` | grok: `~/.grok/auth.json` (subscription OAuth; same posture the worker surface already uses) |

Both fail closed: missing host `HOME`, missing named file, or an `oauth_env` that is not the measured claude var throws; there is no fallback to another provider's token and no reuse of worker auth for a reviewer/planner (and the reverse). Worker injection is the `auth_files` path via `buildWorkerSandbox`: only the declared files are copied; host `config.toml`, MCP servers, sessions, and every other provider's subdirectory stay out. Unknown `auth_method.kind` is unsupported and throws.

### 17.4 Reviewer independence, enforced twice (§8.4)

§8.4's predicate is `identity_class.product ≠` the implementer's product. A provider can never review its own product's implementation. The implementation enforces that twice, on different owners, before and after seal:

1. **At entry, before anything is sealed.** `assertReviewIndependence(worker_product, review_provider)` (`cadp/product/reviewProviders.ts`) compares `REVIEW_PROVIDERS[review].identity_class_product` to the implementing worker's `WORKER_PROVIDERS[worker].identity_class_product` and throws on equality. `startWork` (`cadp/live/ops.ts`) calls it after resolving both selections and before `WORK_START` material is built — so a doomed grok-reviews-grok (or claude-reviews-claude-code) run spends no surface compute and writes no kernel row. Pure; the same-product pairs `("grok","grok")` and `("claude-code","claude")` fail; `("codex-cli","grok")` and `("grok","claude")` pass.
2. **On sealed evidence, at the PR/merge gates.** The reference policy derives `identity_class(envelope)` from `identity_registry[envelope.producer_ref]` under the active policy (never from the claim). `independent_product` requires that product to differ from every implementer's class; `review_ok` additionally requires `producer_ref(REVIEW) ≠ producer_ref(implementer)`. Violation is `reviewer_product_not_independent` / `reviewer_is_the_implementer` — `DENY`, no K6 (C12/C28). Grok's reviewer (`reviewer:grok`) and grok's worker share product `"grok"`, so a `REVIEW` from `reviewer:grok` cannot be independent of an implementer whose registered product is `"grok"`.

The two checks are not substitutes: the entry guard refuses the run before seal; the policy check is the constitutional one on the envelopes the gate actually sees. A draft cannot override class to slip past either (C28).

### 17.5 Per-provider kernel principals

Evidence attribution is honest per provider: each surface authenticates as its own registered principal and submits under its own `producer_ref`. A provider without a token fails closed rather than borrowing another product's identity; the kernel refuses a producer/principal mismatch.

| `producer_ref` | Principal | How the submitter authenticates | Evidence |
|---|---|---|---|
| `reviewer:grok` | `cadp-reviewer-grok` | activity host `CADP_REVIEWER_TOKEN_GROK` | `REVIEW` (`INDEPENDENT_OBSERVATION`) |
| `planner:grok` | `cadp-planner-grok` | `sealPlan` as `cadp-planner-grok` | `WORK_PROPOSAL` (`SELF_REPORT`; confers no authority) |
| `backend-scan:grok` | `cadp-backend-scan-grok` | activity host `CADP_BACKEND_SCAN_TOKEN_GROK` | `BACKEND_EXECUTION` (`SELF_REPORT`; observed model from that provider's session log) |

The claude/codex counterparts remain `reviewer:claude-code`, `planner:claude-code`, `backend-scan:codex`. Registry, adapter registry, and live-env token mint (`PRINCIPAL_TOKEN_NAMES`) name the grok principals explicitly so a grok review, plan, or backend scan cannot be sealed as a claude/codex observation. `identity_class` for those `producer_ref`s is `{vendor: xai, product: grok, …}` — the same product string the entry independence guard compares.

---

## 18. External verification backend (GitHub Actions)

GitHub Actions is a product-layer evidence source for the exact candidate sha, not a lifecycle authority and not a kernel primitive. A green check transitions nothing by itself. The repository-owned workflow runs; the broker reads the check-run result; the activity submits `VERIFICATION` evidence produced by `verifier:github-actions`; the deployment policy decides sufficiency (`require_external_verification`).

### 18.1 Repository-owned workflow

`.github/workflows/cadp-verify.yml` is the verifier. It triggers on the governed `cadp/candidate/**` push (the candidate branch the `GIT_PUSH` effect already landed). `actions/checkout@v4` checks out that exact candidate sha. The job pins OPA `1.20.1` (the same version the deployment's evaluator integrity records — without it the suite stalls to the job timeout; measured live, 16th pilot: `npm test` cancelled at 10m, check-run `conclusion=cancelled`) and runs `npm test`. Actors receive no GitHub credentials for this: the workflow is repository-owned and fires on a push that already happened.

### 18.2 Authority boundary and the broker read

GitHub is the authority for its own check runs. The broker's `/verify-external` (`cadp/product/surfaceBroker.ts`) performs one authoritative check-runs read per call via the operator's `gh` CLI on the broker host (`cadp/product/externalVerification.ts` `fetchExternalVerification`). The credential stays host-side; actors receive no GitHub credentials merely to run CI (issue #57). The polling loop lives in the activity (`verifyCandidateExternal`); the broker itself is a single read. An unauthenticated API read measured out at HTTP 403 within one polling run (60/h/IP — 16th pilot). Any read failure is honest `UNKNOWN` — never a pass or a failure.

### 18.3 Fail-closed projection and sealed evidence

`projectCheckRuns` is a pure projection of the GitHub check-runs payload. Fail-closed: anything that is not exactly **one** completed `cadp-verify` run with a conclusion projects to `UNKNOWN` with an honest reason. Queued, in-progress, absent, ambiguous-duplicate (two completed runs for one sha), or malformed (missing/unparseable fields) is `UNKNOWN` — never a failure, never a pass. A completed failure is `PRESENT` evidence that never clears a gate.

GitHub emits second-precision RFC3339 (`…:50Z`); the K2 envelope contract requires millisecond precision, and `produced_at` must equal `claim.completed_at` (`source_authoritative`). Both timestamps are normalized to the same instant in kernel form (`Date#toISOString`). An unparseable timestamp is `UNKNOWN`. Measured live (17th pilot): the verbatim GitHub string was refused by K2 and the run failed closed.

The activity submits `VERIFICATION` with `producer_ref` `verifier:github-actions`, `source_relation` `TARGET_AUTHORITY_OBSERVATION`, `claim_schema` `cadp.verification.github-actions.v1`, subject bound to the exact candidate sha, `produced_at = claim.completed_at`. The adapter registry records `produced_at_source: { kind: SOURCE, claim_pointer: /completed_at }`. An incomplete poll inside the attempt budget seals honest `UNKNOWN` evidence, not a pass and not a guessed failure.

### 18.4 Opt-in levels and the gate path

Two independent opt-ins; neither is on by default.

1. **Per-run flag.** `development.external_verification === true` (live `/start` extra arg `"external"`; anything else fails closed rather than silently skipping). The workflow then polls and, if the external conclusion is not `success`, stops with `EXTERNAL_VERIFY_NOT_SUCCESS` before any PR effect is sealed.
2. **Policy param.** `require_external_verification` in `data.policy_params`. Default `false` keeps PR/MERGE gates byte-identical. When `true`, those gates additionally require a `PRESENT` `VERIFICATION` from `verifier:github-actions` bound to the exact candidate sha with `claim.conclusion == "success"` and `source_authoritative`. Unmet is reason code `external_verification_missing` — `DENY`. A completed failure is `PRESENT` and still does not satisfy `conclusion == "success"`, so it never clears the gate.

`.github/` is a gate path (`cadp/product/gateFiles.ts`): the workflow defines what the external verifier actually runs, so a delegated merge must not auto-merge an edit to it.

---

## 19. Surface execution observability: observed model and reasoning effort for every model surface

Product-layer design for two follow-ups that are **not implemented here** and authorize no production change: (1) record observed execution facts (model, and the rest of `cadp.backend.v1` `observed.*`) for every model surface — WORKER, REVIEWER, PLANNER — not only the implementer; (2) bind requested and observed reasoning effort per surface. Implementation follows this design. An argv or log format that has not been probed live in the isolated surface is marked **requires a container probe before the registry entry is added**, never asserted. Guessing is the defect §17.2 exists to prevent.

This is not a kernel primitive. It does not add a K1–K7 record, does not change `identity_class` derivation (§9.1 / S2), and does not change the §8.4 independence predicate's inputs other than requiring that predicate to stay honest once more than one surface emits `BACKEND_EXECUTION`.

### 19.1 Current state

Only the WORKER surface records observed execution facts today.

**WORKER.** `brokerImplement` (`cadp/product/surfaceBroker.ts`) creates a fresh host directory, passes it to `runWorker` as `sessionsDir`, and mounts it writable at `/root/<auth_subdir>/<sessions_container_dir>` (`cadp/product/isolation.ts`). After the container exits, `scanBackendModel` walks that tree (and falls back to stdout) using `WORKER_PROVIDERS[p].model_scan`. `implementCandidate` then submits `BACKEND_EXECUTION` as `backend-scan:<provider>` (`cadp/product/activities.ts` `submitBackendExecution`):

- `claim_schema` `cadp.backend.v1`; `source_relation` `SELF_REPORT` (U1: backends do not sign).
- `subject_bindings` = `work_run` + `step`. There is no surface-role binding.
- `observed.model` is `PRESENT` with a locator when the scan hits, else `UNKNOWN`. Requested is a separate sub-object (`requested.model` is the broker placeholder `` `${provider} default` ``) and is never consulted to fill observed (C13 / #91 T5).
- `observed.effort` is hardcoded `{ availability: "UNKNOWN" }` for every provider. There is no `effort_scan` field and no effort capture in `scanBackendModel`.
- `observed.run_id` and `observed.version` are likewise `UNKNOWN`. `observed.provider` is `PRESENT` with locator `broker-response#backend_provider` (the broker's selection, not a session-log fact).

`model_scan` is measured only for the **worker** argv of each provider (§17.2): codex `"model"` in `rollout-*.jsonl`; grok `"model_id"` in `chat_history.jsonl` (2026-09-06 container probe, grok 1.0.13) with stdout `modelUsage` fallback; claude `"model"` in `~/.claude/projects/<slug>/<uuid>.jsonl`. Those measurements do not license a reviewer or planner registry entry.

**REVIEW.** `reviewCandidate` submits `REVIEW` as `reviewer:claude-code` / `reviewer:grok` / `reviewer:codex` with `cadp.review.v1` `{ verdict, body_digest, reviewer_run_id }`. The chosen product is the kernel-stamped `producer_ref` (identity_class derived from the active `identity_registry`, never from the claim). The claim carries no observed model and no effort. `brokerReview` calls `runReviewer` with `{ workspace, auth, argv }` only.

**WORK_PROPOSAL.** `sealPlan` (`cadp/live/ops.ts`) submits `WORK_PROPOSAL` as `planner:claude-code` / `planner:grok` / `planner:codex` with `cadp.work-proposal.v1` `{ schema, items, notes?, intent, stdout_digest }`. Same attribution-via-`producer_ref`, no observed model, no effort. `brokerPlan` also calls `runReviewer` — the planner is a reviewer-class container — with no session directory.

**No session mount on read-only surfaces.** `runReviewer` mounts the workspace `:ro`, injects one provider's auth, and places the container on the internal network with the provider-only proxy. It has no `sessionsDir` parameter and emits no session mount. `runWorker`'s optional writable sessions bind is the only such construction. After a reviewer or planner run there is therefore nothing on the host to scan: the CLI's session tree, if it wrote one, lived in the container overlay and vanished with `--rm`.

**Adapter registry (current).** `backend-scan:*` may submit `BACKEND_EXECUTION`; `reviewer:*` may submit `REVIEW`; `planner:*` may submit `WORK_PROPOSAL`. A reviewer or planner principal cannot seal `BACKEND_EXECUTION`; a backend-scan principal cannot seal `REVIEW` / `WORK_PROPOSAL`.

**Policy (current).** `implementer_refs` includes every `BACKEND_EXECUTION` `producer_ref` (and every `WORK_STEP` producer). `backend_model_present` / `backend_effort_present` quantify over any `BACKEND_EXECUTION` with the corresponding `observed.*.availability == "PRESENT"`. `require_backend_effort` (default `false`) gates `PR_CREATE` via `effort_requirement_met`; unmet is `required_fact_unknown` (C14). Because every provider's `observed.effort` is `UNKNOWN`, turning the param on today denies every `PR_CREATE`. `PR_CREATE` / `PR_MERGE` `evidence_refs` carry the implementer's `BACKEND_EXECUTION` and the `REVIEW` envelope, not a reviewer or planner execution envelope (`cadp/product/workflows.ts`).

### 19.2 Design decision — evidence shape

Two options.

**(a) Reuse `BACKEND_EXECUTION` with a role binding per surface run.** Each model-surface invocation that should be observed submits a `cadp.backend.v1` envelope through the existing `backend-scan:<provider>` principal, with one additional subject binding:

```text
{ authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" | "REVIEWER" | "PLANNER" }
```

The claim stays the scan payload (`requested` / `observed`). Ingress locator rules (C13) apply unchanged. Worker envelopes add `surface-role = WORKER` (today they have none). Reviewer envelopes bind `work_run` + `step` (the review step) + `surface-role = REVIEWER`, plus the candidate sha already bound on the sibling `REVIEW`. Planner envelopes bind the same `work-intent` + `repo-base` as the sibling `WORK_PROPOSAL` + `surface-role = PLANNER` (there is no work run yet).

**(b) Embed an `observed` sub-object into the `REVIEW` / `WORK_PROPOSAL` claims.** `cadp.review.v1` and `cadp.work-proposal.v1` would grow `{ observed: { model, effort, … } }` (and likely `requested`) beside the verdict / proposal.

**Recommendation: (a).** Grounded in the vocabulary the kernel and the policy already speak.

1. **K2 claim is source-native and Ingress-untouched (§9.1).** `cadp.review.v1` is the verdict; `cadp.work-proposal.v1` is a closed proposal schema (`parseWorkProposal` rejects unknown keys). Session-scan facts are a different source. Mixing them into those claims makes the claim no longer the adapter's native payload. `cadp.backend.v1` already exists for that payload.
2. **Adapter registry is exact `producer_ref` → kinds (§5.4 / §9.1).** The worker path already separates producers: `WORK_STEP` is `workflow:cadp-work`; `BACKEND_EXECUTION` is `backend-scan:<provider>`. The broker scans; the activity host submits with the scan token. REVIEW / WORK_PROPOSAL are submitted as `reviewer:*` / `planner:*`. Putting observed facts inside those envelopes would have the reviewer/planner principal attest to a scan it did not perform, or would force those principals onto `BACKEND_EXECUTION` in the registry — either way a producer/kind confusion the registry exists to prevent. Reuse keeps `backend-scan:* → BACKEND_EXECUTION` as the sole execution-observation producer class; no new registry producers.
3. **Requested ≠ observed is already mechanical on this kind (§9.2, C13).** Ingress `assertBackendObservedLocators` is kind-specific to `BACKEND_EXECUTION`. Option (b) either duplicates that rule onto two more kinds or leaves `PRESENT`-without-locator possible on REVIEW / WORK_PROPOSAL — the #91 T5 harm. One kind, one rule.
4. **Policy already consumes `BACKEND_EXECUTION` for model, effort, and implementer identity.** `implementer_refs`, `backend_model_present`, `backend_effort_present`, and C14 are written against this kind. Extending them with a `surface-role` predicate is a smaller, closed change than teaching `review_ok` (and any future planner check) to parse a nested backend object out of a verdict or a proposal.

**Load-bearing companion (without it (a) is a regression).** Today's predicates quantify over *any* `BACKEND_EXECUTION`. A REVIEWER envelope from `backend-scan:grok` (product `grok`) entering `implementer_refs` would make `independent_product` fail a grok review of a non-grok implementation, and could make `backend_model_present` succeed on a reviewer scan while the worker model is `UNKNOWN`. Once a second role emits this kind, every existing quantifier is role-qualified: `implementer_refs`, `backend_model_present`, and `backend_effort_present` match only `surface-role = WORKER`. Ingress, at the same landing, requires exactly one `surface-role` binding from the closed set on every `PRESENT` `BACKEND_EXECUTION`, so a role-less draft cannot satisfy a leftover unqualified rule.

Option (b) is rejected. It is not a kernel-vocabulary fit and it splits the honesty rule.

### 19.3 Design decision — capture mechanics for read-only surfaces

The reviewer/planner containers are read-only toward the **workspace**. They can be given a writable **session** mount exactly like `runWorker`'s `sessionsDir` without widening what the surface can reach.

**Minimal `isolation.ts` change.** `runReviewer` gains the same optional triple `runWorker` already has: `sessionsDir`, `sessionsContainerDir`, and `authSubdir` (required for the container path when auth is `oauth_env` and so does not carry `auth_subdir`). When `sessionsDir` is set, append the identical bind:

```text
-v ${sessionsDir}:/root/${authSubdir}/${sessionsContainerDir ?? "sessions"}
```

No `:ro` on that bind — the CLI has to write the log. The workspace bind stays `-v ${workspace}:/ws:ro`. Network, proxy, auth injection (`reviewerAuthArgs`), argv, and `--init --rm` are unchanged. `brokerPlan` already calls `runReviewer`; one mount construction covers both read-only surfaces. `runVerifier` is out of scope (no model CLI).

**Why this does not widen the surface's reach.** The session directory is a fresh, empty, broker-owned per-run path — the same object `brokerImplement` already creates — not a path into host `HOME`, the PEP secret dir, or another workspace. The container's extra write is only into that directory, so the host can scan the CLI's own session files after exit. `/ws` remains read-only; auth files remain `:ro`; the egress allowlist and the measured read-only argv (plan-mode / `--tools` allow-list / `--sandbox read-only`, §17.2) are untouched. The broker deletes the directory in `finally`, so nothing persists into a later run. A writable log directory is not a write to the candidate, not a credential, and not a governed target. CREDENTIAL_REACH_ATTESTATION continues to measure the same profile minus this log bind; the bind does not add a route.

**Broker / scan.** `brokerReview` and `brokerPlan` create the directory, pass it through, and after exit run the same scan function generalized over the **profile's** `model_scan` (not hardcoded `WORKER_PROVIDERS`). Absent `model_scan` ⇒ no model, no locator ⇒ `observed.model = UNKNOWN`. Worker `model_scan` regexes are **not** copied onto reviewer/planner profiles because they were measured under different argv (grok worker: `streaming-json` + `bypassPermissions`; grok reviewer/planner: `--permission-mode plan` + `--tools` allow-list + `--json-schema` on the reviewer). Same binary, different invocation: **requires a container probe before the registry entry is added** for that surface's `sessions_subdir` / `sessions_container_dir` / `model_scan`. Claude reviewer/planner session layout is likewise unmeasured on those argv (worker claude was measured at `~/.claude/projects`).

Stdout remains a fallback only when that surface's `stdout_regex` has been measured. A worker stdout pattern is not a reviewer stdout pattern.

### 19.4 Reasoning-effort binding

Two independent facts, same requested ≠ observed split as model.

**Requested (orchestrator → argv).** Each provider profile (worker, review, plan) may carry a per-role `requested_effort` together with a measured `effort_argv` expansion (flag token + how the value is placed). The resolver fails closed if one is present without the other. Expansion inserts the measured flag and the requested value into that surface's argv **only** where a live container probe has measured that the flag is accepted on that surface's isolated argv. Values the probe did not list are refused. If `effort_argv` is absent, argv is byte-identical to today and the claim's `requested` object carries no effort field — we do not record a CLI request we did not send. `requested` is never consulted to fill `observed`.

**Measured WORKER surface (2026-09-07 container probes, pinned surface image).** These measurements apply only to the isolated worker argv, not the reviewer/planner surfaces. Grok accepts `--reasoning-effort high` and its `chat_history.jsonl` carries `"reasoning_effort":"high"`. Codex accepts `-c model_reasoning_effort=high` on `exec` and its rollout JSONL carries both `"effort":"high"` and `"reasoning_effort":"high"`; the observed field is bound from `reasoning_effort`. Claude accepts `--effort high` headless and its projects JSONL carries `"effort":"high"`.

The measured worker expansion specs are therefore: grok appends the two tokens `--reasoning-effort`, `{value}`; codex appends `-c`, `model_reasoning_effort={value}`; claude appends `--effort`, `{value}`. The only value licensed by these probes is `high`. The checked-in profiles intentionally leave `requested_effort` and `effort_argv` absent, so all live argv remains byte-identical; choosing and enabling an effort is a deployment decision. A deployment must install both halves of the pair, and an unpaired or unmeasured value is refused.

**Observed (session / stdout scan).** Each WORKER profile now carries its measured `effort_scan`, with the same one-capture-group session/stdout shape as `model_scan`: grok and codex capture `reasoning_effort`; claude captures `effort`. The stdout expression is a same-field-shape fallback, as for the model scans. The generalized backend scan applies the identical recursive session-file-first, stdout-fallback algorithm independently to model and effort. A match produces `observed.effort = { availability: "PRESENT", value, locator }`; absent `effort_scan`, absent files, or no match produces `{ availability: "UNKNOWN" }`. Requested is never copied into observed, and locator replay (C13) applies to every `PRESENT` claim.

Reviewer and planner profiles retain no `effort_scan`: their different argv surfaces remain unmeasured and therefore `UNKNOWN`. No current profile carries `requested_effort` or `effort_argv`.

### 19.5 Policy consequences

`require_backend_effort` today means: `PR_CREATE` sees some `BACKEND_EXECUTION` whose `observed.effort.availability == "PRESENT"` (`effort_requirement_met`); default `false` keeps the gate byte-identical; `UNKNOWN` denies with `required_fact_unknown` (C14). It does not apply to `PR_MERGE` or `WORK_START`.

Once more than one surface emits `BACKEND_EXECUTION`, an unqualified `some e` would change meaning: a reviewer `PRESENT` effort could clear a worker-unknown run, and a reviewer `UNKNOWN` could fail a worker-present run if the quantifier were flipped to `every e`. Neither is the current gate.

**Decision.** `require_backend_effort` continues to mean the **implementing WORKER** surface: a `PRESENT` `BACKEND_EXECUTION` with `surface-role = WORKER` and `observed.effort.availability == "PRESENT"`. That is what C14 and `PR_CREATE` already gate in substance (only the worker emits the kind today). Default remains `false`. `UNKNOWN` never satisfies. Requested effort never satisfies.

Additional roles, if a deployment wants them, get their own opt-in params (`require_review_effort`, `require_plan_effort`), default `false`, same `PRESENT` / fail-closed / `required_fact_unknown` shape, matching `require_external_verification` (§18.4): new facts stay off until explicitly armed. Planner envelopes are not added to `WORK_START` / `PR_CREATE` / `PR_MERGE` `evidence_refs` unless such a param is on — `WORK_PROPOSAL` confers no authority and this design does not silently start gating on a plan-time scan. Reviewer execution envelopes **are** added to the PR/MERGE `evidence_refs` (alongside the existing implementer `BACKEND_EXECUTION` and the `REVIEW`) so the observation is visible; role qualification keeps `implementer_refs` / `backend_model_present` / `require_backend_effort` worker-only, so the gates stay byte-identical while those params remain default-off.

All new observed facts are opt-in in the registry (field absent ⇒ scan returns nothing ⇒ `UNKNOWN`) and fail-closed in policy (`UNKNOWN` is not a pass). No code path copies requested into observed. No code path invents an effort value from help text.

### 19.6 Implementation plan

Independently reviewable items, in this order. Later items may depend on earlier ones; an earlier item must not change gate meaning by itself. None of them is done by this section.

1. **Registry field additions.** On `REVIEW_PROVIDERS` and `PLAN_PROVIDERS`: optional `sessions_subdir`, `sessions_container_dir`, `model_scan` — present only after a live container probe of **that** surface's argv. On all three registries: optional paired `requested_effort` + `effort_argv`, and optional `effort_scan`, under the same probe rule. Worker `model_scan` entries stay as they are; they are not copied. A profile missing a field behaves as today.
2. **Isolation session mount.** `runReviewer` optional sessions bind as §19.3. Conformance: workspace remains `:ro`; the session path is the only extra writable bind; omitted `sessionsDir` keeps today's argv. No change to `runVerifier`.
3. **Broker + activity submission.** `brokerReview` / `brokerPlan` create a per-run sessions dir, pass it, scan after exit, return `{ backend_model?, backend_locator? }` (and later effort, when scanned). Generalize `scanBackendModel` over the profile's scan fields. `submitBackendExecution` grows a `surface-role` argument and always binds it; worker calls pass `WORKER`. `reviewCandidate` submits a sibling `BACKEND_EXECUTION` as `backend-scan:<provider>` with `REVIEWER`. `sealPlan` submits a sibling `BACKEND_EXECUTION` as `backend-scan:<provider>` with `PLANNER` (needs the scan token; the planner token stays `WORK_PROPOSAL`-only). These sibling envelopes are sealed for the record; they are **not** added to PR/MERGE `evidence_refs` in this item — that wait is what keeps `implementer_refs` byte-identical until item 4. Adapter registry: no new producers.
4. **Policy adapter entries.** Role-qualify `implementer_refs`, `backend_model_present`, and `backend_effort_present` to `surface-role = WORKER`. Keep `require_backend_effort` worker-scoped, default `false`. Ingress: `PRESENT` `BACKEND_EXECUTION` requires exactly one closed-set `surface-role` binding. Same landing: add the reviewer execution envelope to PR/MERGE `evidence_refs` (planner envelopes stay out unless a planner requirement is armed). Add `require_review_effort` / `require_plan_effort` default `false` only if a deployment needs them in that landing; otherwise leave the params unintroduced until a consumer exists.
5. **Conformance.** C13 still rejects `PRESENT` without locator, including on reviewer/planner execution envelopes. C14 still denies worker `observed.effort = UNKNOWN` when `require_backend_effort` is true. New controls, independently: (i) a REVIEWER `BACKEND_EXECUTION` from `backend-scan:<review-product>` does not enter `implementer_refs` and does not break a legal independent review; (ii) a REVIEWER `PRESENT` model does not satisfy `backend_model_present` when the WORKER model is `UNKNOWN`; (iii) unmeasured `model_scan` / `effort_scan` yields `UNKNOWN`, never a guessed value; (iv) `effort_argv` absent ⇒ argv byte-identical to the pre-change template; (v) reviewer/planner session mount does not make `/ws` writable and does not mount host `HOME`; (vi) a `PRESENT` `BACKEND_EXECUTION` without `surface-role` is refused at Ingress.

---

## 20. Guarded continuous-deployment contract (deployment actuation)

Product-layer design for roadmap issue #58. It is **not implemented here** and authorizes no production change: the live composition remains a disposable reference proof (README: production deployment is NOT AUTHORIZED). Implementation follows this design. This is not a kernel primitive. It does not add a K1–K7 record, does not add a root-listener document kind, and does not withdraw genesis, `POLICY_ACTIVATE`, or `BREAK_GLASS` as specified in §9.4.

What this section owns is the missing actuation contract: after a sha is on the governed `main`, something has to apply that sha to the running gate processes, and that something must itself be a governed effect with a Human on every admission — because the thing being restarted *is* the gate.

### 20.1 Current state

After every merged change an operator applies code by hand. There is no governed operation whose dispatch restarts a running component from a pinned sha.

**Process actuation today is `ctl stop` / `ctl start` / `ctl up`.** `cadp/live/ctl.ts` is the live-composition control surface (`#100`). `startComponent` names a closed set `{record, temporal, kernel, broker, worker}` and always spawns from `repoRoot = join(import.meta.dirname, "..", "..")` — whatever checkout the running `ctl.ts` was loaded from, with no sha pin, no `git rev-parse` check, and no worktree. `spawnComponent` (`cadp/live/env.ts`) writes a pid file; `killComponent` SIGKILLs it. Broker and worker additionally go through `spawnComponentSandboxed` (Seatbelt: broker denied the PEP secret path; worker denied the secret path and egress-pinned to Kernel/Temporal/broker localhost ports). Kernel, record, and temporal spawn unsandboxed. The measured post-merge operator action is: update that checkout to the merged `main`, then restart **broker** and **worker**, then re-run `ctl attest`. Kernel restart exists on the same `stop`/`start` path and is what P4 / §3.3 recovery uses; it is not the measured post-merge actuation.

**No `DEPLOY` operation exists.** `composeTargetAdapters` (`cadp/kernel/kernelService.ts`) loads store-policy, finding-seal, GitHub, GitHub Issues, Temporal, and record-service adapters. Closed `operation_kind`s actually dispatched: `GIT_PUSH`, `PR_CREATE`, `PR_MERGE`, `RECORD_WRITE`, `WORK_START`, `POLICY_ACTIVATE`, `FINDING_SEAL`, `FINDING_PROJECT`. `allocation_purposes` in the genesis bundle (`cadp/deployment/referencePolicy.ts`) has `policy-activate` and does not have `deploy`. `ctl.ts` has no `deploy` command.

**Deployment-control already exists as an evidence class, not as an actuator.** The genesis identity registry registers `cadp-depctl-probe` (`producer_ref` `deployment-control-probe`, `process_class` `deployment-control`) and `cadp-depctl-target` (`producer_ref` `deployment-control-target`, same class). The adapter registry allows those producers exactly `CREDENTIAL_REACH_ATTESTATION` and `TARGET_IMMUTABILITY_ATTESTATION`. `ctl attest` is the only live producer of both: the probe principal submits reach (negative probes inside the exact production isolation — worker/reviewer/verifier containers plus the activity-host Seatbelt profile; claim carries `alternate_path_found`, `probes[]`, `worker_profile_digest`, `surface_image` from `imageIdentity`, `network_policy_digest`, `secret_acl_digest`); the target principal submits immutability (ruleset read + admin-token negative move/delete of a probe `cadp/candidate/*` ref; claim carries `write_once_enforced`). §12 / `METHOD_REACH` (`cadp/kernel/api.ts`) gives `deployment-control` `submit_evidence`, `get_effect_state`, `request_reconcile`, `get_evidence`, `list_evidence`, `put_blob` — and **not** `seal_effect_request`, `allocate_effect_id`, `assemble_admission_input`, `evaluate`, or `admit_and_dispatch`. No governed operation applies code to the deployment.

**Policy and principal changes cannot be applied to a running deployment.** Genesis is guarded: `runGenesis` refuses with `genesis refused: policy_activation already has rows` (`cadp/kernel/genesis.ts`); `setupLiveEnv` skips genesis when an activation row already exists (`cadp/live/env.ts`). The genesis tuple minted at setup is the live env's constitution in practice: the reference bundle (`buildReferenceBundle`, including `identity_registry` / `adapter_registry` / `allocation_purposes`), the bearer-token map (`PRINCIPAL_TOKEN_NAMES` → `secret/api-tokens.json` / `workflow-token-map.json`), the root key, the PEP secret path, and the disposable-repo binding. Re-running setup on the same directory does not remint any of that. Adding a principal later does not grow an already-minted token map — measured: `ctl.ts` starts an env minted before `cadp-reviewer-grok` existed and selecting that reviewer fails closed in the activity. Kernel restart does not activate new policy source either: §3.3 / `startKernelService` verify-on-read the **store's** active `policy_activation` row and serve that bundle to OPA; `cadp/deployment/` files on disk are not the active policy. `POLICY_ACTIVATE` is specified (§6.4, §9.4) and Human-gated in the reference policy (`human_ok`; `agent_merge_ok` is merge-only, AD3), but live `ctl` has no path that seals or admits it. The successive live environments **live2 through live8** exist for exactly this reason: a new principal, a new registry row, or a new genesis bundle is a new environment, not a mutation of a running one.

**Attestations go stale on a timer, and admissions then refuse.** Recheck #8 (`cadp/kernel/pep.ts`): missing reach envelope → `CREDENTIAL_REACH_UNATTESTED`; `now - produced_at > reach_attestation_max_age_s` → `CREDENTIAL_REACH_STALE`; `alternate_path_found !== false` → `ALTERNATE_CREDENTIAL_PATH_FOUND`. Reference `reach_attestation_max_age_s = 3600` (and the same bound for `target_immutability_attestation_max_age_s`). The PEP reads `latestEvidenceOfKind`; there is no kernel timer that refreshes these two kinds. (Contrast: `PEP_TARGET_IDENTITY` **is** refreshed inside `startKernelService` at half `identity_probe_max_age_s` — §4.2. That pattern was deliberately not copied onto reach/immutability.) The only refresh is operator `ctl attest`. Measured repeatedly in live pilots: `CREDENTIAL_REACH_STALE` refusals that clear only after a manual re-attest.

### 20.2 The danger

Deployment actuation is the platform modifying **its own running gate machinery** — the ultimate self-approval surface.

The merge gate already treats a candidate that touches kernel, policy, isolation, timeout, broker, provider registries, conformance, or the constitutional documents as gate-machinery (`cadp/product/gateFiles.ts`) and withholds `AGENT_DECISION` (`ctl agentApprove` → `WITHHELD_HUMAN_REQUIRED`). That is a merge-time classification over changed paths. A **deploy** is a different act: it restarts the processes that *are* the PEP's sibling gate (broker owns clone/Docker/isolation; worker hosts activities and holds Kernel workflow tokens; `timeouts.ts` / `isolation.ts` / `surfaceBroker.ts` load at process start). Restarting those processes from a sha applies whatever that tree contains — including a no-diff-to-`gateFiles` commit that still re-loads the same isolation and timeout code into a new process. Every deploy therefore touches gate machinery **by definition**, even when the merge of that sha was ordinary and even when a delegated agent was allowed to merge it.

A delegated agent (`process_class = agent-surface`, reach `{submit_evidence(AGENT_DECISION), get_effect_state}` only, §12 r9) must never be able to actuate a deployment change that alters the kernel, policy, isolation, or timeout code that constrains it. Self-approval here is not "the implementer also reviewed"; it is "the constrained process restarts the constraint." Spec §3: one identity may not both perform and validate an incompatible duty. The merge independence predicate does not cover this duty. The deploy admission must not accept `AGENT_DECISION` at all.

Host-root residual (explicit, same class as §4.6 item 4): a human with a shell on the single-host disposable composition can still `kill` a pid or run `ctl start` out of band. DEPLOY does not claim to stop that. It claims that **the platform's own actuation path** — workflow, agent, broker, worker — cannot restart gate components without a Human-admitted effect. An ungoverned `ctl stop`/`start` of broker/worker after this contract lands is that residual, not an alternative product path.

### 20.3 Design decision — the actuation contract

A governed `DEPLOY` operation. One effect, one exact sha, one named component set, one Human.

```text
cadp.deploy.v1 {
  repo_id,                                      // governed repository (target-authoritative)
  sha,                                          // exact merged main sha to run
  components: subset of { "broker", "worker" }, // this generation's closed actuation set; non-empty
  expected_prior: {                             // prior observed identity, per named component
    <component>: { code_sha, image_digest?, pid? }
  }
}
```

Material is a CAS object like every other K3 material (`material_schema = cadp.deploy.v1`, §6.6). Unknown keys refused. Empty `components` refused. Names outside `{broker, worker}` refused at `verify_material` this generation — including `kernel`, `record`, and `temporal`, which `ctl start` can still spawn. **Kernel self-restart residual:** the PEP cannot kill itself inside the K6→dispatch transaction; kernel code changes continue to take effect only by operator `ctl stop/start kernel` (P4 / §3.3) or by a fresh environment. Governing PEP self-restart is a follow-up, not this issue. Record and temporal are commodity processes, not gate machinery.

**Admission requires all of:**

**(a) Ancestry.** `sha` is an ancestor of the governed repo's `main` (or is `main`) as observed from the target authority — GitHub `GET /repos/{id}/compare/{sha}...{default_branch}` status `ahead` or `identical`. A candidate ref, a fork sha, a diverged sha, or a sha the compare cannot see is refused pre-K6; no process is touched. This is what makes rollback a DEPLOY to a previous sha (still an ancestor) and what makes "deploy this unmerged candidate" impossible.

**(b) Fresh attestations.** Recheck #8 already refuses `CREDENTIAL_REACH_UNATTESTED` / `CREDENTIAL_REACH_STALE` / `ALTERNATE_CREDENTIAL_PATH_FOUND` for every admission, DEPLOY included. DEPLOY additionally requires a fresh `TARGET_IMMUTABILITY_ATTESTATION` for this `repo_id` (`write_once_enforced = true`, within `target_immutability_attestation_max_age_s`), even though DEPLOY is not itself a `PEP_READ_THEN_ACT` GitHub operation: restarting the gate without a proven write-once candidate namespace would leave the next `GIT_PUSH` / `PR_CREATE` on an unattested target. Both envelopes must be `PRESENT` at assembly; stale or failing attestations are not cured by the Human decision.

**(c) A `HUMAN_DECISION` always — never delegated.** Path A (§9.3): seal the DEPLOY request → evaluate → `REQUIRE_EVIDENCE(HUMAN_DECISION)` → the Human is shown the exact `effect_id`, `request_digest`, `sha`, `components`, `expected_prior` → approve → new input → fresh evaluate → `ALLOW` → K6. `agent_merge_ok` does not apply (it is merge-only today; DEPLOY must not grow it). An `AGENT_DECISION` present for the same scope does not satisfy; reason code `HUMAN_DECISION`, the AD3 shape. `delegated_merge_producers` is irrelevant. There is no "ordinary sha" exception: see §20.2.

**Local pin (pre-K6, host observation).** `git -C repoRoot rev-parse HEAD` equals `material.sha` and `git status --porcelain` is empty. Otherwise `DISPATCH_PRECONDITION_FAILED`, no admission — the operator (or deployment-control) fast-forwards the checkout to that exact sha and retries the same sealed request. Dispatch then performs the existing pid-kill + `spawnComponent` / `spawnComponentSandboxed` for each named component. Spawn root remains `repoRoot`; this generation does not invent a detached worktree. The pin is what makes "restart from the updated checkout" a function of the sealed sha rather than of whatever the operator's HEAD drifted to between approval and start.

**POLICY-changing deploys stay impossible (fresh-env-only).** Two options.

**(i) Fresh-env-only (preserve the genesis guard).** DEPLOY never publishes a `policy_ref`, never appends `policy_activation`, never remints tokens, never re-runs genesis. A sha whose tree changes `cadp/deployment/` may still be deployed (broker/worker restart); the running kernel continues to serve the store's already-active bundle. New principals, new registry rows, a new genesis bundle, a new secret path: mint a new environment. That is what live2 through live8 already are.

**(ii) `POLICY_ACTIVATE`-composed path.** A DEPLOY of a policy-changing sha would also seal/admit a `POLICY_ACTIVATE` (Human-gated, already specified) against the same expected-active row, then restart. One Human click would both mutate the constitution that admits the next effect and restart the processes that enforce it.

**Recommendation: (i).** Grounded in what the live composition actually is.

1. **Genesis mints more than a bundle.** `POLICY_ACTIVATE` rotates store-side policy content. It does not mint `PRINCIPAL_TOKEN_NAMES`, rewrite `secret/api-tokens.json`, or rebind the disposable repo. A composed path that activated a bundle naming a new principal would leave that principal without a token in the running secret path — the same fail-closed that already bites envs minted before `cadp-reviewer-grok`. The reverse hole (token without registry) is not created by DEPLOY under (i) because DEPLOY does not remint tokens either.
2. **Stacking constitution change on process restart is a different self-approval surface.** `POLICY_ACTIVATE` is already a Human-gated governed effect on `cadp-store:k04`. Composing it with DEPLOY asks the running PEP to admit a new constitution and then restart the gate under it in one operational gesture. Even with `HUMAN_DECISION` on both, the duties are incompatible in the Spec §3 sense: the constitution that constrains DEPLOY would be replaced as part of DEPLOY. Keep them sequential and separately sealed, or keep policy change on the genesis/fresh-env path that live operations actually use.
3. **Kernel restart does not read `cadp/deployment/`.** Applying a policy-source sha via broker/worker restart is already a no-op on the active policy. Pretending DEPLOY "applies policy" would be a false claim about the current kernel. Honest split: DEPLOY applies process code; genesis / `POLICY_ACTIVATE` applies constitution; only the first is this issue.

`POLICY_ACTIVATE` as specified in §9.4 is **not withdrawn**. It is not composed into DEPLOY. Live `ctl` still has no `POLICY_ACTIVATE` command; exposing one is a different issue. Enabling the DEPLOY *policy rules themselves* (new `allocation_purpose`, evaluator branch, adapter `describe` row) is a constitution change, so the first environment that can admit a DEPLOY is a fresh env whose genesis bundle contains those rules — the live2–live8 pattern, applied once to introduce the operation. A standalone Human-gated `POLICY_ACTIVATE` of those rules onto an older env is possible under §9.4 but is not a DEPLOY and is not required by this design.

**§11 implications.** The reference composition (§11) gains one replaceable component class: a **deployment-actuation adapter** whose target is the live env's process set (pid files + spawn from the pinned checkout), not GitHub, not the constitutional store, not Temporal. Reference choice: the existing `ctl stop`/`start` machinery, now reachable only through `admit_and_dispatch`. Why: measured. Replaceability: any host supervisor that can prove the same COMMITTED/NO_EFFECT rules (§20.4) and hold no governed-target credential beyond what deployment-control already holds. It is not a new Kernel Service. It is not folded into `StorePolicyAdapter`. Unmeasured: any production orchestrator (k8s rollout, image registry); those stay `UNKNOWN`, never assumed.

**§12 / root-operation implications.** DEPLOY is an ordinary governed effect. `admit_and_dispatch` remains workflow-only. `deployment-control` does not gain seal/admit reach — it continues to produce reach/immutability evidence and may `request_reconcile`. The Human SSO surface submits `HUMAN_DECISION` only (path A). `agent-surface` still cannot admit, and its `AGENT_DECISION` cannot satisfy DEPLOY. `observer` still cannot. **DEPLOY is not a root operation:** it does not join `GENESIS` / `BREAK_GLASS` on the root listener; there is no `cadp-sig-1` document kind `DEPLOY`; there is no `BREAK_GLASS(DEPLOY)` action. Root operations stay the two already specified (§9.4, §12, C29/C39/C42). A Human-admitted DEPLOY is still a K6 row with a K7 outcome, fail-closed on stale attestations, reconcilable, and in the effect ledger — that is the point of not making it a root shortcut.

### 20.4 Rollback and observation

The deploy records the **prior** component versions as evidence, not as a side log.

**Receipt (K7, bound to material).** For each named component, dispatch observes before stop and after start:

```text
{ component, prior: { code_sha, image_digest, pid },
             next:  { code_sha, image_digest, pid } }
```

`code_sha` is `git rev-parse HEAD` of the spawn root (must equal `material.sha` on `next`). `image_digest` is `imageIdentity` (`cadp/product/isolation.ts`) for broker/worker — the same digest `ctl attest` already puts on the reach claim as `surface_image`. `pid` is the pid-file value. At least one receipt field is a function of the material (`next.code_sha == material.sha`) — the §6.4 receipt-binding rule. `expected_prior` in the material is the NATIVE_PRECONDITION: if a prior identity was claimed and the pre-stop observation differs, `REJECTED_NO_EFFECT` (the running set is not what the Human approved rolling away from). A first-ever DEPLOY on an env may omit `expected_prior`; every subsequent DEPLOY carries the last receipt's `next` as `expected_prior`.

**Rollback is a first-class DEPLOY** to the previous `code_sha` with `expected_prior` = the failed/unwanted receipt's `next`. Ancestry still holds (the previous sha remains an ancestor of `main` unless `main` was force-pushed — in which case compare fails closed and rollback needs a Human on a different sealed sha, honestly). There is no `ROLLBACK` operation, no root undo, and no "revert the K7 row."

**Post-deploy attest is reconciliation, not an operator afterthought.** Temporal's `WORK_START` is not `COMMITTED` on `StartWorkflow` success; it waits for a target-returned Describe memo (§6.4, C34). DEPLOY is the same shape: pid-start is `ACCEPTED` transport, not the outcome. The Reconciler (`request_reconcile`, including by deployment-control) treats the effect as `COMMITTED` only when all of: named components are alive at `next.pid`; `next.code_sha == material.sha`; a `CREDENTIAL_REACH_ATTESTATION` with `alternate_path_found = false` and a `TARGET_IMMUTABILITY_ATTESTATION` with `write_once_enforced = true` exist, **produced after `admitted_at`**, and bound to this `effect_id` in addition to their current subjects (`deployment/cadp-v04-live`, `GIT_REPOSITORY/{repo_id}`). Those envelopes are the existing kinds from the existing principals — no new evidence kind. If the restart happened and the post-deploy probe reports `alternate_path_found = true`, the outcome stays `UNKNOWN` (or a later `COMMITTED` is still forbidden); the failing envelope is sealed honestly; recheck #8 then refuses every subsequent admission, including another DEPLOY, until a passing attest exists. The operator is not asked to "remember to attest." An attest that never comes is `UNKNOWN` until reconcile bounds (`reconcile_max_attempts`) exhaust, then `RECONCILE_EXHAUSTED` and the Human exception branch (§6.5) — the restarted processes are left as found; they are not silently rolled back.

### 20.5 Staleness

Today CREDENTIAL_REACH goes stale on a timer and admissions refuse. The identity probe already auto-refreshes inside the kernel; reach and immutability do not, because they cannot: the reach probe must run **inside worker identity** in the production isolation (§9.2, C6), and the immutability probe is a ruleset read plus an admin-token negative push. The Kernel Service must not impersonate either producer (`deployment-control-probe` / `deployment-control-target`); if it submitted those kinds, `producer_ref` would be a lie and the adapter registry would have to list the PEP as a reach attester — the credential-custody confusion C6 exists to prevent.

**Decision: auto-refresh attestations under a governed schedule, as evidence production, not as an effect.**

- Owner: deployment-control (`ctl attest` as it exists), not the worker, not the agent, not a `WORK_START`. Attest is `submit_evidence`. It is not `admit_and_dispatch`. Recheck #8 therefore does not apply to the refresh itself — a stale deployment can still attest its way back to admissible. If attest were a governed effect that required a fresh reach envelope, a stale env could not recover without a root operation. That chicken-egg is why this stays evidence.
- Period: half of `reach_attestation_max_age_s` (reference: 1800 s), matching the identity-probe cadence already in `startKernelService`. The immutability max age is the same bound; one `ctl attest` produces both envelopes, so one timer covers both.
- Failure: a probe that finds an alternate path or a ruleset that no longer enforces write-once **seals that fact** (`alternate_path_found = true` / `write_once_enforced = false`) and does not retry-until-green. The next admission refuses. Healing is a later passing probe, honestly timestamped.
- DEPLOY does not replace the schedule: admission still needs a *pre-deploy* fresh pair (b), and reconciliation still needs a *post-deploy* pair produced after `admitted_at` (§20.4), even if the timer is not due — the component set just changed, so the last pre-restart probe is not evidence about the new processes.

**Evidence the schedule leaves behind.** Each tick is a new K2 envelope of the existing kinds (append-only; PEP already reads latest). The claim already carries the load-bearing observations: `probes[]`, `alternate_path_found`, `worker_profile_digest`, `surface_image` (image digest + tool versions), `network_policy_digest`, `secret_acl_digest`, ruleset body, negative-probe exits. `produced_at` is Ingress-stamped; for these kinds `produced_at_source = NONE`, so freshness is envelope time, which is what #8 already consumes. No new record kind, no schedule row in the constitutional store, no "attestation is current" flag. Historical ticks remain queryable via `list_evidence`. A tick that did not happen is visible the same way it is today: the latest envelope's `produced_at` is older than `max_age` and the next `admit_and_dispatch` returns `CREDENTIAL_REACH_STALE`.

### 20.6 Implementation plan

Independently reviewable items, in this order. Later items may depend on earlier ones; an earlier item must not change gate meaning by itself. None of them is done by this section. Introducing the evaluator/allocation-purpose rows is a genesis-bundle change and therefore ships in a **fresh live environment** (§20.3 recommendation (i)), not by composing `POLICY_ACTIVATE` into the first DEPLOY.

1. **Closed operation and material.** `DEPLOY` / `cadp.deploy.v1` as above. Adapter `describe()` row on a new deployment-actuation adapter; `available` is false unless both attestations are fresh and passing (same predicate `PR_CREATE` already uses for immutability). Conformance: unknown key, empty `components`, name outside `{broker, worker}` (incl. `kernel`) → `MATERIAL_INCOMPLETE` / verify refusal, process delta 0. No dispatch yet.
2. **Ancestry and checkout pin (pre-K6).** GitHub compare `{sha}...main` must be `ahead` or `identical`; local `HEAD == sha` and a clean worktree. Negative: unmerged candidate sha, diverged sha, dirty or wrong HEAD → `DISPATCH_PRECONDITION_FAILED` or verify refusal, no pid change. Positive: a sha that is `main` itself is admissible.
3. **Policy and caller contract.** Evaluator: `op == "DEPLOY"` ALLOW iff `human_ok`; REQUIRE_EVIDENCE(`HUMAN_DECISION`) otherwise; `agent_merge_ok` does not apply. `allocation_purposes` gains `deploy`. Adapter registry unchanged (no new evidence producer). Conformance: AD3-shaped control — `AGENT_DECISION` does not clear DEPLOY; a `HUMAN_DECISION` for a different `effect_id` / `material_digest` does not either; workflow admits, `cadp-depctl-*` cannot `admit_and_dispatch` (existing C29).
4. **Dispatch of broker/worker.** After K6, existing `killComponent` + `startComponent` for each named component. Receipt as §20.4. `expected_prior` mismatch → `REJECTED_NO_EFFECT`, components left running. Conformance: after COMMITTED-path dispatch, new pids exist, `next.code_sha == material.sha`, prior identity is in the receipt.
5. **Reconciliation includes post-deploy attest.** `ctl attest` (same principals, same probes) is invoked as part of reconcile, not as a documented operator step. Envelopes bind the DEPLOY `effect_id`. COMMITTED only on the §20.4 predicate. Conformance: withhold the post-deploy envelopes → outcome is not COMMITTED; seal a failing reach envelope after restart → still not COMMITTED, and a subsequent ordinary admission refuses #8.
6. **Rollback.** A second DEPLOY whose `sha` equals the first receipt's prior `code_sha` and whose `expected_prior` equals the first receipt's `next` is admitted under the same (a)(b)(c) rules and, on COMMITTED, restores that prior identity. Conformance: that sha still compare-ancestors `main`; a sha that is not an ancestor refuses.
7. **Scheduled attest refresh.** deployment-control timer at half `reach_attestation_max_age_s` running `ctl attest`. Conformance: without the timer, #8 still refuses at `max_age` (no behaviour change if the schedule is omitted); with the timer, a new envelope appears inside the window and a failing probe is sealed as failing, not retried into a pass. Kernel `setInterval` identity probes are untouched and do not start submitting reach envelopes.

---

## 21. Product workflow runtime and the step execution edge (Conductor integration)

Product-layer design. It is **not implemented here** and authorizes no production change; implementation follows this design. This is not a kernel primitive: it adds no K1–K7 record, changes no `identity_class` derivation (§9.1), and does not alter the §8.4 independence predicate. What this section revises is how §7's commodity-orchestrator principle is **realized for product verticals**: alongside the reference Temporal composition (§7, unchanged for kernel-adjacent work), Microsoft **Conductor** (MIT license; YAML-declared multi-agent workflows; deterministic Jinja routing) is adopted as a product workflow runtime.

Measured design inputs (container probe, 2026-09-07): custom `base_url` routing works on the OpenAI chat-completions wire, with `stream: true` and structured output delivered as a **forced `final_result` tool call**; Conductor writes an events JSONL (`workflow_started` / `agent_started` / `agent_retry` / `checkpoint_saved`) under `TMPDIR`; the provider config name is a **closed pydantic literal**, so a native `cadp` provider requires an upstream patch, while the internal `AgentProvider` ABC (`execute(agent, context, rendered_prompt, tools, extra_mcp_servers) -> AgentOutput`) is the natural longer-term seam. Anything not in that probe list is unmeasured and is marked **requires a container probe before implementation** below — never asserted. Guessing is the defect §17.2 exists to prevent.

### 21.1 Conductor is a Product Workflow Runtime outside the kernel

Conductor is composition core only; CADP remains the authority core. The kernel continues to see exactly what §7.1 names: (1) a `WORK_START` governed effect, (2) ordinary `EffectRequestV1`/evidence submissions during the run, (3) `WORK_STEP` / `WORK_BOUND_STOP` evidence that makes the run reconstructable. §7.1 is unchanged, and its rule applies to Conductor **verbatim**: orchestrator history is never authority. Conductor's `events.jsonl` is Temporal history's analogue — a commodity runtime artifact, useful and read (§21.4), but never a kernel row and never what reconstruction trusts. No Conductor state, checkpoint, or event enters the Constitutional Store.

### 21.2 The Step Execution Edge

**Decision.** A single product-layer seam — the **Step Execution Edge** — that Conductor calls for **every** step. No step class executes outside it.

- **Model steps** route through a **Model Facade** protocol adapter: the measured OpenAI chat-completions face (SSE streaming plus the forced `final_result` tool call — the exact wire shape the probe held) presented over the **existing** surface broker and 3×3 provider adapters (§17). The facade is a protocol translation over measured surfaces, not a new provider integration; the closed registries, auth injection (§17.3), and per-provider principals (§17.5) stay the only path to a backend.
- **Non-model executor classes** — script, deterministic validator, retrieval — each carry an **explicit isolation contract** declared on the executor class, not inferred from the step. Script executors run in the verifier-class network-none container posture (the §8.2 fresh-clone shape: no governed-target egress, no credentials). An executor class without a declared sandbox is a **bypass lane** — a route around every posture §17.2 measured — and is refused at the edge, fail-closed, never defaulted.

### 21.3 Execution Receipt split

Each layer asserts only what it actually observed; neither vouches for the other's facts — the same requested ≠ observed honesty as §19 / C13, applied to the seam.

- **Facade/edge receipt (backend facts).** Requested vs observed product / model / effort, request and response digests, and the backend evidence id. These are facts the facade saw on the wire or scanned from the surface; the facade does not assert step semantics.
- **Conductor-side conformance edge receipt (step identity).** Step ordinal, logical agent, input and output digests, prior-step digest. These are facts the conformance edge knows from the workflow definition and the step boundary; it does not assert which backend actually served the tokens.

A receipt field neither layer measured is `UNKNOWN`, never copied across the split.

### 21.4 The LIVE path is authoritative

**Decision.** On step completion the conformance edge submits `WORK_STEP` through the **existing** §7.4 replay-idempotent ingress, under the same `(work_run_ref, step_ordinal)` lock, **before any dependent effect admission**. The §7.4 contract applies unchanged: same semantic payload converges on the same envelope; a differing payload is `WORK_STEP_CONFLICT` plus incident and scope hold; reconstruction reads exactly one envelope per ordinal. `events.jsonl` is recovery, reconciliation, and audit **cross-check only** — a commodity locator for "what did the runtime think happened," compared against kernel rows when reconciling a crashed run. It is never promoted post-hoc to authoritative evidence: a step that exists only in `events.jsonl` did not happen, constitutionally.

### 21.5 Tool lanes and the human gate

- **Read/pure tools** may execute directly inside the step's declared executor posture.
- **Mutating tools carry no real credentials.** Every mutating tool a Conductor agent can name is an **effect-tool shim** that seals an `EffectRequestV1` through the kernel gate (§3.4/§4.4) and returns the kernel's answer; custody stays where §4 put it. A tool that could mutate a governed target directly would be #89 boundary 4 reopened.
- **`extra_mcp_servers` and provider-native agentic tool loops are pinned by an allowlisted runtime profile**, and that profile is gate-path material (the §18.4 sense: a delegated decision must not auto-approve an edit to it). Name-based trust is forbidden — a tool or server is what its measured posture holds, not what its name claims. The measured lesson is §17.2's grok probe: `--permission-mode plan` sounds read-only and still executed `run_terminal_command`; only the probed allow-list held. The same rule applies to every MCP server and tool loop Conductor can reach.
- **Conductor's human gate is a UI/wait primitive only.** It can pause a run and render a prompt; it confers nothing. A paused run resumes only on a `HUMAN_DECISION` envelope (§9.3) bound to the exact run, subject, and effect — never on the gate's own local approval event.

### 21.6 Governed runs (P2)

A governed Conductor run is an ordinary §7.2-shaped `WORK_START`:

```text
EffectRequestV1 {
  operation_kind = WORK_START
  target_ref     = { authority_ref: conductor:<deployment>, target_type: WORKFLOW,
                     target_id: <workflow-name>@<workflow_definition_digest> }
  material       = { workflow_definition_digest, workflow_input_digest, provider_binding_digest,
                     runtime_profile_revision, policy_ref,
                     bounds: { max_steps, max_effects, deadline, budget? } }
}
```

The PEP admits it like any effect and dispatches a **digest-pinned** Conductor run: the definition the runtime loads must reproduce `workflow_definition_digest`, or the dispatch refuses. `effect_id(WORK_START)` is the canonical `work_run_ref` (§7.4 unchanged); Conductor's own run id is a commodity runtime locator recorded in receipts, never an identity the kernel trusts.

**Step-counting semantics.** One Conductor **agent completion** is one step against `max_steps`. Internal provider turns are backend facts only, recorded (if at all) in the facade receipt — measured: a single agent emitted nine `agent_turn_start` events in one completion. Counting turns as steps would make the bound a function of a provider's internal loop shape; the bound binds what the workflow definition names.

### 21.7 Conductor principal

The Conductor runtime holds **zero** external provider, target, or deployment credentials — the facade and the effect-tool shims are its only reach — plus one **bounded CADP-call capability**: a run-scoped, short-lived principal minted at `WORK_START` dispatch. Every edge call (facade, `WORK_STEP` submission, effect-tool shim) authenticates as that principal, so the kernel binds each call to its admitted run and an expired or foreign run cannot submit into another run's ordinals. The principal confers no seal/admit reach beyond what the run's policy grants; it is not an operator identity.

### 21.8 Rollout P0/P1/P2 and stop-loss

Three levels, each with an explicit stop-loss; a domain may deliberately stay at a lower level.

- **P0 — wire probe.** The facade speaks SSE plus the forced tool-call round trip — the measured failure shape — against the existing §17 adapters, driven by a real Conductor workflow with `base_url` pointed at the facade. **If P0 fails, stop**: no receipts, no governed runs, no upstream patch work.
- **P1 — execution integration.** Receipts and attribution (§21.3), live `WORK_STEP` (§21.4), tool lanes (§21.5). At this level, decide whether the native provider patch is even needed, or whether the `base_url` facade suffices indefinitely.
- **P2 — governed run.** §21.6 material, digest-pinned dispatch, run-scoped principal, human gate bound to `HUMAN_DECISION`.

**Requires a container probe before implementation** (unmeasured; never assumed): Conductor resume mechanics after a crash or gate wait; stream-disable options (whether the wire can run without `stream: true`); the `AgentProvider` patch surface (what an upstream `cadp` provider would actually override); the human-gate wire format.

### 21.9 Implementation plan

Independently reviewable items, ordered P0 first. Later items may depend on earlier ones; an earlier item must not change gate meaning by itself. None of them is done by this section.

1. **(P0) Model Facade wire probe.** OpenAI chat-completions face over the surface broker: SSE streaming plus a forced `final_result` tool-call round trip from a real Conductor workflow against the existing 3×3 adapters. Conformance: the structured output arrives as the tool call, byte-digested on both sides. Stop-loss: failure here ends the integration; no later item proceeds.
2. **(P0) Executor isolation contracts.** Declare the per-class contract; script executor in the verifier-class network-none container posture. Conformance: an executor class without a declared sandbox is refused at the edge (fail-closed, no default posture); a script step observes no governed-target egress.
3. **(P1) Execution Receipt split.** Facade backend receipt and conformance-edge step receipt as §21.3, requested ≠ observed preserved, unmeasured fields `UNKNOWN`. Conformance: neither receipt carries a field its layer did not observe.
4. **(P1) Live `WORK_STEP` submission.** Conformance edge submits through the §7.4 ingress under `(work_run_ref, step_ordinal)` before dependent effect admission. Conformance: runtime retry/replay converges on one envelope per ordinal; a divergent resubmission is `WORK_STEP_CONFLICT`; a step present only in `events.jsonl` reconstructs as absent.
5. **(P1) Tool lanes and runtime profile.** Effect-tool shims for every mutating tool; allowlisted runtime profile pinning `extra_mcp_servers` and provider-native loops, treated as gate-path material. Conformance: an unlisted MCP server or tool loop is refused; a mutating tool reaches no credential; the §17.2 name-based-trust control (a "read-only-sounding" mode is not trusted unprobed) passes.
6. **(P1) Provider-seam decision.** With P0/P1 measured, decide facade-only vs upstream `AgentProvider` patch; probe the patch surface first (**requires a container probe before implementation**). No patch ships before the decision.
7. **(P2) Governed run.** §21.6 `WORK_START` material, digest-pinned dispatch, run-scoped principal minted at dispatch, agent-completion step counting. Conformance: an unpinned or digest-mismatched definition refuses to dispatch; nine internal turns count as one step; an expired run principal cannot submit.
8. **(P2) Human gate binding.** Conductor's wait primitive resumes only on a `HUMAN_DECISION` envelope bound to the exact run/subject/effect (probe the human-gate wire format first — **requires a container probe before implementation**). Conformance: the gate's local approval event alone resumes nothing.

