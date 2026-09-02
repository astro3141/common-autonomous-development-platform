# Common Autonomous Development Platform — Specification v0.4

| Field | Value |
|---|---|
| Status | **SPECIFICATION CANDIDATE while unmerged; SPECIFICATION BASELINE upon Human-approved canonical merge** |
| Candidate base | `391126b0337ee80d246f5b820657405d511fc05b` |
| Source evidence | #89 `issuecomment-5507827981`, #90 `issuecomment-5508002386`, #91 `issuecomment-5508009180` |
| Intended succession | Human이 이 candidate를 승인하고 canonical branch에 merge한 때부터 v0.3을 supersede한다. 그 전까지 authority는 v0.3과 current TD v1.5에 있다. |
| Scope | 장기 constitutional architecture, trust boundary, exact binding, external-effect admission, evidence/recovery semantics 및 autonomous-work product outcome conformance |
| Non-scope | Technical Design, 구현 언어, 데이터베이스, policy engine 또는 workflow 제품 선택, production implementation |

이 Specification은 기존 autonomous-development Core를 축소 복제하지 않는다.

목표는 domain workflow를 소유하는 새 framework가 아니라, commodity policy/workflow/agent/review/backend 조합이 외부 effect를 일으킬 때 반드시 지켜야 하는 최소 constitutional contract를 정의하는 것이다.

이 Specification은 두 conformance layer를 함께 정의한다.

```text
Constitutional Kernel Conformance
= K1–K7 policy/effect/evidence safety and authority semantics

CADP Autonomous-Work Product Conformance
= Constitutional Kernel Conformance
+ commodity-backed durable autonomous continuation outcome
```

안전하게 effect를 gate하지만 Human이 ordinary message, identity, state, receipt와 next-step data를 계속 relay해야 하는 gateway는 Constitutional Kernel에 conform할 수 있다. 그러나 CADP autonomous-work product라고 claim할 수는 없다.

---

## 1. 목적

Common Autonomous Development Platform v0.4는 autonomous work를 위한 policy-first control plane이다.

Platform은 다음을 보장한다.

1. policy decision이 exact observed input, exact evidence, exact requested effect에 bind된다.
2. policy의 `ALLOW`만으로 외부 effect 권한이 생기지 않는다.
3. governed effect를 수행할 credential 또는 동등한 mutation reach는 enforcing boundary 밖의 worker에게 주어지지 않는다.
4. non-trivial external effect마다 호출 전에 stable effect identity와 durable admission record가 존재한다.
5. ambiguous effect는 target-authoritative reconciliation 없이 retry 가능한 실패로 바뀌지 않는다.
6. evidence는 이름표가 아니라 실제 subject identity, producer, provenance, freshness 및 integrity에 bind된다.
7. backend가 보고하지 않은 requested value는 observed fact로 합성되지 않는다.
8. workflow, agent, verifier, reviewer, repository 또는 domain backend를 바꾸어도 위 경계는 유지된다.

Platform은 software development 전용 architecture가 아니다.

Development example:

```text
GitHub Issue
→ policy-governed worker
→ exact candidate
→ verification/review evidence
→ gated pull-request effect
→ Human merge evidence when policy requires
```

Non-development example:

```text
authoritative business input
→ policy-governed API/worker action
→ exact external effect
→ evidence and target reconciliation
→ Human exception evidence when policy requires
```

두 example은 같은 constitutional semantics를 사용한다. Issue, branch, PR, coding agent, Supervisor, Actor, Auditor는 Core primitive가 아니다.

---

## 2. 최상위 불변조건

### 2.1 Proposal과 authority

Model, agent, workflow, reviewer, Human 또는 다른 producer의 output은 그 자체로 external-effect authority가 아니다.

```text
Untrusted or bounded producer requests.
Policy evaluates.
Enforcement Point admits.
Narrow capability performs.
Authoritative source reconciles.
```

Human decision도 policy가 요구하는 attributable evidence다. Human identity라는 이유만으로 unrelated effect에 재사용되거나 enforcement point를 우회하지 않는다. 단, deployment의 genesis trust anchor와 명시적 break-glass authority는 §9의 bootstrap rule을 따른다.

### 2.2 Policy와 enforcement

Policy language와 evaluator는 decision computation을 소유할 수 있다. 그러나:

```text
policy ALLOW
≠ external effect authority
```

실제 external effect는 Policy Enforcement Point(이하 PEP)가 exact decision/effect binding을 fresh하게 검증하고 bounded capability를 release하거나 직접 사용한 경우에만 허용된다.

### 2.3 Credential reach

Governed effect를 만들 수 있는 standing credential, token, session 또는 alternate mutation path는 worker, model, reviewer, verifier, workflow payload에 존재해서는 안 된다.

배포가 이 exclusive reach를 증명할 수 없으면 해당 effect의 enforced admission을 주장할 수 없으며, enforcement를 요구하는 policy는 fail closed한다. Prompt instruction, role label, sandbox name 또는 worker self-report는 credential isolation 증거가 아니다.

### 2.4 Exact binding

다음은 추론이나 display label이 아니라 immutable identity와 digest로 bind되어야 한다.

- effective policy identity, revision, content
- observed work/input identity와 mutable revision 또는 content digest
- requested effect target, operation kind, material parameters
- policy가 요구한 evidence identity, subject, producer, provenance, integrity, freshness
- policy가 요구한 Human 또는 machine decision provenance와 scope
- backend가 실제 보고한 execution/observation identity와 availability

Mutable subject에 required revision/digest가 없으면 그 subject는 exact 또는 fresh하다고 주장할 수 없다.

### 2.5 Fail closed

Required fact가 missing, stale, contradictory, unverifiable 또는 `UNKNOWN`이면 evaluator와 PEP는 해당 requirement를 만족한 것으로 처리하지 않는다.

Policy는 낮은-risk effect에 어떤 provenance 또는 `UNKNOWN`을 허용할지 명시할 수 있다. 그러나 Platform은 unavailable fact를 observed value로 승격하거나 assurance를 조작하여 policy를 통과시키지 않는다.

### 2.6 Durable facts, not conversations

Conversation, prompt history, process memory 및 workflow-local transient state는 constitutional authority가 아니다.

Policy decision, effect admission, evidence reference 및 effect outcome은 restart 후 같은 meaning으로 검증 가능한 durable record여야 한다.

### 2.7 No silent substitution

Policy, work revision, effect material, target, evidence, reviewer, Human decision 또는 backend observation이 바뀌면 기존 decision/admission을 silent하게 재사용하지 않는다. 새 material input은 새 evaluation을 요구한다.

---

## 3. Constitutional authority boundary

| Surface | Owns | Does not own |
|---|---|---|
| Constitution authority | immutable policy revision 발행, activation/root trust | individual effect 실행, evidence 사실 합성 |
| Policy evaluator | supplied admission input에 대한 decision computation | credential custody, effect execution, input truth |
| PEP | exact admission 검증, governed credential custody, bounded effect dispatch | domain planning, policy authorship, evidence production |
| Evidence source | 자신이 실제 생산하거나 관측한 claim과 provenance | policy allow, unrelated subject의 truth |
| Effect target / authoritative observer | target-native receipt와 effect reconciliation claim | requested intent, policy decision |
| Workflow / scheduler | ordering, retry request, timers, signals, compensation orchestration | blind retry authority, credential bypass |
| Worker / agent / model | work product, proposed action, requested effect material | policy 변경, permit 발급, governed credential custody |
| Verifier / reviewer | exact subject에 대한 evidence | effect admission, universal PASS authority |
| Human | attributable scoped decision 또는 root operation | implicit wildcard permission, stale decision reuse |

제품은 여러 surface를 한 process에 구현할 수 있다. 그러나 co-location은 authority를 합치지 않으며, 같은 identity가 incompatible duties를 동시에 수행하면 policy가 요구한 independence를 만족하지 못한다.

---

## 4. 최소 constitutional vocabulary

아래 일곱 semantic record가 v0.4 kernel의 exact primitive다. 이는 일곱 service 또는 일곱 database table을 요구하지 않는다. 같은 storage 또는 product 안에 구현할 수 있지만, 필드의 의미와 authority는 합칠 수 없다.

모든 digest는 `{ algorithm, canonicalization, value }`를 포함한다. Canonicalization과 algorithm은 해당 deployment policy가 허용한 versioned scheme이어야 하며, 서로 다른 scheme의 digest를 같은 content identity로 간주하지 않는다.

### K1. `PolicyRefV1`

```text
PolicyRefV1 {
  policy_id
  revision
  content_digest
  issuer_ref
}
```

Rules:

- policy revision은 immutable이다.
- mutable alias만으로 effect를 admit하지 않는다.
- evaluator implementation/version은 decision provenance에 별도로 기록하며 policy identity를 대체하지 않는다.
- policy activation은 §9를 따른다.

### K2. `EvidenceEnvelopeV1`

```text
EvidenceEnvelopeV1 {
  evidence_id
  evidence_kind
  subject_bindings[] {
    authority_ref
    namespace
    object_id
    revision_or_version?
    content_digest?
  }
  availability: PRESENT | UNKNOWN
  claim_schema
  claim?                 # PRESENT일 때만 존재
  claim_digest?          # PRESENT일 때만 존재
  unknown_reason?        # UNKNOWN일 때 필수
  producer_ref
  source_ref
  execution_or_run_ref?
  produced_at
  provenance {
    source_relation: SELF_REPORT | INDEPENDENT_OBSERVATION | TARGET_AUTHORITY_OBSERVATION
    integrity: UNATTESTED | AUTHENTICATED_SOURCE | SIGNED_ATTESTATION
    attestation_ref?
  }
  envelope_digest
}
```

Rules:

- `evidence_kind`는 backend observation, verification, review, Human decision, machine decision 또는 reconciliation claim을 표현할 수 있다.
- claim payload는 domain/backend-native schema를 유지한다. Envelope는 서로 다른 backend claim의 의미를 평탄화하거나 동등하다고 발명하지 않는다.
- requested value는 source가 실제로 emit/attest하지 않은 한 claim에 복사할 수 없다.
- `UNKNOWN`은 값이 없다는 honest observation이다. `claim`과 `claim_digest`는 금지되고 `unknown_reason`과 source provenance는 필수다.
- ordinary lookup miss 또는 unavailable read는 보편적인 absence proof가 아니다. Authoritative source가 명시적 predicate의 absence를 증명했다면 그 proof 자체를 `PRESENT` claim으로 기록한다.
- assurance는 total order 또는 universal trust score가 아니다. Policy는 필요한 `source_relation`, `integrity`, producer independence 및 subject binding을 각각 검사한다.
- review의 candidate identity, reviewer identity, verdict/body integrity와 freshness는 같은 envelope contract로 표현한다. 별도 Auditor authority primitive는 없다.
- Human decision은 `evidence_kind = HUMAN_DECISION`인 envelope로 표현한다. Exact subject/effect scope, attributable producer, issued time, decision body 및 integrity가 필요하다.

### K3. `EffectRequestV1`

```text
EffectRequestV1 {
  effect_id
  requester_ref
  work_bindings[] {
    authority_ref
    namespace
    object_id
    revision_or_version?
    content_digest?
  }
  target_ref {
    authority_ref
    target_type
    target_id
  }
  operation_kind
  material_schema
  material_digest
  material_ref?
  prior_effect_refs[]
  requested_at
  request_digest
}
```

Rules:

- `effect_id`는 non-trivial external call 전에 allocation되는 stable logical-effect identity다.
- `effect_id`는 Platform-controlled effect ingress 또는 PEP가 allocate/reserve한다. Model/worker가 제시한 correlation string은 identity authority가 아니며, accepted request에 사용하려면 Platform이 unique identity로 봉인해야 한다.
- 같은 `effect_id`는 하나의 exact `request_digest`만 가질 수 있다. 다른 bytes/material/target과의 reuse는 conflict이며 effect를 수행하지 않는다.
- target-native idempotency key가 있으면 `effect_id`와 deterministic하게 bind한다. Target-native key가 Platform record를 대체하지 않는다.
- material은 large payload일 수 있으므로 content-addressed reference를 사용할 수 있다. PEP는 dispatch되는 actual bytes가 `material_digest`와 일치함을 검증한다.
- `prior_effect_refs`는 compensation, replacement 또는 unresolved prior effect와의 관계를 숨기지 않기 위한 explicit input이다.

### K4. `AdmissionInputV1`

```text
AdmissionInputV1 {
  policy_ref
  effect_request_ref
  effect_request_digest
  evidence_refs[] { evidence_id, envelope_digest }
  assembled_at
  input_digest
}
```

Rules:

- policy evaluator에 전달된 material input의 complete, canonical binding이다.
- evidence의 display text 또는 mutable URL만 참조해서는 안 된다.
- Human decision, review, verification, backend actual identity 및 target observation은 policy가 요구하는 경우 모두 `evidence_refs`에 들어간다.
- evaluator에 보이지 않은 fact를 PEP가 사후에 정답처럼 채워 넣지 않는다. Material change는 새 `AdmissionInputV1`과 새 evaluation을 요구한다.

### K5. `PolicyDecisionV1`

```text
PolicyDecisionV1 {
  decision_id
  policy_ref
  admission_input_digest
  outcome: ALLOW | DENY | REQUIRE_EVIDENCE
  reason_codes[]
  constraints[]
  evaluator {
    evaluator_ref
    evaluator_version
    integrity_ref
  }
  decided_at
  not_after?
  decision_digest
}
```

Rules:

- decision은 exact `AdmissionInputV1`에만 적용된다.
- `ALLOW`는 permit 또는 credential이 아니다.
- PEP는 selected evaluator와 authenticated local channel 또는 verifiable attestation으로 연결된 `integrity_ref`를 검증한다. Worker가 제출한 decision-shaped document는 evaluator decision이 아니다.
- evaluator error, unknown policy revision 또는 malformed output은 `ALLOW`가 아니다.
- `REQUIRE_EVIDENCE`는 Human/verification/review UI나 pending lifecycle을 정의하지 않는다. Commodity workflow가 필요한 evidence를 수집한 뒤 새 evaluation을 요청할 수 있다.
- constraints는 PEP가 이해하고 enforce할 수 있을 때만 effect admission에 사용한다. Unsupported constraint는 fail closed한다.

### K6. `EffectAdmissionV1`

```text
EffectAdmissionV1 {
  admission_id
  effect_id
  dispatch_ordinal
  prior_admission_ref?
  effect_request_digest
  policy_decision_ref
  policy_decision_digest
  admission_input_digest
  pep_ref
  bounded_capability {
    target_ref
    operation_kind
    material_digest
    single_dispatch: true
    expires_at?
  }
  admitted_at
  admission_digest
}
```

Rules:

- PEP가 current durable facts로 binding, policy validity, evidence freshness, credential reach 및 prior effect state를 commit-time에 다시 검사한 뒤에만 생성한다.
- PEP는 held credential/session의 actual target account, tenant, repository 또는 endpoint가 `target_ref`와 일치함을 증명해야 한다. Caller가 요청한 target text는 actual target proof가 아니다.
- `EffectAdmissionV1`은 external call 또는 mutating credential release 전에 durable하게 기록한다.
- admission record와 pre-effect intent는 동일 semantic record다. 별도 workflow `INTENT` state machine을 요구하지 않는다.
- bounded capability는 하나의 transport dispatch와 exact logical effect/target/material에만 유효하다. General-purpose standing credential을 worker에게 전달하지 않는다.
- `(effect_id, dispatch_ordinal)` reservation과 admission write는 atomic해야 한다. 동일 ordinal의 concurrent writer는 하나만 성공한다.
- 한 `effect_id`의 모든 admission은 같은 `effect_request_digest`를 가져야 한다. 다음 ordinal은 이전 dispatch가 `NO_EFFECT_CONFIRMED`이거나, target-native idempotency가 same logical effect를 보장할 때만 fresh recheck 후 생성할 수 있다.
- conclusive outcome이 없는 admission이 있는데 위 target-native idempotency proof도 없으면 새 admission을 만들 수 없다.
- replay는 기존 admission/outcome을 조회하고 reconcile하는 것일 수 있지만, 같은 bounded capability를 다시 소비하거나 새로운 logical effect를 만들 수 없다.

### K7. `EffectOutcomeV1`

```text
EffectOutcomeV1 {
  outcome_id
  effect_id
  admission_digest
  result: COMMITTED | NO_EFFECT_CONFIRMED | UNKNOWN
  target_ref
  target_operation_ref?
  evidence_ref
  observed_at
  observer_ref
  outcome_digest
}
```

Rules:

- outcome은 append-only observation이다. 과거 `UNKNOWN`을 삭제하거나 no-effect로 rewrite하지 않는다.
- `COMMITTED`는 exact effect를 target이 수락/적용했다는 target-authoritative receipt 또는 policy가 허용한 동등한 authoritative observation이 필요하다.
- `NO_EFFECT_CONFIRMED`는 해당 `effect_id`의 external effect가 발생하지 않았음을 target-authoritative하게 증명해야 한다.
- transient 404, eventual-consistency miss, timeout, unavailable read, parse failure 또는 correlation 불능은 `NO_EFFECT_CONFIRMED`가 아니라 `UNKNOWN`이다.
- target이 authoritative reconciliation을 제공하지 못하면 ambiguous call은 `UNKNOWN`으로 남는다.

---

## 5. Effect admission protocol

### 5.1 Positive path

```text
1. Commodity workflow/worker proposes action material; Platform effect ingress allocates `effect_id` and seals `EffectRequestV1`.
2. Evidence sources emit exact EvidenceEnvelopeV1 records.
3. Platform assembles AdmissionInputV1 under one PolicyRefV1.
4. Commodity policy evaluator emits PolicyDecisionV1.
5. PEP fresh-rechecks exact binding and exclusive credential reach.
6. PEP durably records EffectAdmissionV1 before capability release/call.
7. PEP or its bounded target adapter performs the exact effect.
8. Target-authoritative observation emits EffectOutcomeV1.
```

Steps 5–7 are the constitutional effect gate. Workflow success, agent completion, test PASS, review APPROVE 또는 policy `ALLOW`는 이 gate를 생략할 수 없다.

### 5.2 Commit-time fresh recheck

PEP는 admission 직전에 최소 다음을 다시 검사한다.

- active `PolicyRefV1`가 decision에 bind된 exact revision/content인지
- decision/input/request digests가 서로 일치하는지
- mutable work/input/target revision이 evidence와 decision 이후 drift하지 않았는지
- required evidence가 exact subject에 bind되고 fresh한지
- Human/machine decision이 exact effect scope에 bind되고 다른 effect에 소비되지 않았는지
- decision이 만료/취소되지 않았는지
- 같은 effect identity가 다른 request로 사용되지 않았는지
- prior `UNKNOWN` 또는 conflicting committed effect가 숨겨지지 않았는지
- worker 또는 다른 component에 alternate governed-effect credential path가 없는지
- PEP-held credential/session의 actual target identity가 requested `target_ref`와 일치하는지
- PEP가 policy constraints를 실제로 enforce할 수 있는지

하나라도 증명되지 않으면 `EffectAdmissionV1`을 만들거나 capability를 release하지 않는다.

### 5.3 Human decision model

Policy가 Human judgment를 요구하면 Human interaction product는 `EvidenceEnvelopeV1`을 생산한다.

최소 rule:

- attributable Human/principal identity
- exact work/effect subject binding
- explicit decision body와 scope
- issued time 및 policy가 요구하는 freshness
- authenticated 또는 attested provenance
- 다른 effect에 재사용할 수 없는 binding

동일 `effect_id`의 idempotent recovery는 새 effect가 아니므로 같은 scoped decision을 참조할 수 있다. 다른 `effect_id`, changed material, changed target 또는 changed work revision에는 새 decision/evaluation이 필요하다.

Human UI, approval queue, notification, synchronous/asynchronous interaction 및 escalation workflow는 commodity boundary다.

### 5.4 Review and verification

Verification과 review는 `EvidenceEnvelopeV1` producer다.

- PASS/APPROVE label만으로 충분하지 않다.
- 실행/검토된 exact candidate, input, artifact 또는 effect material의 immutable identity가 필요하다.
- dirty workspace, mutable head, changed artifact 또는 stale review는 exact subject binding을 만족하지 않는다.
- policy가 independent reviewer를 요구하면 producer identity와 implementation producer identity가 separation rule을 만족해야 한다.
- self-assertion은 `SELF_REPORT` provenance로 정직하게 남으며 independent observation으로 승격되지 않는다.
- reviewer, verifier 또는 CI가 credential을 가지고 직접 governed effect를 우회하지 않는다.

별도 Auditor lifecycle이나 universal verification role은 없다. Domain policy가 필요한 evidence type과 provenance를 선언한다.

---

## 6. Ambiguous effect, retry and recovery

### 6.1 Blind retry 금지

External call 후 receipt를 받지 못했거나 result를 authoritative하게 correlate할 수 없으면 outcome은 `UNKNOWN`이다.

`UNKNOWN`을 transport failure 또는 ordinary retryable failure로 간주하여 새 call을 보내서는 안 된다.

같은 effect의 재-dispatch는 다음 중 하나일 때만 가능하다.

1. target-native idempotency가 same `effect_id`에 대해 하나의 logical effect만 만든다는 것을 PEP가 enforce할 수 있다.
2. target-authoritative observation이 `NO_EFFECT_CONFIRMED`를 반환했다.

그 외에는 자동 retry를 멈추고 reconcile 또는 policy-governed exception을 기다린다.

### 6.2 UNKNOWN 이후의 새 effect

이전 `UNKNOWN`과 같은 semantic goal을 다시 시도하거나 보상하려면:

- 새 effect라면 새 `effect_id`를 사용한다.
- 이전 effect와 outcome을 `prior_effect_refs` 및 evidence에 포함한다.
- duplicate/compensation risk를 policy input에서 숨기지 않는다.
- policy가 요구하면 exact scoped Human decision을 새 evidence로 받는다.
- 새 admission은 기존 `UNKNOWN`을 `NO_EFFECT_CONFIRMED`로 바꾸지 않는다.

이는 의식적인 risk decision을 허용하지만 blind retry를 허용하지 않는다.

### 6.3 Restart

Restart 후 authority는 process memory가 아니라 durable records와 target observation에서 재구성한다.

```text
No EffectAdmissionV1
→ capability가 release되었다고 추론하지 않음; fresh evaluation/admission 필요

EffectAdmissionV1 + COMMITTED
→ 같은 logical effect 재-dispatch 금지; committed result 사용

EffectAdmissionV1 + NO_EFFECT_CONFIRMED
→ fresh recheck 후 same request/effect identity의 next dispatch admission 가능

EffectAdmissionV1 + no conclusive outcome
→ reconcile; 결론 없으면 UNKNOWN
→ proven target-native same-effect idempotency가 없는 한 next dispatch admission 금지
```

Workflow product가 자체 retry/history를 보유해도 이 authority를 대체하지 않는다.

### 6.4 Conflict and corruption

다음은 fail-closed safety event다.

- 같은 `effect_id`에 둘 이상의 request digest
- admission 없이 observed committed governed effect
- admission material과 target receipt의 material 불일치
- evidence digest 또는 subject binding corruption
- PEP 밖 alternate governed-effect credential 사용
- target outcome 간 설명 불가능한 contradiction

Platform은 이를 자동 성공/실패로 정규화하지 않는다. Durable incident evidence를 남기고 해당 effect scope의 새 side effect를 중지한다. Incident UI와 operational workflow는 Core primitive가 아니다.

---

## 7. Evidence trust and backend neutrality

### 7.1 Neutral transport, not neutralized meaning

`EvidenceEnvelopeV1`은 heterogeneous backend evidence를 운반한다. 다음을 하지 않는다.

- backend-native claim을 universal capability로 번역
- requested configuration을 observed actual identity로 복사
- self-report를 independent observation 또는 signed attestation으로 승격
- 서로 다른 vendor/model/reviewer identity가 equivalent하다고 추론
- `UNKNOWN`을 default value로 대체

### 7.2 Requested versus actual

Requested runtime/model/version/capability 값은 request 또는 policy input일 수 있다. Actual 값은 backend가 실제 emit한 evidence가 있을 때만 `PRESENT` claim이다.

Backend가 actual field를 제공하지 않으면:

```text
availability = UNKNOWN
```

이다. Requested value로 채우지 않는다.

### 7.3 Assurance requirement

Policy는 evidence별로 다음을 독립적으로 요구할 수 있다.

- accepted producer/source identity
- exact run/work/effect binding
- maximum age 또는 revision freshness
- source relation
- integrity mechanism
- producer independence/separation
- target-authoritative observation

어떤 backend도 요구 assurance를 제공하지 못하면 effect는 fail closed한다. Platform은 backend 간 trust equivalence table이나 universal numeric trust score를 만들지 않는다.

### 7.4 Evidence availability

Missing evidence는 evaluation input의 missing requirement다. Unavailable fact는 `UNKNOWN` envelope로 정직하게 운반할 수 있다. 둘 다 policy가 요구한 `PRESENT` evidence를 만족하지 않는다.

---

## 8. Commodity boundary and conformance layers

다음은 Platform constitutional kernel이 소유하지 않는다.

1. policy language, authoring UI, compiler 및 evaluation engine
2. durable workflow/orchestration engine
3. retry scheduler, timer, queue, signal, callback 및 compensation workflow
4. model provider, agent runtime, session, tool loop 및 context management
5. planning, decomposition, task graph, batch lifecycle 및 recurring-work scheduler
6. verifier implementation, test runner, CI, review product 및 review UI
7. issue tracker, repository, branch, pull request, merge UI 및 source-control mechanics
8. domain input source, business API, target client 및 target-native receipt storage
9. general secret manager, database, message bus, observability stack 및 notification UI

OPA/equivalent는 policy evaluation을 구현할 수 있다. Temporal/equivalent는 durable orchestration을 구현할 수 있다. GitHub/native CI, external agent/worker, review product 및 business backend도 사용할 수 있다.

어느 제품도 mandatory하지 않으며, 제품의 workflow/identity/trust semantics가 이 Specification을 대체하지 않는다.

Commodity component는 다음 thin conformance edge를 구현할 수 있다.

- native output → honest `EvidenceEnvelopeV1`
- domain request → exact `EffectRequestV1`
- policy result → bound `PolicyDecisionV1`
- PEP dispatch → exact target operation
- target query/receipt → `EffectOutcomeV1`

이 edge는 service locator, capability registry, workflow DSL 또는 새 scheduler가 아니다.

### 8.1 Constitutional Kernel Conformance

Constitutional Kernel Conformance는 K1–K7 및 §13.1–§13.3의 policy/effect/evidence contract를 만족한다는 뜻이다.

이 claim은 다음을 의미하지 않는다.

- autonomous work continuation 제공
- repeated work 또는 multi-step workflow 제공
- process restart 후 ordinary work progress 복구
- CADP product conformance

Human-operated tool 또는 manual effect gateway도 K1–K7을 정확히 만족하면 이 제한된 claim을 사용할 수 있다.

### 8.2 CADP Autonomous-Work Product Conformance

CADP Autonomous-Work Product Conformance는 Constitutional Kernel Conformance에 다음 product outcome을 더한 것이다.

1. policy-authorized work start 이후 bounded multi-step 또는 repeated work가 selected worker, orchestrator, policy-required verifier/reviewer 및 backend surface 사이에서 ordinary Human relay 없이 진행된다.
2. continuation, progress와 recovery authority가 durable하며, continuation을 담당하는 relevant process가 restart/fail해도 Human이 ordinary state/data를 다시 입력하지 않고 수렴한다.
3. Human intervention은 policy requirement, ambiguous effect, explicit exception, constitutional/root authority 또는 명시적으로 Human-valued judgment가 요구할 때만 발생한다.
4. implementation/review/verification independence는 fixed role name이 아니라 exact evidence producer/provenance와 policy separation requirement로 증명한다.
5. 최소 하나의 bounded repeated autonomous-work E2E path가 §13.5에 따라 증명된다. Human이 모든 step/effect를 수동 trigger하거나 relay한 sequence는 이 requirement를 만족하지 않는다.
6. development와 non-development는 같은 generic product contract를 사용하는 peer domain composition이다. Development origin을 이유로 Task, Attempt, Supervisor, Actor, Auditor, repository 또는 merge semantics를 Core primitive로 복원하지 않는다.

`policy-authorized work start`는 새 kernel primitive가 아니다. CADP product에서 autonomous execution을 시작하거나 worker/tool capability를 release하는 start/admission을 K1–K7 governed effect로 표현한 것이다. `EffectRequestV1` material은 exact work/input, active policy, enforced bounds 및 selected commodity continuation target을 bind한다. Pure read-only discovery는 start/admission 이전에 있을 수 있지만 autonomous execution authority를 만들지 않는다.

`bounded`는 active policy 또는 policy-bound configuration이 step, iteration, time, cost, effect count 또는 동등한 finite termination condition 중 하나 이상을 enforce한다는 뜻이다. Bound 초과는 silent continuation이 아니라 deterministic stop/hold evidence를 만든다. Kernel은 그 scheduler나 lifecycle을 소유하지 않는다.

`relevant continuation process`는 그 process가 사라지면 ordinary next-step state 또는 progress authority가 유실될 수 있는 component다. Product conformance proof는 최소한 그 책임을 가진 orchestrator/controller process 하나의 실제 restart 또는 failure를 주입해야 한다. 더 넓은 fault-tolerance claim은 claim한 process마다 별도 evidence를 요구한다.

### 8.3 Commodity ownership of continuation

Product outcome을 요구한다고 해서 durable workflow, retry, scheduler, planner 또는 lifecycle이 Kernel 소유가 되지는 않는다. Temporal/equivalent 또는 다른 conforming product가 continuation mechanism을 소유할 수 있다.

다만 commodity mechanism의 존재나 제품명만으로 Product Conformance를 주장할 수 없다. Exact work/run identity, causal step/evidence/effect binding, durable restart result 및 Human-intervention reason을 conformance evidence로 제시해야 한다.

---

## 9. Constitution lifecycle and bootstrap

### 9.1 Genesis

최초 `PolicyRefV1`, trusted issuer 및 PEP credential placement는 deployment root authority가 out-of-band로 설치한다. Genesis 사실은 attributable하고 immutable하게 기록한다.

이 bootstrap은 agent/model inference로 생성하지 않는다.

### 9.2 Policy change

Policy content는 in-place mutation하지 않는다. 새 revision과 새 digest를 발행한다.

Genesis 이후 policy activation/change는 다음 중 하나다.

1. current policy가 정의한 governed effect로 exact new `PolicyRefV1`를 admit한다.
2. current policy가 정의한 scoped Human/root decision을 사용한다.
3. emergency break-glass를 사용하고 identity, reason, scope, prior/new policy refs를 durable evidence로 남긴다.

Break-glass는 과거 effect outcome/evidence를 rewrite하지 않으며 일반 worker capability가 아니다.

### 9.3 In-flight decision

Policy revision 변경은 기존 decision/admission에 silent 적용되지 않는다.

- admission 전: active policy와 decision policy가 다르면 새 evaluation이 필요하다.
- admission 후: exact admitted effect의 recovery는 frozen admission을 따르되, 새 effect는 current policy를 따른다.
- policy가 explicit revocation/stop rule을 제공하면 PEP는 effect dispatch 전에 이를 적용한다.

---

## 10. Domain composition

Development와 non-development는 같은 constitutional kernel과 product outcome contract를 사용하는 peer composition이다. Development는 v0.4의 required reference domain이지만 constitutional center가 아니다.

### 10.1 Development composition

Development deployment는 다음을 commodity composition으로 가질 수 있다.

- Issue 또는 document source가 work identity/version을 제공
- agent가 candidate artifact를 생산
- repository/CI가 candidate digest와 verification evidence를 제공
- reviewer가 exact candidate verdict evidence를 제공
- policy evaluator가 PR creation 또는 merge effect를 평가
- PEP가 repository credential을 보관하고 exact PR/merge effect만 수행
- repository가 commit/PR/merge receipt를 authoritative하게 제공

Pull request creation과 merge는 서로 다른 effect identity와 admission을 갖는다. Policy가 Human merge를 요구하면 Human decision envelope는 exact merge target/candidate에 bind된다.

### 10.2 Non-development composition

Non-development deployment는 다음을 commodity composition으로 가질 수 있다.

- business source가 input/resource identity와 revision을 제공
- worker/API가 bounded action material을 제안
- verifier 또는 backend가 required evidence를 제공
- policy evaluator가 resource/API effect를 평가
- PEP가 service credential을 보관하고 exact operation만 수행
- service target이 receipt 또는 reconciliation observation을 제공

Task, Attempt, repository, branch, review 또는 merge primitive 없이도 동일 contract가 성립해야 한다.

어느 domain이 CADP-conformant product route로 제시되든 §8.2의 autonomous continuation outcome을 별도로 만족해야 한다. Domain example을 한 번 안전하게 실행하거나 Human이 각 step을 relay하는 것만으로는 Product Conformance가 아니다.

---

## 11. v0.3 concept disposition

| v0.3 concept | v0.4 disposition | v0.4 meaning |
|---|---|---|
| Task / Attempt / generic lifecycle | **COMMODITIZE** | Workflow/domain이 소유한다. Kernel에는 optional `work_bindings`만 남는다. |
| Project Profile | **DROP** from kernel | Domain configuration은 commodity/domain owner가 관리하고 policy input/evidence로 제공한다. |
| Compiled Profile | **GENERALIZE** | Giant compiled schema 대신 exact `PolicyRefV1` + `AdmissionInputV1` binding으로 대체한다. |
| Execution Policy / decision validation | **KEEP / GENERALIZE** | Policy language/evaluator는 commodity이고 exact decision/admission semantics는 kernel이다. |
| Capability Broker / CapabilityGrant | **GENERALIZE** | Generic broker/role grants 대신 PEP custody와 exact `EffectAdmissionV1` bounded capability를 유지한다. |
| RuntimeAdapter | **COMMODITIZE** | Agent/session execution은 commodity. Actual identity는 evidence로만 들어온다. |
| WorkflowAdapter | **COMMODITIZE** | Durable orchestration, retry, scheduling 및 lifecycle은 commodity. |
| VerificationAdapter | **COMMODITIZE** | Verification execution은 commodity. Exact evidence/provenance contract만 kernel에 남는다. |
| RepositoryAdapter | **COMMODITIZE** | Repository mechanics와 observation은 commodity. Mutation은 generic PEP effect path를 따른다. |
| Supervisor / Actor / Auditor | **DROP** as Core roles | Requester/producer/reviewer/Human principal은 evidence provenance와 policy separation rule로 표현한다. |
| Task Contract / manifest hashes | **GENERALIZE** | Giant task snapshot 대신 effect/work/evidence/policy의 content-addressed exact binding을 사용한다. |
| Human Gate / Human decision | **GENERALIZE** | Human decision은 attributable, scoped, fresh evidence다. |
| PendingDecision queue/lifecycle | **COMMODITIZE** | Queue, UI, blocking scope 및 pending lifecycle은 workflow/product가 소유한다. |
| external INTENT / reconciliation | **KEEP / GENERALIZE** | Pre-effect durable `EffectAdmissionV1`과 `EffectOutcomeV1` truth contract로 유지한다. |
| single-writer rule | **DEFER** as universal policy | Concurrency/conflict scheduling은 domain policy/workflow가 소유한다. |
| mutation reach | **KEEP / GENERALIZE** | Governed credential의 exclusive PEP custody와 no-alternate-path invariant로 일반화한다. |
| ImprovementFinding / recurring work | **DEFER** | Finding, recurrence 및 planning lifecycle은 kernel 밖이다. Commodity workflow가 이를 구현해도 각 resulting effect는 동일 gate를 거친다. |
| Repository Gate / merge authority | **GENERALIZE** | Repository-specific gate는 generic PEP/target adapter의 한 composition이다. |
| Assurance Levels | **GENERALIZE** | Linear level 대신 source relation, integrity, independence 및 subject binding을 policy가 조합한다. |
| Backend Capability Manifest | **GENERALIZE** | Backend actual capability/identity가 필요하면 evidence로 제시한다. Requested manifest는 actual evidence가 아니다. |
| Platform durable task/batch state | **COMMODITIZE** | Workflow state는 commodity. Kernel은 constitutional records만 durable하게 유지한다. |
| Subflow / hold-next / rework | **COMMODITIZE** | Workflow/domain behavior이며 새 effect admission authority가 아니다. |

`KEEP / GENERALIZE`는 v0.3 schema나 state machine을 이식한다는 뜻이 아니다. 보존되는 것은 negative controls가 입증한 semantic invariant뿐이다.

---

## 12. v0.3 compatibility and migration

### 12.1 Succession

이 document가 Human 승인으로 canonical branch에 merge되면 v0.4가 새 architecture generation의 Specification authority가 된다.

v0.4는 v0.3의 development-specific product contract를 더 넓은 autonomous-work product contract로 supersede한다. Safety/authority semantics는 K1–K7로 일반화하며, development는 required reference/peer domain composition으로 남지만 fixed Core role이나 lifecycle을 소유하지 않는다.

v0.3, TD v1.5, current implementation, #85/#87/#88, OpenClaw 및 durable-jobs 설계는 v0.4의 architecture authority가 아니다. 필요한 경우 historical evidence 또는 commodity adapter implementation input으로만 사용할 수 있다.

### 12.2 Clean execution-domain boundary

v0.3 durable Attempt/Batch를 v0.4 record로 in-place migration하지 않는다.

- v0.4는 새 execution namespace/domain과 genesis `PolicyRefV1`에서 시작한다.
- 이미 시작된 v0.3 execution은 frozen v0.3/TD authority 아래 완료, 중단 또는 보관한다.
- v0.4 cutover 이후 새 v0.3 Attempt를 silent하게 시작하지 않는다.
- v0.3 Task Contract, CapabilityGrant, decision 또는 INTENT는 v0.4 permit/admission으로 승격되지 않는다.
- v0.3 artifact가 provenance와 immutable identity를 유지하면, v0.4 policy가 허용하는 `EvidenceEnvelopeV1` source material로만 import할 수 있다.
- adapter 또는 backend code reuse는 v0.4 conformance와 credential boundary를 별도로 증명해야 한다.

### 12.3 Preserved invariants

다음 v0.3 invariants는 semantic하게 보존된다.

- model output은 proposal이지 execution authority가 아니다.
- policy와 domain/work meaning은 silent하게 섞이지 않는다.
- capability는 prompt가 아니라 enforceable boundary다.
- evidence는 exact execution/artifact에 bind된다.
- worker self-report는 authoritative verification으로 자동 승격되지 않는다.
- model/worker에게 canonical mutation authority를 직접 주지 않는다.
- mutable contract/policy/evidence는 in-flight execution에 silent migration되지 않는다.
- restart/retry는 durable identity와 authoritative reconciliation을 사용한다.
- backend limitation을 invented fact나 prompt convention으로 숨기지 않는다.

보존되지 않는 것은 v0.3의 fixed roles, task lifecycle, project profile compiler, adapter matrix, batch scheduler 및 repository-specific merge state machine이다.

---

## 13. Conformance requirements

Constitutional Kernel Conformance는 §13.1–§13.3을 통과해야 한다.

CADP Autonomous-Work Product Conformance는 Constitutional Kernel Conformance에 더하여 §13.4–§13.5와 §8.2를 통과해야 한다. 두 claim을 documentation, report 또는 deployment metadata에서 혼용해서는 안 된다.

### 13.1 Binding controls

- exact policy/work/effect/evidence binding은 admission 가능
- wrong target, wrong work revision, changed material 또는 stale evidence는 admission 불가
- mutable candidate가 review/verification 뒤 drift하면 admission 불가
- tampered evidence body/digest는 admission 불가
- policy decision을 다른 effect request에 제시하면 admission 불가

### 13.2 Provenance controls

- policy가 independent review를 요구할 때 implementer self-assertion은 불가
- requested backend value를 actual observation으로 복사한 envelope는 불가
- required actual fact가 unavailable하면 `UNKNOWN`이고 admission 불가
- policy가 signed/attested evidence를 요구할 때 self-report만 있으면 admission 불가

### 13.3 Credential and effect controls

- worker-held credential/alternate path로 governed effect를 만들 수 있으면 enforced admission 불가
- admission record가 없으면 PEP capability release 불가
- same effect identity + same request replay는 duplicate logical effect를 만들지 않음
- same effect identity + different request는 conflict로 거부
- ambiguous accepted call을 blind retry하지 않음
- `NO_EFFECT_CONFIRMED`는 target-authoritative proof 없이는 생성되지 않음

### 13.4 Domain controls

- 한 development vertical이 exact candidate evidence에서 gated repository effect까지 성립
- 한 non-development vertical이 authoritative input에서 gated API/service effect와 reconciliation까지 성립
- 두 vertical 모두 Task/Attempt/Supervisor/Auditor를 constitutional primitive로 요구하지 않음

### 13.5 Autonomous continuation product controls

최소 한 development 또는 non-development conformance scenario는 다음 하나의 bounded E2E trace를 증명해야 한다.

```text
K1–K7 policy-authorized work-start admission
→ causally bound ordinary work step/iteration 1
→ durable continuation fact
→ relevant continuation process restart/failure injection
→ ordinary work step/iteration 2 or later
→ required verification/review/backend evidence
→ K1–K7 governed effect admission and authoritative outcome, when the path has an external effect
→ policy-defined completion, hold or bounded stop
```

Acceptance:

- work-start admission이 exact work/input, active policy, finite bounds 및 commodity continuation target에 bind
- 서로 causally bound된 ordinary work step/iteration이 최소 2개 존재
- 위 두 ordinary step은 conformance policy상 Human-valued judgment를 요구하지 않음
- step identity, input/output, evidence 및 governed effect reference를 durable state에서 재구성 가능
- restart 후 Human이 message, SHA, run identity, state, receipt 또는 next-step data를 relay하지 않아도 continuation이 수렴
- ordinary transport/state-bus 목적의 Human action 수는 0
- Human action이 있었다면 exact policy requirement, ambiguity, exception, root authority 또는 Human-valued judgment 중 하나에 bind된 evidence가 존재
- policy가 independence를 요구한 producer/reviewer/verifier 조합은 exact provenance로 separation을 증명
- 모든 external effect는 K1–K7을 통과하고 ambiguous outcome은 §6을 따름
- Human이 각 step/effect를 수동 trigger한 trace는 reject

Global Product Conformance에는 위 repeated E2E proof 하나와 §13.4의 두 peer-domain controls가 필요하다. 특정 domain route를 CADP-conformant라고 별도로 advertise하면 그 route도 §8.2 outcome을 만족해야 한다.

---

## 14. Non-goals

v0.4 kernel은 다음을 만들지 않는다.

- generic workflow engine, scheduler, retry engine 또는 lifecycle state machine
- generic planner, task graph, prompt DSL 또는 context DSL
- model/session/runtime implementation
- verification framework, CI engine 또는 review product
- repository abstraction framework, PR UI 또는 merge workflow
- universal backend capability/trust registry
- universal authority registry 또는 service locator
- universal trust score 또는 cross-vendor equivalence model
- project maturity/mode engine
- dynamic model/workflow topology synthesis
- recurring-improvement planner
- deployment/CD platform
- v0.3 implementation compatibility facade
- OpenClaw/durable-jobs 전용 예외

Commodity-backed autonomous continuation이라는 Product Conformance outcome은 이 Non-goal과 충돌하지 않는다. Specification은 outcome과 evidence를 요구하며 workflow/scheduler implementation을 소유하지 않는다.

---

## 15. TD 및 implementation handoff boundary

이 candidate는 TD와 production implementation을 authorize하지 않는다.

Human이 v0.4를 승인한 뒤 별도 TD는 최소 다음 implementation choices를 결정해야 한다.

- canonical serialization과 approved digest algorithms
- constitutional record storage/atomicity
- PEP deployment topology와 credential isolation proof
- policy evaluator interface와 decision constraints
- target adapter idempotency/reconciliation conformance
- evidence envelope schemas, authentication 및 attestation verification
- genesis/break-glass operational procedure
- v0.3 execution-domain retirement procedure

TD는 이 Specification에 없는 Task/Attempt/role lifecycle을 constitutional requirement로 되살리거나, commodity product의 self-report를 authority로 승격할 수 없다.

Production work는 TD authority와 별도 Human authorization 후에만 시작한다.

---

## 16. Architecture acceptance

이 candidate의 target constitutional architecture는 `THIN_CONSTITUTIONAL_KERNEL`이다.

CADP product claim은 그 kernel 위에 §8.2의 `CADP Autonomous-Work Product Conformance`를 추가로 요구한다.

최종 경계:

```text
Domain and commodity systems propose, execute, verify and orchestrate.
Immutable policy identifies the constitution.
Exact evidence identifies what is known and how it is known.
Policy evaluates one exact requested effect.
The PEP alone admits and reaches the governed effect.
Durable effect identity and target-authoritative reconciliation prevent blind duplication.
Human judgment enters only as attributable, scoped, fresh evidence unless exercising explicit root authority.

Kernel-safe manual relay gateway
≠ CADP autonomous-work product.

CADP autonomous-work product
= Thin Constitutional Kernel
+ commodity-backed durable autonomous continuation.
```

Architecture-blocking unresolved question: **none**.

Implementation choices in §15 remain deliberately unresolved and do not add kernel authority.
