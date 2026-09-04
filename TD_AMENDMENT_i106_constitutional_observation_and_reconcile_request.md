# TD v2 Amendment Candidate — Constitutional read-only observation and bounded re-observation request (#106, superseding)

| Field | Value |
|---|---|
| Status | **DESIGN CANDIDATE — superseding contract, repair round 2 applied; BLOCKED on M1–M8 evidence access (§12)**; TD v2 amendment authority only upon Control scope check + independent Review + Human TD decision/merge |
| Kind | Bounded TD authority amendment (contract-gap closure). **Not** a Platform Core redesign, not a product contract, not implementation authorization |
| Supersedes | First #106 Design candidate `#106 issuecomment-5529476844` (SUPERSEDED / NOT EXECUTION-READY per Review `issuecomment-5533914618` REQUEST_CHANGES and Control `issuecomment-5533947705`) |
| Architecture authority | Spec v0.4 (blob `01ce0e787f7a6dcf283dc3e7bdacbced8c265201`) > landed TD v2.0 r7 |
| Design issue / control / source | #106 / #65 / #96 (Review B1: `CONTRACT_GAP CONFIRMED`, `TD_CHANGE_REQUIRED YES`) |
| Implementation | **HOLD** — this document authorizes no code change |

## 0. Frozen current basis

```text
main (candidate rebase base, past PR #112):     b30c623de50296b4ca1a8c99c463f4d219698654
main (landed through PR #110 merge):            2a49d909c5962eeb507a7a5c62882e14393b8824
TECHNICAL_DESIGN_cadp_v0_4_generation.md blob:  ca16fd9a324efa017fc7102e9e967477b4c00754   (TD v2.0 r7)
Specification v0.4 blob:                        01ce0e787f7a6dcf283dc3e7bdacbced8c265201   (matches TD's declared Spec authority)
cadp/kernel/api.ts blob:                        6d3a8e42b0668168bf9994a00d4dd0e2e11f3e05   (measured method-reach evidence)
cadp/kernel/reconciler.ts blob:                 f0f5318f9624310c364b61d56fc9c2ee6a8e3332   (measured reconcile evidence)
cadp/kernel/ingress.ts blob:                    ebd3df1450e4e0840ff96a5e122e77d586203021   (measured requester_ref stamping + inline-claim sealing)
cadp/kernel/pep.ts blob:                        6b5e1931d60d8e1fb55bbe3d9817488c861f4018   (measured serialization-domain lock D)
cadp/kernel/policyBundle.ts blob:               31a6a1f8d7738865d7010debf8fb18e543ffd9bd   (measured v1 config keys)
cadp/deployment/referencePolicy.ts blob:        08d5eedf50ab03b6549f3d969f08f592cbd40de4   (measured principal/producer_ref registry values)
issue-creation-time main (recorded):            8e63009fb3dd25fdeaf17ddf3023adcd8facb1ed
```

Rebase note (repair round): the candidate was rebased from `2a49d90` onto `b30c623` per Review; the
`2a49d90..b30c623` delta touches only `devharness/` bootstrap tooling and no-op commit pairs. All four
frozen authority/evidence blobs above were re-verified byte-identical at `b30c623`, so every measured
claim in this document remains valid against the rebased basis.

Judgments fixed by the prior independent Review and Control disposition, preserved here unchanged:

```text
SPEC_GAP                NOT_CONFIRMED          SPEC_CHANGE             NO
TD_GAP                  CONFIRMED              OPTION_A_OVER_B         ACCEPTED
K1_EXCLUSION            ACCEPTABLE             NEW_CORE_ROLE           NO
NEW_AUTHORITY_PRIMITIVE NO                     IMPLEMENTATION          HOLD
```

## 1. Exact confirmed gap (#96 Review B1, re-verified against the frozen basis)

Landed TD §12 authorizes every Kernel API method by `identity_class.process_class` resolved from the **active** policy's `identity_registry`. The measured reach matrix (`cadp/kernel/api.ts` `METHOD_REACH`, blob above) defines exactly five classes — `workflow`, `worker`, `evidence-adapter`, `human-surface`, `deployment-control` — plus the root identity on a separate listener. Re-verified facts:

1. **No read-only caller class exists.** Every class that can read (`get_effect_state`) can also write: `workflow` reaches allocate/seal/assemble/evaluate/admit; `worker`, `evidence-adapter`, `human-surface`, `deployment-control` all reach `submit_evidence` and/or `put_blob`.
2. **No K2 read API exists.** No method returns an `EvidenceEnvelopeV1` by exact ref; no method enumerates evidence by subject or kind. `get_effect_state` requires an already-known `effect_id` and returns only K3/K4/K5/K6/K7 projections of that one effect.
3. **No scoped effect enumeration is reachable read-only.** `list_effects(work_run_ref)` is granted only to `workflow` and `worker`.
4. **`request_reconcile` is not a bounded bridge.** It is granted to `workflow` (unscoped, together with full admission reach) and `deployment-control`; it synchronously drives `Reconciler.reconcileEffect`, whose `UNKNOWN` outcome rows count toward `reconcile_max_attempts` regardless of who triggered the pass, so a requester can drive an effect to `RECONCILE_EXHAUSTED`.

Therefore the `cadp.operability.v1` diagnostic reader (#96) cannot obtain exact constitutional observations under the landed TD without one of the unauthorized workarounds the issue prohibits (register as `workflow`; direct DB SELECT; invented methods/classes in implementation). `TD_CHANGE_REQUIRED = YES` stands. `NO_TD_DELTA_AFTER_REASSESSMENT` is not available: the above is current measured evidence, not a stale claim.

## 2. Chosen minimal constitutional read pattern (D1)

**Option A — Kernel-served primary read-only observation API** (accepted direction, preserved). The Kernel Service itself serves verified reads of its own constitutional rows to a new structurally read-only caller class. Option B (separately authorized SELECT-only DB capability) remains rejected: it would create a second, kernel-external read authority over the constitutional store, would need its own verify-on-read implementation and freshness contract outside the kernel build, and would widen — not narrow — the trusted surface. Option A adds no new store principal, no new deployable unit, and reuses the existing verify-on-read machinery (TD §2.5) and the existing per-method reach mechanism (TD §12).

No new K-record is introduced. The observation response wrapper (`ObservationV1`, §4.2) is a **derived, read-only projection** of stored K1–K7 rows in the exact sense TD C41 already establishes for the conformance report: it is never stored, never cited as evidence by digest, and confers no authority.

## 3. Caller classes and method reach delta (D2, D5)

### 3.1 New `process_class` values

Two new values for the existing `identity_class.process_class` field (TD §5.4 `identity_registry`; exact string match, no patterns):

```text
observer             structurally read-only constitutional observation
reconcile-requester  request-only re-observation bridge (request_reconcile and nothing else)
```

These are **authorization-mechanism entries, not Platform Core roles** (Spec §3 role table is unchanged; no Supervisor/Actor/Auditor revival; no new surface owns anything). A `process_class` is how the landed kernel keys method reach; adding values to the closed reach table is the smallest change that separates read reach from work/effect/admission reach, because — as Review B1 established — independent identity *names* alone are insufficient under authorization-by-`process_class`.

### 3.2 Amended TD §12 reach matrix (full delta)

New columns; every existing cell is **unchanged** except the `request_reconcile` row, which gains subject scoping (§6.2). The entire delta — the two new columns and the changed `request_reconcile` cells — is active **only while a v2 bundle is active**; under v1 the landed matrix applies verbatim (§6.4 version gate, §7.2):

| Method | workflow | worker | evidence-adapter | human-surface | deployment-control | **observer** | **reconcile-requester** | root |
|---|---|---|---|---|---|---|---|---|
| `put_blob` | yes | yes | yes | no | yes | **no** | **no** | no |
| `allocate_effect_id` | yes | no | no | no | no | **no** | **no** | no |
| `seal_effect_request` | yes | no | no | no | no | **no** | **no** | no |
| `submit_evidence` | (as landed) | (as landed) | (as landed) | (as landed) | (as landed) | **no** | **no** | root listener only |
| `assemble_admission_input` | yes | no | no | no | no | **no** | **no** | no |
| `evaluate` | yes | no | no | no | no | **no** | **no** | no |
| `admit_and_dispatch` | yes | no | no | no | no | **no** | **no** | no |
| `get_effect_state` | yes | yes | yes | yes | yes | **no** (uses `observe_effect`) | **no** | yes |
| `request_reconcile` | yes — **own-scope only, §6.2** | no | no | no | yes (any) | **no** | **yes — entitlement-scoped, §6.2** | yes (any) |
| `list_effects` | yes | yes (own run) | no | no | no | **no** (uses `observe_effects`) | **no** | yes |
| `observe_effect` (new) | no | no | no | no | no | **yes** | no | no |
| `observe_effects` (new) | no | no | no | no | no | **yes** | no | no |
| `observe_evidence` (new) | no | no | no | no | no | **yes** | no | no |
| `observe_evidence_by_subject` (new) | no | no | no | no | no | **yes** | no | no |

### 3.3 Negative reach matrix (acceptance item 7)

Structural guarantees, all falsified by controls O1/O9/O10 (§8):

```text
observer            cannot call: put_blob, allocate_effect_id, seal_effect_request, submit_evidence,
                    assemble_admission_input, evaluate, admit_and_dispatch, request_reconcile,
                    get_effect_state, list_effects, root listener
                    cannot cause: any K1–K7 row append, any KERNEL_INCIDENT, any scope hold,
                    any CAS insert, any reconcile pass, any policy activation

reconcile-requester cannot call: every method except request_reconcile (same exclusion list as observer
                    plus all observe_* methods)
                    cannot cause: allocate/seal/assemble/evaluate/admit/dispatch; any K2 write;
                    RECONCILE_EXHAUSTED via its own requests alone (§6.4); reconcile of any effect
                    outside its registered entitlement scope (§6.2)
```

Enforcement is structural on three layers: (a) the per-method reach table is enforced by the Kernel Service on every call against the **active** registry (landed mechanism, C29); (b) the observer read path is implemented against a read-only store handle (reference: SQLite read-only connection / PostgreSQL role with `SELECT` only on constitutional tables) and holds no reference to Ingress, PEP, Sealer, or Reconciler components; (c) `reconcile-requester` reaches only the Reconciler's request intake, which never dispatches (TD §6.5 unchanged) and whose writes are kernel-authored under kernel-owned budget accounting (§6.4).

### 3.4 Identity / independence / co-location (D5)

- The active registry maps each exact principal to exactly **one** entry, hence one `process_class` (landed exact-match rule, unchanged). A product that needs both observation and re-observation requests runs **two principals** (two workload identities / tokens). Credential custody rules (Spec §2.3) apply unchanged: sharing one bearer credential across classes is a deployment violation, detectable by the existing credential-reach attestation discipline.
- Co-location of an observer process with any other surface does not merge reach (Spec §3: co-location does not merge authority): reach is evaluated per authenticated principal per call, never per host/pod.
- Policy independence predicates (TD §8.4) are unchanged. `observer` / `reconcile-requester` principals are ordinary `identity_registry` entries; policy may (and the #96 reference policy should) require that an operability product's principals differ in `identity_class.product` from the surfaces they observe, using the existing predicate vocabulary. No new independence primitive is introduced.

## 4. Constitutional observation API — exact contract (D1, D3; closes T2/T6/T7/T8)

### 4.1 Methods (typed; all read-only; all served from the primary store)

```text
observe_effect(effect_id)
    -> ObservationV1<EffectProjection>
       EffectProjection = { request: EffectRequestV1,
                            inputs: AdmissionInputV1[],
                            decisions: PolicyDecisionV1[],          -- includes REQUIRE_EVIDENCE decisions (K5)
                            admissions: EffectAdmissionV1[],
                            outcomes: EffectOutcomeV1[] }           -- full K7 history incl. every UNKNOWN

observe_effects(scope)
    -> ObservationV1<EffectRefPage>
       scope = { work_run_ref: string, page_token?: string }
       EffectRefPage = { effect_refs: EffectRefV1[], complete: bool, next_page_token?: string }

observe_evidence(ref)
    -> ObservationV1<EvidenceEnvelopeV1>                 -- the complete stored envelope, verbatim
       ref = { evidence_id: string, expected_envelope_digest?: DigestV1 }

observe_evidence_by_subject(query)
    -> ObservationV1<EvidencePage>
       query = { evidence_kind: string, subject: SubjectBindingV1 {authority_ref, namespace, object_id},
                 page_token?: string }
       EvidencePage = { evidence_refs: EvidenceRefV1[], complete: bool, next_page_token?: string }

EffectRefV1   = { effect_id: string, request_digest: DigestV1 }
EvidenceRefV1 = { evidence_id: string, envelope_digest: DigestV1, evidence_kind: string,
                  produced_at: string, subject_bindings: SubjectBindingV1[] }
```

**Result types are closed.** Every method returns exactly `ObservationV1<T>` with `T` as declared above; no redacted, partial, or per-record-substituted variant of any type exists (§4.3 rule 3). `EffectRefV1`/`EvidenceRefV1` are locator projections in the same derived, never-stored, never-evidence sense as `ObservationV1` itself: their field values are copied verbatim from stored rows, and the full K-record behind a ref is obtained only via the exact-ref methods. The first candidate's `include_claim` flag is **withdrawn**: the landed K2 representation seals the claim **inline** in the canonical envelope JSON with `claim_digest` computed over it and `envelope_digest` computed over the whole record (measured: `ingress.ts` `sealEnvelope`), so a claim-stripped envelope would not be the stored record and would break caller-side digest recomputation. `observe_evidence` therefore always returns the complete stored `EvidenceEnvelopeV1`.

These four methods cover every read the #96 product composition requires: effect state and scoped enumeration (`observe_effect`, `observe_effects`); K2 `EvidenceEnvelopeV1` by exact ref (`observe_evidence` with `expected_envelope_digest`); Finding / Finding Resolution refs, backend / `WORK_STEP` evidence, and capture evidence added by the later product composition (`observe_evidence_by_subject` over the landed subject index, TD §3.2 — capture kinds enter as ordinary K2 envelopes under the adapter registry and are therefore observable with no further TD change); K5 `REQUIRE_EVIDENCE` and decision/admission state (`observe_effect.decisions/admissions`). No other read is defined; a future read need is a new bounded TD round, not an implementation liberty.

### 4.2 `ObservationV1` response wrapper (derived projection, never stored)

```text
ObservationV1<T> = {
  observed_at     : RFC3339 UTC ms          -- Kernel Service clock at the read transaction
  read_authority  : "PRIMARY"               -- fixed in this amendment; see §5.1
  basis           : { active_policy: { policy_id, revision, content_digest, seq },   -- the activation row
                                                                                     -- read inside the same transaction
                      snapshot: "SINGLE_READ_TXN" }
  result          :   PRESENT     { value: T, verified: true }
                    | NOT_PRESENT { absence_basis: AbsenceBasisV1 }
                    | UNKNOWN     { unknown_reason: string }
}

AbsenceBasisV1 = {
  read_authority : "PRIMARY"
  scope          : <the exact request predicate, echoed verbatim>
  complete       : true                     -- an absence basis is NEVER issued with complete = false (§5.2)
  as_of          : observed_at + active_policy of the enclosing ObservationV1
}
```

### 4.3 Snapshot, digest, and completeness semantics (closes T6/T7/T8)

1. **Single-snapshot rule.** Every `observe_*` call executes all of its row reads, including the `active_policy` basis read, inside **one** read transaction against the primary constitutional store (reference: PostgreSQL `REPEATABLE READ` `READ ONLY` transaction; SQLite one deferred read transaction). All rows in one response are therefore mutually consistent as of one store snapshot; `observed_at` names that snapshot's time and `basis.active_policy` names the constitution active in it. Responses never mix snapshots.
2. **Verify-on-read.** Before any record or ref is returned, the kernel re-runs TD §2.5 steps 3–4 on every row it scanned: recompute every digest the record carries byte-for-byte from the stored canonical JSON — for K2 rows with `availability: PRESENT` this includes recomputing `claim_digest` over the inline claim (TD §2.3) — and check referential digest equality for the refs the projection includes. `verified: true` means exactly this recomputation succeeded at `observed_at`; the observer receives records, their stored digests, and this verification — never an unverified row.
3. **Verification failure makes the entire call UNKNOWN (T2, normative).** If any digest recomputation or referential digest equality fails on any row scanned for a call — including rows scanned only to build a ref page — the **entire call** returns `UNKNOWN { unknown_reason: "READ_VERIFICATION_FAILED" }`: no `value`, no partial page, no absence basis. There is no per-record substitution, no locator-annotated partial result, and no union type for mixed outcomes (the first candidate's per-record granularity is withdrawn; the result-type vocabulary of §4.1 stays closed). The observation path **must not** author a `KERNEL_INCIDENT`, must not trigger the §2.6 scope hold, and must not cause any K2 or other state delta, CAS write, or reconcile pass. Rationale: corruption *declaration* authority stays with the kernel's write/admission-path verify-on-read (TD §2.5/§2.6, unchanged — the same corrupt row still produces the C4 incident the moment an admission-path read touches it), and a less-trusted reader must have no path by which merely reading can impose a scope hold on governed work. Read-side detection is thereby honest (`UNKNOWN`, fail-closed for the reader per Spec §2.5) without becoming an authority channel.
4. **Typed exactness.** Responses carry the stored canonical K-records verbatim (the `*_json` canonical form, TD §3.2) — no flattening, no summary fields, no re-serialization that would break digest recomputation by the caller. The caller can therefore independently recompute every digest it receives.
5. **Enumeration completeness.** Enumerations are index-ordered (insertion order per the landed indexes) and paged; one page returns at most `observer_read_max_rows` (§7.1) rows. `complete: true` iff the enumeration exhausted the scope predicate within this response. A truncated page (`complete: false`) carries `next_page_token` (opaque, encoding the exact scan position; valid only for the same scope predicate) and **cannot ground any negative claim** (§5.2). Because each page is its own snapshot, a multi-page enumeration is not one snapshot; the kernel therefore issues `AbsenceBasisV1` only for single-response complete reads, never assembled across pages.
6. **K1 diagnostics are excluded except identity (fixed judgment K1_EXCLUSION).** The observation surface serves K1 only as the `basis.active_policy` identity `{policy_id, revision, content_digest, seq}` — fields read verbatim from the activation row, all computable from the landed representation. No bundle bytes, no bundle-content diagnostics, no recomputed bundle digests are served, and no digest is claimed that is not a stored row field. Unsupported K1 diagnostics in #96 must be expressed as `UNKNOWN`, not approximated.

## 5. Read authority, absence, and freshness semantics (D3)

### 5.1 Read-authority guarantee

The observation API is served by the Kernel Service process reading the **primary** constitutional store — the same store, same consistency domain, as admission reads. `read_authority: "PRIMARY"` is a normative claim of exactly that. **No replica, export, cache, or secondary serving path is authorized by this amendment.** A deployment that cannot serve observations from the primary store has no conforming observation surface (fail closed); defining a replica/export watermark contract is explicitly out of scope and would require a new bounded TD round. This resolves the stale-projection question by construction: there is no permitted lagging source, so no monotonic-watermark machinery is needed or defined.

### 5.2 Absence semantics

Preserved invariants, now with an exact mechanism:

```text
query success + no row  != authoritative absence by default        (preserved)
stale/replica/export lag -> cannot occur on this surface (§5.1)    (preserved by construction)
missing read authority / incomplete horizon -> UNKNOWN             (preserved: truncation and
                                                                    verification failure are UNKNOWN
                                                                    or complete:false, never absence)
```

The kernel issues `NOT_PRESENT { absence_basis }` **only** when all of: (a) the read ran on the primary store in a single read transaction; (b) the scope predicate is exact (exact `effect_id`, exact `{evidence_id}` / `{evidence_id, expected_envelope_digest}`, or an enumeration that completed with `complete: true` in one response); (c) no verification failure occurred on the scanned path. `observe_evidence` with `expected_envelope_digest` distinguishes: id absent → `NOT_PRESENT`; id present with a different stored digest → `NOT_PRESENT` with the absence basis scoped to the exact `(evidence_id, expected_envelope_digest)` pair (the envelope you named does not exist; the kernel does not disclose the differing row on this path); id present with matching digest but failing recomputation → the whole call is `UNKNOWN(READ_VERIFICATION_FAILED)` per §4.3 rule 3.

### 5.3 Product-side negative-conversion boundary (T5, normative honesty)

This amendment closes **only the Kernel read-authority half** of #96 Review B3. `AbsenceBasisV1` is an exact, primary, snapshot-scoped statement that a named record did not exist *as of* `observed_at`. Converting that into any product-level negative assertion — in particular `NOT_TRIGGERED` for `cadp.operability.v1` — including choosing the observation cadence, deciding how old an `as_of` may be for a given diagnostic claim, and combining multiple observations, is a **#96 product-contract obligation** and is not designed, not implied, and not claimed here. B3 must not be reported as fully closed by this amendment.

## 6. Bounded re-observation: `request_reconcile` bridge (D4; closes T3/T4)

### 6.1 Disposition

Product-layer wrapper semantics under the existing TD are **insufficient**: the landed matrix offers `request_reconcile` only to `workflow` (full admission reach — Review B5–B7's confused-deputy path) and `deployment-control` (trusted side, wrong owner for a product monitor). Therefore TD §6.5 and §12 change as follows; nothing else about the Reconciler changes (it still never dispatches; `RECONCILE_EXHAUSTED` still routes to the Human exception branch).

### 6.2 Requester authentication and subject entitlement (T4)

- `request_reconcile` body becomes `{ effect_id, work_run_ref }` (under v2 — §7.2). The kernel verifies the pair: the named effect must exist and its `work_bindings` must name exactly that `work_run_ref`. A mismatched pair is refused. The requester must therefore name the exact subject it intends; nothing can redirect a request to an effect the requester did not name.
- **Identity-field rule (normative).** Every subject-entitlement comparison in this section is defined over `producer_ref`-valued fields as stamped into K-records by ingress. Measured basis: ingress stamps `EffectRequestV1.requester_ref` from the authenticated caller's `identity_registry` entry's `producer_ref` and rejects any differing declared value (`REQUESTER_REF_MISMATCH`, `ingress.ts` S3). Registry `principal` strings are transport-authentication names; they never appear in K-records and are **never** compared against K-record fields. (Reference policy example: principal `cadp-workflow` authenticates the workload whose `producer_ref` is `workflow:cadp-work`; K3 rows carry `workflow:cadp-work`, so entitlements name that value.)
- v2 `identity_registry` entries with `process_class = "reconcile-requester"` (and only those — the per-entry schema is closed) carry a required `entitlements.reconcile_scope`:

```text
entitlements: { reconcile_scope:
    { kind: "WORK_RUNS_STARTED_BY",
      started_by_producer_ref: <exact producer_ref string, i.e. the value K3 rows carry
                                in requester_ref — NOT a registry principal> }
  | { kind: "ANY" } }        -- ANY is intended for trusted-side diagnostics principals only;
                             -- policy authors grant it deliberately, never by default
```

- Authorization rule, evaluated per call: effect `E` in work run `R` is in scope iff the `WORK_START` effect whose `effect_id = R` has `requester_ref` equal to the entry's `started_by_producer_ref` (exact string equality; or scope is `ANY`). Effects outside any work run (e.g. `POLICY_ACTIVATE`) match only `ANY`.
- `workflow` principals are simultaneously narrowed (this is the one changed existing cell, active under v2 only — §7.2): the kernel resolves the calling principal to its active registry entry and takes `P = entry.producer_ref` — the same resolution ingress uses for stamping — and permits `request_reconcile(E, R)` only if `E.requester_ref = P` or the `WORK_START` of `R` has `requester_ref = P`. `deployment-control` and root remain unscoped.
- Refusal for an out-of-scope, pair-mismatched, or nonexistent subject is uniformly `FORBIDDEN_FOR_SUBJECT` for scoped classes (`reconcile-requester`, `workflow`) — the request bridge is not an existence oracle over effects the requester may not observe. `deployment-control`/root receive exact reasons (`EFFECT_NOT_FOUND`, `WORK_RUN_MISMATCH`).

This closes the cross-work-run confused deputy exactly: a monitor entitled to the runs started by one exact `producer_ref` can neither probe nor confirm anything about runs started under any other `producer_ref`, and within its scope it can only re-observe effects it names exactly. Because the entitlement names the same field ingress stamps, a valid entitlement matches by construction — no principal-to-record translation ambiguity exists for implementations to diverge on.

### 6.3 Serialization and in-flight refusal (T3 — exact, implementable semantics)

The ambiguous "per-effect serialization domain" language of the first candidate is replaced by this exact contract:

1. After the §6.2 authorization checks (which read only immutable inputs: the active registry and append-only, never-mutated K3 rows), an accepted request proceeds to lock acquisition **before any K6/K7-dependent read**. It acquires, in order: (a) the **per-effect reconcile mutex** `M(E)` (in-process mutex keyed by `effect_id`; one reconcile pass per effect at any time, across all trigger origins) by try-acquire; (b) the **serialization-domain lock `D`** of TD §4.6 item 3 — the same lock the PEP holds from precondition read through K6 commit, transport send, and outcome write — by **try-acquire** (PostgreSQL `pg_try_advisory_lock(hash(domain))`; in-process try-mutex on SQLite). Locks are released in reverse order after the pass (or refusal) completes.
2. Because the PEP holds `D` for the entire precondition → admission → dispatch → outcome window, **a dispatch in flight on `E`'s domain makes the try-acquire fail**, and the request is refused with the deterministic structured refusal `{ accepted: false, reason: "DOMAIN_BUSY", retry_after_s: min(reconcile_backoff_s, dispatch_window_s) }` (releasing `M(E)`). No adapter probe runs, no K7 row is written, no budget of any kind is consumed. This is the exact mechanism by which `request_reconcile` is refused while dispatch is in flight; symmetrically, a running reconcile pass briefly holding `D` excludes a same-domain dispatch from starting mid-probe, so a reconcile read can never observe a half-dispatched state and mint a false `NO_EFFECT_CONFIRMED`.
3. `M(E)` busy (another pass already running for `E`) refuses with `{ accepted: false, reason: "PASS_IN_PROGRESS", retry_after_s }` — never a second concurrent pass, never queue growth a requester can inflate.
4. Try-acquire (not blocking acquire) is mandatory for requester-origin passes so that monitor traffic can never convoy or delay the dispatch path.
5. **Fresh-read rule (normative).** Every eligibility and accounting decision of §6.4 must be based exclusively on K6/K7 reads executed **inside the protected region, after both `M(E)` and `D` are held**. No such decision may rely on a read taken before both locks were held: a dispatch can complete and append a conclusive K7 row between any earlier read and lock acquisition, so pre-lock reads of mutable state are stale by construction and must be discarded/repeated.

### 6.4 Trusted-side dedupe, backoff, budget, and the reserved exhaustion floor (T4/D4)

Evaluated by the kernel inside the §6.3 protected region (both locks held), against reads performed inside that region (§6.3 rule 5), in this order, before any adapter probe:

1. **Conclusive short-circuit.** If `E` has no open (non-conclusive) admission, return `{ accepted: false, reason: "CONCLUSIVE" | "NO_OPEN_ADMISSION", latest_outcome_ref }`. No probe.
2. **Dedupe / coalesce.** If the latest reconciler-origin K7 row for the open admission has `observed_at` within `reconcile_request_min_interval_s`, return `{ accepted: true, coalesced: true, outcome_ref: <that row> }`. No probe, no new K7 row.
3. **Backoff.** If any reconciler-origin K7 row for the open admission is within `reconcile_backoff_s`, refuse `{ accepted: false, reason: "RECONCILE_BACKOFF", retry_after_s }`.
4. **Requester budget.** If the count of requester-origin K7 `UNKNOWN` rows for `E` ≥ `reconcile_request_max_attempts`, refuse `{ accepted: false, reason: "REQUEST_BUDGET_EXHAUSTED" }` — a per-effect ceiling on target-probe consumption; it seals no envelope and changes no constitutional state.
5. Otherwise run one pass (still under both locks), write the outcome row, then release `D` and `M(E)` in that order.

Refusals in steps 1–4 write no rows and consume no budget; they occur after lock acquisition, so the state they report cannot be invalidated by a concurrent dispatch or pass.

**Origin-tagged accounting (the reserved floor).** Outcome rows written by the Reconciler carry an exact `observer_ref` discriminator: `<pep_ref>:reconciler` for kernel-originated passes (start scan, dispatch timeout, `UNKNOWN`-write follow-up, kernel-scheduled backoff retries) and `<pep_ref>:reconciler:requested` for requester-originated passes (any accepted `request_reconcile`, whatever the caller class). Matching is exact string equality. The exhaustion rule becomes: **`RECONCILE_EXHAUSTED` is sealed only when kernel-originated `UNKNOWN` rows alone reach `reconcile_max_attempts`.** Requester-origin rows are honest append-only K7 observations (Spec K7 permits many per admission) but count toward no exhaustion condition. Consequently **no sequence of monitor-controlled requests can force `RECONCILE_EXHAUSTED`**, consume the kernel's reserved reconcile budget, or push an effect onto the Human exception branch; the kernel's own schedule retains the full constitutional floor of `reconcile_max_attempts` attempts regardless of requester behavior. (Under an active v2 bundle the landed suffix-match `endsWith(":reconciler")` is replaced by exact equality; `:reconciler:requested` must never be counted by the exhaustion filter. Under v1 the landed filter runs verbatim — §7.2.)

**Version gate (normative; closes the F5 rollout incoherence).** Everything in §§6.2–6.4 — request body, structured response, locks/refusals, dedupe/backoff/budget, origin tagging, and the exact-equality exhaustion filter — is selected by the **schema of the active policy bundle at call/pass evaluation time**. Under an active v1 bundle, `request_reconcile` and all reconcile accounting behave **byte-for-byte as landed** (§7.2). Cross-version accounting stays coherent in both directions: v1-era rows are tagged exactly `<pep_ref>:reconciler` and match both filters identically, while v2-era `:reconciler:requested` rows match **neither** the v2 exact-equality kernel-origin filter nor the landed `endsWith(":reconciler")` filter — so a v2 → v1 rollback can never make requester-origin rows retroactively count toward exhaustion.

Under v2 the response carries `accepted`, with the landed `ack` field retained for one generation as an alias (compatibility, §9); under v1 the response remains exactly the landed `{ ack: true }`.

## 7. Policy/config activation semantics and compatibility (closes T1)

### 7.1 `cadp.kernel-config.v2`

A second closed schema, accepted alongside v1. **v1 remains fully valid and its semantics are unchanged.**

```text
data.cadp.schema = "cadp.kernel-config.v2"
  = every cadp.kernel-config.v1 key, unchanged name/type/bounds/requiredness, PLUS:

  observer_read_max_rows            int 1..10000   (required in v2; reference 1000)
  reconcile_request_min_interval_s  int 1..3600    (required in v2; reference 30)
  reconcile_request_max_attempts    int 1..1000    (required in v2; reference 50)

  identity_registry entries additionally allow process_class values "observer" and
  "reconcile-requester"; entries with process_class = "reconcile-requester" REQUIRE
  entitlements.reconcile_scope (§6.2); entries of any other class MUST omit `entitlements`
  (closed per-entry schema). Unknown keys anywhere under data.cadp remain rejected.
```

There are no implementation defaults for the new keys (TD §5.4 rule preserved): under a v1 bundle the features they govern are **absent**, not defaulted.

### 7.2 Pre-amendment bundle behavior and feature gating

- **Amended kernel + v1 bundle: every landed method behaves byte-for-byte as landed — including `request_reconcile`.** All four `observe_*` methods refuse every caller with the deterministic refusal `OBSERVER_NOT_CONFIGURED` (the active config carries no observer key set). `request_reconcile` runs the **complete landed path** (§6.4 version gate): landed reach row (`workflow` unscoped, `deployment-control`, root — no §6.2 scoping, no workflow narrowing), landed body `{ effect_id }`, landed response `{ ack: true }`, synchronous pass with no `M(E)`/`D` refusal responses, no dedupe/backoff/requester-budget steps (`reconcile_request_min_interval_s` and `reconcile_request_max_attempts` do not exist in v1 and **nothing reads them**), outcome rows tagged exactly `<pep_ref>:reconciler`, and the landed `endsWith(":reconciler")` exhaustion filter. No new config key is read, no new refusal reason or response field exists, and no new row content is written while v1 is active. A v1 registry can name `process_class: "observer"`/`"reconcile-requester"` (the field is an open string in v1); such principals get **no reach at all** under v1 config — the two new reach-matrix columns of §3.2 are active only under v2, `observe_*` refuses `OBSERVER_NOT_CONFIGURED`, and `request_reconcile` under v1 grants only the landed classes (`FORBIDDEN_FOR_PRINCIPAL` for the new ones) — fail-closed, never fail-open.
- **Pre-amendment kernel + v2 bundle:** the landed recheck #17 closed-schema validation rejects the unknown `schema` value pre-K6 (`POLICY_ACTIVATE` refused; no `policy_ref` row, no activation row, active policy unchanged). Refusal, never a brick and never a partial state — the landed one-transaction activation property guarantees this.
- **No silent revocation.** v2 requires every v1 key, so activating v2 can never implicitly drop kernel-config authority; a v2 → v1 re-activation disables the observation/bridge features **explicitly**, via an ordinary, evaluated, appended `policy_activation` row (visible in the activation log and in every subsequent `ObservationV1.basis`), which is a policy decision, not silence. Refusing `observe_*` under v1 is deterministic and diagnosable (`OBSERVER_NOT_CONFIGURED`), not a permission-shaped 403.

### 7.3 Migration / activation ordering (deployment-control and root coverage)

```text
step 1  deploy the amended Kernel Service build          (v1 active; zero behavior change — O4 proves this)
step 2  activate a v2 bundle by ordinary POLICY_ACTIVATE (evaluated under the current v1 policy — legal:
        evaluation runs under the CURRENT constitution, TD §9.4; validated by the amended recheck #17,
        which accepts v1 or v2)
step 3  observer / reconcile-requester principals become effective with the activation row
rollback re-activate a v1 bundle (ordinary effect); observation surface disables deterministically
```

- **Root/break-glass coverage:** `BREAK_GLASS(ACTIVATE_POLICY)` runs *exactly the ordinary #17 publication checks* (TD §9.4 listener step 3), so the amended kernel's root listener accepts v1 and v2 bundles identically; no separate root path exists to diverge.
- **Genesis/bootstrap coverage:** `cadp-bootstrap-1` is **unchanged**. Genesis bundles remain `cadp.kernel-config.v1`; the v2 schema digest is part of the amended kernel build (recorded alongside the other embedded schema digests in `pep_ref`) but is deliberately **not** added to the bootstrap set, so no recorded `GENESIS` envelope's `bootstrap_set_digest` changes meaning and historical verification (C42 discipline) is untouched. A fresh deployment reaches v2 by step 2 above after genesis.
- No ordering of these steps can strand a deployment: every illegal combination is a pre-K6 refusal with the active policy unchanged.

## 8. Falsification controls (acceptance item 10)

To be merged into TD §13.1 numbering on TD integration; guard-bite discipline (remove the check, assert the prohibited observable occurs) applies to O1, O2, O3, O4, O6, O7, O8.

| ID | Control | Setup | Expected observable |
|---|---|---|---|
| O1 | observer/requester negative reach | an `observer` principal calls all ten landed methods + root listener; a `reconcile-requester` principal calls everything except `request_reconcile` | every call `FORBIDDEN_FOR_PRINCIPAL` (root listener: `UNAUTHENTICATED`); store row counts by kind unchanged; guard-bite: add `observer` to `submit_evidence` reach → a write succeeds, proving the matrix is load-bearing |
| O2 | read verification failure is whole-call UNKNOWN (T2/F3) | flip one byte in a stored claim / envelope canonical JSON (test-only DB write); `observe_evidence` the row; `observe_effect` and `observe_evidence_by_subject` over scopes whose scan includes the corrupt row; then run an admission whose input references the same row | every affected call returns `UNKNOWN(READ_VERIFICATION_FAILED)` as the **entire** result — no partial page, no per-record substitution, no absence basis; **zero** `KERNEL_INCIDENT` rows, zero scope holds, zero K2 rows from the observation; the subsequent admission-path read still produces the landed C4 `DIGEST_CORRUPTION` incident + scope hold (authority stays on the admission path) |
| O3 | absence and completeness semantics | (i) `observe_evidence` on a nonexistent id; (ii) with `expected_envelope_digest` ≠ stored digest; (iii) `observe_evidence_by_subject` over a subject with rows > `observer_read_max_rows`; (iv) same scope small enough to complete | (i)(ii) `NOT_PRESENT` with `AbsenceBasisV1{read_authority: PRIMARY, complete: true}`; (iii) `complete: false` + `next_page_token`, **no** absence basis anywhere in the response; (iv) `complete: true`; guard-bite: issue an absence basis on a truncated page → control fails |
| O4 | v1/v2 activation compatibility incl. version-gated reconcile (T1/F5) | amended kernel with v1 active: run the full landed conformance surface + `observe_*` + `request_reconcile` (incl. during an in-flight dispatch and repeated rapid calls); activate v2 (ordinary `POLICY_ACTIVATE` evaluated under v1); use observer + requester; force requester-origin `UNKNOWN` rows; re-activate v1 and run kernel passes to the exhaustion bound | under v1: all landed behavior identical — `request_reconcile` returns exactly `{ack: true}` (no `DOMAIN_BUSY`/`PASS_IN_PROGRESS`/backoff/budget responses), rows tagged `<pep_ref>:reconciler`, landed exhaustion accounting; `observe_*` → `OBSERVER_NOT_CONFIGURED`; v2 activation `COMMITTED` (one transaction); observer + structured/scoped reconcile semantics active; after re-activating v1: `observe_*` refuses again, `request_reconcile` returns the landed shape again, the `:reconciler:requested` rows written under v2 are **not** counted by the v1 `endsWith(":reconciler")` filter (no early exhaustion after rollback), and the activation log shows every transition (nothing silent) |
| O5 | pre-amendment protection | validate a v2 bundle against the **v1** kernel-config validator (the landed #17 logic) | refused (unknown `schema`) pre-K6: no `policy_ref` row, no activation row, active policy unchanged |
| O6 | in-flight dispatch refusal + fresh-read rule (T3/F4; v2 active) | pause the PEP inside lock D after K6 commit and before the outcome write (C20-style fault injection); issue `request_reconcile` for the same domain during the pause; release; separately: let a dispatch complete conclusively in the window between a request's arrival and its lock acquisition | during pause: `{accepted:false, reason: DOMAIN_BUSY, retry_after_s}`; no reconciler K7 row in the window; after release: an accepted pass proceeds; the post-completion request returns `CONCLUSIVE` (fresh in-lock read), never probes; guard-bite 1: remove the try-acquire of D → the interleaved probe writes an outcome contradicting the dispatch (`OUTCOME_CONTRADICTION` observable); guard-bite 2: evaluate §6.4 steps on pre-lock reads → the stale-eligibility probe runs, proving the fresh-read rule is load-bearing |
| O7 | requester subject scope (T4/F2; v2 active) | requester entitled to `WORK_RUNS_STARTED_BY(started_by_producer_ref = P1)` (P1 = a workflow entry's `producer_ref`, e.g. `workflow:cadp-work`) requests reconcile of (i) an effect in a run started under P2 ≠ P1, (ii) a nonexistent effect, (iii) a valid effect with a mismatched `work_run_ref`, (iv) a `POLICY_ACTIVATE` effect; a `workflow` principal requests reconcile of another workflow's effect | (i)–(iv) uniformly `FORBIDDEN_FOR_SUBJECT`, no probe, no K7 row; workflow cross-request refused; positive leg: the same requester on a P1-run effect is accepted — proving the entitlement matches the ingress-stamped `requester_ref` value by construction (an entitlement naming the *principal* string instead must never match; guard-bite: compare against `principal` → the positive leg fails) |
| O8 | exhaustion floor (T4/D4; v2 active) | adapter forced to return `UNKNOWN`; requester issues `request_reconcile` far more than `reconcile_max_attempts` times (spaced past dedupe/backoff); then let kernel-originated passes run to the bound | requester rows all carry `observer_ref = <pep_ref>:reconciler:requested`; **no** `RECONCILE_EXHAUSTED` from requester activity at any count (budget refusals appear at `reconcile_request_max_attempts`); kernel-originated `UNKNOWN` rows alone reaching `reconcile_max_attempts` seal exactly one `RECONCILE_EXHAUSTED`; guard-bite: count requested-origin rows in the exhaustion filter → exhaustion seals early, proving the origin split is load-bearing |
| O9 | observation causes zero state delta | snapshot all constitutional row counts + CAS count; run every `observe_*` method across every kind, including verification-failure and absence paths; re-count | byte-identical counts; no reconcile passes triggered; no locks held after return |
| O10 | dedupe/backoff determinism (v2 active) | two `request_reconcile` calls within `reconcile_request_min_interval_s`; a third within `reconcile_backoff_s` of a probe | second: `accepted, coalesced: true`, same `outcome_ref`, exactly one probe at the target (target-side call count is the observable); third: `RECONCILE_BACKOFF` with `retry_after_s` |

## 9. Delta classification and migration impact (acceptance items 8–9)

**Spec delta: NONE (D6).** Verified against the frozen Spec blob: read-only observation confers no authority (Spec §8.2: "pure read-only discovery … creates no autonomous execution authority"); the observability *stack* stays commodity (§8 item 9) — this amendment serves the kernel's own records, which §3 already places under kernel custody, and dashboards/alerting/UI remain commodity consumers of `ObservationV1`; fail-closed and evidence semantics (§2.5, §7.4) are strengthened, not altered; the §3 role table and §2.1 authority chain are untouched. No constitutional semantic changes, so `SPEC_CHANGE = NO` is confirmed, not merely inherited.

**TD delta (exact section list for the integration edit):** §5.4 (add `cadp.kernel-config.v2` + entitlements sub-schema; v1 retained), §6.5 (Reconciler: request intake ordering §6.4, origin-tagged accounting, exhaustion floor, §6.3 locks), §12 (four new methods; two new classes; matrix of §3.2; structured `request_reconcile` response), §13.1 (O1–O10), §15 (record the replica/export read path and any further read surface as explicitly out of scope / future TD rounds). No change to §§1–4, §§7–11, §14. **Kernel primitive delta: NONE** — no new K-record, no new signed document kind, no new incident kind, no new store table (existing tables and the landed subject / work-run indexes suffice; `ObservationV1` is never stored). **API delta:** +4 methods, +2 `process_class` values, `request_reconcile` request/response shape extended (`ack` kept as an alias of `accepted` for one generation), one existing reach cell narrowed (workflow `request_reconcile` → own scope). **Every element of this API delta is version-gated on the active bundle schema (§6.4/§7.2): while a v1 bundle is active, `observe_*` deterministically refuses and `request_reconcile` behaves byte-for-byte as landed.**

**Reference implementation impact (measured against the frozen blobs):** `api.ts` — four handlers + `METHOD_REACH` rows + config-gating; `reconciler.ts` — intake ordering, origin-tagged `observer_ref` with exact-equality exhaustion filter (replacing the `endsWith(":reconciler")` match), try-acquire of the PEP's `DomainLocks`/advisory lock, per-effect mutex — all selected by the active-bundle schema version, with the landed path preserved verbatim for v1; `policyState`/schema — accept v1 or v2; `store.ts` — read-only accessors over existing indexes (no DDL, no data migration). No landed test or control (C1–C42, P1–P7) changes meaning; **under a v1 bundle there is no behavioral delta to any existing caller** — the workflow own-scope narrowing, the §6.3 lock refusals, the §6.4 intake ordering/origin tagging/exact-equality filter, and the extended response shape all activate only with v2 activation (§6.4 version gate) and every changed response/accounting behavior is tested across both activation directions by O4. Rollout is the two-step sequence of §7.3 with a proven do-nothing first step (O4).

## 10. Review finding closure map

| Finding | Disposition in this candidate |
|---|---|
| T1 (Blocking) | Closed by §7: v2 schema alongside unchanged v1; pre-amendment bundles fully valid; **complete version gating** — under v1, `observe_*` deterministically refuses and `request_reconcile` is byte-for-byte landed (§6.4 gate, §7.2); pre-K6 refusal of v2 on old kernels; migration/rollback ordering incl. root/break-glass and genesis/bootstrap coverage; no silent revocation (O4/O5). Compatibility is claimed only on this basis. |
| T3 (Blocking) | Closed by §6.3: exact two-lock contract (per-effect mutex + try-acquire of the PEP's serialization-domain lock D), acquired **before** any K6/K7-dependent read, with all eligibility/accounting reads repeated inside the protected region (rule 5); deterministic `DOMAIN_BUSY`/`PASS_IN_PROGRESS` refusals with `retry_after_s`; dispatch-in-flight refusal follows mechanically from the PEP holding D across the whole dispatch window (O6). |
| T4 (Blocking) | Closed by §6.2/§6.4: registry-bound `entitlements.reconcile_scope` naming an exact `started_by_producer_ref` — the same `producer_ref` value ingress stamps into K3 `requester_ref`, so entitlements match by construction and are finer than shared-`requester_ref` reach; mandatory `(effect_id, work_run_ref)` pair verification; workflow own-scope narrowing via the caller's registry `producer_ref`; uniform `FORBIDDEN_FOR_SUBJECT` for scoped classes; requester budget + dedupe/backoff (O7/O10). |
| T2 (Blocking) | Closed by §4.3 rule 3: any observation-path verification failure makes the **entire call** `UNKNOWN(READ_VERIFICATION_FAILED)`; no `KERNEL_INCIDENT` authorship, no §2.6 scope hold, no K2/state delta from the read path; incident authority remains with the admission-path verify-on-read (O2/O9). |
| T7/T6/T8 (Blocking) | Closed by §4/§5: a **closed** result-type vocabulary (`ObservationV1<T>`, `EffectProjection`, `EffectRefV1`/`EvidenceRefV1` locator types; no redacted/partial/union variants) over stored canonical records returned verbatim; single-read-transaction snapshot rule; exact verify-on-read/digest semantics incl. inline-claim recomputation; paged enumeration with `complete`/`next_page_token`; absence basis only for complete primary-snapshot reads (O3). |
| T5 (Blocking) | Closed by §5.3: the product-side negative `NOT_TRIGGERED` conversion obligation is explicitly returned to #96; this amendment claims only the Kernel read-authority half of B3. |
| B3/B6/B7 partial-closure honesty | B3: read-authority half closed here; conversion half remains open at #96 (§5.3). B6/B7: the TD-side bridge (class, scope, serialization, budget/floor) is closed here; the #96 product composition retains every product-layer obligation over it — alerting/escalation semantics, observation cadence, and its own use of `retry_after_s`/refusal handling. Neither is claimed fully closed by #106. |
| M1–M8 (Major) | **NOT DISPOSITIONED — evidence unobtainable; this alone blocks `TD_DESIGN_READY` (§12).** The canonical Review comment (`#106 issuecomment-5533914618`) remains unreachable from the Design session: `gh`/network reads are permission-denied, no web-fetch or GitHub-MCP capability is granted, and the M finding bodies are mirrored nowhere reachable — verified by exhaustive local search of the repository (all refs), the harness `state.json` (holds only the current round's five findings), and `journal.jsonl` (whose 2026-09-04T11:10Z `HUMAN_DIRECTION_WAIT` record documents the same block). Per the current Review's own instruction ("Retrieve the canonical review, disposition every M finding …, **or return STOP_DESIGN_REQUIRED if that evidence cannot be obtained**"), this candidate does not claim M1–M8 closure and the round returns `STOP_DESIGN_REQUIRED` instead of asserting readiness it cannot evidence. Once the M1–M8 bodies are provided (mirrored into the issue/repo, or session GitHub read access granted), one bounded round dispositions each M finding against exact clauses and controls of this document. |

### 10.1 Second-round Review closure (REQUEST_CHANGES on head `7c9e49b`)

| Finding | Disposition |
|---|---|
| F1 — M1–M8 undispositioned yet `TD_DESIGN_READY` | Accepted. Retrieval re-attempted and re-verified impossible this session (see the M1–M8 row above for the exhaustive search record). Disposition changed to `STOP_DESIGN_REQUIRED` (§12) as the finding itself directs for this case. |
| F2 — entitlement compared principal against `requester_ref` | Accepted and closed by §6.2: normative identity-field rule; entitlement renamed `started_by_producer_ref` and defined over the ingress-stamped `producer_ref` value (measured `ingress.ts` S3 + reference-policy values); workflow own-scope check defined via the caller's registry `producer_ref` under the same resolution ingress uses; falsified by the extended O7 (incl. principal-comparison guard-bite). |
| F3 — no implementable typed observation result | Accepted and closed by §4.1/§4.3: `include_claim` withdrawn (landed K2 stores the claim inline — measured `sealEnvelope`); `observe_evidence` always returns the complete stored envelope; explicit `EffectRefV1`/`EvidenceRefV1` locator types; closed result-type vocabulary; **whole-call UNKNOWN** on any verification failure — no partial/union/redacted schema exists (O2 extended). |
| F4 — eligibility checks before lock acquisition (TOCTOU) | Accepted and closed by §6.3 rules 1/5 + §6.4 preamble: both locks acquired before any K6/K7-dependent read; all eligibility/accounting reads executed inside the protected region; pre-lock reads of mutable state must be discarded; falsified by the extended O6 (stale-eligibility guard-bite). |
| F5 — v1 behavior claims incoherent with new reconcile semantics | Accepted and closed by the §6.4 version gate + rewritten §7.2: complete `request_reconcile` semantics (body, response, locks, dedupe/backoff/budget, origin tagging, exhaustion filter) selected by the active bundle schema; v1 = byte-for-byte landed path reading no v2-only key; cross-version accounting coherence proven in both directions (`:reconciler:requested` matches neither filter); every changed behavior tested by the extended O4. |

## 11. Non-goals (unchanged from the issue)

No #96 product-contract repair; no observability implementation; no Phoenix/OTel integration; no task/attempt/supervisor lifecycle; no general RBAC framework (two closed-vocabulary class values and one entitlement kind are not a framework and deliberately do not generalize); no production deployment; no OpenClaw/durable-jobs modification; no replica/export read surface.

## 12. Disposition

```text
DESIGN_DISPOSITION   STOP_DESIGN_REQUIRED — blocked on evidence access, NOT on Spec/TD authority.
                     The contract content of this candidate is complete for the five second-round
                     findings and the T1–T8 Blocking scope; the sole open item is that the canonical
                     Major findings M1–M8 (#106 issuecomment-5533914618) are unreachable from the
                     Design session and mirrored nowhere locally (§10 M-row), so their individual
                     disposition — mandatory for TD_DESIGN_READY — cannot be evidenced.
UNBLOCK              Human/Control must either (a) mirror the full M1–M8 finding bodies into the
                     issue body or a repository file, or (b) grant the Design session GitHub read
                     access (gh / MCP). Then one bounded round dispositions M1–M8 against exact
                     clauses/controls of this document and can return TD_DESIGN_READY.
NEXT_OWNER           Human direction (M1–M8 evidence provisioning) -> Design (M disposition round)
                     -> Control (scope/authority check) -> independent Review -> Human TD boundary
AFTER_LANDING        authority returns to #96 product-contract repair (carrying the §5.3 and B6/B7
                     residual obligations recorded above)
IMPLEMENTATION       HOLD
```

### Acceptance mapping (#106 items 1–11)

| # | Item | Where |
|---|---|---|
| 1 | frozen current basis | §0 |
| 2 | exact confirmed gap | §1 |
| 3 | chosen minimal read pattern | §2 |
| 4 | caller/process-class/method reach matrix delta | §3.2 |
| 5 | K2/K3–K7 read semantics, verify-on-read/absence/freshness | §4, §5 |
| 6 | `request_reconcile` requester/bounds disposition | §6 |
| 7 | negative reach matrix | §3.3 (+ O1/O9/O10) |
| 8 | Spec/TD/Kernel primitive/API delta classification | §9 |
| 9 | migration/compatibility impact | §7, §9 |
| 10 | falsification controls | §8 |
| 11 | `DESIGN_DISPOSITION` / `NEXT_OWNER` | §12 |
