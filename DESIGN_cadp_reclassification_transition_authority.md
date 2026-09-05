# CADP Design — Recurring-Improvement Reclassification Transition Authority (#117)

| Field | Value |
|---|---|
| Status | **DESIGN CANDIDATE — TD_DESIGN_READY** (round-9 repair); authority only after Control scope check, Independent Design Review, and Human merge of the protected TD delta. The earlier merge of PR #118 was reverted by recovery PR #124 and carries no authority (§0.5) |
| Design issue | #117 |
| Source execution | #107 (`exec-i107`, held; PR #115 non-admitted evidence only) |
| Source review | #107 `issuecomment-5548393749` (round-3 findings F1/F2/F3) |
| Source measured STOP | #107 `issuecomment-5548451029` (`STOP_CONTRACT_GAP`) |
| Control disposition | #107 `issuecomment-5548740528` (`CONTRACT_GAP_CONFIRMED_BY_IMPLEMENTATION_ATTEMPT`) |
| Repairs | round-4 findings R1–R4 against 2c432b3 (§0.1); round-5 findings R5-1–R5-3 against 5ca3285 (§0.2); round-6 findings R6-1–R6-2 against bc3a097 (§0.3); round-7 **self-measured** R7-1 against 5ea7bae (§0.4); round-8 findings R8-1–R8-2 against 8017bf0 — the round-7 review findings, recovered from the devharness lane state (§0.5 — provenance stated there exactly); round-9 finding R9-1 against d53954a (§0.6 — writer-generation stability of `governed_transition` and invariant U) |
| Architecture authority | Spec v0.4 > landed v0.4-generation TD v2.0 (r7) > #98 landed product contract `issuecomment-5526957311` |
| Frozen design basis | main `1b051f29635c14461ce08b354d554355e3856d57` (#109/#116 landed: exact-digest `supersedes` resolution and fail-closed omitted-ancestry) — `cadp/deployment/referencePolicy.ts`, `cadp/product/improvement/contracts.ts`, `cadp/kernel/ingress.ts`, `cadp/kernel/pep.ts` (recheck #5), TD §2.6/§3.2/§4.4/§6.2/§6.4/§9.1–§9.3/§12, Spec §2/K3/§5.2/§5.3, #98 §1–§10 |
| Implementation | **HOLD** — this document authorizes no code change |
| Production deployment | **NOT AUTHORIZED** |

```text
SPEC_CHANGE          NO   (by construction — §9; no HUMAN_DECISION is ever presented at more
                           than one effect_id; the round-3 escalation trigger is withdrawn)
TD_CHANGE            YES  (bounded, protected: TD §6.4 one reference-adapter operation
                           + TD §9.2 one producer row + TD §9.1 two registry-declared ingress
                           rules (replay + edge uniqueness, §5.3) + TD §3.2 two unique partial
                           indexes + TD §2.6 one incident kind (`GOVERNED_SEAL_CONFLICT`, §5.4)
                           — exact, exhaustive delta in §5.
                           TD §4.4 rechecks (incl. #5 and #14) and TD §9.3 are UNCHANGED.)
PRODUCT_CONTRACT     YES  (cadp.improvement-intake.v1 → v1.1 — governed transition sealing
                           (RECLASSIFICATION + SUBJECT_TRANSFER families) with
                           target-authoritative one-governed-edge-per-predecessor uniqueness,
                           edge/path-scoped barrier whose delegation is either context-preserving
                           or governed context transfer, one-predecessor-per-resolving-descendant
                           (I6, §0.4), typed AUTHORITY_RESOLUTION — §10)
KERNEL_PRIMITIVE     NO CHANGE (K1–K7 untouched; no new record kind, no API-shape change, no
                     recheck change; the sole kernel-service behavioural delta is the §5.3
                     registry-declared ingress replay rule, carried under TD_CHANGE §9.1)
NEW_CORE_ROLE        NO
DESIGN_DISPOSITION   TD_DESIGN_READY
NEXT_OWNER           Control (scope/authority check) → Independent Design Review → Human merge → #107 Execution refresh
```

---

## 0. Repair dispositions

### 0.1 Round-4 repair disposition

The round-4 review of 2c432b3 returned four findings. All four are accepted; none is contested.

```text
R1  §4.4 #5(c) cross-effect HUMAN_DECISION reuse conflicts with Spec §5.3 and landed TD §4.4 #5.
    RESOLVED BY RECONSTRUCTION (§2, §4, §9): the Human authorization is now a completely ordinary
    landed effect-scoped decision consumed by exactly ONE effect — a dedicated governed
    reclassification-seal effect. The proposed #5(c) delta and the §9.3 `authorized_transition`
    claim extension are WITHDRAWN. No HUMAN_DECISION envelope is presented at more than one
    effect_id anywhere in the design, so no Spec question remains and SPEC_CHANGE stays NO
    honestly rather than by interpretation.

R2  The two-step subject-correction path could never discharge C_old's barrier (the intra-
    CONTRACT correction edge was not a clearing_edge, so the barrier stood forever).
    RESOLVED (§6.3): the barrier rule gains a second resolved-entry family — the DELEGATION
    edge. A valid class-preserving supersession between two CONTRACT_* Findings transfers the
    barrier obligation to the successor; the obligation always rests on the terminal CONTRACT_*
    node of each chain and is discharged only there, by authority bound to that exact node and
    subject. Full-chain positive and falsification controls added (FC8).

R3  Deterministic authority was reusable across edges with no binding to predecessor, descendant,
    subject, or run. RESOLVED (§6.5): deterministic reclassification now passes through the same
    single governed choke point as the Human family. Every application of a rule is one admitted
    effect with exact per-application bindings (predecessor id+digest, exact descendant draft
    bytes, subject preservation, method, authority-content digest), individually evaluated
    against the ACTIVE policy and individually revocable. The rule itself remains universal over
    its predicate — justified in §6.5 from its nature as Human-gated policy content, with
    cross-predecessor/subject/descendant/run controls (FC9).

R4  The AUTHORITY_RESOLUTION Human variant required a HUMAN_DECISION to satisfy a transition
    schema that names a descendant edge an AUTHORITY_RESOLUTION does not have.
    RESOLVED BY REMOVAL (§10.4): `landed_authority_ref` is typed as `{authority_content_digest}`
    ONLY, grounded in active policy content. The Human resolution route is preserved and
    documented exactly: the Human resolves by LANDING the authority change (protected merge and
    Human-gated POLICY_ACTIVATE admitting the digest), then the resolution references the landed
    content. No Human-decision envelope is ever a `landed_authority_ref`.
```

### 0.2 Round-5 repair disposition

The round-5 review of 5ca3285 returned three findings. All three are accepted; none is
contested.

```text
R5-1  FINDING_SEAL declared `PEP_READ_THEN_ACT`, but the landed TD §4.6 defines that mode as a
      pre-K6 `current_revision`-vs-admitted-binding comparison, permits it only for a PEP-owned
      write-once reference with target-side immutability attested, and unchanged recheck #14
      refuses every such operation without a fresh `TARGET_IMMUTABILITY_ATTESTATION`; further,
      "existing envelope ⇒ already committed" is unrepresentable in
      `dispatch_precondition_read`, where any non-success is `DISPATCH_PRECONDITION_FAILED`.
      Verified against the landed pep.ts (precondition read gate and recheck #14) — the claimed
      §11 path could not reach K6. RESOLVED BY MODE CHANGE (§5.1): the operation is reclassified
      to the landed append-only family — `idempotency: NATIVE_KEY` (key `cadp-v04:<effect_id>`,
      §6.2, ingress-bound in the material) with `dispatch_precondition: NONE` (the material
      names NO mutable target subject; the landed `RECORD_WRITE` classification). Recheck #14 is
      satisfied as landed (it constrains only mutable-subject/`PEP_READ_THEN_ACT` operations —
      vacuous for this operation, no attestation path needed). The target-side dedup that makes
      `NATIVE_KEY` true is a bounded TD §9.1 ingress delta: registry-declared governed-writer
      replay idempotency on `(producer_ref, source_ref)`, the exact landed WORK_STEP
      lookup-before-allocate pattern (§7.4/C33), provable by the §6.2 double-dispatch test.
      The prior "no ingress change" claim is withdrawn; the delta is declared honestly (§5).

R5-2  The deterministic route bound each APPLICATION at its admission but left the AUTHORITY
      OBSERVATION itself free-floating: the same rule + the same AUTHORITY_TEXT envelope could
      authorize transitions for unrelated predecessors, subjects, descendants, and runs — a new
      admission alone is not an applicability boundary (D2, acceptance #3/#8 violated).
      RESOLVED (§6.5): the observation must carry a typed `applies_to` applicability claim
      naming the exact predecessor id+digest, from→to, normalized subject, method, and (where
      the rule declares run scoping) the exact work-run; the policy predicate requires every
      element to equal the presented F/M/draft exactly. One observation can therefore authorize
      at most one transition ever (§6.5 exclusivity argument); cross-context reuse is
      structurally unsatisfiable, not merely re-admitted. Falsification controls FC9f–FC9i.

R5-3  AUTHORITY_RESOLUTION reduced authority to bare-digest membership in
      `landed_authority_digests`, letting any intake-produced resolution clear ANY CONTRACT_*
      tip with any landed digest — ambient/standing authority. RESOLVED (§10.4): the untyped
      digest set is replaced by applicability-bearing policy entries
      `data.cadp.landed_authority_resolutions[] = { finding_ref: {evidence_id,
      envelope_digest}, authority_content_digest }` — each Human-landed entry authorizes
      resolution of exactly ONE finding tip by exactly ONE landed content. Multiple resolutions
      remain permitted only as idempotent restatements of that same binding; resolving any
      other finding requires its own Human-landed entry. FC12 extended.
```

### 0.3 Round-6 repair disposition

The round-6 review of bc3a097 returned two findings. Both are accepted; neither is contested.

```text
R6-1  The deterministic observation A does not bind the exact descendant, so §6.5's "one
      observation, at most one edge" rested on the §6.4 conflict rule — a check over the
      CALLER-SELECTED evidence list. Omitting an already-sealed governed descendant from a second
      FINDING_SEAL admission bypasses it, so the same A could seal several DIFFERENT drafts for
      the same predecessor/from/to/subject/method, each clearing when evaluated on its own branch.
      Measured correctly: an evidence-list predicate is not an exclusivity mechanism.
      RESOLVED BY TARGET-AUTHORITATIVE UNIQUENESS (§5.3, §6.6 — the second remedy the finding
      offers; the first is unavailable, see below). The round-6 candidate set
      `source_ref = cadp-transition:<predecessor evidence_id>:<predecessor envelope_digest>`, a
      pure function of the material (HISTORICAL — round-8 R8-1 re-keys this: the invariant
      survives unchanged as a store constraint on the draft's own supersedes singleton, and
      source_ref returns to the effect-bound replay key; §0.5, §5.3), and the §5.3
      registry-declared ingress rule did
      lookup-before-allocate on `(producer_ref, source_ref)` INSIDE the store transaction:
      identical payload converges to the existing envelope, a DIFFERENT payload is refused with a
      `GOVERNED_SEAL_CONFLICT` incident. The store — not the presented evidence — therefore holds
      the invariant AT MOST ONE governed outgoing edge exists per predecessor, for all time,
      across runs, callers, and admissions. Evidence omission cannot reach the store rule; the
      §6.4 conflict check is retained but demoted to defence-in-depth. This binds the Human family
      too, which had the same structural hole. New controls FC15 (omission attack) and FC6/FC9f
      rewrites; §6.5's exclusivity argument is re-grounded on §6.6 instead of the evidence list.
      Why not the finding's first remedy (bind A to an exact draft/material identity): it is
      genuinely circular in this direction — the draft's `basis` must cite A by
      {evidence_id, envelope_digest} (E1/#98 §3), so a draft digest inside A's claim would have to
      contain a digest of A itself. Recorded as measured, not waved away.

R6-2  An ordinary, UNAUTHORISED intake CONTRACT_*→CONTRACT_* subject correction was a
      delegation_edge, so authority scoped only to C_new/S2 discharged the ancestry obligation
      originating at C_old/S1, with free-text correction_reason as the only marker — exactly the
      cross-context clearing D2/D3 forbid.
      RESOLVED BY A TYPED, GOVERNED CONTEXT-TRANSFER DISTINCTION (§4.1, §6.3, §6.4, §7 I2):
      delegation now splits. (a) CONTEXT-PRESERVING restatement (subject binding identical) stays
      ordinary intake and needs no authority — no context crosses, and whatever clears the
      successor is bound to the same subject. (b) CONTEXT TRANSFER (subject changes) is a second
      governed transition family `SUBJECT_TRANSFER` through the SAME FINDING_SEAL gate, whose
      material binds BOTH contexts exactly (predecessor id+digest, from_subject, to_subject,
      classification preserved) and which is authorized either by a landed effect-scoped
      HUMAN_DECISION on that effect or by a deterministic rule whose observation names both
      subjects. An unauthorised subject-changing supersession remains permitted at intake but is
      NOT a delegation: C_old's obligation stands until separately transferred or cleared.
      correction_reason is stated as a mandatory audit field and never authority. Controls FC16
      (a)–(f), FC8 rewritten.
```

### 0.4 Round-7 repair disposition (self-measured — provenance stated exactly)

**Provenance, stated plainly so Control and Review can weigh it.** The independent review of
5ea7bae returned `REQUEST_CHANGES` (devharness receipt `HOLD_UNKNOWN`, #117
`issuecomment-5549847816`, "REQUEST_CHANGES beyond repair bound"). Unlike rounds 4–6, **the
findings themselves were not published** to issue #117 or PR #118 — no `REVIEW_REQUEST_CHANGES`
receipt carrying a `findings` array exists for that round. This round therefore does **not** claim
to answer that review. It is a self-audit of the round-6 candidate along the same attack line the
three published reviews used (authority scoped to one context clearing another; exclusivity that
rests on caller-selected inputs). It found one real defect, R7-1, and repairs it. The unread
round-7 findings, then open, have since been recovered and are answered — they named two defects
other than R7-1, exactly as this section warned they might; see §0.5 (R8-1, R8-2).

```text
R7-1  ONE AUTHORIZATION, MANY CLEARED PREDECESSORS (self-measured against 5ea7bae; genuine).
      Every rule in the round-6 candidate matched the predecessor by CONTAINMENT — §4's material
      rule ("descendant_draft.claim.supersedes contains predecessor_ref exactly"), §6.4's shape
      row, and §6.3's clearing_edge/delegation_edge ("D.claim.supersedes contains {C.evidence_id,
      C.envelope_digest}"). The landed claim contract makes `supersedes` a multi-entry array
      (`cadp/product/improvement/contracts.ts` — "non-empty array", each entry an exact ref) and
      the landed policy iterates it (`some s in object.get(e.claim, "supersedes", [])`,
      referencePolicy.ts:306/314 at the round-7 basis; :337/:346 at the current 1b051f2 basis,
      where #109 added exact-digest `supersedes_ref_resolved` but kept the containment
      iteration). So ONE governed seal, authorized against F₁ alone, could carry
      a descendant draft whose supersedes list is [F₁, F₂, F₃ …]. Downstream, clearing_edge(F₂, G)
      is satisfied for every listed CONTRACT_* F_i that shares G's primary subject: the digest
      entry is present, the class crosses, subject_preserved holds, governed_transition(G) holds.
      Neither H nor the deterministic observation A ever named F₂ — both bind exactly one
      `predecessor_ref` — and invariant U does not bite, because only the key T(F₁) is ever
      written. The result is exactly what D2 forbids and what R5-2/R5-3/R6-2 each closed in their
      own dimension: one authority discharging contract questions it never named. The same defect
      makes delegation unsound in both forms (a multi-superseding descendant relocates N
      obligations onto one node, and the graph-level inference "governed + same class + different
      subject ⇒ sealed as SUBJECT_TRANSFER against C" is not valid when D names several
      predecessors, since only one of them was the material's predecessor_ref).
      RESOLVED BY INVARIANT I6 — ONE PREDECESSOR PER RESOLVING DESCENDANT (§7 I6, §4, §6.3, §6.4,
      §10): a descendant resolves a barrier entry only if its `supersedes` list is EXACTLY the
      single entry naming that predecessor. Enforced twice, deliberately: at the seal (the
      governed material must carry `supersedes == [predecessor_ref]`, DENY otherwise) and — the
      load-bearing one — in the barrier predicate itself, which reads the sealed envelope's own
      list and so does not depend on any admission-time check having run. Multi-superseding
      descendants (duplicate merges) stay legal at intake; they simply resolve nothing, and each
      merged predecessor keeps its own obligation until separately transferred or cleared
      (fail-closed; a merge is not an argument). New control FC17, FC8/FC14 extended.
```

### 0.5 Round-8 repair disposition (fresh lane; the recovered round-7 review findings)

**Provenance, stated plainly.** The lane that produced rounds 1–7 was closed by the devharness
after the round-7 review ("REQUEST_CHANGES beyond repair bound") without publishing findings to
issue #117 or PR #118. A second lane then produced a from-scratch artifact
(`DESIGN_ISSUE_117_reclassification_authority.md`); its PR #118 merge was made in error and was
reverted by recovery PR #124 — that merge carries **no** design authority, and that artifact is
superseded by this one. This candidate resumes the round-7 head 8017bf0 in a fresh lane based on
current main (1b051f2, #109/#116 landed). The round-7 review findings were recovered from the
devharness lane state (the closed lane's frozen findings array); their file/line references match
8017bf0 exactly, so they are measured findings against this artifact's immediate predecessor.
Both are accepted; neither is contested. Nothing else was in the findings array, which closes the
§0.4 provenance question.

```text
R8-1  FINDING_SEAL declared NATIVE_KEY while the actual target-deduplication key was T(F),
      derived from the PREDECESSOR rather than from effect_id; the carried cadp-v04:<effect_id>
      value was not used for target deduplication. Spec K3 explicitly requires any target-native
      idempotency key to bind deterministically to effect_id, and landed TD §6.2 fixes that key
      as cadp-v04:<effect_id>. Calling T(F) "coarser" does not satisfy the identity requirement:
      different effects intentionally share it. Remedy offered: separate per-effect replay
      idempotency from predecessor-edge uniqueness, or route the Spec change; SPEC_CHANGE=NO and
      TD_DESIGN_READY were unsupported as written.
      RESOLVED BY SEPARATION (§5.1, §5.3, §6.6 — the finding's first remedy, taken exactly).
      The two concerns the round-6/7 text conflated into one key are now two mechanisms:
      (a) REPLAY IDEMPOTENCY — the NATIVE_KEY declaration — keys on the landed §6.2 value
          cadp-v04:<effect_id>, carried both in the material (landed ingress-enforced
          idempotency_key) and as the dispatch source_ref, deterministically bound to the effect
          identity exactly as Spec K3 requires; §5.3 rule (a) makes it true at the target.
      (b) GOVERNED-EDGE UNIQUENESS (invariant U, round-6 R6-1 unchanged in force) — a separate
          registry-declared STORE CONSTRAINT, §5.3 rule (b), keyed on the sealed draft's OWN
          claim.supersedes singleton (content-derived; the landed WORK_STEP unique-partial-index
          precedent). It is never called an idempotency key and makes no K3 claim.
      Two honest consequences: the effect→artifact audit pointer returns to source_ref (§6.2
      simplifies — the round-6 K7-receipt detour is gone), and I6 gains a second, independent
      enforcement point, because the store's edge key is derived from the very singleton
      supersedes list I6 requires. SPEC_CHANGE stays NO on conformant grounds, not by glossing
      "coarser".

R8-2  The uniqueness path created a new GOVERNED_SEAL_CONFLICT KERNEL_INCIDENT, but the declared
      TD delta excluded §2.6 and claimed nothing else changes. The landed incident_kind set is
      CLOSED and does not contain the value; incident subject bindings also determine mandatory
      scope holds and break-glass release behaviour. Remedy offered: declare the incident kind
      with exact offending/subject bindings, scope-hold and release semantics in the protected
      TD delta, or normatively reuse an existing kind whose contract fits.
      RESOLVED BY EXACT DECLARATION (§5.4): GOVERNED_SEAL_CONFLICT is added to the TD §2.6
      closed set as a declared protected delta, with exact claim shape, offending_refs, subject
      bindings (which make the landed scope-hold rule freeze further governed sealing against
      the conflicted predecessor), and the landed release-only-by-root-signed-BREAK_GLASS
      semantics — no new release primitive. Reuse of WORK_STEP_CONFLICT was considered and
      rejected: its contract names a work-run/step key, its subject bindings would hold the
      wrong scope, and overloading it would make the closed set semantically false. The prior
      "nothing else in the TD changes" claim is withdrawn; §5.3 now enumerates the delta
      exhaustively (§6.4, §9.2, §9.1, §3.2, §2.6 — and nothing else).
```

**Cross-check against the second lane's findings (declared for completeness).** The reviewer
returned seven findings against the second lane's from-scratch artifact. They are measured
findings about *that* artifact, not this one; each was nonetheless checked against this
candidate. Six name mechanisms this design does not contain: a generic run-scoped APPROVE with
the successor self-declaring the transition (closed here by §4 — the decision binds digest(M)
over the complete exact transition); id-only authority links without digest equality (closed by
§6.1/§6.3/§6.5 — id+digest everywhere); a one-time-consumption claim resting on the landed
WORK_STEP-only ingress idempotency (this design claims no such thing — §5.3 declares the new
ingress rules honestly as TD deltas); an unconditional subject-equality rule blocking legitimate
subject correction (closed by the typed SUBJECT_TRANSFER family, §4.1/I2); an internally
inconsistent deterministic contract with digest-suffix matching (closed by §6.5 exact
applies_to); and a Human path using a nonexistent FindingAdmission purpose (this design's §11
path uses the declared FINDING_SEAL operation and unchanged WORK_START gates). The seventh —
EVIDENCE_MAX_AGE(HUMAN_DECISION) is unsatisfiable while the reference registry declares
produced_at_source: NONE for Human decisions — did touch a non-load-bearing aside in §8 of this
document; that aside is corrected to state the registry precondition explicitly. No load-bearing
element of this design rests on any mechanism those findings falsified.

### 0.6 Round-9 repair disposition

One finding against d53954a, accepted in full:

```text
R9-1  §5.2 made the governed writer registry-controlled and revocable, while §6.2's
      governed_transition recognized a Finding by "the writer registered in the ACTIVE policy"
      and invariant U / the §3.2 unique indexes keyed on producer_ref. Removing or replacing
      the registry entry therefore either (i) made an already-cleared edge stop clearing at
      later admissions — contradicting §6.3 ("a validly cleared edge stays cleared") and D4's
      immutable-completed-transition boundary — or (ii), if a replacement writer used a
      different producer_ref, permitted a second governed edge for the same predecessor —
      contradicting the claimed all-time uniqueness. Remedies offered: stable historical
      validation of the writer/effect under the seal-time policy with cross-generation edge
      uniqueness, or one immutable producer identity as a permanent contract invariant,
      reconciled with the stated revocation behaviour.
      RESOLVED BY BOTH REMEDIES AT ONCE, because they converge on one repair (§5.2, §6.2,
      §6.6, §8, FC19):
      (a) PERMANENT PRODUCER IDENTITY (invariant P, §5.2). producer_ref
          "governed:reclassification" is a permanent constant of product contract v1.1 —
          reserved, never re-registered under another string; a registry conformance rule
          makes a bundle that grants governed-edge power to any other producer_ref
          DENY at POLICY_ACTIVATE. What rotates on compromise/retirement is the WORKLOAD
          CREDENTIAL bound to the constant in the identity registry — every writer generation
          maps to the one constant, so the (producer_ref, source_ref) and (producer_ref, T(F))
          keys are generation-independent and invariant U holds across every generation by
          construction. The prior text conflated credential and producer identity; §3's
          "writer" entry is corrected.
      (b) STABLE HISTORICAL VALIDATION (§6.2). governed_transition compares producer_ref
          against the CONTRACT CONSTANT and reads only kernel-stamped immutable envelope
          facts — never the currently-active registry. The seal-time gate under the seal-time
          active policy is what stamped those facts; consuming the gate's product afterwards
          is the design's own stated trust pattern (§6.2), now applied consistently to the
          writer check. Revocation is therefore PROSPECTIVE ONLY: it stops future seals and
          never un-clears a completed edge (K2 — nothing can mutate the stamp). Retroactive
          distrust of a seal made by a compromised writer routes FORWARD — incident + I4
          re-raise (a fresh CONTRACT_* finding with a fresh key T(C₂)) — never through
          history-dependent re-evaluation of active policy.
      FC19 falsifies both failure modes: revoke-after-clear must not un-clear, and a
      successor-generation second seal for the same predecessor must hit the same edge key.
```

## 1. What was measured, restated exactly

The #107 round-3 attempt measured that the landed contract cannot express the Review's required
authority semantics without inventing them:

1. **D1** — `cadp.human-decision.v1` (TD §9.3) carries polarity, principal, `issued_at`, and a
   bounded `scope`, but no structured representation normatively authorizes an exact
   reclassification transition (`predecessor id+digest, from → to, under exact method`).
   Free-text `statement` is non-authoritative (E2) and must stay so. The landed reference-policy
   `reclassified_clear` lets a bare `HUMAN_JUDGMENT` descendant clear a CONTRACT_* ancestor with
   **no Human authority at all** — the measured defect.
2. **D2** — predecessor-only binding permits standing reuse of one authority across later
   descendants/subjects/runs (Review F3); binding to the descendant looked circular because
   #98 §3 clause 1 makes the descendant's basis cite the authority, forcing the authority to be
   sealed before the descendant exists.
3. **D3** — #98 §4 does not close whether supersession must preserve subject/work-run context.
4. **D4** — admission evaluation is deliberately clock-free (TD §9.1/C38); no validity-interval
   vocabulary bounds authority reuse over time.
5. **D5** — no legitimate Human clearing path could be proven through the real
   PEP/`admitAndDispatch`. TD §4.4 #5 makes every `HUMAN_DECISION` single-effect, and Spec §5.3
   requires a new decision for a different `effect_id`, so a decision consumed at one admission
   can never be re-presented at the later in-run admissions that must recompute the barrier.

The round-3 candidate tried to solve D5 by relaxing single-effect consumption inside one work
run; round-4 review R1 correctly identified that as a Spec conflict. This candidate solves D5 the
opposite way: the Human decision is consumed at exactly one admission, and the **durable clearing
artifact is not the decision** — it is the reclassification Finding itself, sealed through the
constitutional effect gate.

## 2. Design decision summary

```text
A1  The reclassification transition is a GOVERNED EFFECT (`FINDING_SEAL`): sealing the
    boundary-crossing descendant Finding is itself dispatched through K3→K7. Its K3 material is
    the exact typed transition payload (issue D1 candidate family 2 — "an exact typed
    transition-authorization material referenced by an existing digest-bearing scope field").

A2  The Human transition authorization is the LANDED effect-scoped HUMAN_DECISION, unchanged:
    scope { effect_id = the FINDING_SEAL effect, material_digest = the transition payload
    digest }, issued via §9.3 path A verbatim. No claim-schema extension, no new Human
    vocabulary, no recheck change. It approves exactly one effect and is presented at exactly
    one effect's admissions — Spec §5.3 and TD §4.4 #5 are satisfied literally.

A3  Circularity is dissolved by identifying the descendant BEFORE it exists via its exact draft
    bytes: the material embeds the complete descendant draft; scope.material_digest binds it;
    the dispatch seals the envelope byte-exactly from that draft. Nothing references a
    not-yet-existing record id, and the sealed Finding is born already bound to the
    authorization that created it.

A4  At every later admission the barrier is recomputed honestly from presented Findings only.
    The clearing predicate recognizes a descendant as authorized iff it was sealed by the
    governed writer (kernel-stamped producer_ref equal to the permanent invariant-P contract
    constant — the same trust base as all evidence; never a lookup in the currently-active
    registry, round-9 R9-1). No HUMAN_DECISION envelope appears at later admissions at all.

A5  Two governed transition families, one gate, one authority shape. RECLASSIFICATION crosses
    CONTRACT_* → non-CONTRACT_* and preserves the exact normalized primary subject binding;
    SUBJECT_TRANSFER changes the subject and preserves the classification, binding BOTH the old
    and the new context in its material (round-6 R6-2). One edge never changes both. Clearing OUT
    of CONTRACT_* and transferring CONTEXT both require the governed path; re-raising INTO
    CONTRACT_* is ordinary intake (raising a barrier needs no authority — fail-closed direction
    is free).

A6  Barrier clearing is EDGE- and PATH-scoped with DELEGATION: every supersession entry into a
    CONTRACT_* ancestor along every chain must be a governed clearing edge, a context-preserving
    delegation, or a governed context transfer; the obligation rests on the terminal CONTRACT_*
    node of each chain and never moves to another context without authority naming both contexts.
    A cleared edge stays cleared forever — a completed immutable transition, not standing
    authority: the artifacts that cleared it can never validate any second, different edge.

A8  Exclusivity is held by the TARGET, not by the presented evidence (round-6 R6-1; re-keyed by
    round-8 R8-1): the ingress enforces, inside the store transaction, (a) replay idempotency on
    `(producer_ref, source_ref = cadp-v04:<effect_id>)` — the landed §6.2 key, deterministically
    effect-bound as Spec K3 requires — and (b) a separate edge-uniqueness constraint keyed on the
    sealed draft's own `supersedes` singleton. At most one governed outgoing edge per predecessor
    can exist, ever — an invariant no admission-time evidence list can bypass.

A9  One authorization discharges exactly one predecessor (round-7 R7-1): a descendant resolves a
    barrier entry only when its `supersedes` list is exactly the single entry naming that
    predecessor (invariant I6, §7). Matching by containment let one authorized seal clear every
    same-subject CONTRACT_* finding its draft happened to list. The rule is enforced at the seal
    and, load-bearingly, in the barrier predicate over the sealed envelope's own list.

A7  All non-Human clearing authority lives in ACTIVE policy content, landed via Human-gated
    POLICY_ACTIVATE, revocable the same way — deterministic rules whose evidence-borne
    observations each carry exact per-predecessor applicability (§6.5), and per-finding
    landed-authority entries for AUTHORITY_RESOLUTION (§10.4). All Human clearing authority is
    consumed effect-scoped at exactly one governed admission. There is no third source.
```

## 3. Vocabulary

```text
F            predecessor Finding, classification CONTRACT_* (exact {evidence_id, envelope_digest})
G            superseding descendant Finding sealed by FINDING_SEAL; non-CONTRACT_* for a
             RECLASSIFICATION, CONTRACT_* (same class, new subject) for a SUBJECT_TRANSFER
edge F→G     the supersession entry in G.claim.supersedes naming F by exact id+digest
E            the FINDING_SEAL EffectRequestV1 whose material is the transition payload
H            the ordinary landed HUMAN_DECISION scoped to E (effect_id + material_digest)
M            E's K3 material: cadp.governed-transition.v1 (§4), transition_kind ∈
             {RECLASSIFICATION, SUBJECT_TRANSFER}
T(F)         the governed-edge key `(F.evidence_id, F.envelope_digest)` — derived by the store
             from the sealed draft's own singleton `supersedes` entry; the target's edge-
             uniqueness key (§5.3 rule (b), §6.6). NOT an idempotency key and NOT the dispatch
             `source_ref` (round-8 R8-1): the dispatch `source_ref` carries the landed replay
             key `cadp-v04:<effect_id>`
writer       two distinct things, named separately from round 9 on (R9-1): the PRODUCER
             IDENTITY `governed:reclassification` — a permanent product-contract constant
             (invariant P, §5.2), the value the ingress stamps as `producer_ref` and the value
             every uniqueness key and clearing predicate uses — and the WORKLOAD CREDENTIAL
             currently bound to that constant in the identity registry, which is the rotatable/
             revocable part (§5.2). "The writer" unqualified means the producer identity
```

## 4. D1 — Exact transition-authorization representation

**Family choice.** The issue's D1 offered three candidate families. Family 1 (bounded extension
of the Human-decision claim) is now proven dead: any design in that family must re-present the
decision at later effect admissions to keep barrier recomputation honest, and the landed TD §4.4
#5 sentence ("has not been referenced by any admission of a **different** `effect_id`") plus
Spec §5.3 ("다른 `effect_id` … 에는 새 decision/evaluation이 필요하다") forbid that for every
`HUMAN_DECISION`, whatever its scope family (round-4 R1). Family 2 — an exact typed
transition-authorization **material** referenced by the existing digest-bearing scope field
`scope.material_digest` — has no such conflict, because a K3 material is not a Human decision:
it is the sealed identity of one effect, and the decision that references it is consumed by that
one effect in full landed §5.3/§9.3 form. The round-3 objection to this family (collision with
`scope.material_digest`'s path-A meaning; CAS payload unreachable by policy) dissolves when the
transition is its **own** effect: the material digest of E *is* the transition payload digest —
the landed meaning, no overload — and the evaluator reads the exact material content at E's own
admission (`input.effect_material`, TD §5.1/§6.6). No v0.3 `approval_binding` semantics are
imported; the representation is derived from v0.4 K3/§5.3 mechanics only.

**The typed material** (`material_schema = cadp.governed-transition.v1`, a CAS object per TD
§6.6; round-6 R6-2 renames the round-5 `cadp.reclassification-transition.v1` and adds the
`transition_kind` discriminator — one schema, one operation, two exhaustive variants):

```text
cadp.governed-transition.v1 {
  contract_id          : "cadp.improvement-intake.v1"
  idempotency_key      : "cadp-v04:<effect_id>"                  (the landed seal path rejects any
                          material whose idempotency_key ≠ the effect's — verified at
                          `cadp/kernel/ingress.ts` sealEffectRequest; requester cannot choose it;
                          covered by material_digest. This IS the target replay key — the dispatch
                          carries it as source_ref, §5.1/§5.3 rule (a); the edge-uniqueness key
                          T(F) is a separate store constraint, §5.3 rule (b)/§6.6)
  transition_kind      : "RECLASSIFICATION" | "SUBJECT_TRANSFER"  (exhaustive; unknown → DENY)
  predecessor_ref      : { evidence_id, envelope_digest }        (exact F)
  from_classification  : exact CONTRACT_* member (== F.claim.classification)
  to_classification    : exact member (== descendant_draft.claim.classification)
                          RECLASSIFICATION : MUST be non-CONTRACT_*
                          SUBJECT_TRANSFER : MUST equal from_classification
  from_subject         : normalized primary subject tuple (== F's, exact)   (round-6 R6-2:
                          present in BOTH variants, so every governed edge names the context
                          it acts on, not only the one it moves to)
  to_subject           : normalized primary subject tuple (== descendant_draft's primary)
                          RECLASSIFICATION : MUST equal from_subject (§7 I1)
                          SUBJECT_TRANSFER : MUST differ from from_subject
  descendant_draft     : {                                       (the COMPLETE K2 draft of G)
    evidence_kind      : "IMPROVEMENT_FINDING"
    subject_bindings   : [...]                                   (primary subject == to_subject)
    claim              : ImprovementFindingClaimV1               (full landed shape: supersedes ==
                          [predecessor_ref] — EXACTLY one entry, round-7 I6 —
                          correction_reason, derivation
                          {HUMAN_JUDGMENT | DETERMINISTIC_DERIVATION, method_ref, method_digest,
                          execution_or_run_ref per landed rules}, basis, occurrence_key, …)
  }
}
```

**The Human authorization** is `cadp.human-decision.v1` **unchanged**:

```text
scope = { effect_id: E, target_ref, material_digest: digest(M) }   — landed fields, landed path A
decision = APPROVE                                                  — the only clearing polarity
```

Normative rules:

1. `statement` remains non-authoritative (E2). Only `decision == APPROVE` with
   `scope.effect_id == E` and `scope.material_digest == digest(M)` satisfies the transition
   requirement — the landed `human_ok` shape, applied to E. `REJECT`, `STOP`, and unknown values
   never clear (FC1). `EXCEPTION_ACCEPT` is deliberately **excluded** for transitions: a
   reclassification is a judgment about what a Finding is, not an accepted risk; excluding it
   keeps the clearing polarity single-valued.
2. Path A applies verbatim (TD §9.3): E is sealed first; the SSO surface renders, from
   `get_effect_state` and the resolved material, E's `effect_id`, `request_digest`, and every
   field of M — `transition_kind`, predecessor id+digest, from → to classification,
   from_subject → to_subject, and the full descendant draft including method, run ref, and
   correction_reason — before approval; the ingress verifies principal,
   `presented_request_digest`, and `issued_at > requested_at` (all landed). For a
   `SUBJECT_TRANSFER` the Human is therefore approving an explicit, rendered `S1 → S2` context
   move against a named predecessor — this is the authority that round-6 R6-2 found missing.
3. The Kernel never parses M or any product claim: M is exact CAS bytes under K3
   `material_digest`; the **policy** predicates over the resolved material and the presented F at
   E's admission (§6.4); the registered surface and the FINDING_SEAL adapter validate the
   product contract (`validateFindingClaim` and cross-field rules) as adapter conformance,
   defense-in-depth to policy.
4. **No new Human-decision representation is needed** (acceptance #2, second branch): the landed
   decision schema, scope fields, path-A sequence, ingress checks, and PEP recheck #5 are used
   without modification. This holds for both transition families: `SUBJECT_TRANSFER` reuses the
   identical decision shape against a different material variant, adding no Human vocabulary.

### 4.1 Why context transfer is a governed family, not a marker (round-6 R6-2)

The round-5 candidate let an ordinary intake supersession move the barrier obligation from
`C_old/S1` to `C_new/S2`, with the mandatory-but-free-text `correction_reason` as the only
distinguishing marker. Review measured the consequence exactly: authority later bound to
`C_new` and `S2` then discharged an obligation that arose at `C_old` under `S1`, and free text
is not authority (E2). The alternatives are (i) never let the obligation move — which
re-creates the round-4 R2 permanent barrier for every legitimate mis-subjected finding — or
(ii) make the move itself an authorized act that names both contexts. This design takes (ii),
with the minimum possible surface:

```text
same gate           FINDING_SEAL — no second operation_kind, no second adapter, no second
                    identity, no second Human path; only a second material variant
both contexts named from_subject (== the predecessor's exact normalized primary subject) and
                    to_subject are BOTH inside digest(M), so H (or the deterministic
                    observation, §6.5) authorizes an exact S1 → S2 move for an exact predecessor
class preserved     to_classification == from_classification: a transfer may not also cross the
                    CONTRACT_* boundary (§7 I3 stays inexpressible in one step)
no clearing power   a SUBJECT_TRANSFER clears nothing; it relocates the obligation to a node that
                    is itself CONTRACT_* and must be cleared on its own terms (§6.3)
unauthorised path   still legal, still non-delegating: an intake subject-changing supersession is
                    an ordinary corrected statement of the problem; C_old's barrier simply
                    stands until transferred or cleared (fail-closed, FC16b)
```

A `SUBJECT_TRANSFER` is *not* a weaker reclassification: it cannot remove a barrier, only move
one, and the move costs the same Human/deterministic authority as a clearing. Both directions of
D3 are satisfied — legitimate subject correction stays possible (it is not blocked by an
accidental equality check), and authority scoped to one context cannot discharge another.

## 5. Exact TD delta (bounded, protected, Human merge required)

**TD §4.4 rechecks (including #5 and #14): UNCHANGED. TD §9.3: UNCHANGED.** The round-3 deltas
are withdrawn.

### 5.1 TD §6.4 — one new reference target adapter operation

**Improvement-transition seal (product target: the Kernel evidence ingress).** The adapter's
"external target" is the deployment's own evidence store, reached exclusively through the landed
public `submit_evidence` API (TD §12) authenticated as the dedicated workload identity
`governed:reclassification`, which no worker, workflow, or other adapter holds. Precedent: the
constitutional store adapter (POLICY_ACTIVATE) already targets the deployment's own store.

| operation_kind | material | idempotency / dispatch_precondition | COMMITTED proof | NO_EFFECT_CONFIRMED proof |
|---|---|---|---|---|
| `FINDING_SEAL` | `cadp.governed-transition.v1` (§4; a CAS object, §6.6) | `NATIVE_KEY` (target key = the landed §6.2 value `cadp-v04:<effect_id>`, **deterministically bound to the effect identity exactly as Spec K3 requires** (round-8 R8-1); it is the material's landed ingress-enforced `idempotency_key`, hence covered by `material_digest`, and the dispatch carries the same value as `source_ref` so the target deduplicates on it without parsing the claim — §5.3 rule (a). The predecessor-edge uniqueness invariant U is a SEPARATE registry-declared store constraint keyed on the sealed draft's own `supersedes` singleton — §5.3 rule (b)/§6.6 — and is deliberately NOT the idempotency key: a key that different effects intentionally share cannot be a K3 idempotency key) / **`NONE`** — the material names **no mutable target subject**: the operation appends exactly one new immutable envelope and binds no revision of any existing target object (the landed `RECORD_WRITE` classification, §4.6 item 1). Recheck #14 is satisfied **as landed** — it constrains only mutable-subject operations and is vacuous here; no `TARGET_IMMUTABILITY_ATTESTATION` is required or claimed. The `NATIVE_KEY` declaration is made true at the target by §5.3 rule (a) and MUST pass the §6.2/§13.3 double-dispatch conformance test — the landed operative meaning, "double dispatch yields one effect" (TD §13.3); a declared `NATIVE_KEY` without a passing test is treated as `NONE` (landed §6.1 rule). `reconcile: BY_QUERY_PREDICATE`, `no_effect_proof_supported: true` | authoritative primary store read (the deployment's own constitutional store — the read authority IS the write authority; no replica in the reference deployment) on the edge predicate `(producer_ref = governed:reclassification, edge = T(F))` (the §5.3 rule-(b) key derived from `material.predecessor_ref`) returns exactly one envelope whose `claim` + `subject_bindings` re-digest byte-exactly (cadp-jcs-1) to `material.descendant_draft` — a target-native field that is a function of the material (§6.4 receipt binding rule); receipt = `{evidence_id, envelope_digest}`. The edge predicate (not the effect key) is read because logical commitment is convergence to THE governed edge: a byte-identical restatement admitted as a second effect converges to the same single envelope (§5.3) and is COMMITTED with the same receipt | the same primary edge read, performed inside serialization domain `evidence-seal` (so no dispatch of this domain can be in flight), returns **either** none (no governed edge for F exists, so this effect produced nothing), **or** an envelope for `T(F)` whose payload does NOT re-digest to this material's `descendant_draft` (the §5.3 rule-(b) conflict case: the edge is permanently held by a different governed transition, so this effect produced nothing and can never commit — a terminal target statement, reason `governed_seal_conflict`). Both are authoritative because the store is the single write path for this producer and the read is primary by construction; neither is client-side inference over an eventually-consistent surface |

Dispatch: submit the draft `{evidence_kind, subject_bindings, claim} = descendant_draft` with
`source_ref = cadp-v04:<effect_id>` (round-8 R8-1: the effect-bound replay key — equal to the
material's `idempotency_key`, which the adapter verifies pre-dispatch and refuses on mismatch;
`source_ref` is thereby also the direct effect→artifact audit pointer, §6.2); the **landed
ingress** stamps `producer_ref` from the
authenticated identity and sets `provenance.integrity = AUTHENTICATED_SOURCE` (§9.1, unchanged).
E's `work_bindings` MUST carry the predecessor's evidence binding (namespace `evidence`,
object_id `F.evidence_id`) in addition to any work-run binding — this is what lets the §5.4
incident scope hold bite on further sealing against F. The adapter validates the product
contract (§4 rule 3) before send and refuses a draft that does
not re-derive `occurrence_key` or violates `validateFindingClaim` — a pre-dispatch
`MATERIAL_INCOMPLETE`-class refusal, conformance-tested per §13.3. Retry/crash behaviour is the
landed `NATIVE_KEY` path, not a precondition read: a re-dispatch of the same admitted E
re-submits the identical draft with the same `source_ref`; §5.3 rule (a) converges it to
the existing envelope, the adapter reports `ACCEPTED` with that envelope's receipt, and the
outcome is `COMMITTED` — nothing is ever routed through `dispatch_precondition_read`, so the
`DISPATCH_PRECONDITION_FAILED`-only result space of that seam is never asked to express
"already committed" (round-5 R5-1). A dispatch refused by §5.3 rule (b) (edge held by a
different governed transition) is a target-authoritative `REJECTED_NO_EFFECT` whose proof claim
is the sealed `GOVERNED_SEAL_CONFLICT` incident (§5.4) — outcome `NO_EFFECT_CONFIRMED` by the
landed §6.3 row, no reconcile read needed. The adapter declares `serialization_domain(material) =
"evidence-seal"` (§4.6 item 3) — not needed for write correctness (the keys dedup), but it makes
the reconcile-time NO_EFFECT read race-free: no dispatch of this domain can be in flight while
the read runs.

### 5.2 TD §9.2 — one new producer row

| evidence_kind | source | subject bindings | claim schema | relation |
|---|---|---|---|---|
| `IMPROVEMENT_FINDING` | `FINDING_SEAL` dispatch (governed writer; §6.4) | per descendant draft | `cadp.improvement-finding.v1` (unchanged) | `SELF_REPORT` (the platform recording its own governed act; the clearing predicate consults `producer_ref` + `integrity`, never the relation string) |

The adapter registry (policy content, §9.1) gains
`{ producer_ref: "governed:reclassification", evidence_kinds: ["IMPROVEMENT_FINDING"],
source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" },
replay_idempotency: "SOURCE_REF_UNIQUE", governed_edge: "SUPERSEDES_SINGLETON" }` (§5.3, the two
declarations of the two separated mechanisms — round-8 R8-1); the identity registry gains the
workload credential bound to that producer_ref.

**Invariant P — permanent producer identity (round-9 R9-1).** The string
`governed:reclassification` is a **permanent constant of product contract v1.1**, not mutable
registry content: it is fixed by the contract itself (like an `evidence_kind` value), and every
mechanism that keys or trusts governed output uses the constant — the §5.3 rule keys, the §3.2
unique indexes, the §5.1 reconcile predicates, and §6.2's `governed_transition`. Two rules make
it permanent:

1. **What rotates is the credential, never the identity.** Compromise or retirement of the
   workload credential is handled by `POLICY_ACTIVATE` on the *identity registry binding*:
   the old credential is unbound (no future dispatch can authenticate as the writer) and any
   successor credential is bound to the **same** constant producer_ref. Every writer
   generation therefore lands on the same `(producer_ref, source_ref)` and
   `(producer_ref, T(F))` key rows — invariant U (§6.6) holds across all generations by
   construction, and no "replacement producer_ref" can ever exist to open a second edge for a
   served predecessor.
2. **The constant is reserved (registry conformance rule, defence-in-depth).** A policy bundle
   whose adapter registry contains any entry declaring `governed_edge: SUPERSEDES_SINGLETON`
   for `IMPROVEMENT_FINDING` under a producer_ref other than the reserved constant fails
   registry conformance and the `POLICY_ACTIVATE` is DENIED. (Even without this rule such an
   entry would be inert for authority purposes — §6.2 compares against the constant, so its
   envelopes could never clear or delegate — but the rule keeps invariant U literally true
   rather than merely true-for-everything-that-matters.)

Revocation is therefore **prospective only**: unbinding a credential stops future sealing and
changes nothing about any envelope already sealed — `producer_ref` is a kernel-stamped immutable
fact (K2), and §6.2 reads only such facts. A seal made by a compromised credential *before*
revocation is distrusted **forward**, by the landed correction path — incident + I4 re-raise
into CONTRACT_* (fresh key `T(C₂)`, §6.6) — never by re-evaluating history against the current
registry. Removing the adapter-registry row itself (retiring the capability entirely) is
likewise prospective: no further `FINDING_SEAL` can dispatch, while every completed edge remains
a completed immutable transition (§8).

### 5.3 TD §9.1 — two registry-declared ingress rules (round-5 R5-1, round-6 R6-1, round-8 R8-1)

The adapter-registry entry schema gains two optional fields — `replay_idempotency:
SOURCE_REF_UNIQUE` and `governed_edge: SUPERSEDES_SINGLETON` (both absent for every existing
producer — their behaviour is unchanged). For a `submit_evidence` whose authenticated producer's
registry entry declares them, the Ingress runs both rules inside the one store transaction — the
landed WORK_STEP replay pattern (`insertWorkStep`, §7.4/C33) applied to two keys, with the
identical three-way outcome shape and the identical semantic-equality set (`subject_bindings,
claim_schema, claim, availability, unknown_reason`):

```text
rule (a) REPLAY — key (producer_ref, source_ref), where the dispatch sets
         source_ref = cadp-v04:<effect_id> (== the material's landed ingress-enforced
         idempotency_key; effect-bound, Spec K3-conformant — round-8 R8-1):
  existing envelope for the key, identical semantic payload → return the EXISTING envelope
                                                              (converged replay; no new
                                                              evidence_id, no incident)
  existing envelope, differing payload                      → GOVERNED_SEAL_CONFLICT incident +
                                                              rejection (unreachable through an
                                                              honest PEP — material_digest fixes
                                                              one draft per effect; fail-closed
                                                              defence-in-depth)
  no existing envelope                                      → proceed to rule (b)

rule (b) GOVERNED-EDGE UNIQUENESS — key (producer_ref, T(F)), where the STORE derives
         T(F) = (supersedes[0].evidence_id, supersedes[0].envelope_digest) from the submitted
         draft's OWN claim; a draft whose supersedes is not exactly one exact ref is rejected
         outright for this producer (shape guard — defence-in-depth to §6.4's DENY):
  existing envelope for the edge, identical semantic payload → return the EXISTING envelope
                                                              (cross-effect idempotent
                                                              restatement: one artifact, one
                                                              edge, two audit trails)
  existing envelope, differing payload                       → GOVERNED_SEAL_CONFLICT incident
                                                              (§5.4) + rejection — the edge is
                                                              permanently held
  no existing envelope                                       → insert (landed path)
```

Neither key is caller-chosen: `source_ref` is set by the PEP-owned dispatch path from the sealed
material (no other principal holds the writer credential, §5.1/FC5), and the edge key is computed
by the store from the draft's own sealed content. Two consequences, both load-bearing:

1. **Replay idempotency (R5-1; re-keyed by R8-1).** Every dispatch of one admitted effect
   re-submits the identical draft under the identical effect-bound key, so it converges to the
   one existing envelope. This is what the §5.1 `NATIVE_KEY` declaration asserts, with the target
   key **deterministically bound to `effect_id`** exactly as Spec K3 requires and with the exact
   landed §6.2 value — no "coarser key" gloss remains. The §13.3 double-dispatch conformance
   test proves it (FC7).
2. **Governed-edge uniqueness (R6-1, unchanged in force; now a store constraint, not an
   idempotency claim).** A second FINDING_SEAL for the same F carrying any different descendant
   draft — a different subject, class, method, basis, run, or transition_kind — hits an occupied
   edge with a differing payload and is refused at the store, with a `GOVERNED_SEAL_CONFLICT`
   incident sealed under the exact §5.4 contract. **At most one governed outgoing edge exists
   per predecessor, for all time.** The check runs inside the store transaction on the store's
   own contents; it reads no admission input, so omitting the first descendant from the second
   admission's evidence list cannot reach it (FC15). Because the edge key is derived from the
   draft's own `supersedes` singleton, this rule is also a second, independent enforcement of
   invariant I6 (§7): a multi-predecessor draft cannot even be keyed.

**TD §3.2 (store) delta, declared:** two `UNIQUE` partial indexes on `evidence_envelope`
mirroring the landed WORK_STEP index precedent — `(producer_ref, source_ref)` and
`(producer_ref, edge_evidence_id, edge_envelope_digest)` (edge columns extracted from the
claim's singleton `supersedes` entry), each scoped to registry-opted producers (reference DDL
uses the governed producer constant, as the WORK_STEP index uses its kind constant). They are
the constraint-level backstop to the transactional lookups, exactly as `UNIQUE(work_run_ref,
step_ordinal)` backstops `insertWorkStep` (C33).

**The §5 delta is exhaustive** (round-8 R8-2 — the prior "nothing else changes" claim is
withdrawn): TD §6.4 one adapter operation row (§5.1); TD §9.2 one producer row + two registry
fields (§5.2); TD §9.1 the two ingress rules above plus the invariant-P reserved-constant
registry conformance rule (§5.2 rule 2 — a `POLICY_ACTIVATE`-time registry validity check,
round-9 R9-1); TD §3.2 the two unique partial indexes; TD §2.6 one incident kind (§5.4). Nothing else: no recheck delta (recheck #14 applies as landed and
is vacuous for a no-mutable-subject operation), no Human-decision delta, no new K-record, no
API-shape change (the seal path is the landed `submit_evidence` signature — `source_ref` is an
existing caller-supplied draft field; only the replay/uniqueness behaviour for registry-opted
producers changes), no evaluator-seam change, no `TARGET_IMMUTABILITY_ATTESTATION` obligations.

### 5.4 TD §2.6 — one new incident kind: `GOVERNED_SEAL_CONFLICT` (round-8 R8-2)

The landed `incident_kind` set is closed; this design extends it by exactly one value, declared
as part of the protected TD delta. The incident is an ordinary §2.6 `KERNEL_INCIDENT` envelope —
`claim_schema cadp.incident.v1`, shape unchanged — sealed by the Ingress (the landed
`WORK_STEP_CONFLICT` path; producer = the Kernel Service instance, `INDEPENDENT_OBSERVATION` /
`AUTHENTICATED_SOURCE`):

```text
incident_kind    GOVERNED_SEAL_CONFLICT
detail           which §5.3 rule refused ("replay" | "edge"), the conflicting key value, and the
                 digest of the refused draft's semantic payload
offending_refs   [ refused effect_id, existing governed envelope's evidence_id,
                   predecessor F's evidence_id ]
subject_bindings exactly (the §2.6 "every id involved" rule applied):
                   the refused effect_id; the admission_digest of the dispatching admission;
                   the existing governed envelope's evidence_id; F's evidence_id
```

**Scope-hold consequence (the landed §2.6 rule, no new behaviour):** the PEP refuses any new
`EffectAdmissionV1` whose `effect_id`, `target_ref` or `work_bindings` intersect those subject
bindings until release. Because every FINDING_SEAL effect's `work_bindings` carry the
predecessor's evidence binding (§5.1), an open conflict on F **freezes all further governed
sealing against F** — fail-closed and intended: a conflicting second seal is either a workflow
defect or an attack, and further governed edges on that predecessor need Human eyes first.
Ordinary work is not held: admissions that merely *present* F as evidence do not intersect (the
hold reads `effect_id`/`target_ref`/`work_bindings`, never evidence lists), and the refused
effect's own hold is moot — its outcome is already terminal `NO_EFFECT_CONFIRMED`.

**Release:** the landed §2.6/§9.4 path only — a later root-signed `BREAK_GLASS` envelope whose
`release_incident_refs` names the incident. No standalone release document, no new release
semantics, no automatic release.

**Why not reuse `WORK_STEP_CONFLICT`:** its contract names a work-run/step replay key, its
detail/subject-binding shape would hold the wrong scope (a work run rather than a predecessor
edge), and overloading it would make the closed set semantically false — a reviewer or operator
could no longer read the kind as identifying the violated invariant. Implementation note: the
ingress rejection-reason union gains the same value (the `WORK_STEP_CONFLICT` precedent,
`cadp/kernel/ingress.ts`) — implementation contract carried under this TD delta.

## 6. D2 — Applicability, anti-standing-authority, and the barrier rule

### 6.1 Non-circular exact applicability basis — Human family

The applicability basis of one authorization H is the closed pair:

```text
{ consuming effect E (kernel scope.effect_id — single-effect by landed TD §4.4 #5),
  exact transition content digest(M) (scope.material_digest) — which covers:
    predecessor F (id+digest), from, to, the COMPLETE descendant draft
    (classification, subject bindings, method ref+digest, run ref, basis, supersedes) }
```

Every element exists and is immutable **before** H is issued (E sealed first, path A). Nothing
binds to a not-yet-existing record; nothing is ambient/latest. Detachment is automatic and total:

- supersede/correct F → new digest → `predecessor_ref` mismatch at E's admission → DENY;
- any change to the intended descendant (subject, class, method, run, basis) → different M →
  `scope.material_digest` mismatch → H unusable;
- a second descendant, subject, run, or predecessor → a **new effect** → by the landed Spec §5.3
  sentence itself, a **new decision**. The rule the round-3 candidate fought now does the D2
  anti-standing work: cross-descendant/subject/run/predecessor reuse of H is not merely
  policy-refused, it is kernel-refused by the unchanged recheck #5 (FC2, FC6).

H is consumed at exactly one admission and appears nowhere else, ever. There is no consumption
ledger, no clock, and no reuse dimension left open.

### 6.2 The durable clearing artifact and its trust base

The thing later admissions consume is G — an ordinary immutable `IMPROVEMENT_FINDING` envelope
distinguished by kernel-stamped facts:

```text
governed_transition(D) iff
  D.evidence_kind == "IMPROVEMENT_FINDING", availability PRESENT
  D.producer_ref == "governed:reclassification"          (the PERMANENT contract constant —
    invariant P, §5.2; part of product contract v1.1 itself, NOT read from active policy
    content — round-9 R9-1)
  D.provenance.integrity == "AUTHENTICATED_SOURCE"
  D.claim.derivation.kind ∈ {HUMAN_JUDGMENT, DETERMINISTIC_DERIVATION}   (defence-in-depth;
    MODEL_PROPOSAL is already unsealable through the gate — §6.4)
```

Every conjunct reads a **kernel-stamped immutable fact of the envelope**; none reads the
currently-active registry (round-9 R9-1). `producer_ref` is stamped by the landed ingress from
the workload credential authenticated at seal time — the credential the *seal-time* active
policy bound to the constant (§5.2) — and no adapter, worker, or model can produce it (§9.1;
FC5). An envelope with this producer exists only if a `FINDING_SEAL` admission passed the full
constitutional gate — including the transition rules of §6.4 — under the Human-gated policy
active at that admission. Which credential generation held the identity then is an audit fact
(the effect's K-records name it), not a validity input: later revocation or rotation of the
credential can therefore never make `governed_transition` flip on a sealed envelope, which is
exactly what §6.3's "a validly cleared edge stays cleared" and D4's completed-transition
boundary require (FC19a).

**Audit pointer (round-8 R8-1 consequence — the round-6 detour is gone).** `source_ref` carries
`cadp-v04:<effect_id>`, so the sealed artifact names its authorizing effect directly; K3/K5/K6
for that effect name the material, the decision and the admitted evidence, and the effect's K7
outcome names the receipt `{G.evidence_id, G.envelope_digest}` — both directions are direct
record lookups. Which predecessor the artifact acts on is equally direct: the sealed claim's own
singleton `supersedes` entry (I6), the same value the store keys invariant U on (§5.3 rule (b)).
No K-record, envelope field, or API changes either way.

This is **not** the "adapter-sealed attestation that policy trusts without resolving the
decision" the round-3 candidate rejected: that shape had a commodity adapter attest *outside*
the gate on conformance trust alone. Here the seal *is* the gate — K3 sealed material, K4 input
resolving F and the authority evidence exactly, K5 decision, PEP rechecks #1–#17 unchanged, K6
admission, K7 target-authoritative receipt — and the decision is resolved exactly, once, where
Spec §5.3 says a decision is resolved: at the admission of the effect it approves. Trusting the
gate's product afterwards is the constitution's own pattern for every landed fact (a merged PR
is not re-approved at later admissions; an activated policy is not re-admitted per evaluation).

### 6.3 Edge-scoped, path-scoped barrier with typed delegation (round-4 R2, round-6 R6-2)

Product-contract rule (v1.1, replaces the landed node-scoped `cleared()`; `→s` is one exact
id+digest `supersedes` entry among presented Findings):

```text
sole_predecessor(C, D) iff                                         (round-7 R7-1, invariant I6)
  D.claim.supersedes == [ {C.evidence_id, C.envelope_digest} ]     — EXACTLY one entry, matching
  C by id AND digest. Containment ("some s in supersedes") is a DEFECT: it let one authorized
  seal resolve every other CONTRACT_* finding the draft happened to list (§0.4 R7-1). This
  predicate reads the SEALED ENVELOPE's own list, so it holds for every consumer at every later
  admission regardless of what any seal-time check did.

clearing_edge(C, D) iff
  sole_predecessor(C, D)                                           (§7 I6)
  and C.classification is CONTRACT_* and D.classification is not
  and subject_preserved(C, D)                                      (§7 I1)
  and governed_transition(D)                                       (§6.2)

delegation_edge(C, D) iff                                          (round-6 R6-2: TWO typed forms,
  sole_predecessor(C, D)                                            exhaustive and disjoint)
  and C.classification is CONTRACT_* and D.classification is CONTRACT_*
  and either
    (a) CONTEXT_PRESERVING  subject_preserved(C, D)                (normalized primary subject
        binding of D == C's, exactly). Ordinary intake; NO authority required, because NO
        context crosses: the obligation lands on D under the SAME subject, and whatever later
        clears D is bound to D's exact id+digest and to that same subject.
    (b) CONTEXT_TRANSFER    governed_transition(D)                 (§6.2) and D was sealed under
        transition_kind == SUBJECT_TRANSFER — evidenced on the graph as: D.classification ==
        C.classification, D's primary subject ≠ C's, and governed_transition(D) holds. The
        seal-time rules of §6.4 guarantee such a D exists only if an authority bound to
        {C exact id+digest, from_subject = C's subject, to_subject = D's subject} was resolved
        at its admission — the old AND the new context are both named by the authorizing
        artifact, so no authority scoped to one context discharges another. This graph-level
        inference is sound ONLY because of `sole_predecessor` (round-7 R7-1): with containment
        matching, D could name several predecessors while the material's `predecessor_ref` — the
        one the authority was bound to — was just one of them, and the inference would attribute
        a transfer authority to predecessors no authority ever mentioned.
  NOTE 1: a subject-CHANGING supersession that is not governed_transition is NOT a delegation_edge.
  It remains a legal, auditable intake correction (I2(a)) — it simply does not move the obligation:
  C's barrier stands until C is itself transferred or cleared. correction_reason is a mandatory
  audit field and is NEVER authority (E2).
  NOTE 2 (round-7 R7-1): a MULTI-superseding descendant (a duplicate merge, `supersedes` with two
  or more entries) is likewise not a resolved_entry for ANY of its predecessors — `sole_predecessor`
  fails for each. Merging stays legal at intake; it just resolves nothing, and each merged
  predecessor keeps its own obligation until separately transferred or cleared. This is
  fail-closed and creates no permanent barrier: each predecessor still has its own governed path
  (its own key T(F), §6.6), and nothing legitimate requires ONE authorization to answer several
  distinct contract questions at once.

resolved_entry(C, D) iff clearing_edge(C, D) or delegation_edge(C, D)

contract_barrier(tip) iff any of:
  (i)   some chain tip →s … →s D →s C with C CONTRACT_*, where entry (C, D) is not a
        resolved_entry and no valid AUTHORITY_RESOLUTION (§10.4) names C's exact id+digest;
  (ii)  tip itself is CONTRACT_* and no valid AUTHORITY_RESOLUTION names its exact id+digest
        (the WORK_START tip-class rule additionally stands unchanged);
  (iii) any supersedes entry reachable from tip fails to resolve to a presented envelope with
        equal id AND digest (fail closed, unchanged).

Ambiguity (fail closed, defence-in-depth): if two distinct presented descendants each form a
clearing_edge or a CONTEXT_TRANSFER delegation_edge from the same C, no such edge of C is valid
(reason reclassification_ambiguous). §6.6 makes this state unreachable for governed edges — it is
retained as a graph-level backstop, not as the exclusivity mechanism (round-6 R6-1).
```

Consequences:

- **The obligation rests on the terminal CONTRACT_* node of each chain.** For the legitimate
  two-step correction `C_old(CONTRACT, S1) ←s C_new(CONTRACT, S2, GOVERNED SUBJECT_TRANSFER)
  ←s G(non-CONTRACT, S2, governed RECLASSIFICATION)`: entry (C_new, G) is a clearing_edge
  (subject S2 preserved); entry (C_old, C_new) is a CONTEXT_TRANSFER delegation_edge authorized
  against C_old and S1→S2; no chain from a tip through G has an unresolved CONTRACT entry — the
  barrier clears (round-4 R2's permanent barrier is gone; FC8 positive). If the same correction is
  made by ordinary intake instead, entry (C_old, C_new) is unresolved and the barrier stands
  (round-6 R6-2; FC16b).
- **Delegation never lets authority cross contexts unauthorized.** A delegation edge clears
  nothing; it relocates the obligation to a node that must itself be cleared by authority bound to
  *its* exact id+digest and *its* subject (I1). In form (a) nothing crosses — the subject is
  identical. In form (b) the crossing is exactly what a Human (or a both-subjects-bound
  deterministic observation) authorized against C_old's own identity. There is no third form, and
  free text authorizes nothing.
- **Path scoping is preserved.** A tip whose ancestry reaches C_old not through C_new (sibling
  branch) hits entry (C_old, ·) unresolved → barrier (FC8 sibling control).
- **One authorization, one predecessor (round-7 R7-1).** Because both resolved-entry families
  require `sole_predecessor`, the predecessor that an artifact resolves is always the exact one
  its authorizing material named. A governed descendant cannot resolve a second, unnamed
  CONTRACT_* finding by listing it — the barrier predicate rejects the whole descendant as a
  resolver, in every direction, for every predecessor (FC17).
- A validly cleared edge stays cleared for every later tip whose ancestry passes through it — a
  completed immutable transition, not standing authority: G, H, and E can never validate any
  second, different edge (§6.1).
- **Expressibility note (non-normative):** the rule needs no path enumeration —
  `graph.reachable` over presented `supersedes` refs yields every reachable descendant D, and
  (i)/(iii) quantify over each D's own `supersedes` entries; the landed Rego shape extends
  directly.

### 6.4 Transition rules at the FINDING_SEAL admission (v1.1)

At E's admission (`op == FINDING_SEAL`, `mat` = M), with F resolved from `input.evidence` by
exact `predecessor_ref` (E1; absent or digest-mismatched → DENY `finding_unresolvable`):

```text
kind         transition_kind ∈ {RECLASSIFICATION, SUBJECT_TRANSFER}
             — any other/absent value → DENY transition_kind_invalid (closed set)
shape        contract_id correct; descendant_draft.claim.supersedes == [predecessor_ref] — a
             list of EXACTLY ONE exact ref, id AND digest (round-7 I6; any second entry → DENY
             transition_shape_invalid, so no governed artifact can even be built with the
             multi-predecessor shape); from_classification == F.claim.classification ∈ CONTRACT_*;
             to_classification == descendant_draft.claim.classification; from_subject == F's
             normalized primary subject binding; to_subject == descendant_draft's normalized
             primary subject binding; correction_reason present; occurrence_key re-derives
             (adapter + surface pre-validate; policy checks the load-bearing fields)
per kind     RECLASSIFICATION : to_classification ∉ CONTRACT_*  and  to_subject == from_subject
                                — else DENY transition_subject_mismatch / transition_shape_invalid
             SUBJECT_TRANSFER : to_classification == from_classification (∈ CONTRACT_*)  and
                                to_subject ≠ from_subject
                                — else DENY transition_shape_invalid (a transfer may neither
                                  cross the boundary nor be a no-op restatement; the latter needs
                                  no authority and belongs at ordinary intake, §6.3 (a))
conflict     no presented descendant of F already forms a clearing_edge or a CONTEXT_TRANSFER
             delegation_edge — else DENY reclassification_ambiguous. DEFENCE-IN-DEPTH ONLY: this
             predicate reads the caller-selected evidence list and is therefore NOT the
             exclusivity mechanism; §6.6 (target uniqueness on T(F)) is (round-6 R6-1)
derivation   HUMAN_JUDGMENT          → require §4's H (landed human_ok shape on E);
                                       absent → REQUIRE_EVIDENCE(HUMAN_DECISION,
                                       transition_unauthorized{predecessor_ref, digest(M)})
             DETERMINISTIC_DERIVATION → require §6.5's rule match AND authority_applicable
                                       (context-bound observation); no Human decision
             MODEL_PROPOSAL           → DENY transition_derivation_forbidden (never sealable)
containment  FINDING_SEAL is admissible while the barrier is up — it is the resolution path —
             and is NEVER in any plain-allow or extra_plain_allow set; it is the second and
             last exception to the unresolved-CONTRACT_* mutation DENY (first: Option-A
             index-only projection, unchanged)
```

Both families use the identical authority shapes: a `SUBJECT_TRANSFER` under `HUMAN_JUDGMENT`
needs an H scoped to its own effect and material digest (which renders `S1 → S2`, §4 rule 2), and
under `DETERMINISTIC_DERIVATION` needs a rule + an observation whose `applies_to` names both
subjects (§6.5). Nothing about a transfer is cheaper than a clearing.

### 6.5 Deterministic family — context-bound authority observations (round-4 R3, round-5 R5-2, round-6 R6-1)

A deterministic reclassification is sealed through the **same** governed effect. At E's
admission, instead of H, policy requires:

```text
some rule r in ACTIVE policy content (data.cadp.authority_text_rules; default set EMPTY) with
  r.transition_kind == M.transition_kind                           (a rule authorizes ONE family)
  r.from == from_classification and r.to == to_classification
  r.method == { descendant_draft.claim.derivation.method_ref, .method_digest }   (exact)
  r.run_scoped : bool                                              (declared per rule)
and some basis entry b of descendant_draft.claim.basis with role AUTHORITY_TEXT resolving by
  exact {evidence_id, envelope_digest} to envelope A in input.evidence (E1) where
  A.producer_ref / evidence_kind / claim_schema == r's exact registered values
  A.provenance satisfies r (AUTHENTICATED_SOURCE or SIGNED_ATTESTATION as r declares)
  A's subject binding carries content_digest == r.authority_content_digest (no ambient/latest text)
and authority_applicable(r, A, F, M)                               (round-5 R5-2, below)
```

**The observation itself is context-bound.** A's claim MUST carry a typed applicability object
(part of the registered claim schema; a claim without it never satisfies the predicate — there is
no free-floating authority text):

```text
A.claim.applies_to = {
  transition_kind     : "RECLASSIFICATION" | "SUBJECT_TRANSFER"
  predecessor_ref     : { evidence_id, envelope_digest }     (exactly ONE predecessor)
  from_classification : exact member
  to_classification   : exact member
  from_subject        : normalized primary subject tuple     (the context acted ON)
  to_subject          : normalized primary subject tuple     (== from_subject for
                                                              RECLASSIFICATION; the corrected
                                                              subject for SUBJECT_TRANSFER)
  method              : { method_ref, method_digest }
  work_run_ref?       : exact run ref                        (REQUIRED iff r.run_scoped)
}

authority_applicable(r, A, F, M) iff
  A.claim.applies_to.transition_kind     == M.transition_kind == r.transition_kind
  A.claim.applies_to.predecessor_ref     == { F.evidence_id, F.envelope_digest }   (exact, both)
  A.claim.applies_to.from_classification == M.from_classification == F.claim.classification
  A.claim.applies_to.to_classification   == M.to_classification
  A.claim.applies_to.from_subject        == M.from_subject == F's normalized primary subject
  A.claim.applies_to.to_subject          == M.to_subject   == descendant_draft's primary subject
  A.claim.applies_to.method              == r.method == descendant_draft.claim.derivation's
  and (r.run_scoped implies A.claim.applies_to.work_run_ref == E's work-run binding
       (the work_run_ref of E.work_bindings); ¬r.run_scoped implies the field is absent)
```

For a deterministic `SUBJECT_TRANSFER` the observation therefore names **both** contexts
explicitly — the round-6 R6-2 requirement applied to the non-Human family: no deterministic
authority can move an obligation from `S1` to `S2` unless it was written about that exact
`C_old`, `S1 → S2` pair.

Non-circularity is preserved: `applies_to` names the predecessor and the intended transition —
both of which exist and are immutable before A is produced — never the descendant record, which
does not yet exist when A is sealed (F exists → A is observed *about* F → M cites A in the
draft's basis → E → G).

**One observation authorizes at most one transition, ever** — and round-6 R6-1 is the reason this
sentence now rests on the target, not on the evidence list:

- a different predecessor, subject, classification pair, kind, or method →
  `authority_applicable` fails structurally (FC9f) — not "re-admitted", **unsatisfiable**;
- a second, DIFFERENT descendant draft for the SAME F: the observation deliberately does not name
  the not-yet-existing descendant (naming it would be circular — §6.6), so this is not an
  `applies_to` mismatch, and the round-5 answer (the §6.4 conflict rule) was measured insufficient
  because that rule reads a caller-selected evidence list. It is now closed at the store: the
  second draft's own `supersedes` singleton derives the same edge key `T(F)` with a differing
  payload and is refused with a `GOVERNED_SEAL_CONFLICT` (§5.3 rule (b), §5.4) — no second
  envelope is ever created, whatever any admission
  concluded (§6.6, FC15). A therefore ends up embodied in **exactly one** sealed G;
- re-raise after clearing (I4: G superseded by C₂) → C₂ has a different id+digest → the same A
  never matches C₂, and `T(C₂) ≠ T(F)` so the store key is fresh; a new observation about C₂ and a
  new authorization are required (FC9g);
- a run other than the one bound (when `r.run_scoped`) → mismatch → DENY (FC9i);
- `applies_to` absent or partial → the predicate is unsatisfied → DENY (FC9h).

**Division of labour between rule and observation (why this satisfies D2):** the *rule* is law —
universal over its exact predicate, and legitimately so: it is Human-gated policy content
(Spec §3; policy content changes are governed effects, TD §9.4), revocable by `POLICY_ACTIVATE`
for every subsequent admission (FC9c), exactly as `verification_ok` applies to every PR. The
*observation* is evidence-borne authority, and D2's anti-standing clause binds **it**: each A
carries its own exact predecessor/subject/method/run applicability and can clear at most the one
edge it names. Every application is additionally one admitted `FINDING_SEAL` effect — evaluated
freshly against the then-active policy, individually audited (K6/K7), individually revocable —
but the admission is the *audit and revocation* boundary, not the applicability boundary; the
applicability boundary is `authority_applicable` (round-5 R5-2 accepted).

There is **no** standing deterministic clearing: the landed `reclassified_clear` shape (an
intake-sealed `DETERMINISTIC_DERIVATION` descendant with an `AUTHORITY_TEXT`-role basis) clears
nothing in v1.1 (FC9e — regression control against the landed defect), and a role string on any
envelope remains presentation metadata (B18; FC9d).

### 6.6 One governed edge per predecessor — the target-authoritative invariant (round-6 R6-1)

```text
INVARIANT U:  for every Finding F, the store contains AT MOST ONE envelope with
              producer_ref == "governed:reclassification" (the permanent contract constant,
              invariant P §5.2 — round-9 R9-1) whose claim.supersedes names F —
              key T(F) = (F.evidence_id, F.envelope_digest), derived by the store from the
              sealed draft's OWN singleton supersedes entry (round-8 R8-1: a store uniqueness
              constraint, §5.3 rule (b) — deliberately NOT the idempotency key, which is the
              effect-bound cadp-v04:<effect_id>).
              Held by the §5.3 lookup-before-allocate inside the store transaction, backstopped
              by the §3.2 unique partial index.
```

Why the previous formulation failed and this one does not:

```text
round-5 mechanism   §6.4 "no presented descendant of F already forms a clearing_edge"
                    → evaluated over input.evidence, which the CALLER assembles
                    → omit G₁ from the second admission's evidence and the check passes
                    → two governed descendants of one F exist; each clears on its own branch
round-6 mechanism   the ingress compares the incoming draft with what the STORE holds for the
(re-keyed, round-8) edge T(F) — derived from the draft's own supersedes singleton, not from any
                    dispatch-chosen key (round-8 R8-1)
                    → the caller supplies no part of that comparison beyond its own draft
                    → identical payload: converges (one envelope); different payload: refused
                    → no admission outcome, evidence selection, run, or principal can produce a
                      second, different governed descendant of F
```

Properties, stated precisely:

- **Scope.** U is keyed on the *predecessor*, so it also blocks a second Human-authorized edge
  from the same F, and it blocks mixing families (one F cannot have both a RECLASSIFICATION and a
  SUBJECT_TRANSFER descendant). One CONTRACT_* node has one governed successor or none.
- **Generation-independence (round-9 R9-1).** The producer_ref component of both key rows is the
  invariant-P constant, so credential rotation, revocation, or any succession of writer
  generations lands every governed seal — past and future — on the same index rows: a
  successor-generation seal for an already-served F hits the occupied edge T(F) exactly as a
  same-generation retry would (`GOVERNED_SEAL_CONFLICT`, FC19b), and the §5.2 reserved-constant
  conformance rule ensures no governed-edge-capable producer_ref other than the constant can ever
  activate. "For all time" in consequence 2 of §5.3 spans writer generations, not one
  registration's lifetime.
- **Not a lock on legitimate work.** Ordinary intake supersessions of F are untouched (different
  producer, no `replay_idempotency` entry, no clearing power). Correcting a *wrong* governed
  outcome is the I4 forward path: re-raise into CONTRACT_* as C₂, whose `T(C₂)` is a fresh key.
  Nothing legitimate needs a second governed edge from the same predecessor.
- **Why not bind A to the descendant instead (the finding's first remedy).** The descendant
  draft's `basis` must cite A by `{evidence_id, envelope_digest}` (E1, #98 §3), so a draft digest
  carried inside A's own claim would have to contain A's envelope digest. That is circular in the
  literal sense, unlike the Human family's `scope.material_digest`, which is sealed *after* A and
  the draft both exist. A partial "core digest" excluding `basis` would not restore uniqueness
  either — two drafts sharing a core still differ. The target-side key is the honest mechanism.
- **Failure visibility.** A refused second seal is not silent: a `GOVERNED_SEAL_CONFLICT`
  incident is sealed under the exact §5.4 contract (declared TD §2.6 delta — round-8 R8-2), whose
  subject bindings put a scope hold on further governed sealing against F until root-signed
  BREAK_GLASS release; the refused effect resolves terminally
  (`REJECTED_NO_EFFECT` at dispatch or the §5.1 `NO_EFFECT_CONFIRMED(governed_seal_conflict)`
  reconcile proof) rather than hanging UNKNOWN.
- **Residual, declared.** U is enforced by the ingress of the deployment that owns the store. A
  deployment that federated governed writers across two independent stores would hold U only per
  store; the reference deployment has exactly one primary store and one governed producer
  identity (invariant P, §5.1/§5.2), and federation is out of scope for this design. Recorded as
  a boundary, not a claim.

## 7. D3 — Supersession subject/work-run context invariants

```text
I1  RECLASSIFICATION EDGE (CONTRACT_* → non-CONTRACT_*): the descendant's normalized primary
    subject binding MUST equal the predecessor's exactly — full tuple {authority_ref, namespace,
    object_id, revision_or_version?, content_digest?}. Enforced at E's admission
    (transition_subject_mismatch) AND in clearing_edge at every later admission.

I2  SUBJECT-CORRECTING SUPERSESSION (round-6 R6-2 — typed, two forms, both legal):
    (a) ORDINARY INTAKE CORRECTION: permitted exactly as today; classification MUST NOT cross the
        CONTRACT_*/non-CONTRACT_* boundary in the same step; correction_reason stays mandatory
        (#98 §4). It confers no clearing AND no delegation: the predecessor's barrier obligation
        STAYS on the predecessor. This is the fail-closed default.
    (b) GOVERNED CONTEXT TRANSFER (`SUBJECT_TRANSFER`, §4.1): the same correction sealed through
        FINDING_SEAL under an authority that names {predecessor id+digest, from_subject,
        to_subject}. It confers no clearing either, but it DOES relocate the obligation to the
        successor (§6.3 delegation form (b)).
    The distinction is typed and graph-visible (`governed_transition(D)`), never a free-text
    marker. A deployment that never uses (b) simply keeps obligations where they arose.

I3  An edge that crosses the boundary outward AND changes subject is inexpressible: FINDING_SEAL
    denies it (per-kind rules, §6.4) and clearing_edge rejects it. The legitimate path is two
    governed steps — transfer the context inside CONTRACT_* (I2(b), authority bound to C_old and
    S1→S2), then reclassify the corrected tip (I1, authority bound to C_new and S2). Each step is
    separately authorized against its own exact context, and together they discharge the whole
    chain (§6.3, round-4 R2 preserved; round-6 R6-2 satisfied).

I4  Boundary asymmetry: crossing INTO CONTRACT_* (re-raising, including superseding a wrongly
    cleared G) is ordinary intake — raising a barrier requires no authority and must never be
    gated on one (fail-closed direction stays free).

I5  No run-equality invariant across supersession: predecessor and descendant may come from
    different runs (detector vs judgment). Run context enters exactly once: the descendant
    draft's execution_or_run_ref (mandatory for HUMAN_JUDGMENT, forbidden for
    DETERMINISTIC_DERIVATION — landed validator rules) is inside digest(M), so the Human
    approves it and it is immutable in G.

I6  ONE PREDECESSOR PER RESOLVING DESCENDANT (round-7 R7-1): a descendant D resolves a barrier
    entry for C — as a clearing_edge or as either delegation form — only if
    `D.claim.supersedes == [{C.evidence_id, C.envelope_digest}]`, a list of exactly one exact
    ref. Rationale: every authority in this design (H's `scope.material_digest` over M, and the
    deterministic observation's `applies_to`) binds exactly ONE `predecessor_ref`, so a
    containment match would let one authorization discharge every other CONTRACT_* finding the
    descendant happened to list — precisely the standing/ambient authority D2 forbids.
    Enforced in two independent places, and the second is the load-bearing one:
      (1) at the seal — the governed material's draft must carry the singleton list (§6.4),
          so the multi-predecessor governed artifact is unconstructible; and
      (2) in the barrier predicate — `sole_predecessor` reads the sealed envelope's own
          `supersedes` list at every later admission (§6.3), so the invariant does not depend on
          any seal-time check having run, on the producer, or on which evidence a caller
          presents.
    Multi-superseding descendants remain fully legal at intake (duplicate merges, #98 §4
    unchanged); they carry neither clearing nor delegation power, and each merged predecessor
    keeps its obligation until separately transferred or cleared. There is no permanent-barrier
    consequence (each predecessor retains its own governed path and its own key T(F)); this is
    the fail-closed reading of a merge, which is a bookkeeping act and not an argument about any
    of the questions merged.
```

## 8. D4 — Validity/reuse under clock-free admission

No wall clock is added to evaluation; `now` remains the TD §5.1 kernel-supplied value; C38
untouched. Every validity boundary is exact and non-temporal:

```text
Human family      kernel boundary : one effect (landed §4.4 #5 — unchanged, now sufficient)
                  content boundary: digest(M) — any change to the intended transition detaches H
                  polarity        : APPROVE only
Deterministic     policy-content boundary: rules live in the active bundle; POLICY_ACTIVATE
family            revokes/amends them for every subsequent FINDING_SEAL admission (Spec §9.3
                  in-flight rules unchanged)
                  observation boundary: applies_to binds each observation to one exact
                  predecessor/subject/method(/run) — at most one edge ever (§6.5)
Resolutions       policy-content boundary: per-finding {finding_ref, authority_content_digest}
                  entries (§10.4), same revocation
Governed edges    target boundary : invariant U — at most one governed outgoing edge per
                  predecessor, held by the store on key T(F) (§6.6), independent of any
                  admission input, clock, or caller (round-6 R6-1)
Context transfers authority boundary: from_subject AND to_subject inside digest(M) / applies_to;
                  an obligation moves only where an authority named both ends (§4.1, round-6 R6-2)
Cleared edges     graph boundary : an immutable completed transition; path-scoped (§6.3);
                  reversible only forward, by I4 re-raise supersession
Writer            identity boundary (round-9 R9-1): producer_ref is the permanent invariant-P
generations       constant; only the workload credential rotates. Revocation by POLICY_ACTIVATE
                  bounds FUTURE sealing (no dispatch can authenticate) and touches no sealed
                  envelope — governed_transition reads kernel-stamped facts only (§6.2), so a
                  completed edge survives every rotation/retirement; a wrongly sealed edge is
                  corrected forward by I4 re-raise, never by registry re-evaluation. Uniqueness
                  keys carry the constant, so invariant U spans all generations (§6.6)
Resolving         predecessor boundary: a descendant resolves the ONE predecessor its authority
descendants       named and no other — `sole_predecessor` over the sealed envelope's own
                  supersedes list (I6, §6.3, round-7 R7-1)
```

"Later" reuse is impossible not because a clock says so but because any later consumer either
presents the same immutable completed edge (idempotent, no new privilege) or needs a different
edge — which requires a new admission and, for the Human family, a new decision by the unchanged
kernel rule. Stated exactly (round-8 cross-check, §0.5): the landed `EVIDENCE_MAX_AGE` constraint
vocabulary exists, but the reference registry deliberately declares `produced_at_source: NONE`
for Human decisions (`referencePolicy.ts` producer table), so an
`EVIDENCE_MAX_AGE(HUMAN_DECISION, s)` constraint is satisfiable only in a deployment that ALSO
registers an authoritative source time for its Human surface — a deployment choice outside this
design, on which nothing here relies; every load-bearing boundary above is non-temporal. This
satisfies Review S3: Findings, subjects, descendants,
runs, and time are each closed by an exact content/kernel/policy/graph boundary.

## 9. Spec conformance analysis — why SPEC_CHANGE = NO

- **§5.3 / §5.2 / §2 (round-4 R1):** every `HUMAN_DECISION` in this design is scoped to exactly
  one `effect_id`, satisfies path A, and is presented only in admissions of that effect.
  `GIT_PUSH`, `PR_CREATE`, `PR_MERGE`, `WORK_START` admissions contain **no** transition
  Human decision; `PR_MERGE` keeps its own separate effect-scoped decision (landed, unchanged).
  The different-effect sentence is satisfied literally; nothing is recast as "graph evidence".
  The round-3 escalation trigger (a Spec question about multi-admission presentation) is
  withdrawn because no artifact needs multi-admission presentation.
- **K1–K7:** untouched — no record kind, no field, no API shape, no recheck (rechecks #5 and #14
  apply as landed; #14 is vacuous for a no-mutable-subject `NONE`-precondition operation). The
  new adapter operation uses landed K3–K7 mechanics and the landed `submit_evidence` signature;
  the ingress delta is the §5.3 registry-opted replay + edge-uniqueness rules, the landed
  WORK_STEP replay pattern applied to two keys, with its declared K3-conformant idempotency key
  (§5.1 — round-8 R8-1). The `GOVERNED_SEAL_CONFLICT` value (§5.4) extends a TD-owned closed
  enum inside `cadp.incident.v1` claim values — a declared protected TD §2.6 delta, not a
  K-record shape change; the §3.2 indexes are store implementation of the §5.3 rules. K2
  immutability is strengthened, never relaxed: the rules can
  only refuse or converge a write, never mutate or delete a sealed envelope, so invariant U (§6.6)
  adds no new mutation surface.
- **§5.1 gate / §2.2:** the clearing artifact is created by steps 5–7 of the constitutional
  gate, not by workflow success or adapter assertion; later consumption trusts kernel-stamped
  provenance exactly as all evidence consumption does (E-symmetric, §6.2). Prior *validation* is
  still not a lease: every admission recomputes the barrier over presented envelopes; what
  persists is a *record*, which is what Spec §2.5 says persists.
- **§11 / TD §15:** ImprovementFinding semantics stay product territory; the TD delta is
  confined to the adapter table (§6.4), the producer table (§9.2), and one ingress replay rule
  (§9.1) — all explicitly TD-owned implementation-contract surfaces.
- **Residual honesty:** a G sealed under an earlier, weaker active policy would be trusted by
  its producer stamp. This is the generic in-flight/policy-history property of every landed fact
  (Spec §9.3), bounded here because policy content is Human-gated from genesis and the writer
  *credential* is registry-revocable — prospectively only (invariant P, §5.2/round-9 R9-1: the
  producer identity is a permanent contract constant, and revocation never re-evaluates sealed
  history); a wrongly sealed G is correctable forward by I4 re-raise. Recorded as a property,
  not a gap.

## 10. Product contract delta — `cadp.improvement-intake.v1` → v1.1 (bounded)

1. **§3 clearing rules replaced** by §6.2–§6.6: governed transition sealing is the only
   boundary-crossing path with clearing power; edge/path-scoped barrier with typed delegation;
   `supersedes`/`finding_tip_ref` matching is id+digest everywhere (id-only matching is a
   defect). #98 §3 clause 1's "its exact basis binds the Human/Design decision" is
   **superseded**: the authorization binds the transition via `{effect_id, material_digest}`
   before sealing; the descendant's basis carries the motivating observations; role strings
   remain metadata, never authority. MODEL_PROPOSAL can never clear (unchanged and now
   structurally unsealable through the gate). Invariant U (§6.6) is part of the contract: a
   predecessor has at most one governed successor, target-enforced. Invariant I6 (§7, round-7
   R7-1) is the dual and is likewise part of the contract: a resolving descendant has exactly one
   predecessor — `supersedes` matching is EQUALITY-to-a-singleton in every barrier rule, never
   containment (the landed `some s in supersedes` shape — referencePolicy.ts:337/:346 at the
   1b051f2 basis, exact-digest-resolved per #109 but still containment — is a defect
   in this respect and is replaced, not extended).
2. **§4 supersession** gains invariants I1–I6 (§7), the two typed delegation forms (§6.3), and
   the `SUBJECT_TRANSFER` governed family (§4.1). Ordinary intake supersession keeps its landed
   semantics exactly, minus the delegation power it never earned (round-6 R6-2).
3. **Intake producer scope:** the registered intake adapter remains the producer of ordinary
   Findings, corrections (I2(a)), re-raises (I4), and resolutions; boundary-crossing or
   subject-changing descendants it seals are non-clearing, non-delegating proposals (FC3, FC16b).
   The governed writer (§5.2) is the sole producer of clearing- or delegation-capable descendants.
4. **§9 AUTHORITY_RESOLUTION (round-4 R4, round-5 R5-3):** `landed_authority_ref` becomes the
   typed `{ authority_content_digest }` — the exact digest of landed Spec/TD/product-authority
   content. The Human-decision variant is **removed**. Bare-digest membership is also removed
   (round-5 R5-3: an untyped digest set let any intake-produced resolution clear ANY CONTRACT_*
   tip — ambient standing authority). The active policy content instead carries
   **applicability-bearing entries** (default empty; Human-gated policy content like every
   registry):

   ```text
   data.cadp.landed_authority_resolutions[] = {
     finding_ref             : { evidence_id, envelope_digest }   (exactly ONE CONTRACT_* tip)
     authority_content_digest: digest of the landed content that answers THAT finding's question
   }

   valid_authority_resolution(C) iff some resolution R and some entry e with
     R PRESENT, produced by the registered intake producer
     R.claim.resolution_kind == AUTHORITY_RESOLUTION
     R.claim.finding_tip_ref == { C.evidence_id, C.envelope_digest }      (digest required)
     e.finding_ref           == { C.evidence_id, C.envelope_digest }      (exact, both fields)
     R.claim.landed_authority_ref.authority_content_digest == e.authority_content_digest
   ```

   Each entry binds one landed content to exactly one finding tip — the Human who lands the
   authority change states, in the same Human-gated `POLICY_ACTIVATE`, *which* contract
   question it answers. Any number of resolutions may still be sealed, but they are idempotent
   restatements of that one binding (no new privilege); resolving any **other** finding —
   another subject, classification, descendant, or question — requires its own Human-landed
   entry, so no ambient authority exists (FC12). Supersession detaches automatically: a
   corrected tip has a new digest, matches no existing entry, and needs a fresh entry for its
   own exact identity. The preserved Human route is exact and non-standing: protected merge of
   the authority text, then Human-gated `POLICY_ACTIVATE` that activates any rule changes and
   admits the `{finding_ref, authority_content_digest}` entry; revocation is removal of the
   entry. The class partition and the other #98 §9 normative rules are unchanged (E4).
5. Everything else in #98 — occurrence identity, conflict rules, Option-A index-only projection,
   containment table (§8, now with FINDING_SEAL as the second enumerated exception),
   resolution partition, restart rules — retained verbatim (E4).
   Multi-superseding descendants (duplicate merges) keep their landed intake semantics and gain
   an explicit statement: they resolve nothing (I6). This is a v1.1 tightening of the landed
   containment match, not a new capability.
6. Reference reason codes added: `transition_unauthorized{predecessor_ref, material_digest}`
   (rendered by the SSO surface), `transition_subject_mismatch`, `transition_shape_invalid`,
   `transition_kind_invalid`, `transition_derivation_forbidden`, `reclassification_ambiguous`,
   `finding_unresolvable`; and the target-side `GOVERNED_SEAL_CONFLICT` ingress rejection +
   incident (§5.3/§5.4 — a declared TD §2.6 incident kind), which is a kernel-service reason
   code, not a policy one.

## 11. D5 — The positive S4 path, end to end (expressible after landing)

```text
 1. F (CONTRACT_GAP tip) exists; barrier up; all non-index mutations DENY (landed, unchanged).
 2. A diagnosis run/surface produces diagnostic evidence and composes M: transition_kind =
    RECLASSIFICATION, predecessor_ref = {F.id, F.digest}, from CONTRACT_GAP → to
    IMPLEMENTATION_GAP, from_subject == to_subject == F's exact subject (I1), descendant_draft
    with that subject, derivation {HUMAN_JUDGMENT, judgment-surface method, run R},
    basis = diagnostic envelopes, supersedes == [F] exactly (I6), correction_reason.
    allocate_effect_id →
    idempotency_key = cadp-v04:<effect_id> into M (§4) → put_blob(M) → seal EffectRequestV1 E
    (operation_kind FINDING_SEAL, material_digest = digest(M); the landed seal path verifies the
    key).
 3. assemble K4 (F + diagnostics; no H) → evaluate → REQUIRE_EVIDENCE(HUMAN_DECISION,
    transition_unauthorized{F, digest(M)}).
 4. SSO path A (landed, verbatim): surface renders E's effect_id + request_digest + every field
    of M → Human APPROVEs → H sealed with scope {effect_id: E, target_ref, material_digest =
    digest(M)}, presented_request_digest verified, issued_at > requested_at.
 5. new K4 (F, diagnostics, H) → evaluate → ALLOW → admitAndDispatch(E): PEP rechecks #1–#17
    UNCHANGED (#5: H scoped to E, referenced only by E's admissions — satisfied trivially and
    forever; #14: vacuous — dispatch_precondition NONE, no mutable target subject, §5.1) → K6 →
    dispatch: adapter validates the draft, submit_evidence as governed:reclassification with
    source_ref = cadp-v04:<E> (NATIVE_KEY, §5.3 rule (a): a retry converges at the ingress to
    the same envelope; and the store's edge rule (b) holds invariant U on T(F) — a different
    draft for F is refused for all time, §5.3/§6.6) → G sealed byte-exactly from
    descendant_draft → K7 COMMITTED with receipt {G.evidence_id, G.envelope_digest}.
    No PEP weakening, no invented claim schema — S4 proven on the real path.
 6. Implementation WORK_START W bound to tip G (work_bindings = exact G id+digest): admission
    presents F and G (no H anywhere): clearing_edge(F, G) holds (G.supersedes == [F] exactly —
    sole_predecessor, I6 — class change, subject preserved, governed producer) → barrier down
    for this path → landed
    intake_workstart_ok gates apply unchanged → ALLOW.
 7. In-run effects (GIT_PUSH → PR_CREATE → PR_MERGE with its own separate effect-scoped Human
    decision): each admission presents F and G and recomputes the barrier honestly from
    presented evidence (E1/E3; #98 §10). Deterministic S3-permitted clearings run steps 2–5 with
    the rule + the applies_to-bearing AUTHORITY_TEXT observation of §6.5 (bound to F, both
    subjects, method, kind, and — where the rule is run-scoped — the run) instead of H, and no
    Human step.
```

**Variant: the mis-subjected finding (round-6 R6-2), same machinery, two governed steps.**

```text
 2'. C_old (CONTRACT_GAP, subject S1 — wrong file/module) is the tip; barrier up.
 3'. Compose M₁: transition_kind = SUBJECT_TRANSFER, predecessor_ref = {C_old.id, C_old.digest},
     from = to = CONTRACT_GAP, from_subject = S1, to_subject = S2, descendant_draft = C_new
     (CONTRACT_GAP on S2, supersedes == [C_old] exactly, correction_reason). Seal E₁ → the surface
     renders
     "C_old : S1 → S2, classification unchanged" → H₁ APPROVE → admit → dispatch (edge key
     T(C_old), §5.3 rule (b)) → C_new sealed. C_old's obligation now legitimately rests on C_new,
     because H₁ named C_old, S1 and S2 (§6.3 delegation form (b)).
 4'. Steps 2–5 above on C_new (RECLASSIFICATION, subject S2 preserved) → G. Its edge key is
     T(C_new), a different key, so invariant U is untouched.
 5'. WORK_START on tip G: chain G →s C_new →s C_old — entry (C_new, G) clearing_edge, entry
     (C_old, C_new) CONTEXT_TRANSFER delegation_edge → barrier down (FC8a/FC16a).
     Had step 3' been an ordinary intake correction instead, entry (C_old, C_new) would be
     unresolved and the barrier would stand — no authority for S2 ever discharges S1 (FC16b).
```

## 12. Falsification controls (all load-bearing; guard-bite required)

| ID | Control | Expected |
|---|---|---|
| FC1 | H with `decision ∈ {REJECT, STOP, EXCEPTION_ACCEPT, unknown}`, valid scope otherwise | E stays REQUIRE_EVIDENCE/DENY; nothing seals; barrier stays |
| FC2 | H scoped to a different effect_id; H with `material_digest ≠ digest(M)`; H issued before E was sealed | policy unsatisfied and/or landed ingress/recheck-#5 refusal in every case |
| FC3 | intake-sealed boundary-crossing descendant (round-3 F1 shape and the landed `reclassified_clear` HUMAN_JUDGMENT shape) presented at later admissions | `governed_transition` fails → clears nothing; barrier stays |
| FC4 | M with exactly one load-bearing field wrong, one control per field: predecessor digest, from, to (CONTRACT_* member), from_subject ≠ F's subject, to_subject ≠ draft's subject, any subject tuple member, supersedes omitting predecessor_ref, supersedes carrying a second entry alongside predecessor_ref (I6), classification ≠ to_classification, missing correction_reason, forged occurrence_key, absent/unknown `transition_kind`, RECLASSIFICATION with to ∈ CONTRACT_*, SUBJECT_TRANSFER with to ≠ from classification, SUBJECT_TRANSFER with to_subject == from_subject | FINDING_SEAL DENY in every case (`transition_shape_invalid` / `transition_kind_invalid` / `transition_subject_mismatch` as applicable) |
| FC5 | non-PEP principal attempts `submit_evidence` as `governed:reclassification`; ordinary adapter submits a claim mimicking a governed transition | ingress identity rejection; wrong `producer_ref` → no clear |
| FC6 | second FINDING_SEAL for the same F with a first governed descendant presented; two governed descendants of one C presented downstream (a synthetic graph, since §6.6 makes the second envelope unconstructible) | DENY `reclassification_ambiguous` at seal; no clearing_edge of C valid downstream — fail closed. Reported as defence-in-depth, with FC15 as the load-bearing control |
| FC7 | double dispatch of one admitted E (crash/retry) — the §6.2/§13.3 double-dispatch test for the declared NATIVE_KEY, whose key is the effect-bound `cadp-v04:<effect_id>` (round-8 R8-1) | §5.3 rule (a) converges to the existing envelope → idempotent COMMITTED; exactly one G exists; guard-bite: with rule (a) removed, the retry falls through to rule (b) and still converges (identical payload) — so the guard-bite for the NATIVE_KEY declaration is removing BOTH rules, upon which a second envelope appears (declaration demoted to NONE); removing rule (a) alone is reported as measured redundancy for the retry case, not as an unused control (rule (a) is load-bearing for the conflict polarity: it converges/refuses on the effect key BEFORE the edge key can misattribute) |
| FC8 | full chain (round-4 R2 + round-6 R6-2): (a) positive `C_old ←s C_new(governed SUBJECT_TRANSFER) ←s G(governed RECLASSIFICATION)` → tips through G clear; (b) sibling tip through C_old not via C_new → barrier stays; (c) guard-bite: remove delegation_edge entirely → (a)'s barrier becomes permanent (reproduces R2); (d) one-step cross with subject change (I3) → DENY + no clear; (e) same-subject intake restatement chain `C_old ←s C_new(S1, intake) ←s G(governed)` → clears via delegation form (a) — the control that proves form (a) is still needed |
| FC9 | deterministic (round-4 R3, round-5 R5-2): (a) rule match but F/A unresolved in evidence → DENY; (b) second FINDING_SEAL for a context A does not name → DENY at that admission (subsumed by f); (c) rule removed by POLICY_ACTIVATE → next seal DENY, prior G unaffected; (d) self-declared AUTHORITY_TEXT role over ordinary envelope (B18) / wrong authority or method digest → DENY; (e) landed `reclassified_clear` deterministic shape → clears nothing (regression); (f) cross-context observation reuse — same A presented with a different predecessor (id or digest), different from_subject, different to_subject, different transition_kind, or different method → `authority_applicable` fails → DENY; same A with a second, different descendant draft for the same F → the seal cannot produce an envelope (FC15, the round-6 R6-1 control); (g) after F's edge is cleared, or after I4 re-raise creates C₂: the same A presented for any new transition (incl. one naming C₂) → DENY (predecessor id+digest mismatch — one observation, at most one edge, ever); (h) A whose claim lacks `applies_to` (free-floating authority text), or with any `applies_to` field absent → DENY; (i) run-scoped rule with A bound to run R₁ presented at an E bound to run R₂ → DENY; non-run-scoped rule with a work_run_ref present → DENY (exact-shape rule) |
| FC10 | positive S4 path of §11 through the real `admitAndDispatch` with target-authoritative K7 | E COMMITTED; W ALLOW; in-run GIT_PUSH admissible; unresolved-barrier PR_MERGE / POLICY_ACTIVATE remain DENY until cleared |
| FC11 | authorization-shaped text in any `statement` field; no valid H/rule | never read; no clear (grep-level guard: policy references no statement field) |
| FC12 | AUTHORITY_RESOLUTION (round-4 R4, round-5 R5-3): (a) no entry whose `finding_ref` equals the tip's exact id+digest (incl. id-match-only and digest-match-only); (b) entry exists for tip C₁ but the resolution targets a different CONTRACT_* tip C₂ with the same `authority_content_digest` (cross-finding reuse of a landed digest); (c) entry's digest ≠ resolution's `landed_authority_ref` digest; (d) entry later removed by POLICY_ACTIVATE; (e) `landed_authority_ref` shaped as a decision-envelope ref; (f) superseded tip: entry bound to old digest, resolution names corrected tip | no clear in every case; (b) is the ambient-authority control; (d) proves the policy-content boundary; positive control: entry + matching resolution → clears, and a second resolution of the SAME tip under the same entry is an idempotent restatement (no new privilege) |
| FC13 | unresolvable ancestor (absent envelope or digest mismatch anywhere in reach(tip)) | fail closed (landed behavior retained) |
| FC14 | guard-bite meta-control: individually remove each new predicate — digest matching in supersedes/tip refs, `sole_predecessor` (§6.3, in each of the three resolved-entry forms) and the §6.4 singleton shape rule, producer/integrity checks, I1 equality, each §6.4 per-kind rule, ambiguity rule, each delegation form, each `authority_applicable` element (§6.5), each `valid_authority_resolution` conjunct incl. entry `finding_ref` equality (§10.4), §5.3 rule (a), §5.3 rule (b) incl. its shape guard, the §5.4 scope-hold bindings | the corresponding exploit reproduces (delta 1); a control whose removal changes nothing is reported as defence-in-depth (FC6 is expected to land there after FC15; FC7 documents the measured redundancy of rule (a) for the retry case) |
| FC15 | **round-6 R6-1, the omission attack, load-bearing.** Seal G₁ from F (deterministic route, observation A). Then assemble a SECOND FINDING_SEAL for the same F with a different descendant draft (different basis/run/class-target), presenting the same A and deliberately **omitting G₁ from `input.evidence`** so the §6.4 conflict rule cannot see it. Run it through the real `admitAndDispatch`. Repeat with the Human route (a fresh H on the second effect) and with a different work run and a different principal | the admission may reach ALLOW (policy is blind by construction — that is the point of the control), and the **dispatch is refused at the store** by §5.3 rule (b): `GOVERNED_SEAL_CONFLICT` incident sealed with the exact §5.4 subject bindings, no second governed envelope whose supersedes names F exists, store count for edge T(F) == 1, effect resolves `NO_EFFECT_CONFIRMED(governed_seal_conflict)` via the `REJECTED_NO_EFFECT` proof. **Scope-hold bite (R8-2):** a third FINDING_SEAL effect naming F in `work_bindings` is refused admission while the incident stands, and admissible again only after a root-signed BREAK_GLASS whose `release_incident_refs` names it; ordinary admissions merely presenting F as evidence are NOT held. Downstream, no graph containing two governed descendants of F is constructible. Guard-bite: remove the §5.3 rule-(b) branch → the second envelope appears and each branch clears separately (reproduces R6-1 exactly) |
| FC18 | **round-8 R8-1, the separated-keys control.** (a) two admitted effects E₁ ≠ E₂ dispatch byte-identical drafts for the same F (legitimate cross-effect restatement); (b) a dispatch forged with `source_ref` ≠ the material's `idempotency_key` (adapter conformance); (c) a draft for this producer whose `supersedes` has two entries or zero entries reaches `submit_evidence` directly (bypassing §6.4 — e.g. a compromised workflow composing its own dispatch through the writer credential is out of reach by FC5, so this is exercised via the adapter conformance suite with a synthetic ingress call) | (a) rule (a) finds no envelope for E₂'s key, rule (b) converges on the identical payload → ONE envelope, store count for T(F) == 1, both effects COMMITTED with the same receipt, no incident, no new privilege; (b) refused pre-dispatch by the adapter (§5.1) — never reaches the target; (c) rejected outright by the rule-(b) shape guard — the edge key cannot even be derived; guard-bite: with the shape guard removed, (c) still cannot clear downstream (`sole_predecessor` fails, FC17b) — reported as the intended defence-in-depth layering |
| FC16 | **round-6 R6-2, context transfer.** (a) positive: governed SUBJECT_TRANSFER `C_old/S1 → C_new/S2` with H₁ rendering both subjects → delegation holds → the §11 variant chain clears; (b) the R6-2 exploit: ordinary intake subject-changing correction `C_old/S1 → C_new/S2`, then a fully valid governed clearing of `C_new/S2` → **C_old's barrier still stands** for every tip through it (authority for S2 never discharges S1); (c) SUBJECT_TRANSFER material with `to_subject` ≠ the descendant draft's primary subject, or `from_subject` ≠ F's → DENY; (d) SUBJECT_TRANSFER that also changes classification (transfer + clear in one step) → DENY `transition_shape_invalid`; (e) deterministic transfer whose observation's `applies_to.to_subject` names S3 while the draft moves to S2 → DENY; (f) H issued for a transfer `S1→S2` re-presented for a transfer `S1→S3` (new material, new effect) → recheck #5 / material_digest mismatch → refused | as stated; (b) is the finding's exact scenario and must fail closed; guard-bite: restore the round-5 rule (any intra-CONTRACT supersession delegates) → (b) clears, reproducing R6-2 |
| FC19 | **round-9 R9-1, writer-generation stability, load-bearing.** (a) revoke-after-clear: seal a governed clearing edge G for F (either family), then `POLICY_ACTIVATE` a bundle that unbinds the writer credential (and a second variant that also removes the adapter-registry row); re-run every later admission of the §11 chain through the real PEP; (b) successor-generation second seal: bind a NEW credential to the constant producer_ref, then attempt a `FINDING_SEAL` for the already-served F with a different descendant draft, omitting G from `input.evidence` (the FC15 shape, now across generations); (c) reserved-constant attempt: a policy bundle registering `governed_edge: SUPERSEDES_SINGLETON` for `IMPROVEMENT_FINDING` under producer_ref `governed:reclassification2`, and a synthetic envelope carrying that producer_ref presented downstream | (a) `governed_transition(G)` still holds and every tip through G still clears — the predicate reads only G's kernel-stamped `producer_ref`/`integrity`, never the active registry; guard-bite: reintroduce the active-registry lookup into `governed_transition` → the cleared edge goes dark after revocation, reproducing R9-1(i) exactly; (b) refused at the store on the SAME occupied key T(F) — `GOVERNED_SEAL_CONFLICT`, store count for T(F) == 1: a new generation gains no fresh edge namespace (guard-bite: key the §3.2 indexes on the credential instead of the constant → (b) seals a second edge, reproducing R9-1(ii)); (c) `POLICY_ACTIVATE` DENY (registry conformance, §5.2 rule 2), and the synthetic envelope clears and delegates nothing (§6.2 constant mismatch — the FC5 no-clear polarity, proving the conformance rule is defence-in-depth, not the sole barrier) |
| FC17 | **round-7 R7-1, the multi-predecessor attack, load-bearing.** (a) the exploit: two distinct CONTRACT_GAP findings F₁ and F₂ sharing one normalized primary subject; obtain a fully valid authorization for F₁ ONLY (H scoped to E over M with `predecessor_ref = F₁`, or a deterministic A whose `applies_to` names F₁); build the descendant draft with `supersedes = [F₁, F₂]`; (b) the same multi-predecessor shape reaching a later admission by any route (an intake-produced descendant listing both, or a synthetic envelope standing in for a pre-I6 artifact); (c) transfer variant: governed SUBJECT_TRANSFER material naming C_old with a draft superseding C_old and C_other; (d) merge-then-clear: intake merge `[C₁, C₂] → C₃`, then a fully valid governed clearing of C₃; (e) positive/no-regression: singleton `supersedes = [F₁]` | (a) seal DENIES `transition_shape_invalid` (§6.4 singleton rule) — the governed multi-predecessor artifact is unconstructible; (b) `sole_predecessor` fails for F₁ **and** for F₂ → no clearing_edge, no delegation, both barriers stand (this is the load-bearing control: it does not depend on the seal-time check); (c) DENY at seal, and no delegation downstream for either predecessor; (d) C₁ and C₂ barriers still stand for every tip through them — one authorization never answers two contract questions; (e) clears exactly as §11. Guard-bite: restore containment matching in `sole_predecessor` → (b) and (d) clear, reproducing R7-1 exactly; restore it in §6.4 only → (a) seals and then (b) clears |

## 13. Preserved paths and non-goals

Preserved exactly (E4): MODEL_PROPOSAL never clears; AUTHORITY_RESOLUTION partition and
routing (Human route documented in §10.4); Option-A index-only behavior; occurrence /
supersession / conflict / current-tip rules; existing effect-scoped Human approvals (C18/C24 —
recheck #5 and §9.3 are the landed text, untouched); exact `evidence_id + envelope_digest`
basis resolution; no self-declared `AUTHORITY_TEXT` authority; clock-free evaluation; ordinary
intake sealing for everything that neither crosses the boundary outward nor moves a context —
including subject-correcting supersession, which stays legal at intake and simply carries no
delegation power (round-6 R6-2), and multi-predecessor merge supersession, which stays legal at
intake and simply resolves nothing (round-7 R7-1, I6).

Non-goals honored: no #107 implementation here; no #109 ancestry-completeness changes (#109 has
now landed at the frozen basis — exact-digest `supersedes` resolution and fail-closed omitted
ancestry; the barrier consumes that completeness as-is, and the fail-closed unresolvable-
ancestor rule is retained); no #106 observer/reconcile changes; no RBAC framework; no admission
clock; no automatic Human approval; no free-text authority; no production deployment.

## 14. Acceptance mapping (#117)

| # | Requirement | Where |
|---|---|---|
| 1 | SPEC_CHANGE / TD_CHANGE classified | header block, §5, §9 |
| 2 | exact Human transition-authorization representation **or proof no new representation is needed** | §4, §4.1 (landed decision suffices for both families; the typed artifact is the K3 material) |
| 3 | exact non-circular applicability/context binding | §6.1–§6.2, §6.5 (`authority_applicable`), §6.6 (invariant U + why descendant-binding is the circular option), §6.3 (`sole_predecessor` — the authorized predecessor is the only one resolved), §10.4 (per-finding entries) |
| 4 | supersession subject/work-run invariants | §7 (I1–I6), §4.1 (typed context transfer), §6.3 (two delegation forms) |
| 5 | validity/reuse compatible with clock-free admission | §8 (incl. the target and context-transfer boundaries) |
| 6 | polarity: only explicit authorization clears | §4 rule 1, §6.4, FC1 |
| 7 | exact id+digest basis resolution; no self-declared AUTHORITY_TEXT | §6.3–§6.5, §10, FC9/FC13 |
| 8 | falsification controls incl. cross-run/subject/descendant reuse and invalid Human paths | §12, notably FC15 (descendant/evidence-omission reuse + scope-hold/release), FC16 (cross-subject), FC17 (cross-predecessor reuse of one authorization), FC18 (separated replay/edge keys), FC19 (writer-generation stability of cleared edges and edge uniqueness) |
| 9 | real-PEP positive S4 path expressible | §11 |
| 10 | DESIGN_DISPOSITION / NEXT_OWNER | header block, §15 |

## 15. Disposition and routing

```text
DESIGN_DISPOSITION   TD_DESIGN_READY
NEXT_OWNER           Control — scope/authority check. The §0.4 provenance question is CLOSED:
                     the round-7 review findings were recovered from the devharness lane state,
                     measured against 8017bf0 (their line references match it exactly), and are
                     answered as R8-1/R8-2 (§0.5); nothing else was in the findings array.
THEN                 Independent Design Review (fresh, against this exact head)
THEN                 Human merge — the §5 TD delta (§6.4/§9.2/§9.1/§3.2/§2.6) and the v1.1
                     authority semantics are protected authority changes. NOTE: the earlier
                     merge of PR #118 (the second lane's from-scratch artifact) was made in
                     error, was reverted by recovery PR #124, and carries no authority; this
                     candidate supersedes both prior lanes' artifacts (§0.5).
THEN                 #107 Execution refresh/rebase/re-admit against the landed contract
                     (round-2 mechanics at 01b913a remain measured evidence; the implementation
                     base must be re-derived from this contract — notably the landed
                     reclassified_clear predicate is replaced, not extended)
ESCALATION           none pending — the round-3 SPEC_GAP trigger is withdrawn (§0 R1, §9), and
                     the round-7 NATIVE_KEY Spec question is resolved conformantly (R8-1: the
                     declared idempotency key is now the effect-bound landed §6.2 value);
                     SPEC_GAP_CONFIRMED remains the routing if Review measures a new Spec
                     conflict in this candidate
HOLDS UNTIL LANDED   exec-i107 held; PR #115 not merge-admitted
```
