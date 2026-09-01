# Common Autonomous Development Platform — Technical Design v1.5 (design-track canonical)

> **Authority provenance ([원장], ADP #6 AMENDMENT-1 계보):** v1.2~v1.4는 **TD 개선축(design track)의
> working canonical**로 개발되었다. **PR #18 머지 전까지 repository authority는 main의 TD v1.1이었고**,
> **이 파일이 main에 올라간 시점부터 이 문서가 Spec v0.3 아래의 repository TD authority다.** 이후의
> 개선축 산출물은 다시 별도 sync를 거치며, 참조는 exact commit SHA로 한다(#1 AMENDMENT-1).
> authority 서열 자체는 불변: Spec v0.3 > 이 TD > Backend Capability Contract > STATUS 문서들.
>
> **v1.5 revision (MVP 4 operability closure — IO #23은 evidence source로만 사용,
> ARCH_REOPENING 없음):** 기존 primitive를 유지한 채 향후 production implementation에 필요한 네 경계만
> 보강한다 — (1) §22.5 monitoring/liveness는 observation trigger일 뿐 authority가 아니며 반드시
> authoritative re-observation → §22 reconciliation → 기존 deterministic recovery로 이어짐,
> (2) §5.13 `ImprovementFindingV1`은 evidence-derived semantic record이고 issue/task-system은 projection일
> 뿐 lifecycle/policy authority가 아님, (3) §5.12/§13.2a/§24.1은 실제 role/provider/model/usage/cost와
> failure domain을 추정 없이 귀속, (4) §5.14/§7.1d/§13.5는 role-specific evaluation → read-only routing
> recommendation까지만 허용하고 automatic policy routing·mid-attempt fallback은 future authority seam으로
> 남김. 새 WorkflowProfile, telemetry authority store, monitoring state machine, IO mechanism은 만들지 않는다.
> 전부 **PROSPECTIVE_REQUIREMENT**이며 MVP 0/1 FORMAL seal과 기존 D1–D19를 소급 무효화하지 않는다.
>
> **v1.5 Operator-evidence amendment (PR #42 comment `5477209602`, Design Evidence이지 authority가 아님):**
> IO self-hosting 운영에서 측정된 false positive·partial observation·alert fatigue·stage duration 차이·평가
> input 누락·unwired fail-closed guard를 portable failure mode로만 번역했다. §22.5의
> **Monitoring is observation, not authority / An anomaly is not a lifecycle fact**는 반증되지 않았고, 네 건의
> confident false signal이 actuation으로 번지지 않은 실측으로 강화되었다. amendment는 (a) durable하게
> 재구성 가능한 signal·absence/coverage 정직성, (b) Finding 기반 presentation collapse, (c) state/stage-aware
> threshold resolution, (d) sealed MVP 1과 구분된 prospective early read-only monitoring, (e) evaluation input
> completeness, (f) material fail-closed boundary의 bounded falsification validation만 추가한다. 전부
> **PROSPECTIVE_REQUIREMENT**이며 Spec 변경, architecture reopening, 새 store/state machine은 없다.
>
> **v1.5 PR #43 contract-gap amendment (comments `5479029297` / `5479598382`, Design Evidence이지
> authority가 아님):** 구현·운영 검토에서 측정된 세 failure를 Spec의 기존 lifecycle primitive로만 닫는다.
> (a) `PendingDecision RESOLVED` fact와 category별 lifecycle application을 분리하고 fresh authority/state
> revalidation 뒤에만 deterministic transition 또는 current-world Proposal re-entry를 허용한다(§17.4),
> (b) `START_SUBFLOW` parent는 cardinality로 추론하지 않고 explicit authoritative intent에서 검증·동결하며
> child admission과 parent suspension을 atomic하게 기록한다(§9.2f/§10.1a/§19.5), (c) completion은 frozen
> pipeline의 terminal-success predicate이며 `MERGED → COMPLETED`는 `MERGE_GATE`의 한 concrete case로만
> 남기고 foundation child success는 canonical merge 없이 deterministic `RESUME_PARENT` eligibility를 만든다
> (§19.2/§19.5). 전부 **PROSPECTIVE_REQUIREMENT**다. Spec 변경, architecture reopening, 새 workflow/
> decision state machine, 새 table, IO mechanism 이전은 없고 MVP 0/1 FORMAL seal은 불변이다.
>
> **v1.5 Issue #60 Supervisor decision-basis contract amendment (Issue #52 RUN #3 comment
> `5489088308`, Design Evidence이지 authority가 아님):** Core의 fail-closed rejection은 기존 계약대로
> 동작했지만, §13.4의 fresh context assembly가 model-facing exact projection을 고정하지 않아
> `SupervisorProposalV1`의 선택값·freshness 값·ULID identity를 구현이 생략할 수 있었다. §9.1/§9.2와
> §13.4에 `SupervisorDecisionContextV1` 및 Platform-allocated `proposal_id` echo binding을 추가한다.
> Supervisor는 declared semantic choice를 직접 선택하고 turn에서 관측한 freshness basis를 Proposal에
> 명시하며, Platform/Harness는 model output 뒤에 누락값을 채우지 않는다. Runtime structured-output
> constraint는 generation aid일 뿐 Core authority가 아니다. **SPEC_CHANGE=NO / TD_CHANGE=YES /
> BACKEND_CHANGE=NO**, 전부 **PROSPECTIVE_REQUIREMENT**다. 새 store/state machine/framework,
> OpenClaw/durable-jobs 변경이나 MVP 0/1 schema/state/validator seal의 소급 무효화는 없다. 다만 B13의
> 기존 model-facing context evidence는 이 prospective contract의 충족 증거가 아니며, production
> Coordinator의 기존 §13.4 축약은 후속 implementation verification 대상이다. 이 amendment 시점의 #59
> child materialisation gap은 별도 OPEN이었고, 아래 Human-authorized #59 amendment가 후속으로 닫는다.
>
> **v1.5 Issue #59 Human-authorized Spec/TD amendment (Issue #52 RUN #3 comment `5489088308`):**
> Human은 Supervisor가 whole intent를 bounded child tasks로 decomposition하고 완전한 child
> `TaskDefinitionBodyV1` + explicit parent intent를 structured `START_SUBFLOW` materialisation Proposal로
> 제안할 authority를 Spec v0.3 amendment로 승인했다. Platform만 validation, idempotent publish,
> TaskSource round-trip과 durable binding을 수행한다. 이 amendment는 기존 `START_SUBFLOW` admission 앞의
> narrow materialisation phase를 추가하고 D22 parent/suspend/resume 및 D23 decision-basis를 재설계하지
> 않는다. Supervisor는 backend/TaskSource를 직접 mutate하지 않고 Profile-declared pipeline/role/
> verification/scope만 이후 admission Proposal에서 선택한다. dynamic pipeline/workflow/model topology,
> generic Planner/Task Graph/DSL은 future subject다. **SPEC_CHANGE=YES(Human approved) / TD_CHANGE=YES /
> BACKEND_CHANGE=NO**, 전부 **PROSPECTIVE MVP 3 REQUIREMENT**이며 MVP 0/1 seal은 불변이다.
>
> **v1.3 revision (batch fold — intake #1~#6 + material assessment):** architecture decision 재개방
> 없음. 접힌 내용 — (1) I-TD12 승격(#3 AMENDMENT-1의 좁힌 문구; 원안의 mechanism-과잉 자백 포함),
> (2) §1.1에 TRANSFER_KIND 이전 규율(#1 AMENDMENT-1), (3) §5.11 Diagnostic Projection + §5.12
> Measurement Projection 계약(#4 AMENDMENT-1, DELTA-4 — IO #23 body[8] 측정 우선 규칙의 번역),
> (4) §19.4에 C-11 경계 문장(material assessment CLARIFICATION), (5) §31에 C-03/C-12 architecture-
> reopening 후보 seam 등록(**채택 아님** — assessment 권고 "승인 전 Spec/TD 편집 금지" 준수),
> (6) §13.1 증거 등급 소급 명시(#6 checklist 항목 종결). C-04는 DEFER 유지, C-05/06/08/10은
> IO-SPECIFIC으로 미반영. M0-x/M1-x 봉인·D1~D16·MVP 0/1 FORMAL 판정 소급 무효화 없음.
>
> **v1.4 revision (practitioner hardening — main-sync 전 경화, ARCH_REOPENING 없음):**
> PRACTITIONER-DELTA(#3/#4/#9) + PRACTITIONER REVIEW(#6, `SPEC_FIT=PASS`,
> `MAIN_SYNC=CONDITIONAL_GO`)의 5개 refinement 전부 수용 — (1) I-TD12에 실행 가능한 teardown-DENY
> predicate, **적용 시점 = PROSPECTIVE 명시**(sealed MVP 1 teardown path 비소급), (2) §5.11
> partial-result semantics(한 authority 실패 ≠ packet 실패), (3) §5.12 귀속 정밀화(human_handoffs
> ≠ human_interventions, cost provenance, attempt-level aggregate), (4) §1.1
> DesignEvidenceGrade ↔ VerificationEvidence.assurance_level 네임스페이스 분리, (5) I-TD8~I-TD12
> **applicability map을 main-sync gate로** 격상(§31) + 문서 계층 경계 guidance. D18.

> **v1.2 revision (document discipline + operational-evidence hardening):** 이 revision은 architecture
> decision을 하나도 재개방하지 않는다. 변경은 네 갈래다 — (1) §1.1 문서 층위/규범 표기 계약과 backend
> 주장 증거 등급, (2) §2 신설 invariant I-TD8~I-TD11 (IO fork #303–#309 Atlas·CORR1의 라이브 증거에서
> 도출; 소급 적용 아님, applicability note 참조), (3) §14.3 mutation-reach 선언 요구, (4) §31 Platform
> Seam/Hotspot Register 신설. M0-x/M1-x 봉인 절과 기존 D1–D15 결정은 문자 그대로 유지된다.

> **Status: TECHNICAL DESIGN — 설계만 수행. 구현/스캐폴드/테스트/Runtime 변경 없음.**
> **v1.1 revision:** trust/state-model 보정 — (P0-1) Platform Core ≠ trusted identity issuer /
> WorkflowControllerHandle 도입, (P0-2) RuntimeResultChannel 분리(Auditor read-only 모순 해소),
> Backend Capability Manifest의 Task Contract 동결 + CapabilityEnforcementReceipt, Approved Override의
> authoritative approval binding, secret 저장 금지, Task/Attempt state 분리, Contract Drift의
> Execution Policy화, MVP 1 Human Merge semantics 분리, RepositoryAdapter의 OpenClaw 결합 완화,
> recovery/trust model 보강. v1.0의 architecture 방향(§2·지시서 §13 목록)은 유지.
> Baseline: `Common Autonomous Development Platform — Specification v0.3` (정본).
> Backend 근거: `PLATFORM_BACKEND_CAPABILITY.md` (2026-08-08 read-only audit), `STATUS_workflow_harness.md` (2026-08-08).
> Historical evidence로만 참조: `DESIGN_workflow_harness.md`, `P3_H_session_bound_audit_smoke.md`.
> 우선순위: **Spec v0.3 > Backend Capability Contract > STATUS > old design/history.** 충돌 시 Spec v0.3 우선.

---

## 1. Purpose / Scope

이 TD는 Spec v0.3를 다시 설명하지 않는다. Spec이 열어 둔 기술 결정(§73 Q1–Q8)을 닫고,
MVP 0 → MVP 1 구현자가 **추가 architecture decision 없이** 착수할 수 있는 수준의
component 경계, data contract, state machine, adapter mapping, recovery rule, trust model을 확정한다.

Scope:

- Platform Core 결정: durable store, canonicalization/hash, state machine, idempotency, recovery precedence.
- Backend v1 mapping: OpenClaw(RuntimeAdapter), durable-jobs(WorkflowAdapter), local Git(RepositoryAdapter),
  local verifier(VerificationAdapter), Slack(ReportAdapter), ProjectDocumentTaskSource.
- MVP 0 / MVP 1 상세 설계와 MVP 2–4 extension point.

Non-scope: 코드, 테스트, package 구조 이상의 파일 수준 세부, OpenClaw/durable-jobs 수정, Spec 수정.

표기 규약:

- `IMPLEMENTATION GAP` — Backend capability 문서상 아직 formalize되지 않아 구현 시 확정이 필요한 지점. 추측으로 채우지 않는다.
- `ADR-CANDIDATE` — 장기적으로 독립 ADR로 승격할 결정. 이번 작업에서는 TD 내 기록만 한다.
- `BACKEND CAVEAT` — Common Platform architecture가 종속되지 않는 하위 Backend 잔여 이슈.

### 1.1 문서 층위와 규범 표기 계약 (v1.2 신설)

이 문서는 세 층위의 텍스트를 담는다. 층위 판별이 독자 추론에 맡겨져 있던 것이 v1.1까지의 결함이었고,
아래가 그 판별 규칙이다.

```text
[계약]  binding. 위반 = 결함.
        해당: M0-x/M1-x 표기가 붙은 절 전체, "normative"를 자칭하는 절,
              §2 invariants, §29 D-결정, schema v1 정의, 그리고 v1.2부터 [계약] 표기를 단 문단.
[설명]  rationale / alternatives / MVP impact / 배경. 구속력 없음. 계약과 충돌하면 계약이 이긴다.
        해당: 위 두 분류에 들지 않는 모든 프로즈 (기본값).
[원장]  결정·정정의 역사 기록 (CLOSED 판정, "정정(실측)" 블록, §30.1/§30.1a). 소급 수정 금지 —
        틀렸으면 새 항목으로 정정하고 원문은 남긴다.
```

새로 추가되는 binding 텍스트는 `[계약]`을 자기 선언해야 하며, "예시가 아니라 normative"라는 문장으로
층위를 사후 해명해야 하는 상황 자체를 결함으로 취급한다.

**Backend 주장 증거 등급 (v1.2 신설, [계약]).** Backend(OpenClaw/durable-jobs/Git/GitHub)의 동작·심볼·
경로에 대한 모든 주장은 다음 중 하나의 등급을 가진다:

```text
MEASURED(<경로/심볼/SHA/커밋>)   read-only 실측으로 확인됨. 근거 포인터 필수.
INFERRED                        문서/구조에서 추론. 실측 전.
CANDIDATE                       구현 후보 제안. 사실 주장이 아님.
```

`INFERRED`/`CANDIDATE`는 CLOSED 판정·normative mapping·preflight PASS의 근거가 될 수 없다.
이 규칙의 존재 이유는 원장에 있다: v1.1이 RA-1 후보로 사실처럼 적었던 `spawn_agent` + subagent
registry는 실측에서 Codex provider alias와 retired legacy store로 판명되었다(§13.1 정정 기록). GAP
표시는 등급 표기의 면제가 아니다. 기존 §13.1 행들은 다음 갱신에서 소급 표기한다.

**TD ≠ STATUS ([계약]).** 이 문서는 계약과 gap을 담는다. 현재 환경의 pass/fail·BLOCKED/READY 같은
운영 상태의 소유자는 STATUS 문서들이며, TD 본문에 현재 상태를 복제하지 않는다(§30.2의 실측 기록은
원장으로서의 예외 — 상태 조회는 언제나 STATUS가 이긴다).

**IO→ADP 이전 규율 ([계약], v1.3 — ADP #1 AMENDMENT-1 편입).** IO 등 외부 실물에서 오는 모든
delta는 다음 TRANSFER_KIND 중 하나로 분류되어야 반영 대상이 된다:

```text
INVARIANT / FAILURE_MODE / OPERABILITY / DIAGNOSTIC   → ADP식 mechanism으로 번역해 반영 가능
BACKEND_MECHANISM                                      → Core 반영 금지 — adapter/참고만
NON_PORTABLE                                           → 기록만
```

**mechanism은 승계 대상이 아니다.** 외부 mechanism이 잘 작동했다는 사실은 그것이 증명하는 portable
invariant의 증거이지 그 구현을 쓰라는 근거가 아니다(대응표: ADP #2 transfer map). intake 아티팩트
(ADP repo 이슈)는 evidence/queue이며 두 번째 architecture authority가 아니다.

**DesignEvidenceGrade ≠ Runtime assurance ([계약], v1.4 — 네임스페이스 분리).** 본 절의
`MEASURED / INFERRED / CANDIDATE`는 이제부터 **DesignEvidenceGrade**로 부르며, 문서/설계 판정
metadata일 뿐이다. Runtime `VerificationEvidence.assurance_level`(§15.2/§40:
`REEXECUTED / ARTIFACT_VERIFIED / LOG_VERIFIED / WORKER_REPORTED / INFERRED`)과 authority가
다르고 `INFERRED` 토큰이 겹치므로:

```text
DesignEvidenceGrade is documentation/design-assessment metadata only.
It is not VerificationEvidence.assurance_level and MUST NOT be serialized
into runtime contracts or used as runtime verification authority.
```

새 공통 Evidence framework는 만들지 않는다 — 이 경계 선언이 전부다.

**문서 계층 경계 ([설명], v1.4 — practitioner review 권고).** formalism은 유지하되 document
monolith는 더 키우지 않는다: Spec=장기 invariant/scope, TD main=현행 normative contract,
ADR/원장=Dxx 결정 맥락, Issues=미채택 후보/evidence queue, STATUS=실제 구현·검증 상태,
Ops/readout=운영성 계약. §5.11/§5.12 같은 운영성 계약은 main-sync 시 별도 문서로의 분리가
후보다(§31 seam).

---

## 2. Architecture Invariants (재논의 금지)

Spec v0.3 §2를 그대로 상속하며 TD 전체에서 완화하지 않는다.

```text
Runtime ≠ Platform          MCP ≠ Platform Core       ACP ≠ Platform
OpenClaw ≠ Platform         durable-jobs ≠ Platform   Claude ≠ Platform
infra-scanner ≠ Platform    TaskSource ≠ Platform durable state
CI ≠ Platform               GitHub ≠ Platform

Model proposes.  Platform validates.  Capability boundary authorizes.
Runtime executes.  Verification proves.  Auditor reviews.
Repository Gate merges.  Human decides only where policy requires.

Project-specific semantics = Project Profile
Automation authority       = Execution Policy
Execution contract         = Immutable Task Contract Snapshot
Platform lifecycle/safety  = Generic deterministic Core
```

TD-level 파생 invariant (본 문서에서 추가로 고정):

- **I-TD1.** Platform Core 코드/스키마 어디에도 `sessionKey`, `agy`, `PROJECT_STATUS`, `READY_ITEM` 등
  Backend/Project 고유 문자열이 등장하지 않는다. 등장 위치는 Adapter/Profile config뿐이다.
- **I-TD2.** 모든 canonical side effect(merge, workflow start, session spawn, notification)는
  durable idempotency record가 **선기록**된 뒤에만 수행된다 (write-ahead intent).
- **I-TD3.** 어떤 component도 Model 발화 문자열을 파싱해 authoritative fact로 승격하지 않는다.
  Model 산출물은 항상 (a) structured envelope + (b) provenance 표시 + (c) evidence candidate로만 취급된다.
- **I-TD4.** same-Supervisor automatic continuation(구 P3-H H3/H4 경로)은 어떤 Core contract에도
  나타나지 않는다. Workflow 관측은 §14(Q8 결정)의 poll 기반 contract만 사용한다.
- **I-TD5.** **Platform Core ≠ Runtime trusted identity issuer.** Core는 어떤 계층에서도
  `agentId`/`sessionKey` 등 trusted identity를 생성·주장하지 않는다. trusted identity는 Runtime의
  authoritative owner(host)가 발급하며, Core는 opaque `RuntimeSessionHandle` /
  `WorkflowControllerHandle`만 소유한다 (§13.3, §16.3).
- **I-TD6.** **Runtime structured result artifact ≠ Repository candidate artifact.**
  Actor/Auditor의 structured 결과는 repository 밖의 RuntimeAdapter 소유 `RuntimeResultChannel`로
  전달되며(§13.2), repository write capability를 결과 제출의 전제로 삼지 않는다.
- **I-TD7.** **Platform durable store는 raw secret-bearing runtime identifier를 저장하지 않는다.**
  ACP sessionKey, token, Authorization header, secret env 값은 어떤 테이블(`adapter_metadata` 포함)에도
  기록 금지. Core에는 opaque handle·redacted fingerprint·non-secret backend reference만 저장한다.
  raw secret이 recovery에 필요하면 그것은 Runtime 자체 store 또는 별도 secret storage abstraction의
  소유다 (§6.1, §18.1).

v1.2 신설 invariant — IO fork 라이브 운영 증거(#303–#309 Atlas)와 본 프로젝트의 CORR1에서 도출:

- **I-TD8. Ownerless 상태 금지.** 모든 terminal / HELD / blocked durable 상태는 기계가 읽을 수 있는
  **next-owner**를 가져야 한다 — `BLOCKED_BY_DECISION:<id>` → HUMAN(해당 decision), 재시도 가능한
  HELD reason → COORDINATOR, terminal → 없음(명시). "다음 주인이 미정의라서 사람이 data-bus가 되는"
  상태는 결함이다. (증거: IO D5/D7/#264/#296 — 전부 next-owner 부재가 human relay를 강제한 사례.)
- **I-TD9. Mutation-reach 선언.** 모든 adapter primitive는 자기 mutation 도달 범위를 계약에 선언한다
  — 읽기 전용인지, 어떤 ref/브랜치/파일 범위를 변형할 수 있는지. 선언 밖 mutation, 특히 "준비/조회"로
  보이는 primitive의 숨은 canonical/branch 변형은 capability boundary 위반으로 취급한다(§24
  `CAPABILITY_BOUNDARY_UNAVAILABLE` 계열). (증거: IO #303 — worktree "path 준비" 경로의 숨은
  rebase/reset이 무관한 HOLD 브랜치를 오염. §14.3에 RepositoryAdapter 적용.)
- **I-TD10. 관측 ≠ actuation.** board/backend-wide 관측·reconciliation의 결과 집합은 actuation 권한을
  함의하지 않는다. actuation은 언제나 scope-bound admission(단일 Coordinator choke point + 해당
  attempt/op_key binding)을 경유한다. `WorkflowObservation`이 transition fact가 아니라는 기존
  규정(§14.2)의 일반화이며, MVP 3 scheduler가 이 경계를 넘는 설계를 사전에 금지한다. (증거: IO
  #303→#307 — 같은 `owned` 집합이 lease 소유와 actuation 권한으로 이중 해석되어 오염 발생, 단일
  composite scope owner로 수습.)
- **I-TD11. Presentation ≠ routing.** 대화형/표현 출력은 그 안에 모든 사실이 담겨 있어도 routing
  authority가 아니다. Coordinator는 durable canonical record(receipt / structured envelope / Store
  전이)에서만 전진하며, chat/표현 계층에서 직접 소비해 전이하는 경로는 존재하지 않는다. I-TD3의
  routing 측 보강이다. (증거: 본 프로젝트 CORR1 — 우회 활성화가 존재하지 않는 wiring을 보고; IO #307
  — chat-only Operator 완료가 canonical RESULT로 교정된 라이브 사례.)

- **I-TD12. Capture-before-teardown ([계약], v1.3 승격 — ADP #3 AMENDMENT-1의 좁힌 문구 채택).**

  ```text
  Ephemeral execution surface MUST NOT be destroyed while evidence or
  diagnostic artifacts required by an authoritative record remain solely
  on that surface.

  Before teardown:
  - required artifact is durably captured, OR
  - durable loss/unavailability is explicitly recorded.
  ```

  "모든 것을 저장한다"가 아니라 **"authoritative record가 참조하는 것을 조용히 파기하지 않는다."**
  캡처 범위는 authoritative record의 참조가 정의하며, 무엇을 어떤 형태로 뜰지는 mechanism 결정으로
  각 적용 절(§13.2/§14.3/§15)이 다룬다. I-TD7(secret 금지)이 항상 우선한다 — secret이 포함된
  아티팩트는 redaction 후 캡처하거나 손실 기록을 남긴다. (원장: 원안 "전부 blob 캡처"는
  mechanism-과잉으로 판정되어 교체됨 — #3 AMENDMENT-1.)

  **실행 판정 (v1.4, #3 PRACTITIONER-DELTA 채택 — deterministic teardown predicate):**

  ```text
  authoritative ref exists
  + artifact is ephemeral-only
  + no durable artifact reference AND no explicit durable unavailable/lost record
  → teardown DENY
  ```

  참조가 (1) durable artifact reference 또는 (2) explicit durable loss record 중 정확히
  하나로 해소될 때까지 파기는 금지된다. 이 predicate는 캡처 storage mechanism을 지정하지 않는다.

  **적용 시점 ([계약], v1.4 — practitioner review의 소급 질문에 대한 답):** I-TD12는
  **PROSPECTIVE_REQUIREMENT**다 — live composition/pilot 이후의 신규 코드에 binding이며,
  sealed MVP 1의 기존 teardown path에 소급 적용되지 않는다. 기존 path의 상태는 main-sync
  applicability map(§31)에서 분류만 한다.

**Applicability note ([계약]).** I-TD8~I-TD11은 v1.2, I-TD12는 v1.3 신설이다. 기존 MVP 0/1 FORMAL 판정을 소급
무효화하지 않는다 — 현행 구현의 conformance 평가는 §31 register의 read-only 과제로 수행하며, 발견된
gap만 통상 절차로 leaf가 된다. 신설 invariant는 다음 구현 batch부터 신규 코드에 binding이다.
(이 note는 I-TD12에도 동일하게 적용된다.)

---

## 3. System Context / Component Diagram

```text
Human / Slack
     │
     ▼
Supervisor Runtime (OpenClaw RuntimeSession — Backend v1)
     │  MCP (Platform API transport)
     ▼
┌─────────────────────────────────────────────────────┐
│ Platform API / MCP Adapter                          │
│  - Supervisor Proposal 수신, Platform read model 제공 │
├─────────────────────────────────────────────────────┤
│ Common Platform Core (단일 프로세스, 단일 writer)      │
│                                                     │
│  Profile Registry / Compiler                        │
│  TaskSource Coordinator                             │
│  Decision Validator                                 │
│  Capability Broker                                  │
│  Platform State Store (SQLite, §18)                 │
│  Platform Coordinator / State Machine (§7,§19,§20)  │
│  Verification Coordinator (§15)                     │
│  Pending Human Decision Store (§17)                 │
│  Repository Gate (§14)                              │
│  Report Outbox (§21의 idempotent reporting)          │
└───────────────┬─────────────────────────────────────┘
                │  Backend Contracts (interfaces only)
   ┌────────────┼──────────────┬───────────────┬────────────────┐
   ▼            ▼              ▼               ▼                ▼
RuntimeAdapter  WorkflowAdapter RepositoryAdapter VerificationAdapter ReportAdapter
(OpenClaw)      (durable-jobs)  (local Git /      (Local, 향후 CI)     (Slack)
                                optional GitHub)
```

핵심 topology 결정:

- **Platform Core는 Supervisor Runtime 밖의 독립 프로세스다.** Supervisor는 MCP로 Proposal을 제출하는
  클라이언트일 뿐이며, Coordinator loop·durable state·side effect는 전부 Core 프로세스가 소유한다.
  (Spec §32: Supervisor auto-continuation 비요구. Runtime↔Platform 순환 topology 위험을
  "Platform이 Runtime 안에 살지 않는다"로 절단한다.)
- **단일 writer.** Platform State Store에 쓰는 주체는 Core 프로세스 하나뿐이다. Supervisor/Actor/Auditor는
  Store에 직접 접근하지 않는다.
- **Core는 trusted identity issuer가 아니다 (I-TD5).** Backend가 host-derived trusted context를 요구하는
  호출(현재: durable-jobs `workflow.start` / `audit_decide`)은 Core가 직접 수행하지 않고, RuntimeAdapter가
  발급·관리하는 opaque handle 뒤의 **backend-authoritative identity**를 통해 수행한다.
  초기 OpenClaw Backend에서의 우선 검토 topology:

  ```text
  Platform Coordinator
          │  WorkflowControllerHandle (opaque)
          ▼
  OpenClawRuntimeAdapter
          │
          ▼
  Managed Platform-Controller Session   # host가 identity 발급·관리
          │  host-derived trusted context
          ▼
  durable-jobs workflow.start / audit_decide
  ```

  Core는 controller session의 agentId/sessionKey를 알지 못하고 생성하지도 않는다. 상세는 §13.3/§16.3,
  구현 확정 전 사항은 `IMPLEMENTATION GAP RA-3`(§30).

---

## 4. Build vs Reuse Boundary

### 4.1 Reuse (Platform Core에서 재구현 금지)

| 재사용 대상 | 제공 primitive | 근거 (capability 문서) |
|---|---|---|
| OpenClaw | persistent session `[L]`, session-bound trusted tool context `[L]`, spawn child `[P]`, worktree service `[D]`, Slack/control-plane `[L]` | §1 |
| durable-jobs | journaled workflow store `[D][L]`, stage advance `[D]`, resume/attempt `[D]`, idempotent start `[D][L]`, restart reconcile `[D][L]`, audit_decide gate `[D]`, verification-level 강제(`SUFFICIENT_VERIFICATION_LEVELS`) `[D]`, redaction | §2, §4 |
| Git | worktree/branch/lineage/ff-only primitive | — |
| optional GitHub | protected branch, required checks, server-side merge | §45 전략 B |
| Slack | report/control surface (frozen delivery route) | §1 |

### 4.2 Build (Platform Core 자체 자산)

Profile Compiler · Execution Policy compilation · Compiled Profile Snapshot · Decision Validator ·
ProjectDocumentTaskSource(+ generic TaskSource contract) · Immutable Task Contract · Capability Broker ·
Child Task Materialisation contract/Coordinator ·
Platform Durable State/Store · Platform Coordinator(state machine, batch) · Verification Policy/Evidence binding ·
PendingHumanDecision · Repository Gate policy · Recovery/Reconciliation logic · Report Outbox.

### 4.3 만들지 않는 것 (지시서 §4/§29 그대로)

generic coding agent, terminal emulator, generic process runner, Git worktree engine, generic workflow engine,
GitHub/Jira client 재구현, CI engine, PR UI, diff viewer, model provider client, Slack transport,
새 agent session manager, plugin marketplace, workflow DSL, multi-runtime production adapters.

---

## 5. Core Components — responsibility / authority / must-not-own

각 component: **responsibility · input · output · authoritative state · side effects · must-not-own**.

### 5.1 Platform API / MCP Adapter
- responsibility: Supervisor의 structured Proposal 수신, Platform read model(현재 task/batch 요약, pending decisions) 노출.
- input: MCP tool call (JSON). output: validation 결과 / read model.
- authoritative state: 없음 (stateless transport).
- side effects: 없음 — 모든 side effect는 Coordinator에 위임.
- must-not-own: 어떤 policy 판단도 하지 않는다. MCP schema에 OpenClaw 타입을 노출하지 않는다.
- **Proposal ingress authority (M1-3).** `Supervisor → MCP → Platform API/MCP Adapter →
  SupervisorProposalV1`이 **유일한 authoritative 제출 경로**다(§26 step 5). `RuntimeTurnResult`에
  model structured output이 존재할 수는 있으나 그것은 **Proposal submission authority가 아니다**
  (I-TD3). transport는 transport일 뿐이다 — policy 판단 없음, state transition 없음, side effect 없음.
- **Submission context binding (M1-3).** Proposal schema(§9.1)는 변경하지 않는다. 대신 transport
  invocation이 `{ run_id, batch_id, proposal }` 최소 context를 갖는다. `run_id`/`batch_id`는 Proposal
  body에 **hash되는 field가 아니라** MCP transport routing context이며, Core는 제출 시 durable state로
  다음을 검증한다:

  ```text
  run이 존재한다
  batch가 그 run에 속한다
  batch가 이 제출의 current/eligible batch다
  compiled profile context가 proposal.expected.compiled_profile_hash와 일치한다
  ```

  Model이 공급한 run/batch context를 execution authority로 승격하지 않으며, proposal snapshot table을
  만들지 않는다(§9.1 유지).

### 5.2 Profile Registry / Compiler
- responsibility: Project Profile + Execution Policy + Approved Overrides 로드·검증·합성(§7 규칙) → Compiled Profile Snapshot 생성/보관.
- input: profile/policy 문서(YAML), overrides. output: `compiled_profile` (immutable row + hash).
- authoritative state: Profile/Policy/Compiled Profile 원문과 hash.
- side effects: Store에 immutable snapshot 기록 — durable home은 `compiled_profile_snapshot`(§18.1a).
- must-not-own: 프로젝트 classification의 의미 해석, 성숙도 판단.

### 5.3 TaskSource Coordinator
- responsibility: TaskSource adapter 호출, TaskCandidate/Definition/Dependency 캐시, external state projection.
- authoritative state: 없음. external task definition의 authority는 TaskSource(§55).
- side effects: `update_task_projection` (optional, adapter 경유).
- must-not-own: Platform task lifecycle 상태. **TaskSource ≠ durable state**를 코드 경계로 강제 — Coordinator는 TaskSource 응답을 Store의 `external_snapshot` 컬럼에 "관측 기록"으로만 저장한다.

### 5.3a Child Task Materialisation boundary (Issue #59, prospective MVP 3)
- responsibility: validated bounded child semantics를 §8.1b의 configured materialisation adapter에
  idempotent publish하고, 같은 configured TaskSource의 fresh round-trip을 검증한 뒤 §8.4 discovery row에
  immutable materialisation binding을 붙인다.
- input: validated `SubflowChildMaterializationProposalV1`, batch-bound Compiled Profile v3,
  `ChildMaterializationParentViewV1`, `ChildMaterializationBatchViewV1`.
- output: immutable `ChildTaskMaterializationSnapshotV1` + exact adapter receipt + fresh TaskSource-observed
  `DISCOVERED` child, 또는 side effect 0인 deterministic rejection/fail-closed recovery outcome.
- authoritative state: validated semantic source는 immutable materialisation snapshot, published external
  identity/representation은 adapter receipt, 이후 task definition authority는 fresh TaskSource observation.
- side effects: configured target에 child representation 하나 생성. update/delete/upsert, 다른 task/source,
  repository/runtime/workflow mutation은 범위 밖이다.
- must-not-own: child classification/pipeline/role/verification/scope 선택, parent suspension, admission,
  Task Contract build, scheduler priority, dynamic workflow/model topology. Supervisor/MCP/Runtime는 이
  adapter를 직접 호출할 수 없다.

### 5.4 Decision Validator
- responsibility: Supervisor Proposal의 deterministic 검증 (Spec §18의 11개 항목 + Backend Compatibility Gate §13).
- input: Proposal + Compiled Profile + Backend Capability Manifest + caller가 공급한 read-model
  (TaskLookupView / RepositoryValidationView / DecisionValidationBatchView) — Validator Core는
  TaskSource·RepositoryAdapter·Store를 직접 호출하지 않는다 (§9.2, M0-27).
- 추가 진입점 하나: `validateDecisionAfterResolvedHumanGate` (§17.3). ordinary API/result contract는
  변경하지 않으며, resolved Human Gate 이후 fresh V1–V11 재검증을 위한 narrow seam이다.
- output: `ACCEPTED` | `HUMAN_GATE_REQUIRED` | `POLICY_REJECTED(reason_code)` |
  `BACKEND_INCOMPATIBLE(detail)` (§9.2, M0-26). `HUMAN_GATE_REQUIRED`는 거부도 실행 승인도 아닌
  deterministic branch다.
- side effects: decision_log append만. 실행은 하지 않는다.
- must-not-own: 실행, retry, 사람 알림.

### 5.5 Capability Broker
- responsibility: Compiled Profile + Role + Task Contract + Backend Capability Manifest → Effective CapabilityGrant 계산 (§13 TD).
- authoritative state: 발급된 grant (immutable row).
- must-not-own: enforcement 자체(Backend 소유), grant 확대 요청 수락(불가).

### 5.6 Platform Coordinator (§19–§22 상세)
- 유일한 side-effect orchestrator. state machine의 실행 주체.
- **MVP 0 public seam (M0-33).** §25가 이 계층을 MVP 0에서 `interface + dummy`로 요구하므로, MVP 0
  Coordinator의 logical surface는 정확히 세 역할뿐이다 — 실제 이름/casing은 언어·repo convention의
  구현 세부이며 architecture가 아니다.

  ```text
  tick_once()                              # caller-driven single step (§5.6a)
  observe(workflow_handle)  -> WorkflowObservation      # §14.2 그대로
  recover(run_id)           -> RecoveryClassification   # §22.4
  ```

  MVP 0 Coordinator는 **stateless shell**이다: `coordinator_state` table, `tick_cursor`, `last_tick`,
  `scheduler_state`, durable work queue를 만들지 않으며 in-memory queue를 authority로 삼지 않는다.
  durable authority는 §18의 Platform Store 하나뿐이므로 `Coordinator 객체 파기 → 동일 SQLite 재개봉 →
  새 Coordinator 객체`로도 Core authority가 유실되지 않는다. **migration은 추가되지 않는다.**

### 5.6a MVP 0 `tick_once` semantics (M0-33)

MVP 0의 tick은 **caller-driven · single-step · deterministic**이다.

```text
금지 (MVP 0):
  setInterval / setTimeout scheduler / background thread·process / cron /
  heartbeat / wall-clock sleep / self-rescheduling loop
```

§14.2의 "기본 30s tick"은 **MVP 1 production Coordinator의 scheduling configuration**이며 MVP 0 dummy의
contract가 아니다. `tick_once()`는 production external side effect를 수행하지 않는다.

반환값에 별도 authority vocabulary를 만들지 않는다 — `void`(또는 언어의 동등한 no-result contract)로
충분하며 `TickResult` enum / `CoordinatorEvent` / `CoordinatorCommand` 를 신설하지 않는다.

**Stage-boundary drift (M1-11).** Coordinator는 stage boundary마다 §11.4의 authoritative read를 모아
`DriftObservationV1`을 만들고 순수 evaluator를 호출한다. 판정 결과의 lifecycle 적용은 §19.3의 기존
transition helper가 수행하며, Coordinator가 drift 판정 자체를 소유하지는 않는다.

### 5.7 Verification Coordinator
- responsibility (M1-9 구체화): frozen verification request 조립 → `VerificationAdapter.start_verification`
  호출 → 불투명 `VerificationRunHandle` projection 저장 → `get_verification_result` polling →
  Evidence 수집·envelope 검증·binding(§15.2) → verification policy 평가(§15.3).
- authoritative state: VerificationEvidence rows (단, "fact"의 authority는 verification backend — Platform은 binding과 정책 판정을 소유).
- must-not-own: 검증 커맨드의 프로젝트 의미(Profile 소유), verdict의 semantic 해석(Auditor 소유),
  그리고 **verification backend의 실행 기전** — durable-jobs `WorkflowHandle`, local verification을 위한
  `WorkflowControllerHandle`, backend job state는 전부 VerificationAdapter 아래에 있다(§15.1, M1-9).

### 5.8 Pending Human Decision Store — §17.
### 5.9 Repository Gate — §14. canonical mutation의 유일한 수행자(MVP 2+).
### 5.10 Report Outbox — §21. state transition과 분리된 idempotent 알림 발송.

### 5.11 Diagnostic Projection (v1.3 신설 — derived read-only **contract**, component 아님)

[계약] Store fact와 adapter 관측을 사람이 읽을 수 있는 단일 산출물로 도출하는 계약. ADP #4
AMENDMENT-1의 조건을 그대로 채택한다:

- `diagnostic_packet(run_id | task_key | attempt_key)` → run/task/attempt 단위로 현재 state ·
  next-owner(I-TD8) · 최근 전이 · op_key INTENT/DONE · evidence/receipt 포인터 · reason code를
  한 번에 생성. **첫 소비자: HANDOFF §17의 15항목 이슈 패킷을 이 산출물로 승격**(수집 체크리스트 →
  자동 생성물).
- **per-field provenance 필수 (v1.4 확장 — #4 PRACTITIONER-DELTA 채택):**

  ```text
  per field:
    availability: AVAILABLE | UNAVAILABLE
    value: ...                       # AVAILABLE일 때만
    authority/source: ...            # §22.1 authority map
    observed_at: ...                 # 실제 관측이 있을 때
    freshness: fresh | durable_projection
    error_ref: ...                   # UNAVAILABLE일 때 optional
  ```

- **partial-result semantics ([계약]):** `one authority unavailable ≠ whole diagnostic packet
  unavailable` — 진단이 가장 필요한 순간(Runtime/Repository 조회 실패)에 진단 자체가 죽지
  않는다. 단 unavailable 값을 추정하지 않고, cached/durable projection을 `fresh`로 표시하지
  않는다 — 있는 그대로 표시가 전부다.
- must-not-own: 전이 권한 없음, side effect 없음, authority 없음 — projection은 두 번째 authority가
  되지 않는다(IO #298 교훈). 구현은 read-only 도출 함수로 시작하며 **component 승격은 구현 경험 후
  별도 결정**(§31 seam).

### 5.12 Measurement Projection (v1.3 신설 — DELTA-4, derived read-only contract)

[계약] IO #23의 Phase 3 측정 원칙("실행된 계약으로 귀속하라 — 라벨로 분류하지 말라", #25 교훈)의
ADP 번역. 신규 수집기가 아니라 **기존 durable 기록의 도출**이다:

```text
per attempt (key: task_contract_hash + attempt_key):
  role / role_profile / runtime_profile
                                    ← frozen selection + Compiled Profile + grant
  requested/actual provider/model   ← §13.5 binding + §13.2a RuntimeExecutionObservationV1
                                      (backend가 보고하지 않으면 UNKNOWN; profile 이름에서 추정 금지)
  wall-clock / stage 시간            ← state transition 타임스탬프
  verification/gate 시간             ← verify INTENT + evidence timestamp/run_reference + gate transition
  attempts / review rounds / rework  ← attempt.n, rework_count, audit_record
  human_handoffs                     ← next-owner=HUMAN 레코드 수 (I-TD8이 측정을 정의로 만든다)
  human_interventions (optional)     ← resolved decision / operator action 등 실제 human action
                                       record에 bind해 별도 derive — handoffs와 동일 metric 금지
  provider/runtime/infrastructure failures
  model/task/protocol failures       ← §24 lifecycle code + §24.1 FailureAttributionV1
                                      (서로 합치거나 한쪽을 다른 쪽으로 추정 금지)
  final typed outcome                ← Task/Attempt terminal state + reason code
  usage/cost                         ← { kind: REPORTED | ESTIMATED | UNKNOWN, value,
                                         estimator_version(ESTIMATED일 때만) } — 관측값과
                                       추정값을 합산 가능한 동급 fact로 승격하지 않는다
  escaped defect discovered later   ← §5.13 Finding의 escaped_from ref가 존재할 때만
```

[계약] **귀속 정밀화 (v1.4 — #9 PRACTITIONER-DELTA 채택):** normative measurement unit은
**attempt-level aggregate**다. MVP 1 FIX_REQUIRED에서 동일 Attempt 내 candidate A→B가
가능하므로, candidate-cycle detail은 기존 `candidate_commit / op_key / evidence` identity에서
derived하며 새 durable measurement identity(`measurement_cycle_id` 류)를 만들지 않는다.
Measurement Projection은 새 telemetry authority가 아니라 실행된 계약/기록의 정확한
read-only 도출이라는 경계를 유지한다.

[계약] **availability와 귀속.** 위 metric은 source record가 존재할 때만 `AVAILABLE`이다. source가 없거나
backend가 값을 제공하지 않으면 `UNKNOWN/UNAVAILABLE`로 남기며, profile 이름·wall-clock·요금표·평균 token
비율에서 실제 provider usage나 cost를 역산해 `REPORTED`로 기록하지 않는다. `ESTIMATED` cost는 currency,
estimator version, price-source ref, 계산 시점을 함께 가져야 하며 reported cost와 별도 series다. 여러
provider/model이 한 Attempt에 관측되면 하나로 뭉개지 않고 runtime operation별 observation을 먼저 내고,
attempt aggregate에는 mixed binding임을 표시한다. §13.5가 금지한 unapproved mid-attempt switch가
관측되면 measurement normalization으로 숨기지 않고 finding 후보로 노출한다.

[계약] **durable source minimum (PROSPECTIVE_REQUIREMENT).** completed Runtime turn의
`idempotency.DONE.result_json`은 redacted `RuntimeTurnResult`와 §13.2a observation을 보존한다. 이는 기존
write-ahead operation receipt의 result를 정밀화하는 것이며 `runtime_turn`/telemetry event table을 새로
만들지 않는다. 저장할 수 없는 provider-native field는 버리고 availability를 낮춘다(I-TD7). 기존 v1
receipt에 이 데이터가 없으면 과거 metric은 `UNKNOWN`이며 소급 합성하지 않는다.

[설명] **확장 규율 (baseline-first, IO #23 body[8] 준용):** 측정된 실패 클래스 없이 role/pipeline
stage/topology를 늘리지 않는다 — `observed failure class → missing capability 가설 → bounded
실험 → 비교 → 채택/폐기`. 이 규율은 MVP 3의 pipeline/role 확장에 대한 사전 구속이다. 목적 함수
(completed useful work ÷ (AI cost + human handling + failure cost))는 방향 지시용이며 텔레메트리
확보 전 문자 그대로 최적화하지 않는다.

### 5.13 Improvement Finding (v1.5 — derived semantic record, issue가 아님)

[계약, PROSPECTIVE_REQUIREMENT] 운영/E2E/verification/audit에서 관측된 이상을 continuing work로 넘길 때
사용하는 최소 generic record다. Finding은 **evidence에 근거한 분류된 진단 record**이지 Task/Attempt
lifecycle fact, Execution Policy, contract 변경 승인, repository mutation authority가 아니다.

Envelope은 `schema = "platform/improvement-finding"`, `schema_version = 1`이다. `finding_hash`는 envelope
전체의 hash이며 self-reference를 피하기 위해 body에 넣지 않는다(§6/§7.7 규율 재사용).

```text
ImprovementFindingV1Body {
  finding_id
  subject_ref                    # run/task/attempt/op/evidence 중 기존 generic ref
  classification: BUG | IMPLEMENTATION_GAP | BACKEND_GAP | OPERABILITY_GAP |
                  CONTRACT_GAP | CONTRACT_AMBIGUITY | CONTRACT_CONTRADICTION |
                  NON_BLOCKING_NIT
  summary
  evidence_refs[]                # non-empty; authoritative owner/provenance 확인 가능
  observation_refs[]             # optional; §22.5 anomaly/diagnostic packet ref
  discovered_at
  classifier: DETERMINISTIC_RULE | AUDITOR | HUMAN | MODEL_PROPOSAL
  classifier_ref
  escaped_from:                  # optional; 존재할 때만 escaped-defect metric이 성립
    { attempt_key, audit_id? }
  supersedes_finding_ref?        # 정정은 새 immutable record로만
}
```

- `MODEL_PROPOSAL` classification은 다른 classifier보다 높은 truth가 아니며 provenance가 보이는 제안이다.
  evidence ref의 존재·integrity·subject binding을 Platform이 검증하지 못하면 record 생성과 projection을
  fail-closed한다. classification confidence를 숫자로 지어내지 않는다.
- persistence는 기존 content-addressed `blob` + append-only `decision_log(kind=finding_recorded)`로 충분하다.
  별도 Finding authority DB/event bus를 만들지 않는다. immutable envelope는 같은 identity+같은 hash만
  idempotent하며 정정/재분류는 `supersedes_finding_ref`를 가진 새 record다.
- **반복 anomaly의 acknowledgement/presentation ([계약], v1.5 Operator-evidence amendment).** 같은
  `subject_ref` + 같은 `classification`에 대해 다른 valid Finding이 supersede하지 않은 Finding이 이미
  존재하는지는 위 immutable record chain에서 derive한다. 별도 acknowledgement row/state machine을 만들지
  않는다. presentation/notification layer는 그 `finding_ref`에 bind된 반복 anomaly를 하나의 continuing
  item으로 collapse하거나 후속 notification을 suppress할 수 있다. 이는 **표현 계층의 중복 억제일 뿐**
  anomaly 관측·Diagnostic Projection·raw observation 조회를 없애거나 lifecycle/reconciliation을 바꾸지
  않는다. subject/classification binding이 불명확하거나 unsuperseded Finding을 세울 수 없으면 이 규칙으로
  collapse하지 않는다.
- issue/task-system projection은 §21.1 Report Outbox를 재사용한다. `op_key`가 external create/update의
  idempotency identity이고 확인된 `backend_ref`는 `idempotency.DONE.result_json`에 durable receipt로
  보존한다. **Finding semantic record ≠ GitHub/Jira Issue**다. 외부 issue는 continuing work의
  receipt/index일 수 있으나 Core lifecycle/policy authority가 아니다. projection route/channel은
  deployment/operator가 명시적으로 구성해야 하며 Core가 repository URL이나 tracker를 추측하지 않는다.
  issue create/update를 수행하는 ReportAdapter primitive는 I-TD9 mutation reach와 가능한 operation을
  선언해야 한다; route가 없으면 Finding만 durable하게 남고 external projection은 없다.
- projected item이 다시 실행되려면 반드시 기존
  `TaskSource → Supervisor Proposal → Decision Validation → Immutable Task Contract` 경로로 재진입한다.
  Finding이나 issue 생성이 Task admission, retry, state transition, contract edit를 직접 일으키는 경로는
  없다. repair의 regression/E2E replay는 selected `verification_profile`이 수행하고, 그 Evidence가 repair
  Task Contract/candidate에 bind되어야 closure evidence가 된다.
- `CONTRACT_GAP` / `CONTRACT_AMBIGUITY` / `CONTRACT_CONTRADICTION`은 구현자가 TD/Spec 의미를 임의로
  정하는 authority가 아니다. 기존 `CONTRACT_DECISION`/Human-Governance 경로로 보낸다. Spec 변경이
  필요한 finding은 TD에서 봉합하지 않고 `SPEC_GAP`으로 STOP한다.

따라서 improvement loop의 portable form은 정확히 다음이다:

```text
authoritative evidence/observation
→ ImprovementFindingV1
→ optional issue/task-system projection receipt
→ normal TaskSource/admission/Task Contract
→ implementation repair
→ bound regression verification
→ bound E2E replay
```

### 5.14 Role-specific evaluation / routing recommendation (v1.5)

[계약, PROSPECTIVE_REQUIREMENT] evaluation은 하나의 global best-model score를 만들지 않는다. unit은
`role × task/corpus class × runtime binding × assurance context × role-input-context cohort`이며
provider/runtime/infrastructure failure를 model quality denominator에 조용히 넣지 않는다.

| role | 최소 quality signal | 기존 source |
|---|---|---|
| Actor / implementer | first-pass acceptance, deterministic acceptance coverage, scope/architecture invention, rework, later escaped defects | Task Contract, Evidence, audit_record, Finding |
| Auditor / Reviewer | seeded material-defect detection, false block, authority/provenance finding, PASS 뒤 escaped defect | corpus ground truth, verdict/audit_record, Finding |
| Supervisor / planning | contract-gap recognition, bounded decomposition, architecture invention, executable-vs-governance classification | TaskDefinition/corpus ground truth, Proposal/decision_log, Finding |

- **evaluation input completeness ([계약], v1.5 Operator-evidence amendment).** 같은 provider/model이라도 role이
  실제로 받은 contract/acceptance/authority context가 다르면 같은 benchmark condition이 아니다. 각 sample은
  provider-specific prompt format이나 raw prompt를 Core에 고정하지 않고 다음 최소 provenance를 보존한다:

  ```text
  EvaluationInputContextV1 {
    role_input_context_identity        # 실제 전달/읽기 가능하게 한 normalized manifest의 hash/ref
    required_context_manifest_ref      # corpus/profile이 요구한 context category/version
    contract_context:          PRESENT | ABSENT | UNKNOWN
    acceptance_context:        PRESENT | ABSENT | UNKNOWN
    authority_boundary_context:PRESENT | ABSENT | UNKNOWN
    input_completeness: COMPLETE | PARTIAL | UNKNOWN
    provenance_refs[]                  # Platform input manifest + Runtime/backend delivery observation
  }
  ```

  `PRESENT`는 해당 contract가 Store에 존재한다는 사실만으로 만들지 않는다. 그 role의 해당 turn에서 실제로
  전달되었거나 capability 안에서 읽을 수 있었음이 operation-bound provenance로 확인되어야 한다. 모든 required
  category가 확인될 때만 `COMPLETE`, 하나라도 known `ABSENT`이면 `PARTIAL`, 전달 여부를 증명할 수 없으면
  `UNKNOWN`이다. manifest는 전달된 authoritative ref/category의 identity이고 raw prompt·secret·provider-native
  serialization을 저장하지 않는다(I-TD7). 기존 content-addressed blob + runtime operation receipt를 재사용하며
  evaluation-input table이나 prompt framework를 만들지 않는다.
- material하게 다른 `required_context_manifest_ref` 또는 `input_completeness`를 가진 sample은 같은 comparable
  cohort로 pool하지 않는다. 별도 stratum으로 보고하거나 제외하고 그 사유를 `exclusions/limitations`에 남긴다.
  context를 우연히 추론해 맞춘 run은 context-complete run으로 승격하지 않는다. `assurance_context`는 검증
  assurance이고, role에게 실제 제공된 input context와 서로 대체되지 않는다.
- harness topology는 새 Core subsystem이 아니다. versioned/immutable corpus를 TaskSource로 제공하고, 후보를
  `roles`, 허용 stage를 `pipelines`, oracle/regression/E2E를 `verification_profiles`, mutation boundary를
  `repository_scopes`로 선언한다. 실제 ADP/IO에서 재현 가능한 failure class를 우선하되 IO state machine,
  labels, planning lane을 복제하지 않는다.
- 한 benchmark run은 평가 대상 role/runtime binding을 하나로 고정한다. 평가 대상 Model이 자기 binding,
  ground truth, accepted assurance를 선택하게 하지 않는다. corpus version/hash, seed/expected material
  finding, Task Contract, verifier identity를 보존해야 rerun 비교가 가능하다.
- `RoutingRecommendationV1`은 Measurement Projection에서 만드는 read-only operability output이다:

  ```text
  { role, task_or_corpus_class, assurance_context, candidate_runtime_profile,
    observed_provider, observed_model, sample_size, quality/failure/latency/usage/cost refs,
    exclusions, limitations, generated_at }
  ```

  값이 없는 metric은 UNKNOWN이며 composite leaderboard 숫자를 필수로 만들지 않는다. recommendation은
  Project Profile change proposal이나 Supervisor decision context의 evidence가 될 수 있지만, Coordinator,
  RuntimeAdapter, Profile Compiler가 직접 소비하는 policy input은 아니다(I-TD10).
- **automatic evidence-based routing은 채택되지 않았다.** 추가하려면 새 Execution Policy version에서
  eligibility, evidence window/sample sufficiency, assurance/capability floor, fallback order, rebind boundary,
  failure/reconciliation semantics를 명시하고 Compiled Profile/Task binding에 동결해야 한다. 그 전에는
  recommendation이 runtime/model을 바꾸거나 provider failure를 fallback으로 재해석할 수 없다.

- **책임 경계 (M0-5).** Outbox는 **Platform Core 소유**다. ReportAdapter는 Outbox를 소유하지도,
  읽지도, 그 저장 표현(§18.1 `report_outbox` row)을 보지도 않는다. Core가 outbox row를
  `ReportDeliveryRequest { op_key, channel, payload }`로 **투영해** adapter를 호출하고,
  확인된 delivery 이후에만 `sent_at`을 기록한다(§21 Reporting). report policy와 payload 생성은 Core,
  transport는 adapter — 이 경계를 넘는 방향의 의존은 없다.

---

## 6. Data Contracts — canonicalization & hashing (Q1 결정)

**Decision (Q1).**

1. 모든 hash 대상 문서(Project Profile, Execution Policy, Compiled Profile, TaskDefinition,
   Task Contract Snapshot, Contract Source Snapshot, CapabilityGrant)는 로드 후
   **제한된 JSON data model**로 정규화한다: `object / array / string / integer / boolean / null`만 허용.
   **float 금지** (필요 시 string으로 표기). YAML 원문은 입력 포맷일 뿐 hash 대상이 아니다.
2. Canonical serialization: **RFC 8785(JCS) 부분집합** — UTF-8, object key 오름차순 정렬(code point),
   무의미 공백 없음, integer는 10진 최소 표기. float를 금지했으므로 JCS의 number 직렬화 난점이 제거되어
   수십 줄 수준의 구현으로 충분하다.
3. Hash: `sha256`, 표기 `sha256:<lowercase-hex>`.
4. 모든 hash는 **envelope 포함** hash다:
   ```json
   { "schema": "platform/task-contract", "schema_version": 1, "body": { ... } }
   ```
   envelope 전체의 canonical bytes를 hash한다. schema_version 변경 = 다른 hash (versioned 요구 충족).
5. Contract Source(파일)는 **raw bytes의 sha256** (`content_hash`)로 별도 취급한다. 정규화하지 않는다
   (개행/인코딩 변조도 drift로 간주해야 하므로 raw가 옳다).
6. `compiled_hash`는 `project_profile_hash + execution_policy_hash + overrides_hash + effective body`를
   담은 envelope의 hash다. 구성요소 hash가 body에 포함되므로 체인 무결성이 성립한다.

- Rationale: deterministic·restart-stable·field-order-independent·versioned 요구를 최소 구현으로 충족.
- Alternatives rejected: YAML canonicalization(정규화 규칙 부재), 완전 RFC 8785(float 처리 복잡),
  protobuf/CBOR canonical form(1인 프로젝트 과잉), git object hash 재활용(파일 외 문서에 부적합).
- Failure behavior: 정규화 불가 입력(float, 비-UTF8, 중복 key) → `PROFILE_COMPILE_ERROR` /
  `CONTRACT_BUILD_ERROR`로 **실행 전 거부**. 절대 "가까운 값"으로 보정하지 않는다.
- MVP impact: MVP 0의 Profile Compiler·Contract 빌더가 즉시 사용. 이후 변경 시 schema_version만 올린다.

**Schema-declared semantic set (M0-13).** 일부 schema는 특정 collection을 **순서가 semantic이 아닌 set**으로
정의한다. 그런 field는 generic canonical serialization **이전에** schema-specific canonical
normalization을 거친다:

```text
schema validation → schema-specific normalization → normalized constrained JSON
                  → §6 canonical serializer → envelope hash
```

- normalization의 canonical order는 **Unicode code-point 오름차순**이며, 이는 §6 item 2의 object key
  ordering과 **동일한 ordering relation**을 재사용한다. locale 의존 collation(localeCompare, system
  locale, case-insensitive, enum 선언 순서, 입력 순서)을 canonical authority로 쓰지 않는다.
- **generic array는 계속 order-sensitive다.** §6 serializer의 array semantics는 변경되지 않으며,
  schema가 semantic set이라고 명시한 field만 normalization 대상이다. "모든 array를 정렬"하는 동작은 없다.
- v1의 semantic set 목록은 §7.1b(3종)와 §7.1c(1종)에 열거된 것이 전부다.

`ADR-CANDIDATE: canonical-json-jcs-subset + sha256 envelope hashing`

### 6.1 공통 식별자 규약

```text
run_id        = run:<ulid>
batch_id      = batch:<run_id>:<n>
task_key      = task:<project_id>:<external_task_ref>        # external ref는 TaskSource가 부여
attempt_key   = attempt:<task_key>:<n>
op_key        = op:<attempt_key|batch_id>:<operation>[:<qualifier>]   # §21 Idempotency
```

**Composition rule — D+ positional injectivity (Decision, MVP 0).**
위 모든 generic identifier는 자신의 **logical component tuple에 대해 injective**해야 한다. 서로 다른
tuple이 같은 문자열로 합쳐지는 경로가 존재해서는 안 된다 — §18.1의 `op_key PRIMARY KEY` /
`dedup_key UNIQUE` / row identity와 §21의 stable idempotency identity가 이를 전제한다. injectivity는
**encoding·escaping·surrogate 없이**, component의 소유권에 따른 최소 grammar로만 확보한다.

- **Adapter-scoped opaque component.** `external_task_ref`는 TaskSource가 부여하는 opaque string이며
  **Core는 그 의미도 내부 구조도 해석하지 않는다**(§8.1 `adapter-scoped opaque ref` 그대로 보존).
  `:` 포함을 허용하고, **Core는 delimiter-safe charset이나 encoding domain을 부과하지 않는다.**
  `task_key`에서는 `project_id` 뒤 첫 structural separator 이후의 **나머지 문자열 전체**가
  `external_task_ref`에 해당한다.
- **Core/Profile-owned structural boundary component.** 아래 component만 injective 합성에 필요한
  최소 grammar를 진다. project/backend semantics를 해석하기 위한 제약이 아니라 §6.1 nested grammar의
  구조 경계를 확정하기 위한 Core structural grammar다.
  - `project_id` — `:` 금지 (task_key의 첫 structural separator를 확정)
  - `<n>` (batch/attempt ordinal) — decimal integer, 해당 형태의 terminal component
  - `operation` — non-empty, `:` 금지, **순수 decimal token 금지**
    (허용하면 opaque ref가 `r:1`인 attempt와 `op:…:r:1:2:z`가 operation=`2`·qualifier=`z`로도,
    n=`2`·operation=`z`로도 읽혀 collision이 성립한다)
  - `qualifier` — optional. 존재 시 **단일** structural segment이며 `:` 금지
  - `<ulid>` — 고정 길이 ULID
- **Decoding/reversibility는 Core 요구가 아니다.** 요구되는 속성은 injectivity와 determinism(동일
  logical tuple → 재시작 이후에도 동일 문자열)뿐이다. Store는 구성요소를 별도 컬럼으로 보관하므로
  (§18.1) 식별자를 되파싱할 필요가 없고, 범용 identifier decode/parse API를 두지 않는다.
- **금지.** 새 identifier codec(percent/base32/base64/length-prefix 등), hash 유래 surrogate identity,
  random UUID identity, 범용 ID framework를 도입하지 않는다.
- 동일 rule이 §6.1 형태를 재사용하는 파생 key(§17.1 `dedup_key`)에도 그대로 적용된다.

`ADR-CANDIDATE: D+ positional injectivity for generic identifiers (no codec, no surrogate)`

Backend 고유 reference(durable-jobs workflowId, PR number 등 **non-secret** ref)는 generic 식별자에
**절대 포함하지 않고** `adapter_metadata` (entity별 JSON, adapter namespace key)로 격리한다.
예외: git commit SHA는 RepositoryAdapter가 소유한 fact로서 repository 필드에 저장한다(§55 authority).

**Secret 금지 (I-TD7):** `adapter_metadata`에도 **raw secret-bearing identifier는 저장할 수 없다** —
raw ACP sessionKey, token, Authorization header, secret env 값 일절 금지. 세션을 재식별해야 하면
adapter가 발급한 opaque handle 또는 **redacted fingerprint**(truncated hash — durable-jobs
`redactAuditText`/`publicAuditProjection` 규약과 동일 정신)만 기록한다. handle→raw identity 해석은
해당 adapter/Runtime 자체 store의 책임이며, Platform DB가 유출되어도 trusted identity가 유출되지 않는
구조를 schema 수준에서 보장한다.

---

## 7. Profile Compilation TD

### 7.1 합성 파이프라인

```text
load(project_profile.yaml)  → normalize → validate(schema v1) → hash
load(execution_policy.yaml) → normalize → validate(schema v1) → hash
load(approved_overrides)    → normalize → validate            → hash
        ↓
merge (7.2 규칙)
        ↓
effective 검증 (7.3)
        ↓
Compiled Profile Snapshot (immutable, compiled_hash)
```

**Schema 설계 원칙 (v1 확정).** 전 schema에 일관 적용한다:

```text
Core-consumed structure                  → strict schema (unknown field = COMPILE_ERROR)
Project/backend/adapter-specific body    → opaque constrained JSON (내부 unknown field는 preserve)
Project semantics                        → Project Profile
Automation authority                     → Execution Policy (유일한 source)
```

`config` 류 opaque body도 §6의 제한 JSON data model만 허용한다(float 금지 등 동일 규칙).
Project Profile에는 automation-authority field를 두지 않는다 — 이는 §7.5의 schema boundary로 강제한다.

**Input boundary (P8 확정).** Compiler의 input은 **normalized constrained JSON object**다. YAML/파일
로딩은 Profile Registry(입력 계층, §5.2)의 책임이며 Compiler는 파서 의존성을 갖지 않는다. YAML의
철자·대소문자 정규화도 Compiler 책임이 아니다 — normalized object가 canonical 값을 담고 있어야 한다.

### 7.1a Project Profile schema v1 (`ProjectProfileV1`)

Envelope: `schema = "platform/project-profile"`, `schema_version = 1`.

Body top-level은 **정확히** 아래 11개이며 **전부 required**다. 빈 collection/object는 허용하되 field
자체의 생략은 허용하지 않는다. 미기재 top-level field는 reject → `COMPILE_ERROR`.

```yaml
project_profile:
  id: <non-empty string>          # §6.1 project_id structural grammar — ":" 금지
  version: <integer >= 1>

  repository:
    adapter: <non-empty string>
    config:  { ... }              # opaque. path/provider/location 등은 전부 이 안에 있다

  task_sources:                   # §8.2를 canonical schema로 승격
    - id:     <non-empty string>  # unique
      adapter: <non-empty string>
      config:  { ... }            # opaque — parser-specific vocabulary는 여기에만 존재(I-TD1)

  contract_sources:
    - path: <non-empty string>    # unique. content_hash는 Profile field가 아니다
                                  # (Task Contract build 시 §10.1/§10.2가 생성)

  classifications:                # key = Profile-owned vocabulary, Core는 의미를 해석하지 않는다
    <classification_name>:
      default_execution_policy: <ExecutionDisposition>

  roles:
    <role_profile_id>:
      runtime_profile: <non-empty string>   # RuntimeAdapter가 해석할 profile reference
      config: { ... }                       # opaque — tool/permission semantics는 Core가 해석 안 함

  pipelines:
    <pipeline_id>:
      steps: [ <PipelineStep>, ... ]        # non-empty
      auditor_profile: <role_profile_id>    # M1-10 — steps에 AUDITOR가 있을 때만, 그때는 필수
                                            # roles의 key를 참조한다. 없는 pipeline이면 field 자체가 없다.

  verification_profiles:
    <verification_profile_id>:
      adapter: <non-empty string>
      config:  { ... }            # argv/timeout/expected artifact 등은 전부 이 안 (§15.1은 예시)

  repository_scopes:              # M1-6 — repository mutation scope의 선언 authority
    <repository_scope_id>:        # non-empty, object key이므로 unique
      allowed_paths:   [ ... ]    # exact RepositoryScopeV1 (§10.1)
      forbidden_paths: [ ... ]    # 두 array 외 unknown field는 reject

  hooks:
    <hook_name>:
      adapter: <non-empty string>
      config:  { ... }            # inline script 금지 (§7.3)
```

**`repository_scopes` (M1-6).** Task Contract의 `repository_scope`(§10.1)가 required인데도 그 값의
authoritative source가 없었다 — 그대로 두면 Task Contract builder의 caller가 execution mutation 경계를
임의로 정하게 된다. 이 field가 그 authority다.

```text
required             MVP 1에서 최소 1 entry (빈 map은 COMPILE_ERROR)
scope body           exact RepositoryScopeV1 — allowed_paths / forbidden_paths 둘뿐,
                     unknown field reject, §10.1의 validation semantics를 그대로 재사용
ordering             generic array이므로 order-sensitive, semantic-set normalization 없음(M0-13)
```

**implicit default를 만들지 않는다** — 선언되지 않은 scope, `["."]`, `["**"]`, empty-means-everything
같은 whole-repository 기본값은 존재하지 않는다. 새 glob/regex/path DSL도 만들지 않는다: v1의 generic
path array semantics 그대로이며, 실제 대조는 §14.3의 mechanical path 비교가 수행한다.

`repository_scopes`는 **project-specific execution scope semantics**이며 Execution Policy의 automation
authority를 대체하지 않는다. 세 축은 서로 독립이고 어느 것도 다른 것에서 추론되지 않는다:

```text
Project Profile repository_scope        승인된 task가 repository의 **어디를** 바꿔도 되는가
CapabilityGrant repository.feature_write  Actor가 **쓸 수 있는가** (§12.4)
Execution Policy capability_requirements  어떤 **enforcement assurance**가 필요한가 (§12.2)
```

특히 broad scope가 `feature_write=true`를 뜻하지 않고 narrow/empty scope가 `feature_write=false`를 뜻하지
않는다 — §12.7의 path→capability inference 금지가 그대로 유지된다.

**`ExecutionDisposition` (Core-fixed generic vocabulary v1, 고정):**

```text
AUTO_EXECUTE | AUTO_SUBFLOW | HOLD_HUMAN
```

classification **name**은 project 소유 어휘이고 **value**는 Core 어휘다 — profile은
`project classification name → generic disposition` 매핑을 선언할 뿐이다. `READY_ITEM`,
`THIN_FOUNDATION` 같은 project 이름을 Core enum에 넣지 않으며, 새 disposition을 임의 추가하지 않는다.

**`PipelineStep` (Core-fixed v1 vocabulary, 고정):**

```text
ACTOR | VERIFY | AUDITOR | MERGE_GATE | RESUME_PARENT | HUMAN_GATE
```

pipeline은 Core lifecycle template이므로 opaque config로 두지 않는다. v1에서 pipeline DSL·분기·조건식을
만들지 않으며, **pipeline body 안에 actor_profile / verification_profile reference를 넣지 않는다** —
그 둘은 Supervisor Proposal(§9.1)의 선택값으로 유지한다.

### 7.1b Execution Policy schema v1 (`ExecutionPolicyV1`)

Envelope: `schema = "platform/execution-policy"`, `schema_version = 1`.

Body top-level은 **정확히** 아래 12개이며 **전부 required**다. 명시하지 않은 policy를 암묵 default로
보완하지 않는다(누락 = `COMPILE_ERROR`). 미기재 top-level field는 reject.

```yaml
execution_policy:
  id: <non-empty string>
  version: <integer >= 1>

  classification_policy:                    # §7.2 rule 2의 explicit 값이 놓이는 위치 (P3 확정)
    <classification_name>: <ExecutionDisposition>

  auto_merge:          <boolean>
  allow_auto_subflow:  <boolean>

  batch_policy:
    max_tasks:   <integer >= 1>
    max_rework:  <integer >= 0>
    concurrency: <integer >= 1>

  repository_policy:
    remote_push:            <RemotePushMode>
    direct_canonical_write: <boolean>
    allow_force_push:       <boolean>
    allow_tag_change:       <boolean>
    allow_git_clean:        <boolean>
    allow_reset_hard:       <boolean>

  human_gate_policy:
    required_decisions: [ <DecisionType>, ... ]     # §9.1 vocabulary 재사용, 중복 금지

  verification_policy:
    required_verification:
      <check_id>:
        accepted_assurance: [ <AssuranceLevel>, ... ]   # §15.2 vocabulary, empty·중복 금지

  capability_requirements:                  # §12.2 구조 그대로
    <operation_id>:
      <CapabilityName>:
        accepted: [ <EnforcementAssurance>, ... ]

  contract_drift_policy: { ... }            # §11.1/§11.2 그대로

  recovery_policy:
    capability_downgrade: HOLD | PAUSE
```

- **`RemotePushMode` (canonical, 대문자만 허용):** `DENY | PLATFORM_MANAGED_ONLY | FEATURE_BRANCH_ONLY`.
  Spec §7의 소문자 예시는 explanatory example이며 **Compiler는 silent case normalization을 하지 않는다** —
  normalized object에 소문자 값이 오면 schema invalid다.
- **`batch_policy` 예시값(3/2/1)은 sample policy 값이지 implicit default가 아니다.** 문서가 명시해야 한다.
- **`human_gate_policy.required_decisions`**: `proposal.decision ∈ required_decisions`이면 §9.2 V7이
  PendingHumanDecision 경로로 분기한다. array 순서는 semantic이 아니므로 set으로 정규화한다.
- **Semantic set canonical ordering (M0-13).** 아래 세 collection은 중복 거부·값 검증 이후
  **Unicode code-point 오름차순**으로 정규화한 뒤 hash한다(§6):
  ```text
  human_gate_policy.required_decisions
  verification_policy.required_verification.<check_id>.accepted_assurance
  capability_requirements.<operation_id>.<CapabilityName>.accepted
  ```
  `accepted_assurance`와 `accepted`는 Spec §41/TD §12.2가 accepted **set** semantics로 정의하므로 입력
  순서가 의미를 갖지 않는다. 반대로 `pipelines.<id>.steps`는 lifecycle 순서가 semantic이므로 정렬 대상이
  아니며, opaque `config` 내부 array도 adapter/project 소유 데이터라 Core가 재정렬하지 않는다.
  **MVP 1의 mandatory human merge(§19.4)는 이 field로 우회할 수 없다** — `PROPOSE_MERGE`를 빼도
  §19.4의 요구가 사라지지 않는다.
- **`capability_policy`는 canonical field가 아니다.** Spec §7의 개념적 `capability_policy: ...`는 TD가
  이미 구체화한 **`capability_requirements`(§12.2)로 실현된 것**이며, 두 개의 source of truth를 만들지
  않는다. §11.2 drift target의 키 이름도 `capability_requirements`를 사용한다.
- `recovery_policy`는 v1에서 `capability_downgrade` 한 field만 정의한다(implicit default 없음).
- **top-level 누락 금지의 유일한 예외는 `contract_drift_policy`의 *내부* 항목이다** — top-level field
  자체는 required이지만, 그 안의 7개 drift target은 §11.2가 기본값을 이미 확정했으므로 미기재 항목에
  §11.2 기본값을 적용한다. 그 외 어떤 policy도 암묵 default로 보완하지 않는다.

### 7.1c Approved Overrides schema v1 (`ApprovedOverridesV1`)

Envelope: `schema = "platform/approved-overrides"`, `schema_version = 1`.

```yaml
body:
  items:                          # empty 허용
    - field_path:     <v1 whitelist 중 하나>
      value:          <constrained JSON value>
      approval_ref:   <optional — permissive일 때 required>
      approval_hash:  <optional — permissive일 때 required>
```

items 순서는 semantic이 아니며, **동일 `field_path` 중복 override는 `COMPILE_ERROR`**다. 따라서 items는
검증 완료 후 **`field_path`의 Unicode code-point 오름차순**으로 정규화한 뒤 hash한다(M0-13). v1에서
`field_path`가 unique이므로 secondary sort key는 필요 없다.

**Override 대상은 Execution Policy field뿐이다.** Project Profile field에 대한 override는
`COMPILE_ERROR` — Approved Overrides는 project semantics 변경 수단이 아니다.

**v1 whitelist (이외 field_path는 전부 `COMPILE_ERROR`):**

```text
auto_merge
allow_auto_subflow
batch_policy.max_tasks
batch_policy.max_rework
batch_policy.concurrency
repository_policy.remote_push
repository_policy.direct_canonical_write
repository_policy.allow_force_push
repository_policy.allow_tag_change
repository_policy.allow_git_clean
repository_policy.allow_reset_hard
human_gate_policy.required_decisions
```

v1에서 override **금지**: `classification_policy`, `verification_policy`, `capability_requirements`,
`contract_drift_policy`, `recovery_policy`, 그리고 모든 Project Profile field. 확장이 필요하면 schema
version up 또는 명시적 TD 개정으로만 한다 — **arbitrary JSON path override를 만들지 않는다.**

### 7.1d Project Profile schema v2 — Supervisor role binding (v1.5, prospective)

[계약, PROSPECTIVE_REQUIREMENT] sealed MVP 0/1의 `ProjectProfileV1`은 변경하지 않는다. production MVP 4와
role-specific Supervisor evaluation에서 §13.4 `spawn_session(role=SUPERVISOR, runtime_profile=?)`의
`?`를 구현자/deployment가 임의로 채우지 않도록 v2는 v1 body에 **정확히 한 required field**를 더한다.

```yaml
project_profile:                       # platform/project-profile schema_version: 2
  # ProjectProfileV1Body의 모든 field 그대로
  supervisor_profile: <role_profile_id> # roles의 key를 참조
```

- `supervisor_profile`은 non-empty이고 `roles`에 존재해야 한다. missing/unknown reference는
  `COMPILE_ERROR`; roles의 첫 entry, 이름 `"supervisor"`, 설치된 유일 runtime profile, deployment default로
  추론하지 않는다.
- v2의 나머지 shape/normalization/authority는 v1과 동일하다. 새 role registry, Workflow Profile,
  per-stage DSL을 만들지 않는다. Supervisor의 `runtime_profile`은
  `roles[supervisor_profile].runtime_profile`에서만 해소한다.
- Project Profile은 허용된 role/runtime preference의 source이고 Grant 확대 authority가 아니다(§12.4).
  runtime/model 자동 교체 권한은 이 field가 만들지 않는다(§5.14/§13.5).
- v1 artifact와 sealed test는 계속 v1로 유효하다. v1을 production unattended composition에 사용하면서
  Supervisor runtime profile을 외부 default로 보완하는 것은 금지한다; 해당 composition은 v2로 명시적으로
  승격해야 한다.

### 7.1e Project Profile schema v3 — one TaskSource-bound child materializer (#59, prospective MVP 3)

[계약, PROSPECTIVE_REQUIREMENT] v1/v2를 수정하지 않는다. v3는 v2 body의 `task_sources` entry에 아래
optional exact field 하나를 허용한다:

```yaml
task_sources:
  - id: ...
    adapter: ...
    config: { ... }
    child_materializer:            # 없으면 이 source에는 materialisation authority 없음
      adapter: <non-empty string>
      config:  { ... }             # constrained opaque config
```

MVP 3 v1 materialisation scope는 **Project Profile 전체에 task source가 정확히 하나이고 그 entry에
`child_materializer`가 정확히 하나인 경우**뿐이다. 0개면 feature unavailable이고 profile compile 자체는
유효하다. `child_materializer`를 선언하면서 task source가 여러 개이거나 여러 target 중 하나를 골라야 하는
형상은 `COMPILE_ERROR`다 — Core가 parent ref, 이름, discovery order로 source/target을 추론하지 않는다.
multi-source routing은 별도 typed revision이다.

`child_materializer`는 Project가 어떤 external task representation을 사용할지 선언하는 project semantic일
뿐 automation authority가 아니다. 실행 허용은 batch-bound `effective.policy.allow_auto_subflow`와
`human_gate_policy`가 소유한다. Model Proposal에는 adapter/source/config 선택 field가 없으며,
Supervisor가 backend topology를 선택하지 않는다.

materializer와 TaskSource는 같은 entry에 bind되지만 **서로 다른 interface**다. `TaskSourceV1` 네 read
operation은 변경하지 않고, write mutation reach는 §8.1b contract 하나에만 존재한다. v3는 dynamic
pipeline/workflow/model topology, materializer registry, routing DSL을 만들지 않는다.

### 7.2 합성 규칙 (deterministic, versioned = `merge_rules_version: 1`)

1. **영역 분리는 schema가 강제한다.** Project Profile v1(§7.1a)에는 automation-authority field가
   존재할 수 없고(§7.5), Execution Policy v1(§7.1b)에는 project semantics field가 없다. 따라서 두 계약이
   동일 authority field를 동시에 선언하는 상황 자체가 v1 schema에서 불법이며, **Profile ↔ Policy merge에
   `more-restrictive wins`를 적용하지 않는다.** (`more-restrictive`는 rule 6의 override 방향 판정에서만 쓴다.)

2. **classification disposition 해소 (P3 확정).** Execution Policy의 explicit 값이 **항상 이긴다.**

   ```text
   for each name in project_profile.classifications:
       if name in execution_policy.classification_policy:
           effective[name] = execution_policy.classification_policy[name]     # automation authority
       else:
           effective[name] = project_profile.classifications[name].default_execution_policy   # proposal
   ```

   - Project default는 **semantic default/proposal**이고 Execution Policy explicit 값은
     **automation authority**이므로, 이 지점에도 more-restrictive를 적용하지 않는다.
   - `classification_policy`에 Project Profile에 없는 classification name이 있으면 `COMPILE_ERROR`.

3. **unknown field는 reject.** schema-owned wrapper의 unknown field는 `COMPILE_ERROR`이고, opaque
   `config` body 내부의 unknown field는 보존한다(§7.1 원칙).

4. **Approved Override 적용 범위.** override는 §7.1c whitelist의 Execution Policy field만 덮는다.
   whitelist 밖 field_path, Project Profile field, 동일 field_path 중복은 전부 `COMPILE_ERROR`.

5. **no-op override 금지.** override value가 적용 시점의 effective value와 동일하면 `COMPILE_ERROR`.
   의미 없는 override가 compiled_hash와 audit trail만 바꾸는 것을 허용하지 않는다(새 failure taxonomy를
   만들지 않고 기존 COMPILE_ERROR 계열을 사용).

6. **Override privilege direction과 authority binding (v1.1 → v1 확정).** Compiler는 각 override를
   현재 effective value와 비교해 **restrictive(권한 축소) / permissive(권한 확대)** 로 판정한다.

   privilege ordering (v1 whitelist 전 field에 대해 결정 가능):

   ```text
   boolean field (auto_merge, allow_auto_subflow, repository_policy.direct_canonical_write,
                  allow_force_push, allow_tag_change, allow_git_clean, allow_reset_hard)
       false < true                      # false 방향 = restrictive

   repository_policy.remote_push
       DENY < PLATFORM_MANAGED_ONLY < FEATURE_BRANCH_ONLY

   batch_policy.max_tasks / max_rework / concurrency
       smaller = more restrictive        # schema minimum(§7.1b)은 그대로 유지

   human_gate_policy.required_decisions  # set semantics
       strict superset = restrictive     # 요구 decision 추가
       strict subset   = permissive      # 요구 decision 제거
       incomparable(add+remove 동시) = COMPILE_ERROR (v1은 단일 override로 허용하지 않는다)
   ```

   - **restrictive override**: `approval_ref`/`approval_hash`가 **없어야 한다**(안전 방향).
     approval metadata를 붙이면 v1에서는 reject한다.
   - **permissive override**: `approval_ref`와 `approval_hash`가 **required**이며, YAML의
     `approved_by: human` 같은 문자열은 **authority가 아니다.**

     ```yaml
     approved_override:
       field_path: ...
       value: ...
       approval_ref: human-decision:<decision_id>   # 또는 operator-action:<action_id>
       approval_hash: sha256:...                    # 참조 레코드의 envelope hash
     ```

     Compiler는 (a) `approval_ref`가 durable 승인 레코드로 존재하고, (b) `status == RESOLVED`,
     (c) 그 레코드의 scope(`field_path`)와 승인된 value가 override와 **정확히 일치**하며,
     (d) `approval_hash`가 레코드 hash와 일치함을 검증한다. 하나라도 실패 → `COMPILE_ERROR`.

     **(c)의 "정확히 일치" 정의 (M0-13).** 두 값을 각각 `field_path`의 domain으로 검증하고 그 field의
     canonical normalization을 적용한 뒤 비교한다. 따라서
     `human_gate_policy.required_decisions`처럼 semantic set인 field는 **순서만 다른 동일 집합이
     mismatch가 아니다.** boolean·integer·`RemotePushMode` 같은 scalar는 종전의 exact equality 그대로다.
     override value 자체에도 동일 normalization이 적용되므로 no-op 판정, restrictive/permissive set 비교,
     `effective.policy` 반영이 모두 canonical set 기준으로 이뤄진다.

     **(d)는 정규화 대상이 아니다.** `approval_hash`는 authoritative 승인 레코드 envelope의 실제 hash와
     **raw 그대로** 비교한다 — approved_value의 semantic 비교와 record hash 비교는 별개다.

7. **Approval lookup boundary (P6 확정).** Profile Compiler는 concrete Store table을 직접 참조하지
   않는다. v1 dependency는 개념적으로 다음 하나면 충분하다:

   ```text
   lookup_approval(approval_ref) -> ApprovalBindingView | not-found

   ApprovalBindingView { ref, status, field_path, approved_value, record_hash }
   ```

   이는 generic authority framework가 아니다 — 주입된 함수/인터페이스와 deterministic fixture로 충분하며,
   `ApprovalRepository`·event bus·범용 authorization subsystem을 만들지 않는다. 구체 Store wiring은 이후
   Coordinator/domain-store 통합 시점에 연결한다. `human-decision:<id>`는 PendingHumanDecision(§17.1)의
   resolution을, `operator-action:<id>`는 §7.6 레코드를 **동일한 `ApprovalBindingView`로 projection**한다.

   **projection 성립 조건 (M0-31).** `human-decision:<decision_id>`는 다음이 모두 참일 때만 view를
   만든다: `status == RESOLVED` ∧ `resolution.approval_binding != null` ∧ terminal `record_hash` 유효.
   그때 `field_path`/`approved_value`는 `resolution.approval_binding`에서, `record_hash`는 최종
   PendingDecision envelope hash(§17.1f)에서 온다. 평범한 `HUMAN_GATE_APPROVAL`/`MERGE_APPROVAL`은
   `approval_binding`이 `null`이므로 **Profile override 승인 근거로 쓰일 수 없다** — 실행 승인이
   실수로 권한 확대 승인으로 번지는 경로를 차단한다. `operator-action:<id>`는 immutable row(§18.1a)를
   그대로 projection한다(`status`는 항상 `RESOLVED`). concrete 연결은 domain store의
   `lookupApprovalBinding(ref)` helper 하나면 충분하며 `ApprovalRepository`류 framework를 만들지 않는다.

8. 어느 부류든 override hash는 compiled_hash에 포함되어 감사 가능하다.

### 7.3 effective 검증

§7.1a–§7.1c schema 통과 이후, 합성 결과에 대해 아래를 **전부** 검사한다. 하나라도 실패하면
`COMPILE_ERROR`이며 Compiled Profile은 생성되지 않는다.

```text
S1  classification_policy의 key ⊆ project_profile.classifications의 key
S2  해소된 effective classification_policy가 project_profile.classifications 전체를 cover
S3  roles / pipelines / verification_profiles의 id set이 각각 non-empty key로 unique
      (object key이므로 중복은 구조적으로 불가 — 빈 문자열 key 금지)
S4  Supervisor Proposal(§9.1)이 참조할 source set이 존재:
      pipeline_id           ∈ project_profile.pipelines
      actor_profile         ∈ project_profile.roles
      verification_profile  ∈ project_profile.verification_profiles
      repository_scope_id   ∈ project_profile.repository_scopes   # M1-6, 최소 1 entry
S4a pipeline body의 auditor_profile (M1-10):
      steps에 AUDITOR 포함  → auditor_profile 필수, non-empty, ∈ project_profile.roles
      steps에 AUDITOR 없음  → auditor_profile 부재 (present면 COMPILE_ERROR)
      unknown/default role 해소 금지. 이것은 pipeline body에 role reference를 **선언**하는 것이지
      per-stage config를 여는 것이 아니다 — PipelineV1은 workflow DSL이 되지 않는다.
      (검증은 참조 시점에 V6가 수행한다. Compiler는 source set의 존재/형태만 보장하며
       pipeline body 안에 role/verification reference를 invent하지 않는다.)
S5  hooks wrapper valid — `{ adapter, config }`만 허용, inline script 금지
      (Profile이 프로그래밍 언어가 되는 것 방지, Spec §74 risk 1)
S6  task_sources wrapper valid + id unique
S7  contract_sources의 path unique
S8  모든 pipelines.<id>.steps가 non-empty이며 PipelineStep vocabulary(§7.1a) 내
S9  auto_merge=true → capability_requirements에 merge operation(§12.2/§12.3의 `automatic_merge`)의
      요구 enforcement 선언 존재 (미선언 시 COMPILE_ERROR)
S10 auto_merge=true → contract_drift_policy.canonical_head.action ≠ CONTINUE_SNAPSHOT (§11.2)
S11 auto_merge=true → verification_policy.required_verification의 어떤 check도
      accepted_assurance가 {WORKER_REPORTED, INFERRED}만으로 구성되지 않을 것 (§15.3)
S12 Approved Override 전체가 §7.2 rule 4–7을 통과
S13 ProjectProfileV3 child materialisation:
      child_materializer가 존재하면 task_sources.length == 1
      child_materializer wrapper는 exact { adapter, config }, adapter non-empty
      Model-selectable source/materializer/default route 없음
```

### 7.4 적용 시점 불변성

Compiled Profile은 `next Task 또는 next Batch`부터 적용된다(Spec §10). Coordinator는 Task Attempt 시작 시점의
compiled_hash를 Task Contract에 동결하며, 이후 Registry에 새 버전이 등록되어도 진행 중 Attempt에는
어떤 경로로도 주입되지 않는다. 소급 적용은 §12.4의 명시적 INVALIDATE 경로뿐이다.

### 7.5 Project Profile authority boundary

Project Profile v1 top-level에 다음 automation-authority field가 나타나면 **unknown-field validation으로
reject**한다(§7.1a는 10개 top-level만 허용):

```text
auto_merge, allow_auto_subflow, batch_policy, repository_policy, human_gate_policy,
verification_policy, capability_requirements, contract_drift_policy, recovery_policy,
classification_policy
```

Spec의 `Automation authority = Execution Policy`를 **schema boundary에서 강제**하는 것이며, 그 결과
"두 계약이 같은 authority field를 선언한다"는 전제의 generic merge 규칙은 v1에서 불필요해진다.

### 7.6 operator-action 승인 레코드

`operator-action`은 사람이 Platform CLI/API를 통해 Core에 직접 기록한 durable 승인 레코드다(최초
bootstrap처럼 선행 PendingHumanDecision이 없는 경우용). **파일 편집으로는 생성할 수 없다.**

Envelope: `schema = "platform/operator-action"`, `schema_version = 1`.

```yaml
operator_action:
  action_id:      ulid
  status:         RESOLVED            # v1은 이 값 하나뿐 (M0-31)
  field_path:     ...
  approved_value: ...                 # §6 constrained JSON
  recorded_by:    <non-secret operator identity/reference>   # I-TD7
  recorded_at:    ...
```

- immutable record. `record_hash`는 이 envelope의 hash(§6)이며, override의 `approval_hash` 대조 대상이다.
- **`REVOKED`는 v1 vocabulary에서 제거한다 (M0-31).** "immutable record"와 "status가 envelope 안에서
  바뀐다"는 양립할 수 없었다 — envelope를 UPDATE하면 `record_hash`가 달라져 이미 그 hash로 bind된 모든
  override가 근거를 잃고, immutability 주장 자체가 거짓이 된다. 따라서 v1 `platform/operator-action`은
  **immutable approval issuance record로 한정**하며 `status`는 `RESOLVED` 하나만 허용한다.
- **v1에는 post-creation revocation 기능이 없다.** 실제 요구가 생기면 기존 레코드를 수정하는 대신
  별도 versioned revocation record/schema를 설계한다. 기존 immutable record를 UPDATE해 hash를 바꾸는
  경로는 어떤 경우에도 만들지 않는다.
- compile 시 `status`는 **RESOLVED여야 한다**(§7.2 rule 7의 `ApprovalBindingView.status`).
- 인증/UI semantics는 이 TD의 범위 밖이다.
- 저장은 §18.1의 `operator_action` 테이블이며, **MVP 0 foundation table set(Batch 2)은 수정하지 않고**
  이후 domain-store batch의 migration으로 추가한다. Profile Compiler 테스트는 `ApprovalBindingView`
  fixture를 사용한다 (contract 확정 ≠ store 구현).

---

### 7.7 Compiled Profile schema v1 (`CompiledProfileV1`)

Envelope: `schema = "platform/compiled-profile"`, `schema_version = 1`. `compiled_hash`는 이 envelope
전체의 hash(§6)다.

```yaml
body:
  project_profile:    { id: ..., version: ..., hash: sha256:... }
  execution_policy:   { id: ..., version: ..., hash: sha256:... }
  approved_overrides: { hash: sha256:... }

  compiled_version:    1
  merge_rules_version: 1

  effective:
    project: <ProjectProfileV1Body>              # validated/normalized 그대로
    policy:  <EffectiveExecutionPolicyV1Body>    # 해소 + override 적용 후
```

- **self-reference 금지:** `compiled_hash`는 envelope 전체의 hash이므로 **hash 대상 body 안에 자기 자신을
  넣지 않는다.** Spec §9 형태의 외부/public projection이 `compiled_hash`를 함께 보여주는 것은 무방하다.
- `compiled_version`은 v1에서 `compiled_version == schema_version == 1`이다. 이후 compiled semantics가
  바뀌면 둘을 함께 version-up하는 것을 기본으로 한다.
- **`effective.project`**: validated/normalized `ProjectProfileV1Body` 그대로 — 따라서 M1-6의
  `repository_scopes`도 여기에 그대로 실린다. 별도 scope registry/envelope/hash를 만들지 않으며, scope
  정의는 Project Profile component hash를 통해 `compiled_hash`에 자연히 bind된다. raw YAML text를 포함하지
  않고 원문 body를 별도 duplicate field로도 저장하지 않는다. **Approved Override는 project semantics에
  적용되지 않으므로**(§7.1c) `effective.project`는 validated Project Profile semantics와 동일하다.
- **`effective.policy`**: `ExecutionPolicyV1Body`와 동일 shape이되 ① `classification_policy`가
  **완전 해소된 map**(Project Profile의 모든 classification name이 존재하고, explicit 값이 있으면 그것,
  없으면 Project default) ② Approved Override 적용 후의 최종 값을 갖는다. 따라서 downstream component는
  **`effective.policy`만 읽으면 되고**, Project default와 raw explicit map을 매번 다시 merge하지 않는다.
- **normalized input:** 여기서 hash되는 component body와 `effective`는 §6/§7.1b/§7.1c의
  schema-specific normalization을 **이미 거친** 표현이다. 따라서 semantic set의 입력 순서만 다른 문서는
  동일한 component hash와 동일한 `compiled_hash`를 낳는다(M0-13).
- **hash binding:** body에 `project_profile.hash + execution_policy.hash + approved_overrides.hash +
  merge_rules_version + effective`가 모두 존재하므로 구성요소 무결성과 **merge algorithm 버전까지 hash에
  bind**된다. 동일 Profile/Policy/Override라도 `merge_rules_version`이 달라지면 다른 `compiled_hash`가
  생성되어야 한다 — silent compiler-semantic migration을 금지한다. 새 hashing rule은 만들지 않는다(§6 재사용).

### 7.7a Compiled Profile schema v2 (v1.5, prospective)

[계약, PROSPECTIVE_REQUIREMENT] `ProjectProfileV2`를 소비하는 compiler output은
`platform/compiled-profile` schema_version/compiled_version `2`다. body shape와 merge rules는 v1과
동일하고 다음 두 차이만 있다:

```text
project_profile ref/body version = ProjectProfileV2
effective.project                = ProjectProfileV2Body (supervisor_profile 포함)
compiled_version                 = 2
```

`merge_rules_version`은 여전히 `1`이다 — 새 field는 Project Profile semantic을 그대로 동결할 뿐 policy
merge algorithm을 바꾸지 않는다. Supervisor session의 requested runtime binding은 이 immutable
`effective.project.supervisor_profile → roles[...].runtime_profile` chain에서만 해소한다. v1 compiled
artifact를 v2로 silent reinterpret하거나 v1 Attempt에 v2 field를 주입하지 않는다(§7.4).

### 7.7b Compiled Profile schema v3 (#59, prospective MVP 3)

`ProjectProfileV3`를 소비하는 output은 `platform/compiled-profile` schema_version/compiled_version `3`다.
v2 shape/merge rules를 그대로 유지하고 `effective.project.task_sources[*].child_materializer`를 validated
normalized form으로 동결한다. `merge_rules_version`은 계속 `1`이며 Execution Policy schema도 v1 그대로다.

materialisation target은 이 immutable Compiled Profile에서만 resolve한다. current registry, deployment
default, installed adapter 목록, Model field로 보완하지 않는다. v1/v2 Compiled Profile과 진행 중 Attempt에는
silent injection하지 않는다.

---

## 8. TaskSource TD

### 8.1 Generic contract (Core가 보는 전부)

```text
discover_tasks(context)      -> TaskCandidate[]
get_task(task_ref)           -> TaskDefinition
get_dependencies(task_ref)   -> TaskDependency[]
get_task_state(task_ref)     -> ExternalTaskState
update_task_projection(...)  -> optional
```

```yaml
TaskCandidate:
  task_ref: string            # adapter-scoped opaque ref
  title: string
  summary: string
  external_state: ExternalTaskState
  discovered_at: timestamp

TaskDefinition:
  task_ref: string
  version: string             # adapter가 부여하는 단조 증가/변경 감지용 표기
  definition_hash: sha256     # canonical body hash (§6 envelope)
  body:                       # Core는 내용을 해석하지 않는다 — Supervisor/Actor에게 전달만
    title, description, references[], acceptance_notes[]

TaskDependency: { task_ref, depends_on_ref, kind: HARD|SOFT }

ExternalTaskState: enum { TODO, READY, IN_PROGRESS, BLOCKED, CLOSED, UNKNOWN }
```

**TaskSourceV1 required callable surface (M0-24).** MVP 0 v1이 요구하는 public interface는 **정확히 네 개의
read operation**이다:

```text
discover_tasks(context: TaskDiscoveryContextV1) -> TaskCandidate[]
get_task(task_ref)                              -> TaskDefinition
get_dependencies(task_ref)                      -> TaskDependency[]
get_task_state(task_ref)                        -> ExternalTaskState
```

method 명명/표기의 실제 언어 style은 repo convention을 따르며, 새 generic adapter framework를 만들지 않는다.

**`TaskDiscoveryContextV1` — 정확히 한 field.**

```text
TaskDiscoveryContextV1 { observed_at: timestamp }
```

목적은 `TaskCandidate.discovered_at = context.observed_at`으로 **caller-controlled deterministic
observation time**을 공급하는 것 하나다. adapter나 parser가 `Date.now()`/`new Date()`/filesystem mtime을
discovery authority로 사용하지 않는다. `observed_at`은 **TaskDefinition body가 아니고, `definition_hash`에
포함되지 않으며, task identity도 version도 아니고, Task Contract body로 자동 승격되지 않는다** — 단순
observation metadata다. timestamp 표기는 기존 repo 표현을 재사용하며 새 format framework를 만들지 않는다.

context에는 그 외 **어떤 것도 넣지 않는다** — `project_id`, repository path, TaskSource config,
classification, pipeline, compiled profile, execution policy, runtime/backend identity, 임의 metadata,
opaque extension map 모두 금지다. adapter instance는 이미 Profile 소유 config를 받으므로(§8.2), project
semantics나 execution authority를 discovery context로 우회 주입하는 경로를 만들지 않는다. 향후 discovery에
실제 새 authority input이 필요해지면 **typed contract revision**으로 추가한다 — v1에 generic
extensibility bag을 두지 않는다.

**`update_task_projection`의 v1 해석.** Spec §14의 `update_task_projection(...) -> optional`은
**optional capability/extension point**로 해석하며 **MVP 0 required callable surface에 포함하지 않는다.**
근거: §8.2가 MVP 0 ProjectDocumentTaskSource의 document mutation 미구현을 확정했고, projection은
best-effort이며 Platform execution state authority가 아니고(§8.3), projection payload/state mapping의
typed semantics가 현재 TD에 존재하지 않는다. 미정 payload를 `any`/`unknown`/`CanonicalObject`/임의 JSON으로
public surface에 고정하는 것은 계약을 닫는 것이 아니라 **미정 semantics를 generic escape hatch로 굳히는
것**이므로 하지 않는다.

향후 실제 writeback이 필요해지면 **typed optional extension 또는 TaskSource contract revision**으로 exact
request/result semantics를 추가한다. 그 전까지 `TaskProjectionUpdate { payload: any | unknown }`,
generic projection event, projection DSL, platform-state→external-state 암묵 매핑을 만들지 않는다.
Spec이 남겨 둔 optional extension 가능성 자체는 유지된다.

### 8.1a TaskDefinition v1 exact contract (M0-20)

Core가 정규화해 보관·해시하는 body는 **정확히 다음 4개 field**다. unknown body field는 reject.

```text
TaskDefinitionBodyV1 {
  title:            <non-empty string>
  description:      <string, empty 허용>
  references:       <string[], empty 허용, 각 item non-empty>
  acceptance_notes: <string[], empty 허용, 각 item non-empty>
}
```

- `references`/`acceptance_notes`는 **semantic set이 아니다** — M0-13의 semantic-set 목록에 포함되지
  않으므로 **generic array로서 order-sensitive**이며, Core가 중복 문자열을 임의 제거하지 않는다.
- `task_ref`: non-empty **adapter-scoped opaque string**. Core는 내부 syntax를 해석하지 않는다(§6.1 D+).
- `version`: non-empty string. adapter의 provenance/change label이며 body hash와 **별도 field**다.

**Hash identity.** definition body hash의 envelope를 확정한다:

```text
schema = "platform/task-definition", schema_version = 1, body = TaskDefinitionBodyV1

definition_hash = hashEnvelope({ schema, schema_version, body })
```

`task_ref`와 `version`은 **definition hash body에 포함하지 않는다.** 셋의 역할이 다르기 때문이다 —
`task_ref`는 external identity, `version`은 adapter provenance label, body hash는 **semantic definition
content identity**다. Task Contract는 세 값을 각각 별도로 동결한다(§10.1). 새 hashing rule은 만들지 않고
§6 envelope/JCS/SHA-256을 그대로 재사용한다.

**Adapter-provided `definition_hash` 검증 (blind trust 금지).** Core는 정규화 경계에서 **항상**
normalized body로 Platform hash를 재계산한다:

```text
adapter hash 부재  → Core-computed hash 사용
adapter hash 존재  → Core-computed hash와 exact equality 요구
                    불일치 → TaskSource contract failure (fail-closed)
```

정규화된 public `TaskDefinition`에는 검증을 통과한 `definition_hash`가 항상 존재한다. raw adapter 결과
타입과 normalized 타입을 분리할지는 local 구현 세부다. 새 authority framework를 만들지 않는다.
drift 감지는 종전대로 hash 비교만 사용한다.

### 8.1b ChildTaskMaterializationAdapterV1 (#59, prospective MVP 3)

`TaskSourceV1` required read surface는 §8.1 그대로다. v3 Project Profile의 same-entry
`child_materializer`가 구성하는 별도 interface만 child creation mutation을 가진다:

```text
materialize_child(request: ChildTaskMaterializationRequestV1)
  -> { status: COMMITTED, receipt: ChildTaskMaterializationReceiptV1 }

reconcile_child_materialization(op_key)
  -> NOT_FOUND | COMMITTED(receipt) | UNKNOWN
```

```text
ChildTaskMaterializationRequestV1 {
  op_key
  materialization_id       # accepted Proposal의 Platform-assigned proposal_id
  materialization_hash     # §8.4b immutable snapshot hash
  task_definition_body     # exact TaskDefinitionBodyV1
}

ChildTaskMaterializationReceiptV1 {
  materialization_id
  materialization_hash
  external_task_ref        # adapter가 할당한 non-empty opaque ref
  backend_ref?             # optional non-secret opaque receipt ref
}
```

exact field set이며 unknown field는 reject다. `external_task_ref`를 request/Model이 공급하지 않는다.
adapter는 같은 `op_key + materialization_hash`에 항상 같은 committed external ref를 반환하거나 exact
COMMITTED receipt를 reconcile해야 한다. 같은 op_key에 다른 hash/request는 fail-closed conflict다.

mutation reach는 **configured source에 새 task representation 하나 생성**으로 한정한다. existing task
update/upsert/delete, issue close/label mutation, dependency graph rewrite, Project Profile/Platform lifecycle,
repository/runtime/workflow mutation은 금지다. adapter가 target system의 최소 metadata를 추가할 수는 있지만
fresh `TaskSource.get_task(external_task_ref)`의 normalized `TaskDefinitionBodyV1`/definition hash가 request와
exact equality여야 한다. round-trip 불일치는 successful materialisation이 아니다.

Supervisor/Runtime/MCP는 이 interface를 호출하거나 credential을 받지 않는다. Coordinator만 validated
snapshot + durable INTENT 뒤에 호출한다(I-TD2/I-TD9/I-TD10).

### 8.2 ProjectDocumentTaskSource (초기 구현) — parser `markdown-sections-v1` (M0-2)

**Config v1.** config는 **Profile이 소유**하며 Profile Compiler에게는 여전히 opaque constrained
JSON이다(§7.1a) — 아래 schema를 검증하는 주체는 **adapter 자신**이다.

```yaml
task_sources:
  - id: <profile-owned id>
    adapter: ProjectDocumentTaskSource
    config:
      paths:  [ <non-empty string>, ... ]   # required, non-empty array, 각 element non-empty,
                                            # duplicate path reject, 입력 순서 보존
      parser: markdown-sections-v1          # required. MVP 0에서는 이 값만 허용
```

- config wrapper는 **정확히 `paths`와 `parser` 두 field**만 허용하며 unknown field는 adapter-local
  config validation failure다. unknown parser id도 동일하게 adapter-local deterministic config error다.
- **`ready_marker`는 v1 canonical config에서 제거한다.** `markdown-sections-v1`이 `state:`로 6-state를
  직접 표현하므로 숨은 state authority가 필요 없다.
- parser는 adapter package 내부 구현이며 Core는 parser id도 해석하지 않는다. `PROJECT_STATUS` 문자열,
  프로젝트 고유 표기(U-XX 등)는 **config 값 또는 문서 내용**으로만 존재한다 (I-TD1).

**Grammar (v1, 고정).** 각 task block은 `## Task`로 시작하고, 그 직후 metadata 4개가 **정확히 한 번씩
아래 순서대로** 오며, 이어 네 subsection heading이 **전부 required**로 순서대로 온다(내용은 비어도 된다).
optional-section 모호성을 만들지 않기 위한 고정 구조다.

```markdown
## Task
task-ref: T-101
version: 1
state: READY
title: Collector script cleanup

### Description
Free-form description text.

### Dependencies
- HARD: T-100
- SOFT: T-090

### References
- docs/DESIGN.md#collector

### Acceptance
- Existing output remains byte-identical.
```

- **`task-ref`** — non-empty single-line string. 앞뒤 whitespace를 제거하고 그 결과가 비면 malformed다.
  **`:`를 허용**하며, 이는 parser-local 표기 제약일 뿐 Core의 generic `external_task_ref` domain을
  축소하지 않는다(§6.1 D+). 별도 encoding/escaping/identifier codec을 만들지 않는다.
- **`version`** — non-empty single-line string. 숫자로 제한하지 않는다.
- **`state`** — `TODO | READY | IN_PROGRESS | BLOCKED | CLOSED | UNKNOWN` 중 하나. **다른 token을
  `UNKNOWN`으로 silent normalize하지 않는다** — 명시적 `UNKNOWN`만 UNKNOWN이고, 그 외는 malformed다.
- **`title`** — non-empty single-line string.
- **Description** — `### Description`부터 `### Dependencies` 직전까지의 text. 내부 줄 순서와 개행을
  보존하고, 경계 양끝의 formatting blank line만 결정적으로 제거한다. empty 허용. block 내부에서
  `### Dependencies`/`### References`/`### Acceptance`/`## Task`는 structural marker이므로 literal
  prose로 쓸 수 없다. 범용 Markdown AST 의미는 해석하지 않는다.
- **Dependencies** — `- HARD: <ref>` 또는 `- SOFT: <ref>` 두 형태만 허용(§8.1의 `kind` vocabulary).
  첫 `HARD:`/`SOFT:` prefix 이후 **remainder 전체**가 target ref이므로 ref 내부 `:`도 허용된다. empty 허용.
- **References / Acceptance** — `- <non-empty string>` item. empty 허용. **array order 보존**이며 새
  semantic-set normalization을 추가하지 않는다.
- **Free prose 공존** — `## Task` block **밖**의 text는 task data로 해석하지 않고 무시한다. 반면 block
  **안**에서 위 grammar에 맞지 않는 structural content는 **fail-closed malformed task**다.

**TaskCandidate projection.** `task_ref = task-ref`, `title = title`, `external_state = state`.
`summary`는 별도 문서 authority field를 만들지 않고, **Description의 첫 non-empty physical line**을 trim해
사용한다(그런 줄이 없으면 `summary = title`). 이렇게 하여 hash 밖의 별도 metadata source가 생기지 않는다.
`discovered_at`은 grammar의 일부가 아니다 — **한 번의 `discover_tasks(context)` 호출에서 생성되는 모든
TaskCandidate가 `context.observed_at`을 그대로 사용한다**(§8.1). file/task마다 clock을 다시 읽지 않고
configured path의 mtime도 쓰지 않으므로, 동일한 `document bytes + config + context.observed_at`은 항상
동일한 TaskCandidate sequence를 만든다. 이 값은 **immutable definition hash에 들어가지 않는다**. 새 clock
framework를 설계하지 않는다.

**TaskDefinition projection.** `body`는 §8.1a의 `TaskDefinitionBodyV1`로 정규화하고, `definition_hash`는
공유 helper로 계산한다 — ProjectDocumentTaskSource는 Platform-owned adapter이므로 §8.1a의 재계산·대조
규칙을 그대로 만족한다.

**Multi-path 동작.** configured `paths` 순서대로 파일을 처리하고 각 파일 안에서는 document order를
보존한다. 이는 **deterministic presentation/discovery order일 뿐 task priority authority가 아니다.**

- 같은 `task_ref`가 한 파일 안 또는 여러 configured 파일에 걸쳐 중복되면 **discovery 전체를 fail-closed**
  처리한다(첫 task를 조용히 채택하지 않는다). §6.1 D+의 task_key injectivity 귀결이다.
- dependency target은 **다른 configured 파일의 task를 참조할 수 있다.** parser는 target 존재 여부로
  새로운 task semantics를 추론하지 않는다.
- configured path가 missing/unreadable이거나 **한 block이라도 malformed면 partial task set을 반환하지
  않고** 해당 adapter operation을 실패시킨다. 오류는 adapter-local deterministic error로 유지하며 새
  Platform-wide failure taxonomy를 만들지 않는다(상위 매핑은 §24 기존 코드 사용).

**projection semantics (M0-24).** `update_task_projection`은 optional·best-effort·idempotent이며
**`TaskSourceV1` required surface가 아니다**(§8.1). 따라서 **MVP 0 ProjectDocumentTaskSource는 projection
capability를 expose하지 않는다** — 실제 document mutation을 구현하지 않는 것은 물론이고, fake no-op
public method를 둘 필요도 없다. writeback capability가 없는 것이 정상 상태다. optional projection은 future
typed extension point로 남으며, 실제 projection이 도입되면 실패 시 Platform transition은 진행하고
`PROJECTION_LAG` 관측만 남긴다는 기존 semantics가 적용된다. TaskSource 문서는 Platform durable state가
아니다(§8.3). projection writeback framework를 만들지 않는다.

### 8.3 분리 강제 — `ExternalTaskSnapshotV1` (M0-29)

Store에는 TaskSource 관측이 `task.external_snapshot`으로만 저장된다. Platform task state 컬럼과 물리적으로
분리되어 있어 "TaskSource가 durable state가 되는" 회귀를 schema 수준에서 차단한다. exact shape:

```text
ExternalTaskSnapshotV1 {
  external_state:  ExternalTaskState      # §8.1 6-값 vocabulary
  version:         non-empty string       # TaskDefinition.version (§8.1a)
  definition_hash: sha256:<lowercase-hex>
  observed_at:     timestamp
}
```

- **exact 네 필드**이며 unknown field는 reject다.
- **`version`을 반드시 포함한다 (M0-29).** Spec §18과 §9.2 V3가 Task version freshness를 authoritative
  하게 사용하는데, `version`은 §8.1a대로 definition hash **밖**에 있으므로 hash만 저장하면 재검증
  시점(§17.3)에 V3 1)을 평가할 수 없다.
- `task_ref`는 row identity(`task.project_id` + `task.external_task_ref`, §18.1a)에 이미 있으므로
  snapshot에 중복 저장하지 않는다.
- §6 constrained JSON으로 저장하며 **최신 관측의 projection**일 뿐이다 — Platform lifecycle state가
  아니고 authority도 아니다(authority는 항상 TaskSource, §22.1). 관측 이력은 `decision_log`에 남는다.
- **불변식 (재확인).** `TaskSource observation은 Platform lifecycle state를 단독으로 결정하지 않는다.`
  외부 관측만으로 TaskState가 조용히 바뀌는 경로는 존재하지 않는다.
- **Materialization contract는 §8.4 (M1-1)가 소유한다.** MVP 0 Coordinator shell은 이를 구현하지
  않았고, MVP 1 integration이 §8.4대로 구현한다.

### 8.4 Discovery materialization contract (M1-1)

관측을 durable `task` row로 옮기는 유일한 규칙이다. 위 불변식 — **TaskSource observation은 Platform
lifecycle state를 단독으로 결정하지 않는다** — 은 이 절 전체를 지배한다.

**Caller context.** materialization의 caller는 Coordinator이며 `run_id` / `batch_id` /
`TaskDiscoveryContextV1`을 이미 알고 있다. **TaskSource는 batch를 선택하지 않는다** — adapter는
candidate를 반환하고, Coordinator가 자신이 지정한 batch에 projection한다. MVP 1은
single-task/human-merge phase지만 Supervisor가 후보를 고르려면 candidate set이 필요하므로, discovery
pass는 **현재 active batch**에 대해 candidate set을 materialize할 수 있다. MVP 3의 scheduler semantics는
도입하지 않는다.

**Pass의 exact required read.**

```text
1  discover_tasks(context)
2  각 candidate에 대해 get_task(candidate.task_ref)
```

이 둘이 최소이자 전부다 — §8.3의 네 필드가 두 source에서만 오기 때문이다:

```text
external_state, observed_at   ← TaskCandidate / TaskDiscoveryContextV1
version, definition_hash      ← TaskDefinition
```

`get_dependencies()`와 `get_task_state()`는 **최초 row 생성의 required read가 아니다.** 특히 같은
discovery observation의 external state를 얻겠다고 곧바로 `get_task_state()`를 중복 호출해 **두
관측을 섞지 않는다** — snapshot의 `external_state`는 그 pass의 candidate 값 하나다.

**Dependency 경계.** `get_dependencies(task_ref)`는 durable materialization payload가 **아니다.**
MVP 1에서 dependency는 (a) Supervisor read model과 (b) `START_TASK`/`START_SUBFLOW` selection·admission
직전의 **fresh** guard(§19.3, 규칙은 §8.4a)에만 쓰인다. `task_dependency` table, dependency graph table,
dependency cache durable schema를 만들지 않으며 MVP 3 dependency scheduler를 당기지 않는다.

**최초 materialization.** 새 `task_key`가 현재 batch에 없으면:

```text
platform_state    = DISCOVERED
external_snapshot = { external_state: candidate.external_state,
                      version:        definition.version,
                      definition_hash: definition.definition_hash,
                      observed_at:    context.observed_at }
```

이 write는 **admission이 아니다** — `admitted_task_count` / `active_task_count` /
`active_writable_candidate_count` 어느 것도 소비하지 않는다(§19.3c). admission은 여전히 검증된
`START_TASK`/`START_SUBFLOW`의 `DISCOVERED→SELECTED` transition이 소유한다(§19.3a).

**재관측(repeated discovery).** 이미 materialize된 task를 다시 관측하면:

```text
새 task row 생성 금지 · platform_state 변경 금지 · Attempt 변경 금지
external_snapshot 만 최신 관측으로 refresh
```

refresh는 **Platform lifecycle transition이 아니다.** 필요한 관측 이력은 기존 `decision_log`에 남기며
별도 observation-history table을 만들지 않는다.

**version / definition_hash drift.** 재관측에서 `version` 또는 `definition_hash`가 달라져도
materialization 단계는 **TaskState를 HELD로 만들지 않고, Attempt를 INVALIDATED하지 않으며,
COMPLETED/FAILED로 종결하지 않는다.** `external_snapshot`만 갱신한다. 실행 전 freshness는 §9.2 **V3**가
차단하고, 진행 중 Attempt의 TaskDefinition drift는 §11 `contract_drift_policy`가 stage boundary에서
처리한다. **관측 refresh가 drift policy를 대체하지 않는다.**

**external state 변화.** `TODO`/`READY`/`IN_PROGRESS`/`BLOCKED`/`CLOSED`/`UNKNOWN` 어떤 변화든
`external_snapshot` refresh일 뿐이다. external state를 TaskState로 옮기는 mapping table/DSL을 만들지
않는다. 특히 **external `CLOSED` ≠ Platform `COMPLETED`.**

- **아직 실행 전(DISCOVERED/SELECTED)에서 CLOSED 관측**: snapshot만 갱신한다. 자동
  `COMPLETED`/`FAILED`/`DEFERRED` transition을 만들지 않는다. 새 실행을 제안할지 여부는 fresh
  TaskSource 관측과 Proposal validation 경로가 결정한다.
- **ACTIVE 중 CLOSED 관측**: 진행 중 Task Contract를 silent terminate/migrate하지 **않는다.**
  lifecycle을 바꿀 수 있는 것은 §11의 drift semantics와 명시적 Proposal/Human Decision 경로뿐이다
  (§22.3의 `EXTERNAL_CLOSED` hold도 그 경로 위에서만 발생한다).

**Pass atomicity — fail closed.** 하나의 discovery/materialization pass는 다음 중 하나라도 발생하면
**부분 commit하지 않는다**:

```text
discover_tasks 실패 · 한 candidate set 안의 duplicate task_ref · get_task 실패
TaskDefinition normalization/hash mismatch · malformed candidate/definition
```

순서는 **관측 수집·검증 → 하나의 Core transaction → row/snapshot write**다. 이전 관측은 그대로
보존된다. 이런 operational failure를 **`TASK_NOT_FOUND`로 가장하지 않는다**(§9.2 V2) — Coordinator는
validator를 호출하지 않고 보고 후 대기한다(§26 step 3). 새 Platform-wide failure taxonomy를 만들지
않는다.

**Ordering.** TaskSource가 반환한 순서는 deterministic presentation order일 수는 있어도
**execution/admission/scheduler priority authority가 아니다.** selection은 Supervisor Proposal +
deterministic validation이 결정한다.

**금지.** TaskSource→TaskState mapping, task priority engine, dependency scheduler,
`task_dependency` durable table, `discovery_exhausted` flag, TaskSource event bus, generic
materialization framework, projection DSL을 만들지 않는다.

### 8.4a Direct HARD dependency admission fact (M1-5)

§8.4가 admission 직전 fresh dependency read를 요구하고 §19.3이 "dependency 미차단"을 precondition으로
두었지만, **HARD dependency가 언제 satisfied인지**가 어디에도 없었다. 여기서 그 규칙 하나만 확정한다 —
MVP 3 dependency scheduler를 설계하는 것이 아니다.

**Kind semantics.** `SOFT`는 MVP 1 admission blocker가 **아니다**. Supervisor read model에는 보이지만
transition을 막지 않으며, SOFT 관계로 lifecycle을 자동 변경하지도 않는다. `HARD`만 아래 satisfaction
rule의 대상이다.

**Direct only.** 평가 대상은 `get_dependencies(current_task_ref)`가 **직접 반환한** dependency뿐이다.
dependency의 dependency를 재귀 조회하지 않는다. transitive closure는 MVP 3 scheduler와
`DEPENDENCY_SUBTREE`(§17.2)의 별도 scope다.

**두 관측.** 각 direct HARD dependency `depends_on_ref`에 대해 Coordinator는 admission 직전에 둘 다 읽는다:

```text
external   = TaskSource.get_task_state(depends_on_ref)      # fresh, 매번
platform   = task_key(project_id, depends_on_ref) 의 durable task row (없을 수 있음)
```

external state는 **반드시 fresh TaskSource 호출**로 얻는다. materialized target의
`external_snapshot.external_state`는 이전 pass의 projection일 뿐 authority가 아니다(§8.3). `depends_on_ref`는
opaque하며 §6.1 D+ 그대로 쓴다 — parse하지 않는다.

**Satisfaction rule.** Platform이 그 dependency의 execution을 소유한 적이 있는지로 갈린다:

```text
durable row 없음  OR  admitted_at == null
    → Platform에는 그 task를 실행했다고 주장할 execution history가 없다
    → satisfied  ⟺  external == CLOSED

admitted_at != null
    → Platform이 그 task의 lifecycle을 실제로 소유했다
    → satisfied  ⟺  platform_state == COMPLETED  AND  external == CLOSED
```

admitted target의 state matrix — 새 state를 만들지 않는다:

```text
DISCOVERED   admitted_at != null과 공존하지 않는 것이 정상 불변식이나, 관측되면 not satisfied
SELECTED     blocked
ACTIVE       blocked
HELD         blocked
DEFERRED     blocked
FAILED       blocked
COMPLETED    external == CLOSED일 때만 satisfied
```

**왜 두 fact를 모두 요구하는가.** 한쪽만 보면 두 unsafe path가 열린다. (a) Platform이 ACTIVE/HELD/FAILED인
dependency를 external `CLOSED` 하나로 satisfied 처리하면, TaskSource 관측이 Platform-managed execution의
미완료·실패를 덮어쓰게 된다 — external CLOSED ≠ Platform COMPLETED라는 §8.3 불변식의 정면 위반이다.
(b) 반대로 Platform이 COMPLETED인데 external이 `READY`/`IN_PROGRESS`로 다시 열렸다면, authoritative external
source가 prerequisite가 재개되었다고 말하는 중이므로 silent proceed하지 않는다. 이 divergence 자체는
**여기서 자동 reconcile하지 않고 dependency target의 lifecycle도 건드리지 않는다** — 그것은 MVP 4
reconciliation의 몫이고, M1-5는 "지금 이 admission을 진행해도 되는가"만 답한다.

**Non-materialized external dependency.** dependency ref가 현재 batch/task set에 materialize되어 있지
않다는 사실 자체는 malformed가 아니다. TaskSource contract는 Platform 밖에서 완료된 prerequisite를 표현할
수 있고, 위 규칙의 첫 분기가 정확히 그 경계다 — 이미 외부에서 끝난 선행 작업을 Platform이 다시 실행하도록
강제하지 않는다.

**UNKNOWN과 실패.** `UNKNOWN`은 satisfied가 아니다(fail-open 금지). `TODO`/`READY`/`IN_PROGRESS`/`BLOCKED`도
전부 blocked다. `get_task_state(depends_on_ref)`가 operationally 실패하면 dependency가 clear라고 **추측하지
않고** admission을 수행하지 않는다 — 이를 `TASK_NOT_FOUND`(§9.2 V2)로 위장하지 않으며 Coordinator
operational failure로 fail-closed한다. 새 global failure taxonomy를 만들지 않는다.

**Cycle.** 별도 cycle detector를 만들지 않는다. direct HARD self/cyclic dependency는 위 규칙의 자연스러운
결과로 완료되지 않은 동안 blocked된다. cycle detection framework·SCC 분석·dependency graph validation
framework를 추가하지 않으며, project/TaskSource validation requirement가 생기면 별도 revision 대상이다.

**Typed admission fact.** B8 state machine은 TaskSource를 호출하지 않는다(§19.3b). Coordinator가 위 규칙을
계산해 transition에 typed fact 하나를 공급한다:

```text
DependencyAdmissionView { hard_dependencies_clear: boolean }
   # 현재 repo convention의 동등한 explicit typed parameter여도 된다
```

generic FactBundle/AuthorityRegistry를 만들지 않는다. `hard_dependencies_clear`는 **durable state가
아니다** — transition-time fact이며 `task_dependency`/`dependency_snapshot`/`dependency_cache`/
`dependency_status`/`dependency_clear` 컬럼/generation 어느 것도 만들지 않는다. decision_log에 dependency
graph 전체를 새 authoritative artifact로 저장하지 않는다(기존 admission decision/transition log가 최소
observation/result를 남기는 것은 무방하되 dependency cache 역할을 하게 만들지 않는다).

**Timing.** dependency fact는 admission 적용 시점에 최대한 가깝게 계산한다:

```text
fresh get_task → fresh repository fact → manifests/batch view → validateDecision V1–V11
→ fresh direct dependency 관측 → hard_dependencies_clear 계산 → commitAdmission(… fact …)
```

기존 fact assembly가 dependency를 더 앞에서 읽더라도 **동일 submission invocation 안의 fresh 관측이면**
허용된다. cached durable dependency state를 authority로 쓰는 것만 금지된다. Human Gate resolution은
반드시 다시 계산한다(§17.3).

**Validator 경계.** dependency satisfaction은 V1–V11에 **추가하지 않는다**. `V12`도, `DEPENDENCY_BLOCKED`
같은 새 `DecisionRejectReason`도 만들지 않는다. Decision Validator는 policy/freshness/repository/
capability/batch를 판정하고, dependency guard는 state-machine admission precondition에 속한다(§19.3).

**Spec §48 경계.** "HELD task가 있어도 independent safe task는 계속 가능"은 그대로다. 다만 M1-5가 정의하는
것은 **현재 START_TASK 하나의 direct HARD dependency가 clear인가**뿐이다.
`safe_independent_runnable_exists` 자동 계산과 hold-next scheduler 전체 구현은 MVP 3이며 여기서 당기지
않는다.

### 8.4b Bounded child materialisation / TaskSource round-trip (#59, prospective MVP 3)

이 절의 materialisation은 §8.4의 **external observation → durable row projection**보다 앞선 별도 external
creation operation이다. child 하나의 authority chain은 정확히 다음이다:

```text
validated SubflowChildMaterializationProposalV1
→ immutable ChildTaskMaterializationSnapshotV1 + idempotency INTENT atomic write
→ ChildTaskMaterializationAdapterV1.materialize_child
→ COMMITTED receipt durable DONE
→ same configured TaskSource.get_task(external_task_ref) fresh read
→ normalized body/hash exact equality
→ §8.4 DISCOVERED task row + ChildMaterializationBindingV1 one transaction
```

immutable snapshot envelope:

```text
schema = "platform/child-task-materialization", schema_version = 1

ChildTaskMaterializationSnapshotV1 {
  materialization_id       # accepted Proposal.proposal_id
  batch_id
  compiled_profile_hash
  task_source_id            # Compiled Profile v3의 sole source; Model 선택 아님
  parent_intent: MaterializationParentIntentV1
  child_definition_body: TaskDefinitionBodyV1
  child_definition_hash     # §8.1a envelope hash, Platform 계산
  reason_refs               # Proposal의 order-sensitive immutable copy
}
```

`parent_intent`는 §9.1 F의 exact tagged union을 그대로 동결한다. semantic relation identity는
`parent_intent.task_key`이며, observed Attempt/definition fields는 publish 전 freshness basis다. Platform은
child title/description/references/acceptance 또는 parent를 Proposal 뒤에 보완하지 않는다.

`materialization_id = proposal_id`로 고정해 새 identity service를 만들지 않는다. Proposal 자체를 hash
artifact로 승격하지 않으며, validation을 통과한 exact semantic input을 위 별도 immutable envelope로
동결한다. 같은 identity + 같은 envelope는 idempotent success, 같은 identity + 다른 envelope는 conflict다.

**Publish와 executable task의 경계.** COMMITTED receipt는 external creation authority지만 admission
authority가 아니다. fresh TaskSource read가 다음을 모두 만족해야 한다:

```text
task.task_ref == receipt.external_task_ref
task.body == snapshot.child_definition_body
task.definition_hash == snapshot.child_definition_hash
Core recomputed definition_hash == task.definition_hash
```

성공 시 ordinary §8.4 snapshot을 쓰면서 task row의 `materialization_binding_json`을 정확히 한 번 설정한다:

```text
ChildMaterializationBindingV1 {
  materialization_id
  materialization_hash
  task_source_id
  parent_task_key
  child_definition_hash
}
```

같은 task ref의 existing row에 binding이 없거나 다른 binding/hash/parent가 있으면 merge/upsert하지 않고
`SUBFLOW_MATERIALIZATION_CONFLICT`다. binding은 admission 뒤에도 provenance로 남고 rewrite/clear하지 않는다.
ordinary external/pre-existing task는 binding이 null인 것이 정상이다.

**No admission / no suspension.** snapshot, publish, receipt, round-trip 어느 단계도 child를 SELECTED/ACTIVE로
만들거나 parent를 suspend하거나 Task Contract/Grant를 생성하지 않는다. child는 DISCOVERED이고 parent는
그 상태를 유지한다. executable relation은 이후 §9.2f/§19.5 E admission transaction만 만든다.

**Bound.** F 하나는 child 하나만 만든다. validation은 §9.2g의 reservation count로
`batch_policy.max_tasks`를 넘는 snapshot/INTENT조차 만들지 않는다. 여러 child는 여러 exact Proposal이며
graph/priority/scheduler inference가 없다.

**Failure.** validation/Human Gate 전에는 side effect 0. adapter가 definitive NOT_FOUND/no-effect를
authoritative하게 증명한 실패만 idempotency FAILED로 끝내고 reservation을 해제할 수 있으며, parent는
`HELD(TASK_MATERIALIZATION_FAILED)`로 전이해 whole intent 실행이 child 필요성을 조용히 무시하지 않게 한다. COMMITTED 뒤
TaskSource visibility 지연은 DONE receipt를 보존한 채 같은 ref를 재관측한다. exact body mismatch,
duplicate/conflicting ref, unreadable snapshot/source는 task row를 만들지 않고 batch를 기존
`PAUSED_SAFELY`/recovery path로 보낸다. ambiguous INTENT에서 effect 존재를 판정할 수 없으면 blind retry나
두 번째 materialization id를 만들지 않는다(§21/§22).

---

## 9. Supervisor Decision / Validation TD

### 9.1 Supervisor Proposal schema v1 (M0-25)

**Proposal은 hash 대상 artifact가 아니다.** `platform/supervisor-proposal` envelope, `proposal_hash`,
proposal snapshot table을 만들지 않는다 — strict typed structured input일 뿐이다. Model 발화를 파싱해
authority로 승격하지 않는다(I-TD3): validator의 입력은 이미 구조화된 Proposal 객체다.

**DecisionType v1 (고정, 8종):**

```text
START_TASK  REQUEST_REWORK  PROPOSE_MERGE  HOLD_TASK
DEFER_TASK  START_SUBFLOW   RESUME_PARENT  CLOSE_BATCH
```

unknown DecisionType은 V1 schema invalid다. B4 `human_gate_policy.required_decisions`가 같은 vocabulary를
재사용한다(§7.1b).

**네 MVP 0/1 structural variant + 두 MVP 3 subflow variant.** decision별 개별 schema를 만들지도, 모든
decision에 의미 없는 field를 강제하는 단일 flat schema를 쓰지도 않는다. 각 variant wrapper와 `expected`
wrapper는 **exact field set**이며 unknown field는 reject다. 기존 네 variant의 MVP 0/1 seal은 불변이다.
prospective MVP 3의 E는 existing child admission, F는 child definition materialisation이며 서로 다른 exact
shape다. F는 admission Proposal의 missing `task_ref/version/hash`를 Platform이 사후 보완하는 escape hatch가
아니다 — external identity가 생긴 뒤 E를 새로 제출한다.

```yaml
# A. TaskSelectionProposalV1  — START_TASK
proposal_id, decision, task_ref, classification,
pipeline_id, actor_profile, verification_profile, repository_scope_id, expected, reason_refs
expected: { task_version, task_definition_hash, base_head, compiled_profile_hash }

# B. RepositorySensitiveTaskControlProposalV1 — REQUEST_REWORK | PROPOSE_MERGE
proposal_id, decision, task_ref, expected, reason_refs
expected: { task_version, task_definition_hash, base_head, compiled_profile_hash }

# C. TaskControlProposalV1 — HOLD_TASK | DEFER_TASK | RESUME_PARENT
proposal_id, decision, task_ref, expected, reason_refs
expected: { task_version, task_definition_hash, compiled_profile_hash }

# D. BatchControlProposalV1 — CLOSE_BATCH
proposal_id, decision, expected, reason_refs
expected: { compiled_profile_hash }

# E. SubflowSelectionProposalV1 — START_SUBFLOW (MVP 3, prospective)
proposal_id, decision, task_ref, classification,
pipeline_id, actor_profile, verification_profile, repository_scope_id,
parent, expected, reason_refs
parent: {
  task_key, attempt_key, task_contract_hash, attempt_state
}
expected: { task_version, task_definition_hash, base_head, compiled_profile_hash }

# F. SubflowChildMaterializationProposalV1 — START_SUBFLOW materialisation phase (MVP 3, prospective)
proposal_id, decision, parent, child, expected, reason_refs
parent:
  | { kind: DISCOVERED_TASK,
      task_key, task_ref, task_version, task_definition_hash }
  | { kind: ACTIVE_ATTEMPT,
      task_key, attempt_key, task_contract_hash, attempt_state }
child: { task_definition_body: TaskDefinitionBodyV1 }
expected: { compiled_profile_hash }
```

- **B**는 §19.3대로 동일 Attempt/snapshot/session의 rework 경로이므로 pipeline/actor_profile/
  verification_profile을 재선택하지 않는다. `PROPOSE_MERGE`도 새 Actor/Verification profile 선택이 아니다.
  **`repository_scope_id`도 selection variant에만 있다** — rework는 기존 Attempt의 Task Contract에 동결된
  scope를 그대로 쓰며 새 scope를 고르지 않는다(§10.1).
- **C**는 repository expected HEAD를 요구하지 않는다 — 이 셋의 repository/state legality는 §19.3
  transition guard가 소유한다.
- **D**에 `task_ref`/classification/pipeline/profile/task hash/base_head를 fake placeholder로 넣지 않는다.
- **E의 `parent`는 Supervisor가 관측한 explicit relationship intent다.** `task_key`는 Platform durable parent
  identity이고, 나머지 세 field는 그 parent의 current Attempt/Contract/continuation point에 대한 stale guard다.
  `parent = batch의 unique in-flight task`나 `parent = 유일 ACTIVE task` 같은 cardinality inference는
  금지다. **Uniqueness is not relationship authority.** TaskSource 또는 durable Platform record가 이미 exact
  parent relation을 authority로 가진 경우, Proposal producer가 그 relation에서 E를 deterministic하게 구성할
  수는 있다. 이때도 normalized E는 네 parent field를 모두 가지며 `reason_refs`가 relation provenance를
  지목한다. UI label, issue topology, subscriber visibility, 주변 task 수는 parent authority가 아니다.
- **F는 child semantic authoring Proposal이지 admission이 아니다.** `decision` literal은 기존 policy
  vocabulary를 재사용하는 `START_SUBFLOW`지만 `task_ref`/classification/pipeline/profile/scope/base_head가
  없다. `child.task_definition_body`는 §8.1a exact four-field body이며 Supervisor의 complete semantic
  선택이다. Platform이 empty/default title, acceptance, reference를 추가하지 않는다.
- F의 `DISCOVERED_TASK` parent는 whole-intent intake용이다. fresh TaskSource version/hash와 durable
  `DISCOVERED`/Attempt 없음이 exact해야 한다. `ACTIVE_ATTEMPT`는 실행 중 decomposition용이며 E의 current
  Attempt/Contract stale guard vocabulary를 재사용한다. 두 variant 모두 semantic parent는 exact
  `task_key` 하나이고 cardinality inference는 금지다.
- F는 external `task_ref`/version/hash를 요구하거나 허용하지 않는다. 그것은 §8.1b adapter와 fresh
  TaskSource round-trip이 나중에 확립한다. 이후 E에서 Supervisor가 observed child와 Profile-declared
  classification/pipeline/role/verification/scope를 직접 선택한다. F acceptance에서 E를 Platform이 제조하지
  않는다.

**공통 field 규칙.** `proposal_id`는 valid ULID. `reason_refs`는 `string[]`이며 empty 허용, 각 item
non-empty, **입력 순서 보존, 중복 허용** — semantic set이 아니므로 sorting/dedup/normalization을 추가하지
않는다(M0-13 목록 밖). `task_ref`가 있는 variant에서 그 값은 non-empty adapter-scoped opaque string이며
`:`를 허용하고 Core는 내부 syntax를 해석하지 않는다(§6.1 D+). selection variant의 `classification`,
`pipeline_id`, `actor_profile`, `verification_profile`, `repository_scope_id`는 모두 non-empty string이다.

**`proposal_id` authority (#60).** Supervisor가 제출하는 Proposal의 `proposal_id`는 semantic choice가
아니라 Platform-assigned Proposal identity다. Coordinator/Platform input layer가 Supervisor turn을 보내기
**전에** valid ULID 하나를 할당하고 §13.4 `SupervisorDecisionContextV1.proposal_id`로 제공한다.
Supervisor는 그 값을 Proposal에 **변경 없이 echo**한다. V1은 ULID grammar와 active turn의 allocated
value와의 exact equality를 모두 검증하며, active context가 없거나 값이 다르면
`POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID)`(`/proposal_id`)다.

allocation은 snapshot/grant/decision id와 같은 existing caller-supplied ULID factory seam을 재사용한다.
Core 내부 clock/random generator, identifier service, allocation registry를 만들지 않는다.

Platform/Harness가 model output을 받은 **뒤** 새 id를 넣거나 교체하는 경로는 없다. active turn context를
restart 뒤 안전하게 correlate할 수 없으면 기존 indeterminate Runtime-turn/recovery semantics로
fail-closed하며, 반환된 output 주위에 새 id를 만들어 acceptance를 복구하지 않는다. Proposal snapshot
table, proposal store, identity registry는 만들지 않는다.

**`repository_scope_id`의 authority 경계 (M1-6).** Supervisor는 `repository_scope` body를 제안하지 않는다 —
`allowed_paths`/`forbidden_paths`를 Proposal에 담을 자리가 아예 없고, Model이 고를 수 있는 것은 Project
Profile이 이미 선언한 **id 하나**뿐이다. 따라서 Model은 Profile에 존재하지 않는 임의 path scope를 만들 수
없다(I-TD3). Profile에 broad scope가 선언되어 있다면 그것은 Profile author가 proposal-selectable한 project
semantic으로 **명시적으로** 허용한 것이며, 그 판단은 Profile 변경 경로(§7.1c 승인 override, §7.4 batch
freeze)의 통제를 받는다.

`expected` 블록의 목적은 종전대로 **Supervisor가 자기가 본 세계를 명시**하게 하여 관측과 Platform
authoritative 상태의 divergence를 V3에서 기계적으로 잡는 것이다.

### 9.2 Validation 순서 (전부 통과 전 side effect 없음)

**결과 (M0-26).** Decision Validator의 public result는 정확히 네 종류다:

```text
{ kind: ACCEPTED }
{ kind: HUMAN_GATE_REQUIRED }
{ kind: POLICY_REJECTED,      reason_code: DecisionRejectReason }
{ kind: BACKEND_INCOMPATIBLE, detail: { operation_id, role, failure } }
```

**precedence (M0-28).** `V1 → V2 → … → V11` 순서로 평가하고, N/A step은 skip하며, **첫 non-PASS에서
종료**한다. 여러 실패를 aggregate하지 않는다 — 예: TASK_DRIFT와 repository mismatch가 동시라면
`TASK_DRIFT`를 반환한다.

**authoritative input boundary (M0-27).** Validator Core는 **pure deterministic function**이며
`TaskSource.get_task()` / `RepositoryAdapter.verify_canonical_head()` / Store query를 **직접 호출하지
않는다.** caller가 authoritative owner에서 관측한 read-model을 공급한다:

```text
proposal
compiled_profile + compiled_profile_hash        # B4 CompiledProfileV1 (effective만 사용)
TaskLookupView   { status: FOUND, task } | { status: NOT_FOUND }
RepositoryValidationView { canonical_head }     # RepositoryAdapter fact의 projection
BackendManifestSet                              # B5 validated
DecisionValidationBatchView                     # §V11
SubflowParentValidationView | null               # §9.2f; E에서만 non-null
SupervisorProposalIdentityView { proposal_id }     # active §13.4 turn의 Platform allocation
ChildMaterializationParentViewV1 | null          # §9.2g; F에서만 non-null
ChildMaterializationBatchViewV1 | null           # §9.2g reservation bound
ChildMaterializationCapabilityViewV1 | null      # Compiled Profile v3 materializer projection
```

ordinary submission에서 `SupervisorProposalIdentityView`의 source는 active
`SupervisorDecisionContextV1`이다. §17.3 post-Human-Gate revalidation에서는 새 id를 할당하지 않고,
terminal `record_hash`가 bind한 `gate_proposal.proposal_id`와 `created_from = proposal:<same id>`의 exact
equality를 검증해 같은 view를 재구성한다. 이 특례는 이미 최초 V1을 통과한 exact Proposal copy 하나에만
적용되며 generic bypass가 아니다.

TaskSource unavailable/malformed/IO failure는 **`NOT_FOUND`로 가장하지 않는다** — 그런 operational failure
에서는 caller가 validator를 호출하지 않으며 매핑은 Coordinator 소관이다. raw Model fact는 어떤 단계에서도
authoritative input이 아니다.

```text
V1  Proposal structural/domain validation (variant exact shape, unknown field reject)
      → POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID)
      task lookup·membership·repository·capability·batch·state legality를 V1에 섞지 않는다.
      prospective MVP 3에서 parent 없는 legacy-shaped START_SUBFLOW는 E가 아니므로
      POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID). validated-but-unapplied acceptance로 parent를 나중에
      고르는 경로도 금지한다.
      proposal_id가 valid ULID가 아니거나 SupervisorProposalIdentityView.proposal_id와 exact
      equality가 아니면 POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID) at /proposal_id.
      F.child.task_definition_body는 §8.1a exact body validation/hash recomputation을 통과해야 한다.
      F에 task_ref/classification/pipeline/profile/scope/base_head/external identity field가 있으면 invalid다.

V2  task 존재 — task-bearing variant(A/B/C/E)에만 적용, CLOSE_BATCH는 N/A
      TaskLookupView.status == NOT_FOUND → POLICY_REJECTED(TASK_NOT_FOUND)
      E는 SubflowParentValidationView도 FOUND여야 한다
      → 아니면 POLICY_REJECTED(SUBFLOW_PARENT_NOT_FOUND)
      F는 child lookup이 N/A이고 ChildMaterializationParentViewV1이 FOUND여야 한다
      → 아니면 POLICY_REJECTED(SUBFLOW_PARENT_NOT_FOUND)

V3  expected freshness (M0-25). task-bearing variant는 아래 순서로 비교한다:
      1) expected.task_version         == TaskDefinition.version          → 불일치: TASK_DRIFT
      2) expected.task_definition_hash == TaskDefinition.definition_hash  → 불일치: TASK_DRIFT
      3) expected.compiled_profile_hash == 현재 Compiled Profile hash      → 불일치: PROFILE_DRIFT
      CLOSE_BATCH는 3)만 비교한다.
      E는 이어서 parent.task_key/attempt_key/task_contract_hash/attempt_state를
      fresh SubflowParentValidationView와 exact 비교한다
      → 하나라도 불일치: SUBFLOW_PARENT_STALE
      F는 expected.compiled_profile_hash를 비교한 뒤 tagged parent basis를 §9.2g fresh view와 exact 비교한다.
      DISCOVERED_TASK의 task_ref/version/definition_hash/state/Attempt 없음 또는 ACTIVE_ATTEMPT의
      attempt/contract/state가 다르면 SUBFLOW_PARENT_STALE.
      이로써 Spec §18의 "Task version 일치"를 직접 만족한다. version은 §8.1a대로 definition hash에
      포함되지 않으므로(M0-20 유지) body 동일·version 변경도 여기서 잡힌다.

V4  classification — selection variant(A/E)에만 적용
      proposal.classification ∈ effective.project.classifications
      → 아니면 POLICY_REJECTED(CLASSIFICATION_UNKNOWN)
      control Proposal에 fake classification을 요구하지 않는다.
      F는 classification을 아직 선택하지 않으므로 N/A다.

V5  decision authorization (§9.2a) — policy/disposition만 판단. current state legality는 §19.3 소유.

V6  profile reference — selection variant(A/E)에만 적용
      pipeline_id          ∈ effective.project.pipelines
      actor_profile        ∈ effective.project.roles
      verification_profile ∈ effective.project.verification_profiles
      repository_scope_id  ∈ effective.project.repository_scopes    # M1-6
      → 하나라도 실패: POLICY_REJECTED(PROFILE_REFERENCE_UNKNOWN)
      네 번째 reference도 기존 reason code를 재사용한다 — 새 V-step도 새
      DecisionRejectReason도 만들지 않으며 V4/V5의 classification/disposition
      semantics는 변경되지 않는다.
      E의 selected pipeline은 frozen definition의 terminal step이 RESUME_PARENT여야 한다
      → 아니면 POLICY_REJECTED(SUBFLOW_PIPELINE_INVALID)
      F는 selection reference가 N/A이고 §9.2g capability view가 ProjectProfile/CompiledProfile v3의
      sole TaskSource-bound materializer를 exact하게 증명해야 한다
      → 아니면 POLICY_REJECTED(SUBFLOW_MATERIALIZER_UNAVAILABLE)

V7  Human Gate (§9.2b) → HUMAN_GATE_REQUIRED (거부도, 실행 승인도 아님)

V8  repository expected state — variant A/B/E에만 적용, C/D는 N/A
      expected.base_head == RepositoryValidationView.canonical_head
      → 불일치: POLICY_REJECTED(REPOSITORY_STATE_MISMATCH)
      F는 repository mutation/admission이 아니므로 N/A다.

V9  capability derivation feasibility (§9.2c) — Grant를 발급하지 않는다
      → 불가: POLICY_REJECTED(CAPABILITY_DERIVATION_FAILED)
      F는 Actor/Auditor/Repository capability를 요청하지 않으므로 N/A다. §8.1b mutation reach는
      §9.2g의 typed materializer capability가 소유한다.

V10 Backend Compatibility Gate (§9.2d) — 실패: BACKEND_INCOMPATIBLE(detail)
      §12.2의 directional accepted-set membership만 평가한다. `receipt_supported`는 V10 조건이
      아니다 — M0-19.
      F는 Runtime/Workflow/Repository/Verification Backend operation이 아니므로 N/A다.

V11 batch admission / concurrency (§9.2e) — A/E admission에 적용. F는 §9.2g reservation bound를 적용
```

`DecisionRejectReason` v1 exact vocabulary (그 외 임의 문자열 금지):

```text
PROPOSAL_SCHEMA_INVALID   TASK_NOT_FOUND            TASK_DRIFT
PROFILE_DRIFT             CLASSIFICATION_UNKNOWN    DECISION_NOT_ALLOWED
PROFILE_REFERENCE_UNKNOWN REPOSITORY_STATE_MISMATCH CAPABILITY_DERIVATION_FAILED
BATCH_MAX_TASKS_REACHED   CONCURRENCY_LIMIT_REACHED WRITABLE_CONCURRENCY_CONFLICT
SUBFLOW_PARENT_NOT_FOUND  SUBFLOW_PARENT_STALE       SUBFLOW_PARENT_INELIGIBLE
SUBFLOW_PARENT_BATCH_MISMATCH SUBFLOW_RELATION_CONFLICT SUBFLOW_CYCLE_DETECTED
SUBFLOW_PIPELINE_INVALID SUBFLOW_MATERIALIZER_UNAVAILABLE SUBFLOW_MATERIALIZATION_CONFLICT
SUBFLOW_MATERIALIZATION_DRIFT
```

V10 실패는 이 enum이 아니라 `BACKEND_INCOMPATIBLE` result kind다.

결과는 `decision_log`에 append되고 — **rejected와 HUMAN_GATE_REQUIRED도 append한다** — `ACCEPTED`인 경우에만
Coordinator가 A/E transition 또는 F의 §8.4b operation을 시작한다. F acceptance는 admission/state
transition authority가 아니다. pure validator와 durable append wrapper의 분리는 구현 세부이며 B2
`decision_log`를 재사용한다(새 decision table/event framework 없음). Batch 7에서 허용되는 durable write는
이 append뿐이며 Runtime/Workflow/Repository mutation, state transition, PendingHumanDecision 생성, Report
발송, Task Contract/Grant persistence는 하지 않는다.

### 9.2a V5 — decision authorization (M0-26)

V5는 **Execution Policy와 effective classification disposition이 이 Proposal type을 허용하는가**만
판단한다. Task/Attempt current-state legality는 §19.3 transition precondition이 fail-closed authority다.

| decision | 조건 | 결과 |
|---|---|---|
| `START_TASK` | disposition `AUTO_EXECUTE` | PASS |
| | disposition `HOLD_HUMAN` | PASS → V7에서 `HUMAN_GATE_REQUIRED` |
| | disposition `AUTO_SUBFLOW` | `DECISION_NOT_ALLOWED` |
| `START_SUBFLOW` | `effective.policy.allow_auto_subflow == false` | `DECISION_NOT_ALLOWED` |
| E + 위 통과 + disposition `AUTO_SUBFLOW` | PASS |
| E + 위 통과 + disposition `HOLD_HUMAN` | PASS → V7 |
| E + 위 통과 + disposition `AUTO_EXECUTE` | `DECISION_NOT_ALLOWED` |
| F + 위 통과 | PASS — classification disposition은 이후 E에서 판정 |
| `REQUEST_REWORK` | — | PASS (rework_count/max_rework/AttemptState는 §19.3 guard) |
| `PROPOSE_MERGE` | `auto_merge` 값과 무관 | PASS |
| `HOLD_TASK` / `DEFER_TASK` / `RESUME_PARENT` / `CLOSE_BATCH` | — | PASS |

- **`allow_auto_subflow=false`를 human gate 하나로 우회하지 않는다** — Execution Policy를 사람 approval로
  암묵 override하는 경로를 만들지 않는다.
- F가 classification을 미리 선택하지 않는 것은 policy bypass가 아니다. external child를 exact하게
  re-observe한 뒤 E가 새 Proposal로 classification/disposition/profile을 선택·검증하며, F acceptance를 E
  acceptance로 재사용하지 않는다.
- **`PROPOSE_MERGE`는 `auto_merge=false`에서도 V5에서 거부되지 않는다.** `auto_merge`는 automatic canonical
  side effect의 authority이지 merge proposal 자체의 권한이 아니며, MVP 1 §19.4 Human Merge 경로가 살아
  있어야 한다.
- **`RESUME_PARENT`의 V5 PASS는 resume authority가 아니다.** prospective MVP 3에서 normal resume는
  §19.5.3 predicate가 직접 소유한다. Proposal은 exceptional re-observation/recovery request일 뿐이며,
  predicate 또는 exact recovery/operator authorization 없이 `SUSPENDED→ACTIVE`를 만들지 못한다.

### 9.2b V7 — Human Gate (M0-26)

다음 중 하나면 `HUMAN_GATE_REQUIRED`다(둘 다 참이어도 결과는 하나):

```text
Rule A  proposal.decision ∈ effective.policy.human_gate_policy.required_decisions
Rule B  selection variant(A/E)이고 effective classification disposition == HOLD_HUMAN
```

F의 `decision`도 literal `START_SUBFLOW`이므로 Rule A가 적용된다. policy가 START_SUBFLOW를 Human Gate로
지정했다면 publish **전** exact F Proposal 승인이 필요하다. 이후 E는 fresh 별도 Proposal이므로 같은 Rule
A/B를 다시 통과하며, F approval을 admission approval로 확대하지 않는다.

- V1–V6 실패가 있으면 그것이 먼저 반환된다 — human gate는 invalid proposal을 승인하는 escape hatch가 아니다.
- V7이 `HUMAN_GATE_REQUIRED`를 반환하면 **V8–V11을 실행하지 않으며** 어떤 execution side effect도 없다.
- Batch 7은 PendingHumanDecision을 **생성하지 않는다** — 이 결과는 Coordinator가 이후 소비할
  deterministic branch일 뿐이다.
- MVP 1 §19.4의 mandatory human merge semantics를 V7로 대체하지 않는다. READY_TO_MERGE 이후의 필수 merge
  decision은 Batch 8/Coordinator lifecycle contract 그대로다.

### 9.2c V9 — capability derivation feasibility (M0-27)

가상의 `dryRunBroker()` API를 만들지 않는다. §12.4의 requested map 계산과 §12.2a의 directional enforcement
선택이 deterministic하게 가능한지만 확인하며, **Grant를 발급하지 않는다**(따라서 `grant_id`도, Task
Contract도, `TaskContractCapabilityView`도 필요 없다).

```text
selection variant(A/E)           → ACTOR, AUDITOR 두 role에 대해 derivation
PROPOSE_MERGE + auto_merge=true  → ACTOR requested/enforcement 계산
그 외                             → N/A
```

Task Contract가 두 Grant를 모두 동결하므로(§10.1) selection 단계에서 둘 다 계산 가능해야 한다.
SUPERVISOR grant derivation은 요구하지 않는다. 실패 시 `POLICY_REJECTED(CAPABILITY_DERIVATION_FAILED)`.

### 9.2d V10 — Backend Compatibility Gate (M0-27)

`operation_id`는 계속 Execution Policy가 소유하는 **opaque non-empty string**이며 generic operation enum을
만들지 않는다. 다만 **DecisionValidator v1이 직접 참조하는 operation id는 정확히 세 개**로 고정한다:

```text
actor_execution   auditor_execution   automatic_merge
```

Policy에 다른 custom operation id가 존재할 수 있으나 validator가 임의로 선택·추론하지 않는다. Proposal에
`operation_id` field를 추가하지 않으며 **Model이 operation을 선택하지 않는다.**

```text
START_TASK / START_SUBFLOW
  1) operation_id = actor_execution,    role = ACTOR
  2) operation_id = auditor_execution,  role = AUDITOR

PROPOSE_MERGE
  effective.policy.auto_merge == true  → operation_id = automatic_merge, role = ACTOR
  auto_merge == false                  → N/A  (Human Merge 경로를 capability requirement로 막지 않는다)

그 외 decision → N/A
```

- **missing requirement = empty requirement set = compatible.** 해당 operation이 policy에 선언되지 않았다는
  사실만으로 incompatible로 만들지 않는다 — Execution Policy가 요구를 선언했을 때만 enforcement minimum을
  강제한다.
- `auto_merge=true`일 때 `automatic_merge` declaration이 필요하다는 §7.3 S9 invariant는 Compiled Profile이
  이미 보장하므로 B7에서 다시 compile하지 않는다.
- 판정은 §12.2 그대로: `requested ? allow : deny` 방향 선택 후 `actual ∈ accepted`. assurance ranking·
  numeric level·`NOT_YET_AUDITED` 암묵 통과·`receipt_supported` 추론·opaque `features` 사용은 전부 금지다.
  `receipt_supported`나 `features`만 달라져도 V10 결과는 동일해야 한다.
- 실패는 `BACKEND_INCOMPATIBLE`이며 detail은 최소 `{ operation_id, role, failure }`로, `failure`는 §12.2
  compatibility primitive의 기존 failure projection을 **재사용**한다(같은 의미의 두 번째 failure schema를
  만들지 않는다). 여러 operation을 검사할 때는 위 순서의 **첫 실패**를 반환한다.
- 이 gate가 canonical execution side effect **이전에** 결정적으로 차단하는 것이 MVP 0 Acceptance A5다.

### 9.2e V11 — batch admission / concurrency (M0-28)

Batch 8 Store/schema를 B7로 당기지 않는다. caller가 pure read-model을 공급한다:

```text
DecisionValidationBatchView {
  admitted_task_count:             integer >= 0   # 이 batch에서 SELECTED된 적 있는 task 수
                                                  # (완료/HELD/FAILED가 되어도 소비 기록은 남는다)
  active_task_count:               integer >= 0   # concurrency slot을 점유한 non-terminal task 수
  active_writable_candidate_count: integer >= 0   # 동일 canonical repo에서 writable candidate 보유 task 수
}
```

exact 세 field이며 구체 Store query는 Batch 8/Coordinator의 projection이다. V11은
`START_TASK`/`START_SUBFLOW`에 적용하며 순서는:

```text
1 admitted_task_count >= batch_policy.max_tasks        → BATCH_MAX_TASKS_REACHED
2 active_task_count   >= batch_policy.concurrency      → CONCURRENCY_LIMIT_REACHED
3 선택된 pipeline에 ACTOR step 존재 AND
  active_writable_candidate_count >= 1                 → WRITABLE_CONCURRENCY_CONFLICT
```

**두 mode (M1-7 + §17.4).** 같은 `START_TASK`가 신규 admission일 수도 있고, 이미 admitted된 task의
**explicit reselection**(§19.3 `HELD(SELECTION_STALE)` 또는 §17.4
`HELD(REATTEMPT_REQUIRED:<decision_id>)` 해소)일 수도 있다. 후자는 새 admission이 아니므로 rule 1을 다시
소비하지 않는다:

```text
SelectionAdmissionKind = INITIAL_ADMISSION | RESELECTION

INITIAL_ADMISSION   rule 1,2,3 전부 적용 (종전 그대로)
RESELECTION         rule 1 = N/A  — 이 task는 이미 admitted slot을 소비했다
                    rule 2,3 = 적용 — 지금 실행을 시작해도 되는지는 다시 봐야 한다
```

`SelectionAdmissionKind`는 **Proposal field가 아니다.** Model이 공급하지 않고, Coordinator가 durable task
state(`platform_state == HELD` + reason이 `SELECTION_STALE` 또는 `REATTEMPT_REQUIRED:<decision_id>` +
`admitted_at != null` + current non-terminal Attempt 부재)에서 결정해 typed caller context로 넘긴다.
generic operating-mode framework가 아니라 이 한 판정을 위한 두 값짜리 enum이다. **새
DecisionRejectReason은 추가되지 않는다** — RESELECTION에서도 rule 2/3의 기존 reason code를 그대로 쓴다.

`batch.admission_closed`는 **새 task admission**의 차단이지 이미 admitted된 task의 안전한 진행 차단이
아니므로, RESELECTION은 `admission_closed == true`라는 이유만으로 거부되지 않는다 — `max_tasks` 도달로
admission이 닫힌 batch에서도 기존 admitted task는 lifecycle을 계속 진행할 수 있어야 하고, 이는
`CLOSE_BATCH`가 진행 중 task를 강제 종료하지 않는다는 §19.3a의 기존 semantics와 같은 성질이다.

pipeline의 ACTOR 유무는 B4 `PipelineStep` vocabulary(§7.1a)를 그대로 사용하며 새 writable classification
field를 만들지 않는다 — ACTOR가 없는 review-only pipeline은 rule 3의 writable slot을 요구하지 않는다.
`REQUEST_REWORK`의 `max_rework` 검사는 V11이 아니라 §19.3 state guard다.

**START_SUBFLOW projected admission (prospective MVP 3).** E는 parent `ACTIVE→SUSPENDED`와 child
`DISCOVERED→SELECTED`가 한 transaction에서 일어날 것을 전제로 V11을 계산한다. 따라서 parent가 소비하던
`active_task_count` slot 하나와 child가 소비할 slot 하나는 atomic하게 교환되며 concurrency를 둘로 부풀리지
않는다. 그러나 parent에 이미 존재하는 writable candidate/workspace conflict는 suspension으로 사라지지 않는다.
rule 3은 그 fact를 그대로 세며, conflict가 있으면 `WRITABLE_CONCURRENCY_CONFLICT`다. `admitted_task_count`는
child 하나만 증가한다. 이 projected 계산과 같은 식을 §19.5 admission transaction 안에서 current rows로
다시 평가한다.

**lifecycle legality 경계.** "현재 AttemptState에서 REQUEST_REWORK 가능한가", "현재 READY_TO_MERGE인가",
"parent가 실제 suspended인가", "batch가 close 가능한가" 같은 판단의 fail-closed authority는 §19.3/§20의
state-machine precondition이다. V5는 policy authorization, V11은 admission/concurrency policy만 담당하며
state machine과 중복되는 guard table을 B7에 만들지 않는다.

### 9.2f START_SUBFLOW parent authority / binding (v1.5 PR #43 amendment)

[계약, PROSPECTIVE_REQUIREMENT] `START_SUBFLOW`의 relationship authority는 E의 explicit parent intent와
Platform의 fresh validation이 함께 만든다. **주변 cardinality, unique in-flight task, 유일 ACTIVE task는
relation authority가 아니다.** parent를 Task Contract 생성 단계나 Coordinator tick에서 새로 선택·추론하지
않는다.

Caller가 owner에서 구성하는 read-model은 exact shape다:

```text
SubflowParentValidationView =
  | { status: NOT_FOUND }
  | { status: FOUND,
      task_key, batch_id, platform_state,
      current_attempt_key, current_attempt_state, current_task_contract_hash,
      ancestor_task_keys, current_suspension_child_task_key,
      has_open_blocker, has_recovery_conflict }
```

`ancestor_task_keys`와 `current_suspension_child_task_key`는 §18.1f의 durable `parent_task_key`와 current
suspension transition에서만 derive한다. TaskSource unavailable, unreadable Store, corrupt relation은
`NOT_FOUND`가 아니라 validator 호출 전 operational failure이며 side effect 0이다(§9.2 authority boundary).

V2/V3/V6 통과 뒤 V11 안에서 다음을 순서대로 검증한다:

```text
P1 parent.batch_id == child.batch_id
   → SUBFLOW_PARENT_BATCH_MISMATCH
P2 parent.platform_state == ACTIVE
   AND current_attempt_state in {READY, IMPLEMENTING, VERIFYING, AUDITING, REWORKING}
   AND has_open_blocker == false
   AND has_recovery_conflict == false
   → SUBFLOW_PARENT_INELIGIBLE
P3 child task_key != parent task_key
   AND child task_key not in parent.ancestor_task_keys
   → SUBFLOW_CYCLE_DETECTED
P4 parent.current_suspension_child_task_key == null
   AND child has no current parent relation
   → SUBFLOW_RELATION_CONFLICT
P5 §9.2e projected admission rules 1–3 pass
```

P1–P5는 validation pass가 authority를 장기간 lease한다는 뜻이 아니다. §19.5 admission transaction이
child/parent/current Attempt/Contract/batch/cycle/conflict를 모두 다시 읽고 exact equality로 재검사한다.
하나라도 바뀌면 child admission, parent suspension, relation write 모두 0이다. 새 relationship engine이나
subflow scheduler table은 만들지 않는다.

### 9.2g F materialisation validation / E binding consumption (#59, prospective MVP 3)

F의 fresh parent view는 exact union이다:

```text
ChildMaterializationParentViewV1 =
  | { status: NOT_FOUND }
  | { status: FOUND,
      task_key, batch_id, platform_state, task_ref,
      task_version, task_definition_hash,
      current_attempt_key, current_attempt_state, current_task_contract_hash,
      has_open_blocker, has_recovery_conflict }

ChildMaterializationCapabilityViewV1 =
  | { available: false }
  | { available: true, task_source_id, materializer_adapter }

ChildMaterializationBatchViewV1 {
  admitted_task_count
  unadmitted_materialized_child_count
  parent_admitted
  admission_closed
}
```

capability view는 batch-bound Compiled Profile v3에서만 만들며 raw adapter installation/config probe를
authority로 쓰지 않는다. `materializer_adapter`는 diagnostic/reference용 declared id이고 Model 선택값이
아니다.

F parent rule:

```text
DISCOVERED_TASK:
  parent.platform_state == DISCOVERED
  current_attempt_key/state/contract == null
  task_ref/version/definition_hash == Proposal parent exact basis

ACTIVE_ATTEMPT:
  parent.platform_state == ACTIVE
  current attempt/state/contract == Proposal parent exact basis
  attempt_state in {READY, IMPLEMENTING, VERIFYING, AUDITING, REWORKING}

both:
  same batch, no open blocker, no recovery conflict
```

parent가 SELECTED/HELD/DEFERRED/SUSPENDED/terminal이면 F를 적용하지 않는다. F는 parent를 suspend/hold하지
않으며 accepted relation intent는 §8.4b immutable snapshot에 동결된다.

reservation rule은 external task spam과 later admission dead-end를 막는다:

```text
reserved = admitted_task_count
         + unadmitted_materialized_child_count
         + (parent_admitted ? 0 : 1)      # DISCOVERED whole-intent parent 자리 보존

admission_closed == true OR reserved >= batch_policy.max_tasks
  → BATCH_MAX_TASKS_REACHED
```

INTENT/COMMITTED이나 아직 TaskSource round-trip 전인 non-FAILED snapshot도
`unadmitted_materialized_child_count`에 포함한다. definitive no-effect FAILED만 reservation에서 제외한다.
concurrency/writable candidate는 publish 단계가 execution slot을 만들지 않으므로 F에서 N/A다.

**E consumption.** child task row의 `materialization_binding_json`이 non-null이면 E만 admission 가능하고:

```text
E.parent.task_key == binding.parent_task_key
fresh child.definition_hash == binding.child_definition_hash
snapshot(materialization_hash)의 parent/child hash == binding
```

를 추가로 요구한다. mismatch는 parent mismatch면 `SUBFLOW_MATERIALIZATION_CONFLICT`, body drift면
`SUBFLOW_MATERIALIZATION_DRIFT`다. A `START_TASK`로 materialized child를 ordinary top-level task처럼
admit하거나 다른 parent E로 rebind하지 않는다. binding null인 pre-existing external child는 D22의 기존
E path를 그대로 사용한다.

F validation/Human approval은 E acceptance가 아니다. TaskSource round-trip 뒤 Supervisor가 E에서
classification/pipeline/actor/verification/scope와 fresh expected values를 직접 선택·echo하고, V1–V11과
§9.2f를 전부 새로 통과한다.

---

## 10. Immutable Task Contract Snapshot TD (Q7의 절반)

### 10.1 저장 내용 (schema `platform/task-contract` v1, M0-21)

Envelope: `schema = "platform/task-contract"`, `schema_version = 1`.
**`hash`(task contract hash)는 envelope 전체의 hash이며 hash 대상 body 안에 넣지 않는다** — §7.7
`compiled_hash`, §12.5 `grant_hash`와 동일한 self-reference 금지 원칙이다. 외부/public projection이나
Store row가 `snapshot_id` + `hash`를 함께 보여주는 것은 무방하다.

Body는 **정확히 아래 12개 top-level field**를 가지며 전부 required, unknown top-level field는 reject다.

```yaml
task_contract_snapshot:            # = envelope body
  snapshot_id: ulid                # caller 공급 (grant_id와 동일 원칙, §12.5)
  task:
    ref:             <non-empty adapter-scoped opaque string>
    version:         <non-empty string>
    definition_hash: sha256:...    # §8.1a platform/task-definition v1 envelope hash
    body_copy:       <TaskDefinitionBodyV1>   # validated+normalized body의 immutable copy
                                              # (raw Markdown source text가 아니다)
  attempt: n
  base_head: <sha>                 # selection 시 검증된 base (§19.3a SelectionBindingV1, M1-7)
  compiled_profile_hash: sha256:...
  contract_sources:
    - { path: <non-empty, unique>, content_hash: sha256:... }   # §10.2 — storage_ref 없음
  pipeline_id: ...
  verification_profile: ...
  repository_scope:
    allowed_paths:   [ ... ]       # generic array — order-sensitive (M0-13)
    forbidden_paths: [ ... ]
  backend_requirements:            # Grant 계산에 사용한 Manifest를 동결
    runtime_manifest_hash:      sha256:...
    workflow_manifest_hash:     sha256:...
    repository_manifest_hash:   sha256:...
    verification_manifest_hash: sha256:...
    provenance:
      runtime_adapter_version: ...
      backend_instance_id: ...     # non-secret 식별자만 (I-TD7)
  capability_grants:
    actor:   { grant_id: ..., grant_hash: sha256:... }
    auditor: { grant_id: ..., grant_hash: sha256:... }
  completion_conditions: [ <non-empty string>, ... ]
```

- **`completion_conditions` (v1 확정).** `string[]`이며 empty 허용, 각 item non-empty, **입력 순서 보존**,
  semantic-set normalization 없음. v1 builder는 **독립 authority input을 새로 만들지 않고** 정확히
  `task.body_copy.acceptance_notes`의 immutable copy를 사용한다. 즉 Project/TaskSource가 제공한 acceptance
  criteria가 그대로 완료 조건으로 동결되며, **Supervisor/Model이 별도 completion condition을 추가·삭제할
  수 없다.** Core는 condition 문자열의 project 의미를 해석하지 않는다. typed completion condition이
  필요해지면 schema version-up 대상이다.
- **`task.*` / `base_head` (authority — M1-7).** 이 네 값은 activation 시점의 최신 관측을 그대로 담는
  것이 아니라 **selection 시 검증된 basis와 일치함이 확인된** 값이다(§19.3a `SelectionBindingV1`).
  `task.version`/`task.definition_hash`/`task.body_copy`는 **하나의 fresh normalized TaskDefinition
  관측**에서 함께 오며(두 관측을 섞지 않는다), 그 version/hash가 binding과 exact equality일 때만 그
  body가 `body_copy`로 동결된다. `base_head`는 selection 시 검증된 값이고 activation의 fresh canonical
  읽기는 **새 base를 고르기 위한 것이 아니라 그 binding이 아직 유효한지 확인하기 위한 것**이다. 따라서
  `Attempt.base_head == SelectionBinding.base_head == TaskContract.base_head`가 항상 성립한다.
- **`repository_scope` (authority — M1-6).** 두 array는 M0-13의 semantic set 목록에 없으므로
  order-sensitive이며, v1에서 path→capability inference를 추가하지 않는다(§12.7
  `TaskContractCapabilityView` semantics 유지). **여기 동결되는 값은 caller가 정한 것이 아니라
  resolve된 것이다**: Project Profile이 `repository_scopes`로 선언하고(§7.1a), Proposal이
  `repository_scope_id`로 선택하고(§9.1), V6가 declared reference임을 검증하고(§9.2), admission이 그 id를
  durable하게 기록하고(§18.1a), activation이 **해당 batch에 bind된 immutable Compiled Profile**에서
  resolve한다(§12.7). Task Contract는 그 resolve된 값의 immutable copy를 동결한다.
  `repository_scope_id`는 Task Contract body에 **넣지 않는다** — selection provenance는 `task` row가,
  authority snapshot은 이미 존재하는 `compiled_profile_hash`가 갖고 있으므로 중복 provenance field를
  만들지 않는다. Contract가 동결하는 것은 실행에 실제 적용될 resolved scope다.
- **`backend_requirements`**는 정확히 four component Manifest hash를 bind한다(§12.2a) — aggregate manifest
  hash는 없다. **`capability_grants`에 SUPERVISOR grant를 넣지 않는다.**
- `contract_sources` array는 Project Profile이 선언한 순서를 보존하며(generic array), `path`는 §7.1a와
  동일하게 non-empty·unique다.

`capability_grants`는 **final Task Contract hash 이전에 생성된 immutable grant reference**다 — 생성
순서는 §12.7의 finalization order를 따르며, "Task Contract 생성"과 "Grant 발급"은 병렬이 아니라
`inputs → Grant → final snapshot` 순서다. `backend_requirements`의 four-way hash는 각 component의
`platform/backend-capability-manifest` v1 envelope hash이며(§12.2a), 별도 aggregate manifest hash는 없다.

`backend_requirements`로 인해 "이 Attempt는 어떤 Backend capability 조건에서 시작되었는가"가
immutable execution context의 일부가 된다. restart 시 현재 Manifest와의 재대조는 §22.2, 실제 적용
확인은 §12.6 `CapabilityEnforcementReceipt`가 담당한다.

### 10.1a Subflow Task Contract v2 relation freeze (v1.5 PR #43 amendment)

[계약, PROSPECTIVE_REQUIREMENT] ordinary `START_TASK`는 `platform/task-contract` v1을 그대로 쓴다.
`SubflowSelectionProposalV1`로 admitted된 child만 `schema_version = 2`를 사용한다. v2 body는 v1의 exact
12개 field에 아래 **한 required top-level field**를 더한 exact 13-field body다:

```yaml
subflow_binding:
  parent_task_key: ...
  parent_attempt_key: ...
  parent_task_contract_hash: sha256:...
  parent_attempt_state_at_suspend: READY | IMPLEMENTING | VERIFYING | AUDITING | REWORKING
  suspension_transition_ref: transition:<decision_log.seq>
```

이 값은 Proposal을 그대로 복사하지 않는다. §19.5의 atomic admission이 E의 parent 관측과 fresh durable
rows의 exact equality를 확인하고 suspension을 commit한 **뒤**, child activation builder가 그 authoritative
rows/transition에서 구성한다. 따라서 Task Contract 생성 단계는 parent를 선택하지 않고 이미 validated된
relation만 freeze한다. `parent_attempt_state_at_suspend`는 parent Attempt가 suspension 동안 변하지 않는다는
continuation point이고, restart 후 current Attempt와 불일치하면 normal resume는 fail-closed한다(§19.5.3).

v2 child Contract의 `pipeline_id`가 가리키는 frozen pipeline은 terminal step `RESUME_PARENT`여야 한다.
v1 ordinary Contract에 nullable parent field를 넣거나 `START_TASK`에 무의미한 placeholder를 강제하지 않는다.
새 Contract store/table은 없으며 기존 content-addressed snapshot/blob 저장을 재사용한다.

#59 materialized child도 Contract v2 build 시점은 E admission/activation 이후로 동일하다. builder는 fresh
TaskSource body가 `ChildMaterializationBindingV1.child_definition_hash`와 일치함을 확인한 뒤 §10.1의
`task.body_copy`로 동결하고, committed `parent_task_key`가 materialisation binding과 같은지도 확인한다.
`ChildTaskMaterializationSnapshotV1`은 provenance/input authority이지 Task Contract나 completion authority의
대체물이 아니다. F publish 시 Contract/Grant/Attempt를 미리 만들지 않는다.

### 10.2 Contract Source 보관 방식 — **Decision: content copy + raw sha256**

- snapshot 시점에 각 contract source 파일의 **내용 사본**을 Store의 blob 테이블에 저장하고
  `content_hash`(raw sha256)로 참조한다. blob은 content-addressed라 중복 저장이 자연히 dedup된다.
- Rationale: (a) 대상 문서는 로컬 md 수준으로 작고, (b) restart/repo 이동 후에도 계약 재구성이
  저장소 상태와 무관하게 가능해야 하며(Spec §22), (c) "immutable repository reference"는 로컬 Git에서
  가지 삭제/GC에 취약하다.
- Alternatives rejected: hash+repo-ref only(GC/브랜치 이동 취약), 외부 파일 디렉토리(원자성·정합 관리 추가 비용).
- Failure behavior: source bytes를 공급하지 못하면(파일 읽기 실패 등) 상위 build operation이
  `CONTRACT_BUILD_ERROR`로 실패하고 Attempt 시작 자체가 거부된다.
- MVP impact: MVP 0 blob 테이블 1개 추가로 종결.

**Capture boundary (M0-22).** Task Contract builder는 **filesystem을 직접 읽지 않는다.** caller가
pre-read raw bytes를 공급한다:

```text
ContractSourceInput { path: string, bytes: Uint8Array }

bytes → §6 raw Contract Source SHA-256 → BlobStore.put(bytes) → { path, content_hash }
```

- raw bytes를 **normalization하지 않는다**(개행/인코딩 차이가 hash 차이로 남아야 한다).
- **`content_hash`가 integrity identity이자 blob lookup address다** — 별도 `storage_ref`를 두면 동일
  bytes에 authority-like identifier가 둘 생기므로 **v1에서 제거한다.** 향후 다른 storage backend에서
  별도 ref가 실제로 필요해지면 Task Contract schema revision으로 추가한다.
- 기존 content-addressed BlobStore를 그대로 재사용하며 새 blob/content store abstraction을 만들지 않는다.
- filesystem path 해석·읽기 소유권은 이후 Coordinator/input layer의 책임이며, `core/contract` production
  logic에는 direct `fs` dependency를 두지 않는다.
- **Atomicity.** §26의 "snapshot + source blobs + grants를 동일 transaction"이라는 최종 요구는 유지된다.
  contract snapshot helper는 **caller-owned transaction 안에서** BlobStore를 사용할 수 있어야 하되 스스로
  Coordinator transaction을 소유하지 않는다. 새 transaction framework를 만들지 않고 §18.2의 기존
  primitive를 재사용한다. 따라서 §19.3 `SELECTED→ACTIVE` commit은 **이미 완성된 build 결과를 밖에서
  건네받는 대신 builder를 자기 transaction 안에서 호출**한다 — blob put이 그 transaction에 포함되어야
  하기 때문이며, contract algorithm·grant derivation·hash 규칙은 전부 이 절과 §12.7 소유 그대로다.

### 10.3 계약 동결 보장

Actor와 Auditor는 **snapshot_id/hash로 동일 계약을 전달받는다.** Coordinator는 Auditor spawn 시
Actor attempt에 기록된 snapshot hash를 재사용하며, 다른 hash로 Auditor를 spawn하는 코드 경로가 없다
(단일 함수 `bindContract(attempt_key)`만 존재).

---

## 11. Contract Drift — Execution Policy 기반 처리 (Q7 결정, v1.1 수정)

**Decision.** drift 처리는 Core에 하드코딩하지 않고 **Execution Policy의 `contract_drift_policy`**로
선언하며, Core는 Compiled Policy를 deterministic하게 집행만 한다. Immutable Snapshot의 의미는
"silent migration 금지"이지 "모든 변경 무조건 무시"가 아니다. 검사 시점은 **stage boundary**
(IMPLEMENTING→VERIFYING, VERIFYING→AUDITING, AUDITING→READY_TO_MERGE, READY_TO_MERGE→MERGING)다.

### 11.1 Action vocabulary (v1, 고정)

```text
CONTINUE_SNAPSHOT        # 동결본으로 계속. drift는 관측 기록만
REEVALUATE_AT_BOUNDARY   # boundary에서 새 값 기준 재평가 — 남은 stage가 불허되면 HELD+PendingDecision
INVALIDATE_AT_BOUNDARY   # boundary에서 Attempt → INVALIDATED (task는 HELD+PendingDecision, §19.2)
HOLD_AT_BOUNDARY         # boundary에서 HELD + PendingHumanDecision (Attempt 유지)
```

### 11.2 Policy schema와 기본값

```yaml
execution_policy:
  contract_drift_policy:
    project_profile:      { action: CONTINUE_SNAPSHOT }
    execution_policy:     { action: REEVALUATE_AT_BOUNDARY }   # 권한 축소를 안전측 반영
    task_definition:      { action: INVALIDATE_AT_BOUNDARY }
    contract_source:      { action: CONTINUE_SNAPSHOT }        # 프로젝트에 따라 INVALIDATE_AT_BOUNDARY 선택 가능
    canonical_head:       { action: HOLD_AT_BOUNDARY, boundary: MERGE_ONLY }
    verification_profile: { action: CONTINUE_SNAPSHOT }
    capability_requirements: { action: REEVALUATE_AT_BOUNDARY }   # canonical field명 (§7.1b)
```

- `canonical_head`의 `boundary: MERGE_ONLY`: IMPLEMENTING/VERIFYING/AUDITING 중에는 관측만 하고
  READY_TO_MERGE/MERGING boundary에서 HOLD(merge fail-closed, 자동 rebase 금지). Profile Compiler는
  `auto_merge: true`인 policy에서 `canonical_head.action`이 `CONTINUE_SNAPSHOT`이면 COMPILE_ERROR로 거부.
- `REEVALUATE_AT_BOUNDARY`는 **권한 확대 방향으로는 아무것도 주입하지 않는다** — 확대는 언제나 다음
  Attempt/Batch부터다. 축소로 남은 stage가 불허되면 `HELD` + PendingDecision(INVALIDATE or 동결본 완료 허용).

**적용 구간 경계 (M1-7).** 위 stage boundary는 전부 **Attempt와 immutable Task Contract가 이미 존재하는**
구간이다. `SELECTED`(또는 `HELD(SELECTION_STALE)`)이고 아직 Attempt가 없는 **pre-Attempt** 구간의
staleness는 §11이 아니라 §19.3a의 selection binding semantics가 소유한다 — 동결된 계약이 아직 없으므로
`contract_drift_policy`의 action(CONTINUE_SNAPSHOT / INVALIDATE_AT_BOUNDARY …)을 적용할 대상 자체가 없다.
두 system을 합치지 않는다:

```text
SELECTED / Attempt 없음            → M1-7 selection binding (§19.3a) — SELECTION_STALE
ACTIVE / Attempt + Contract 존재   → §11 contract_drift_policy — CONTRACT_DRIFT
```

특히 canonical 이동은 두 구간에서 **의도적으로 다르게** 다뤄진다. Attempt 생성 전에는 아직 어떤 작업도
시작되지 않았으므로 새 repository 세계에 대해 Supervisor 판단을 다시 받는다(`SELECTION_STALE`). Attempt
생성 후에는 동결된 base를 유지한 채 관측만 하고 merge boundary에서 fail-closed한다
(`canonical_head: HOLD_AT_BOUNDARY, boundary: MERGE_ONLY`). 어느 쪽에도 silent base rebasing은 없다.

### 11.3 불변 규칙 (policy로도 변경 불가)

- **Silent migration 금지:** 어떤 action도 현재 Actor/Auditor에게 새 Profile/Policy/Contract Source
  내용을 주입하지 않는다. Contract Source가 변경되어도 진행 중 Attempt가 보는 것은 snapshot의 blob뿐이다.
- INVALIDATE는 항상 `decision_log` 명시 이벤트 + 새 snapshot_id + 명시적 재시작 결정(§19.2)을 거친다.
- Actor와 Auditor가 서로 다른 계약으로 실행되는 경로는 존재하지 않는다 (§10.3 단일 bind).
- Failure behavior: drift 검사 실패(TaskSource unreachable 등) → 해당 boundary에서
  `HELD(DRIFT_CHECK_UNAVAILABLE)` — 추측 진행하지 않는다(§24, M1-11).

### 11.4 Stage-boundary drift evaluation (M1-11 — concrete contract)

**구조.** §9.2의 Decision Validator와 같은 경계를 쓴다: authoritative owner가 읽고, 순수 evaluator가
판정한다. fact registry도, authority registry도, drift engine도 만들지 않는다.

```text
authoritative owners → DriftObservationV1 (typed read model) → evaluateStageBoundaryDrift → DriftOutcome
```

**target별 authority matrix.** frozen 쪽은 전부 이미 durable하다.

```text
target                  frozen baseline                              current authority / read
project_profile         Compiled.project_profile {id,version,hash}    ProfileSource(현재 Project Profile)
execution_policy        Compiled.execution_policy {id,version,hash}   ProfileSource(현재 Execution Policy)
task_definition         Contract.task {ref,version,definition_hash}   TaskSourceV1.get_task(ref)
contract_source         Contract.contract_sources[] {path,content_hash} ContractSourceReader(원본 bytes)
canonical_head          Attempt.base_head (= Contract.base_head)      RepositoryAdapter.snapshot_canonical()
verification_profile    Compiled.effective.project
                          .verification_profiles[contract.verification_profile]   ProfileSource 동일 read
capability_requirements Compiled.effective.policy.capability_requirements         ProfileSource 동일 read
```

- **비교 규칙.** component 두 개(project_profile / execution_policy)는 `{id, version, hash}` 동등성으로
  본다 — `compiled_hash` 하나만 보면 어느 target이 움직였는지 귀속할 수 없기 때문에 component ref를 쓴다.
  나머지는 각자의 정본 비교다: task_definition은 정규화된 `version`+`definition_hash`, contract_source는
  §10.2의 **raw SHA-256**(정규화 금지, mtime 금지), canonical_head는 commit identity, verification_profile /
  capability_requirements는 frozen sub-body와 현재 sub-body의 canonical JSON 동등성.
- **귀속 규칙.** `verification_profile` / `capability_requirements`는 각각 Project Profile / Execution
  Policy 안에 살기 때문에, 그 둘이 바뀌면 상위 component target도 함께 drift로 잡힌다. 이것을 heuristic
  attribution으로 풀지 않는다 — 두 target 모두 평가되고 §11.4의 precedence가 결과를 정한다. 사실 관계상
  둘 다 참이며 안전측이다.
- **boundary applicability.** target은 boundary마다 선택적으로 적용된다. v1에서 이를 쓰는 것은
  `canonical_head: boundary MERGE_ONLY`뿐이다 — VERIFYING→AUDITING에서 canonical 이동은 **관측·기록만**
  하고 그것만으로 HOLD하지 않으며, rebase도 `attempt.base_head` 변경도 없다.

**두 개의 새 read seam (M1-11).** `ProfileSource`(현재 Project Profile / Execution Policy)와
`ContractSourceReader`(현재 원본 bytes)는 Core에 없다 — §7의 Registry persistence/파일 접근은 명시적으로
Core 밖이다. TaskSource / RepositoryAdapter와 같은 계열의 **좁은 read seam**으로 도입한다. authority이지
framework가 아니다.

`ProfileSource`는 **component ref와 정규화된 body를 함께** 돌려준다. ref만으로는 위 matrix의
`verification_profile` / `capability_requirements` sub-body 비교와 REEVALUATE의 현재 pipeline/roles
확인을 수행할 수 없고, body만으로는 어느 component가 움직였는지 귀속할 수 없기 때문에 **둘 다 필요하다**.

```text
ProfileSource.current_project_profile()
  -> { ref: {id, version, hash}, body: ProjectProfileV1Body }      # 이미 §7.1a로 정규화된 typed body

ProfileSource.current_execution_policy()
  -> { ref: {id, version, hash}, body: ExecutionPolicyV1Body }     # 이미 §7.1b로 정규화된 typed body
```

- 정확히 두 호출뿐이다. `get(path)` / json-pointer / `metadata: Record<string, unknown>` /
  임의 `CanonicalObject` 조회 같은 data bag은 노출하지 않는다 — evaluator가 필요로 하는 것은 이미
  정의된 두 versioned body뿐이다.
- YAML 파싱·파일 접근은 이 seam 구현 안에 있고 **pure evaluator 안에는 없다**. evaluator는 I/O를 하지 않는다.
- 현재 body는 **관측**일 뿐이다. Task Contract / CapabilityGrant / Compiled Profile을 대체하지 않으며
  Attempt에 주입되지 않는다(§11.3 silent migration 금지).
- 이 Attempt에 대해 읽는 범위도 좁다: `pipelines[contract.pipeline_id]`, `roles`,
  `verification_profiles[contract.verification_profile]`, `capability_requirements`,
  `contract_drift_policy`. 무관한 project semantics는 보지 않는다.
- top-level target 두 개의 비교는 그대로 `{id, version, hash}` 동등성이다 — body를 함께 받는다고 해서
  `compiled_hash` 통짜 비교로 바꾸지 않는다. component 귀속은 계속 필요하다.

**결과 vocabulary.** evaluator는 lifecycle을 바꾸지 않고 판정만 돌려준다(전이 적용은 §19.3 commit helper).

```text
DriftOutcome =
  | { kind: "CONTINUE" }                        # CONTINUE_SNAPSHOT, 또는 축소가 아닌 REEVALUATE
  | { kind: "HOLD";        target: DriftTarget } # HOLD_AT_BOUNDARY, 또는 축소된 REEVALUATE
  | { kind: "INVALIDATE";  target: DriftTarget } # INVALIDATE_AT_BOUNDARY
  | { kind: "UNAVAILABLE"; target: DriftTarget } # 현재 값을 authoritative하게 읽지 못함
```

- **관측 성공 후 차이**와 **관측 실패**를 절대 합치지 않는다. 후자는 `HELD(DRIFT_CHECK_UNAVAILABLE)`이며
  "차이 없음"으로 접지 않는다. 셋을 구분한다:

```text
OBSERVED  현재 값을 authoritative하게 읽었고 frozen과 비교했다        → 같으면 무시, 다르면 drift
ABSENT    읽기는 성공했고 그 안에 해당 항목이 더 이상 없다            → 성공한 관측이며 곧 drift다
UNAVAILABLE 그 target의 현재 값을 authoritative하게 읽지 못했다        → HELD(DRIFT_CHECK_UNAVAILABLE)
```

  선택된 `verification_profile` id나 `pipeline_id`가 현재 Profile에서 사라진 것은 **ABSENT**이며,
  key가 없다는 이유로 UNAVAILABLE로 접지 않는다 — 그것은 현재 상태를 정확히 관측한 결과다.

**`DriftObservationV1` (typed read model).** evaluator는 이미 관측된 typed fact만 받고 I/O를 하지 않는다.
generic fact bag이 아니라 target별 상태가 명시된 좁은 구조다.

```text
DriftObservationV1 {
  boundary: StageBoundary
  frozen: {                       # 전부 이미 durable한 값
    project_profile: ComponentRef
    execution_policy: ComponentRef
    task: { ref, version, definition_hash }
    contract_sources: [ { path, content_hash } ]
    base_head: <commit>
    verification_profile: { id, body }
    capability_requirements: <map>
    auditor_capability: {                     # M1-11 최종 — Grant에서 온 동결 basis
      source_runtime_manifest_hash            #   provenance/binding identity
      requested                               #   동결된 요구 방향
      enforcement                             #   그 Backend 조건에서 선택된 assurance
    }                                         #   historical Manifest body는 필요하지 않다
  }
  current: {                      # target마다 OBSERVED{value} | ABSENT | UNAVAILABLE
    project_profile:        Observed<ComponentRef> | Unavailable
    execution_policy:       Observed<ComponentRef> | Unavailable
    task_definition:        Observed<{version, definition_hash}> | Absent | Unavailable
    contract_sources:       Observed<[{path, content_hash}]> | Absent | Unavailable
    canonical_head:         Observed<commit> | Unavailable
    verification_profile:   Observed<body> | Absent | Unavailable
    capability_requirements:Observed<map> | Unavailable
    auditor_stage:          Observed<{ has_auditor, auditor_profile_declared, requirement_met }>
                            | Absent | Unavailable      # REEVALUATE용, 위 A/B/C의 관측 결과
  }
  policy: contract_drift_policy    # Attempt-bound frozen policy
}
```
- **precedence (deterministic, object 순회 순서 비의존).** 모든 applicable target을 평가한 뒤
  `INVALIDATE > UNAVAILABLE > HOLD > CONTINUE`. 숫자 severity를 발명하지 않고 action 강도만 쓴다.
  INVALIDATE가 UNAVAILABLE보다 앞서는 이유: 전자는 **증명된 사실**이고 후자는 미지이며, 둘 다 실행을
  멈추므로 더 확정적인 기록이 남는 쪽을 택한다.
- **REEVALUATE_AT_BOUNDARY의 MVP 1 의미**는 "남은 stage가 여전히 허용되는가"뿐이며, 차이가 있다는 사실만으로
  HOLD하지 않는다. 축소를 안전측으로 반영하기 위한 것이므로 VERIFYING→AUDITING에서는 정확히 셋을 본다:

```text
A 현재 project.pipelines[contract.pipeline_id]가 여전히 AUDITOR를 포함하는가
B 그 pipeline의 auditor_profile이 존재하고 현재 roles에 선언되어 있는가
C 현재 policy.capability_requirements["auditor_execution"]이 Attempt-frozen Auditor
  CapabilityGrant와 여전히 호환인가 — 현재 requirement가 선언한 모든 capability에 대해
    current_requirement[c].accepted  ∋  auditor_grant.enforcement[c]
  ranking 없음, "minimum level" 없음, NOT_YET_AUDITED의 암묵적 수용 없음,
  요구 없음 = 호환(기존 의미 유지). 좁은 pure projection으로 계산한다(아래 참조).
```

  셋 다 허용이면 `CONTINUE`, 축소가 stage를 불허하면 `HOLD`다. 확대는 이 Attempt에서 무시된다.

- **capability basis (M1-11 최종 — 구현 선택지로 남기지 않는다).** C의 비교는 **Attempt-frozen Auditor
  CapabilityGrant**를 기준으로 수행한다. Runtime Manifest **body**를 되살리지 않는다: Task Contract v1은
  `runtime_manifest_hash`만 durable하게 갖고 manifest body registry나 hash→manifest resolver는 존재하지
  않으므로, body를 요구하면 restart 재구성이 정의되지 않는다. 그리고 그 body를 **현재 Backend에서 읽어
  hash로 대조하는 방식은 금지한다** — 그렇게 하면 진짜 Backend 변경이 §12.6/§22.2/RA-4가 분류하기 전에
  §11의 `DRIFT_CHECK_UNAVAILABLE`로 소비되어, 하나의 사실에 다시 두 authority가 생긴다.

  필요한 값은 이미 §12.5로 동결되어 있다. Grant의 `enforcement[c]`는 발급 시점에 그 Runtime Manifest
  조건에서 `requested[c]` 방향에 대해 **실제로 선택된 assurance**이지 근사치나 순위가 아니다. 즉 Grant는
  "그때 그 Backend 조건에서 Platform이 내린 authorization 결과"를 그대로 담고 있다.

```text
frozen basis  = Attempt-frozen Auditor CapabilityGrant
                  .requested   (동결된 요구 방향)
                  .enforcement (그 Backend 조건에서 선택된 assurance)
binding id    = grant.source_runtime_manifest_hash
                  == contract.backend_requirements.runtime_manifest_hash   (provenance 확인용)
```

  로드 대상은 `TaskContract.capability_grants.auditor`가 이미 가리키는 Grant이며 기존 store/검증 의미를
  그대로 쓴다. 최소 확인: `role == AUDITOR`, envelope hash == `capability_grants.auditor.grant_hash`,
  `grant.source_runtime_manifest_hash == contract.backend_requirements.runtime_manifest_hash`.
  `ManifestHistoryStore` / `BackendManifestRegistry` / manifest blob table / hash→manifest resolver는
  만들지 않으며, CapabilityGrant의 두 번째 표현도 만들지 않는다.

- **compatibility 규칙.** §12.2의 set semantics를 그대로 보존한다. 고정 vocabulary를 순회하며, 현재
  requirement가 선언한 capability에 대해서만:

```text
current_requirement[c].accepted  ∋  auditor_grant.enforcement[c]
```

  ranking 없음, "minimum level" 없음, `NOT_YET_AUDITED`의 암묵적 수용 없음. 현재 requirement가 아예
  없으면 §12.2/V10의 기존 "요구 없음 = 호환" 의미를 그대로 따른다.

  기존 `evaluateCapabilityRequirements(requested, runtimeManifest, requirements)`는 입력으로 Manifest
  body를 받으므로 **그대로는 쓰지 않는다** — 그 함수 호출을 위해 존재하지도 않는 historical Manifest를
  지어내는 것이 정확히 금지된 일이다. 대신 그 함수가 내부에서 이미 하는 마지막 단계
  (`requirement.accepted.includes(actual)`)를, 이미 동결된 `enforcement`를 `actual`로 삼아 수행하는 좁은
  pure projection을 쓴다. 이것은 두 번째 authority가 아니다: 판정 규칙도 vocabulary도 동일하고, 다른 것은
  `actual`을 지금 계산하지 않고 Grant에서 읽는다는 점뿐이다.

- **basis를 세우지 못하는 경우.** Grant 부재 / envelope hash 불일치 / `role != AUDITOR` /
  `source_runtime_manifest_hash` 불일치 / 손상은 **Backend가 변했다는 증거가 아니라 Attempt의 동결
  authorization basis 자체를 세우지 못한 것**이다. §18.1a의 load·re-hash 의미와 execution use-case들의
  기존 처리를 그대로 따른다 — 전이도 reason code도 없이 fail-closed로 중단하며(Runtime side effect 0),
  새 §24 code를 만들지 않는다. 이는 `HELD(DRIFT_CHECK_UNAVAILABLE)`과도 다르다: 후자는 *현재* 값을 읽지
  못한 경우이고, 이쪽은 *동결된* 자기 자신의 durable record가 정합하지 않는 경우다.

- **Backend 변경은 끝까지 §11 밖이다.** 현재 Backend assurance가 activation 시점보다 낮아졌더라도 위
  비교 결과는 바뀌지 않는다. §11이 답하는 질문은 오직 "**현재 policy requirement였다면 이미 동결된
  authorization 조건을 허용했겠는가**"이며, "Backend가 실제로 변했는가"는 §12.6 / §22.2 / RA-4와 그
  taxonomy(`CAPABILITY_BOUNDARY_CHANGED` / `CAPABILITY_BOUNDARY_UNAVAILABLE`)의 소유다.

```text
§11 Contract Drift          "정책 요구가 바뀌었는가?"
                            현재 policy requirement
                              vs  Attempt-frozen Auditor CapabilityGrant.enforcement
                            (basis provenance = grant.source_runtime_manifest_hash,
                             Manifest body는 필요하지 않다)

§12.6 / §22.2 / RA-4        "Backend 자체가 바뀌었는가?"
                            CAPABILITY_BOUNDARY_CHANGED / CAPABILITY_BOUNDARY_UNAVAILABLE
```

  fresh Backend manifest를 drift REEVALUATE 안에서 직접 관측하는 안(candidate B)은 채택하지 않는다 —
  그렇게 하면 "Backend가 바뀌었다"는 하나의 사실에 §11과 §22.2 두 authority가 생기고, 같은 downgrade가
  boundary마다 다른 reason code로 기록된다. 두 질문은 서로 다른 사실이고 서로 다른 owner를 갖는다.

- **현재 runtime_profile은 채택되지 않는다.** 현재 Project Profile이
  `roles[auditor_profile].runtime_profile`을 바꾸더라도 이 Attempt의 Auditor runtime profile은 M1-10이
  고정한 **Attempt-bound frozen Compiled Profile** 해소 결과 그대로다. 현재 Profile은 "남은 실행이 아직
  허용되는가"를 판단하는 데에만 쓰인다. 확대된 `runtime_profile` / `CapabilityGrant` / repository
  permission / accepted enforcement 중 어느 것도 Attempt에 주입되지 않는다.

**restart 재구성.** §11은 재시작 후에도 다음만으로 평가 가능해야 한다: Task Contract, Auditor
CapabilityGrant, Attempt-bound Compiled Profile, 현재 `ProfileSource`, 현재 `TaskSourceV1`,
`ContractSourceReader`, `RepositoryAdapter`. historical in-memory Manifest도, 이전 process 상태도,
Model 대화도, **historical surrogate로서의 현재 Backend Manifest도** 필요하지 않다.

**§11 vs §12.6/§22.2 경계.** `capability_requirements` drift는 **Execution Policy의 요구가 바뀐 것**이다.
Backend manifest/enforcement가 바뀐 것은 §12.6 receipt 대조와 §22.2 recovery가 소유하며
`CAPABILITY_BOUNDARY_CHANGED` / `CAPABILITY_BOUNDARY_UNAVAILABLE`로 처리된다. 같은 사실에 두 authority를
두지 않는다.

**lifecycle 적용 (기존 helper 그대로).**

```text
CONTINUE     → 전이 계속. drift 관측은 기록일 뿐 second source of truth가 아니다
HOLD         → Attempt는 전이 전 stage 유지 / 인과 fact = CONTRACT_DRIFT (transition)
               → CONTRACT_DECISION open → Task HELD(BLOCKED_BY_DECISION:<id>), Runtime side effect 0
INVALIDATE   → Attempt INVALIDATED (attempt reason = CONTRACT_DRIFT) + decision log (§19.2)
               → REATTEMPT_DECISION open → Task HELD(BLOCKED_BY_DECISION:<id>)
UNAVAILABLE  → Task HELD(DRIFT_CHECK_UNAVAILABLE), Attempt 유지, Runtime side effect 0
```

**인과(cause)와 차단(blocker)을 분리한다 (M1-12).** 둘은 서로 다른 질문이고 같은 column에 넣을 수 없다:

```text
왜 이 분기에 도달했는가   = 인과 transition/failure fact   → CONTRACT_DRIFT
왜 지금 Task가 막혀 있는가 = 현재 TaskState blocking reason → BLOCKED_BY_DECISION:<decision_id>
```

`subject.kind == TASK` 이고 `blocking_scope == TASK_ONLY`인 **모든** OPEN PendingDecision은 §17.2의
단일 규칙대로 `HELD(BLOCKED_BY_DECISION:<id>)`를 만든다 — `HUMAN_GATE_APPROVAL` / `MERGE_APPROVAL` /
`CONTRACT_DECISION` / `REATTEMPT_DECISION` 모두 동일하며, drift만 Task reason column에
`CONTRACT_DRIFT`를 남기기 위한 예외를 만들지 않는다. 인과 fact는 지워지지 않고 기존 durable 기록에
그대로 남는다: `state_transition`/`decision_log` 항목, `PendingHumanDecision.created_from`
(`drift:<attempt_key>:<target>`), `category`, 그리고 INVALIDATE의 경우 Attempt row의 reason. 새 durable
column(`cause_reason` 등)도 새 table도 만들지 않는다.

`UNAVAILABLE`은 여기서 예외가 아니라 **다른 경우**다: PendingDecision이 열리지 않으므로 현재 blocker가
없고, 따라서 `DRIFT_CHECK_UNAVAILABLE`이 그대로 Task reason으로 남는다.

PendingDecision은 §17의 기존 category로 충분히 표현된다 — INVALIDATE는 `REATTEMPT_DECISION`
(새 snapshot으로 재시도 / 포기), HOLD와 축소 REEVALUATE는 `CONTRACT_DECISION`이다. 새 category도,
새 durable table도 필요 없다: Task Contract + Compiled Profile + 현재 authoritative read +
decision/PendingDecision record로 충분하다.
- Platform Core는 project maturity를 이해하지 않는다 — 위 기본값도 Policy 문서의 값일 뿐 Core 상수가 아니다.

---

## 12. Capability Model TD (Q4 결정)

### 12.1 Vocabulary (v1, 고정)

```text
repository.read
repository.feature_write
repository.canonical_write        # grant는 항상 false 방향으로 쓰임 — "denial"의 enforcement가 관심사
repository.merge
repository.create_workspace
shell.execute
runtime.spawn_child
remote.feature_push
remote.canonical_push
remote.create_pr
destructive.git_clean
destructive.reset_hard
```

이 12개 이상으로 세분화하지 않는다. Backend 고유 능력은 Manifest 쪽에서 이 vocabulary로 사상해 선언한다.

**모델 분리 (v1 확정, M0-14/M0-15).** 두 개념을 섞지 않는다:

```text
Backend component capability/provenance   → Backend Capability Manifest set (§12.2a)
Role/session에 허용·금지할 Platform 권한  → CapabilityGrant (§12.5)
```

12개 `CapabilityName`은 **"Role/session에 대해 Runtime enforcement boundary가 그 허용 또는 거부 상태를
얼마나 강하게 집행할 수 있는가"** 를 표현하는 Core-fixed vocabulary다. RepositoryAdapter primitive
availability, Workflow feature availability, Verification feature availability와 **혼합하지 않는다** —
그런 backend 자체 기능은 각 component Manifest의 `features`에 기록하되 v1
`capability_requirements`의 enforcement 판단 source로 승격하지 않는다. **opaque feature 문자열이 policy
requirement를 만족시키는 경로는 존재하지 않는다**(fail-closed).

### 12.2 Enforcement assurance 계산

Backend Capability Manifest는 capability별로
`ENFORCED | AVAILABLE_WITH_REDUCED_ASSURANCE | UNENFORCEABLE_CAPABILITY_BOUNDARY | NOT_YET_AUDITED`를 선언한다.

**계산 규칙 (Decision):**

- 선형 서열을 두지 않는다. Execution Policy가 operation별 **accepted enforcement set**을 선언한다
  (§40 assurance level과 동형의 set 방식):
  ```yaml
  capability_requirements:
    automatic_merge:
      repository.canonical_write:   # Actor에 대한 denial
        accepted: [ENFORCED]
      repository.merge:
        accepted: [ENFORCED]        # "Gate 외 주체의 merge 불가"
    actor_execution:
      repository.feature_write:
        accepted: [ENFORCED, AVAILABLE_WITH_REDUCED_ASSURANCE]
      shell.execute:
        accepted: [ENFORCED, AVAILABLE_WITH_REDUCED_ASSURANCE, NOT_YET_AUDITED]
  ```
- `NOT_YET_AUDITED`는 어떤 요구도 자동 충족하지 않는다 — 명시적으로 accepted에 포함될 때만 통과.
- prompt-only 제한은 Manifest에 선언 자체가 금지된다 (ENFORCED로 위장 불가, Spec §26).
- 판정 (v1 확정, M0-16): Manifest는 capability별로 **directional entry**(§12.2a)를 선언하므로, 비교
  대상은 Role의 requested 방향에 해당하는 **단일 assurance**다.
  ```text
  actual_assurance = requested ? manifest.capability_enforcement[c].allow
                              : manifest.capability_enforcement[c].deny
  requirement PASS  ⟺  actual_assurance ∈ requirement.accepted
  operation compatible ⟺ 모든 requirement가 PASS
  ```
  선형 assurance ordering을 만들지 않는다(set membership만). 실패 → `POLICY_BACKEND_INCOMPATIBLE`
  (Decision Validator V10, session spawn 전 거부, §13 TD). `operation_id`는 §7.1b대로 non-empty opaque
  string이며 Core-fixed operation enum을 만들지 않는다 — Core가 이름으로 직접 참조하는 것은 §7.3 S9의
  `automatic_merge` 등 문서에 이미 등장한 operation뿐이다.

### 12.2a Backend Capability Manifest schema v1 (M0-14)

v1 backend selection은 정확히 **네 개의 component manifest**를 갖는다: `RUNTIME`, `WORKFLOW`,
`REPOSITORY`, `VERIFICATION`. 각각 독립 envelope과 hash를 가지며, 공통 envelope name은:

```text
schema = "platform/backend-capability-manifest",  schema_version = 1
```

**공통 body (전 component 필수, wrapper unknown field는 reject):**

```yaml
backend_kind:         RUNTIME | WORKFLOW | REPOSITORY | VERIFICATION
adapter_id:           <non-empty string>
adapter_version:      <non-empty string>
backend_instance_id:  <non-empty non-secret string/reference>     # I-TD7
features:             { ... }        # opaque constrained JSON (§6 model)
```

- `features`는 v1에서 **provenance/adapter fact 기록용**이며 그 값이 V10 requirement를 만족시키는 경로는
  없다. 향후 어떤 feature가 policy authority가 되려면 typed requirement로 승격되어야 한다.
- 별도 mutable `manifest_id`를 두지 않는다 — Manifest의 authoritative identity는 **`backend_kind` +
  envelope hash**로 충분하다.
- raw secret-bearing identifier 금지(I-TD7). `RuntimeSessionHandle`은 Manifest identity가 아니다.

**RUNTIME 전용 추가 필드 (required; 다른 backend_kind에는 허용하지 않는다):**

```yaml
receipt_supported: <boolean>
capability_enforcement:
  <CapabilityName>:                  # §12.1의 정확히 12종, 전부 명시
    allow: <EnforcementAssurance>    # §12.2의 정확히 4종
    deny:  <EnforcementAssurance>
```

Runtime Manifest는 **12개 CapabilityName을 전부 명시**한다 — omission 금지, unknown capability/assurance
금지, `allow`/`deny` 둘 다 required. 이로써 "capability omission semantics"라는 문제 자체가 사라진다.

**Directional enforcement (v1, capability별 polarity table 없음):**

```text
requested = true   → allow assurance   ("허용하면서 그 boundary를 적용할 수 있는 강도")
requested = false  → deny  assurance   ("금지를 적용할 수 있는 강도")
```

따라서 `repository.canonical_write` 같은 denial 관심사도 별도 capability(`canonical_write_denial`)를
만들지 않고 동일 vocabulary에서 결정적으로 표현된다. Spec §11의 conceptual example key
(`repository_read`, `canonical_write_denial`, `shell_restriction`, `PARTIAL`/`REDUCED`/`NOT_AUDITED` 등)는
설명용 예시이며 **TD v1 exact schema가 아니다.**

**WORKFLOW / REPOSITORY / VERIFICATION Manifest**는 v1에서 공통 5필드만 갖는다. `guarded_merge`,
`provenance_binding`, `persistent_workflow` 같은 항목은 `features`에 기록할 수 있으나 위 fail-closed
원칙에 따라 policy authority가 아니다.

**Manifest set invariant.** 한 backend selection에 각 kind가 **정확히 하나**씩 존재한다. 동일
`backend_kind`가 둘이면 `MANIFEST_SET_INVALID`(또는 동등한 deterministic validation failure)로 거부한다.
Core는 개념적으로 `BackendManifestSet { runtime, workflow, repository, verification }` 정도의 typed
aggregate input만 취하며, **이 set 자체를 별도 hash envelope로 만들지 않는다** — 각 component envelope
hash가 authority다(§10.1의 four-way hash 유지).

### 12.3 Backend v1 Manifest 초기값 (capability 문서 §5에서 전사 — 감사 전 보수적 값)

아래 값은 **generic contract의 example/initial data**이지 Core algorithm이 아니다. §12.2a의 directional
manifest에 맞추어 방향을 명시해 읽는다 — 반대 방향 assurance가 backend audit에서 확인되지 않은 항목은
추측하지 않고 `NOT_YET_AUDITED`로 둔다(현재 상태를 과장하지 않는 보수적 mapping이며 새 실측이 아니다).

```text
repository.feature_write   allow deny 중 allow = AVAILABLE_WITH_REDUCED_ASSURANCE / deny = NOT_YET_AUDITED
repository.canonical_write deny  = UNENFORCEABLE_CAPABILITY_BOUNDARY / allow = NOT_YET_AUDITED
repository.merge           deny  = UNENFORCEABLE_CAPABILITY_BOUNDARY / allow = NOT_YET_AUDITED
shell.execute              allow/deny 모두 NOT_YET_AUDITED
runtime.spawn_child        deny  = NOT_YET_AUDITED
remote.* / destructive.*   deny  = NOT_YET_AUDITED
```

표의 "workflow ownership / audit_decide 인가" 행은 12 CapabilityName이 아니라 **WORKFLOW Manifest의
`features` 기록 대상**이다(§12.2a — features는 policy authority가 아니다).

| capability | OpenClaw Backend v1 선언 |
|---|---|
| workflow ownership / audit_decide 인가 | ENFORCED (`resolveOwnerContext` fail-closed, live-verified) |
| repository.read | NOT_YET_AUDITED |
| repository.feature_write (worktree 내) | AVAILABLE_WITH_REDUCED_ASSURANCE |
| repository.canonical_write **denial** | UNENFORCEABLE_CAPABILITY_BOUNDARY |
| repository.merge (Gate 외 차단) | UNENFORCEABLE_CAPABILITY_BOUNDARY |
| shell.execute 제한 | NOT_YET_AUDITED |
| runtime.spawn_child 제한 | NOT_YET_AUDITED |
| remote.* / destructive.* 차단 | NOT_YET_AUDITED (사실상 UNENFORCEABLE without shell 제거) |

**직접 귀결:** Backend v1 단독으로는 `automatic_merge` capability_requirements를 충족할 수 없다.
MVP 2 활성화 경로는 §14.5. 이것은 TD의 결함이 아니라 Compatibility Gate가 설계대로 작동하는 사례다.

`ADR-CANDIDATE: capability enforcement assurance semantics (set-based, NOT_YET_AUDITED 불인정)`

### 12.4 Requested capability derivation — v1 normative baseline (M0-16)

아래는 예시가 아니라 **normative derivation rule**이다. requested map을 결정하는 authority input은
정확히 `CompiledProfile.effective.policy` + `CoreExecutionRole` 두 가지뿐이며, Project Profile의 role
config도 Supervisor/Model도 requested map을 입력하지 않는다 — "Model proposes capability" API는 존재하지
않는다. 산출물은 항상 **12개 key 전부를 담은 flat boolean map**이다.

| CapabilityName | SUPERVISOR | ACTOR | AUDITOR |
|---|---|---|---|
| repository.read | false | **true** | **true** |
| repository.feature_write | false | **true** | false |
| repository.canonical_write | false | false | false |
| repository.merge | false | false | false |
| repository.create_workspace | false | false | false |
| shell.execute | false | **true** | false |
| runtime.spawn_child | false | false | false |
| remote.feature_push | false | **policy 파생(아래)** | false |
| remote.canonical_push | false | false | false |
| remote.create_pr | false | false | false |
| destructive.git_clean | false | false | false |
| destructive.reset_hard | false | false | false |

- **SUPERVISOR는 12개 전부 false다.** Supervisor는 Proposal만 제출하며 canonical side-effect capability를
  직접 받지 않는다(Platform read model 경유는 capability가 아니다).
- **ACTOR `remote.feature_push`**는 유일한 policy 파생 항목이다:
  ```text
  effective.policy.repository_policy.remote_push == FEATURE_BRANCH_ONLY  → true
  DENY | PLATFORM_MANAGED_ONLY                                            → false
  ```
  `PLATFORM_MANAGED_ONLY`는 Actor의 push 권한이 아니다.
- **`remote.create_pr`은 false**다 — v1 Execution Policy에 이를 enable하는 authority field가 없으므로
  true로 추측하지 않는다. policy field가 명시적으로 추가되기 전까지 유지한다.
- **AUDITOR는 `repository.read`만 true**다. Auditor의 결과 제출은 RuntimeResultChannel 경유이므로
  repository write나 shell capability를 요구하지 않는다(I-TD6).
- Spec §24의 중첩 예시(`shell: { read_only_or_sandboxed: true }`, `remote: { push: FEATURE_BRANCH_ONLY }`)는
  conceptual presentation이다. `read_only_or_sandboxed`는 schema value가 아니라 설명이며, v1에서 Auditor의
  shell 미허용은 `"shell.execute": false`로 표현한다.

**Role profile authority boundary.** `roles.<role_profile_id>.runtime_profile`/`config`는 Runtime
선택·설정 preference일 뿐 **Grant를 확대하는 authority가 아니다.** runtime profile/config가 실제 도구를
Grant보다 더 좁히는 것은 가능하지만, Grant가 false인 capability를 true로 넓히는 경로는 없다. 실제 적용
상태는 Receipt가 보고한다(§12.6).

### 12.5 CapabilityGrant schema v1 (M0-15)

Broker 산출물은 **Platform-owned authorization contract**이며 backend 적용 수단을 담지 않는다.

Envelope: `schema = "platform/capability-grant"`, `schema_version = 1`.

```yaml
body:
  grant_id:                     <ulid>
  role:                         <CoreExecutionRole>
  source_runtime_manifest_hash: sha256:...      # §12.2a RUNTIME Manifest envelope hash
  requested:                    { <CapabilityName>: <boolean> }              # 정확히 12 key 전부
  enforcement:                  { <CapabilityName>: <EnforcementAssurance> } # 정확히 12 key 전부
```

- **`grant_hash`는 이 envelope의 hash이며 body에 넣지 않는다** (§7.7의 self-reference 금지 원칙과 동일).
  외부 projection이나 Store row가 `grant_id` + `grant_hash`를 함께 보관하는 것은 무방하다.
- `requested`/`enforcement` 모두 **12개 key 전부 required** — sparse map 금지, unknown key 금지.
- `enforcement[c]`는 §12.2a directional rule로 선택된 Runtime Manifest assurance의 **그대로의 값**이다.
  별도의 transformation·minimum·ranking·downgrade 계산을 하지 않는다:
  ```text
  requested[c] + runtime_manifest.capability_enforcement[c] → enforcement[c]  (scalar)
  ```
  Policy의 accepted set은 compatibility 여부만 판정하며 grant assurance 값을 바꾸지 않는다.
- **source manifest는 Runtime Manifest 하나뿐이다.** Broker의 12-capability 계산이 Runtime Manifest의
  directional map만 사용하기 때문이며, Grant가 Workflow/Repository/Verification hash를 중복 저장하지
  않는다 — 네 component hash 전체는 final Task Contract의 `backend_requirements`가 bind한다(§10.1).
- **`backend_application`은 v1 Grant에서 제거한다** (M0-18). Grant는 Platform-owned authorization
  contract이고 구체 적용 수단은 RuntimeAdapter implementation fact이므로 두 authority를 같은 immutable
  hash body에 두지 않는다. Core는 `permissionMode`/`tool_allowlist_removal`/`workspace_confinement` 같은
  값을 생성하지 않는다. 실제 적용 수단의 유일한 보고 위치는 §12.6 `applied_means`다.

**CoreExecutionRole (v1 Core-fixed, 고정):**

```text
SUPERVISOR | ACTOR | AUDITOR
```

세 층을 같은 namespace로 합치지 않는다:

```text
CoreExecutionRole   → Platform authorization role (grant.role, spawn_session의 role)
role_profile_id     → Project Profile이 정의한 role preference/profile (§7.1a roles.<id>)
runtime_profile     → RuntimeAdapter가 해석하는 backend runtime profile
```

Supervisor Proposal의 `actor_profile`은 **`role_profile_id`**이고, CapabilityGrant의 `role`은
**`CoreExecutionRole`**이다.

Policy 요구보다 enforcement가 약하면 **session을 spawn하지 않고** V10에서 거부된다(§12.2).
spawn 이후 발견되는 약화는 §52 circuit breaker `capability boundary violation`으로 처리한다.

### 12.6 CapabilityEnforcementReceipt (v1.1 신설)

**Grant requested ≠ Grant actually enforced**를 durable하게 추적한다. RuntimeAdapter는
`spawn_session` 성공 시 실제 적용한 enforcement의 영수증을 반환하고, Coordinator는 이를 spawn과
동일 트랜잭션 흐름에서 저장한다.

**Delivery contract (M0-7 결정).** 영수증은 별도 조회 경로가 아니라 **spawn 결과 자체**로 전달된다:

```text
spawn_session(...) -> RuntimeSpawnResult { session_handle, enforcement_receipt? }
```

- 영수증을 얻기 위한 별도 query method를 두지 않는다. spawn outcome을 담는 새 result framework도
  만들지 않는다 — receipt가 그 spawn에 원자적으로 귀속되어 session↔receipt 바인딩이 구조적으로 성립한다.
- **presence는 Backend Capability Manifest의 `receipt_supported`가 유일한 authority다** (이중 source of
  truth를 만들지 않는다). 따라서 결과 타입에 `UNSUPPORTED` value/enum/variant를 두지 않는다.
  - `receipt_supported: true` — 성공한 spawn result에는 `enforcement_receipt`가 **반드시 존재**하며
    `result.session_handle == receipt.session_handle`이어야 한다. 누락 또는 mismatch는
    **fail-closed**로, 아래 검증 규칙과 동일하게 `CAPABILITY_BOUNDARY_CHANGED` → `HELD`로 처리하고
    **`send_turn`을 호출하지 않는다** (새 failure taxonomy를 만들지 않는다, §24).
  - `receipt_supported: false` — 성공한 spawn result에 `enforcement_receipt`가 **존재하지 않아야 한다.**
    receipt 없는 성공 spawn은 정상 contract-conforming 결과이며, 반대로 receipt가 존재하면 contract
    violation으로 pure validation FAIL이다. `receipt_supported: false`라는 사실 자체는 V10
    incompatibility를 만들지 않는다 (M0-19, 아래).

```yaml
capability_enforcement_receipt:
  receipt_id: ulid
  grant_hash: sha256:...
  backend_manifest_hash: sha256:...
  session_handle: <opaque>
  applied:            # 12 CapabilityName 전체를 담는 complete map (§12.2 vocabulary)
    repository.feature_write: AVAILABLE_WITH_REDUCED_ASSURANCE
    repository.canonical_write: UNENFORCEABLE_CAPABILITY_BOUNDARY
    shell.execute: NOT_YET_AUDITED
    ...
  applied_means: [ tool_allowlist_removal, permission_mode, workspace_confinement, ... ]
  issued_at: ...
```

- 검증: Coordinator는 receipt의 `applied`가 grant 산출 시 계산된 `enforcement`(§12.5) 및 Policy의
  accepted set과 모순되지 않는지 대조한다. receipt가 grant보다 약하면 해당 turn을 시작하지 않고
  `CAPABILITY_BOUNDARY_CHANGED` → `HELD` (silent downgrade 금지).
- **필드 의미 확정 (M0-18).**
  - `receipt_supported`는 **RUNTIME Manifest 전용 required boolean**이며 위치는
    `runtime_manifest.body.receipt_supported`, 따라서 Manifest envelope hash에 포함된다(§12.2a).
    presence authority가 이 field 하나뿐이라는 규칙은 그대로다.
  - `backend_manifest_hash`는 **spawn에 사용된 RUNTIME Manifest envelope hash**를 뜻한다(필드명은 B3
    public contract 유지를 위해 rename하지 않는다).
  - `applied`는 **12 CapabilityName 전체를 담는 complete map**이다. Grant 자체가 full 12 map이고 false
    capability의 denial enforcement도 trust boundary의 일부이므로, missing key나 unknown key는 invalid
    receipt다.
  - `applied_means`는 **adapter/runtime 소유의 실제 적용 수단 증거**이며 Core가 생성하지 않는다.

- **Pure validation rules (v1, M0-18).** 아래는 순수 함수로 판정 가능한 항목이다:
  ```text
  1 receipt presence  == runtime_manifest.receipt_supported
  2 spawn_result.session_handle == receipt.session_handle
  3 receipt.grant_hash          == capability_grant envelope hash
  4 receipt.backend_manifest_hash == grant.source_runtime_manifest_hash
                                  == task.backend_requirements.runtime_manifest_hash
  5 receipt.applied의 key/값이 §12.1/§12.2 vocabulary에 유효
  6 receipt.applied가 12 capability 전체를 포함 (complete map)
  7 receipt.applied[c] == grant.enforcement[c]        # v1은 exact equality
  8 operation requirement가 있으면 receipt.applied[c] ∈ requirement.accepted
  ```
  assurance는 **partial order가 아니라 set semantics**이므로 "더 강하다/약하다" ranking을 v1에서 만들지
  않는다. 그래서 7은 exact equality다. 불일치는 `CAPABILITY_BOUNDARY_CHANGED` 판정 대상이다.
- **Orchestration 경계.** 위 판정은 pure validation result까지다. `HELD` transition, `send_turn` 억제,
  durable receipt write, restart loop, Coordinator action은 State Machine/Coordinator Batch의 책임이며
  판정 결과가 fail-closed로 처리된다는 기존 semantics는 유지한다.

- **receipt requirement의 표현 가능성 (M0-19, v1 확정).** MVP 0 v1 `ExecutionPolicyV1`에는 **독립적인
  receipt-required field가 없다**(`receipt_required` / `require_receipt` / `attestation_required` 등 부재).
  따라서 `receipt_supported`는 **Runtime이 spawn-specific actual-application receipt를 제공하는지**라는
  attestation availability만 뜻하며, **V10 capability compatibility와는 별개의 축**이다.
  - `receipt_supported: false`라는 사실만으로 operation을 incompatible로 만들지 않는다 — V10은 §12.2의
    directional accepted-set membership만 평가한다(§9.2).
  - `accepted: [ENFORCED]` 같은 policy에서 "그러므로 receipt required"를 **암묵 추론하지 않는다.**
    v1에 그런 규칙은 존재하지 않는다.
  - `receipt_supported: false`인 backend에서 **receipt 없는 successful spawn은 정상 contract-conforming
    결과**다. 반대로 receipt가 존재하면 contract violation이며 pure validation FAIL이다.
  - 이 값은 Runtime Manifest에 선언된 directional assurance를 무효화하지 않는다 — pre-spawn
    compatibility authority는 여전히 `capability_enforcement`다(§12.2a).
  - 향후 어떤 operation이 **receipt attestation 자체를 요구**해야 한다면, 그 요구는 Execution Policy
    schema의 **명시적 typed authority field**(또는 동등한 TD/schema revision)로만 추가한다.
    `capability_requirements.accepted`에서 도출하지 않는다.
  - OpenClaw Backend v1의 receipt 산출 가능 범위는 RA-1과 함께 실측 확정한다(§30).
- restart 시 재검증은 §22.2.

---

### 12.7 Broker input과 Task Contract finalization order (M0-17)

Spec §25의 Broker input "Task Contract"를 **final hashed Task Contract Snapshot**으로 읽으면
`Task Contract → Broker → Grant → Task Contract` 순환이 생긴다. v1은 이를 다음으로 구체화한다.

Broker가 보는 것은 final snapshot hash 이전에 이미 결정된 **capability-relevant view**다:

```text
TaskContractCapabilityView { repository_scope }      # §10.1의 allowed_paths / forbidden_paths 그대로
```

Broker는 scope **id를 해석하지 않는다** — resolve는 step 3에서 이미 끝나고 Broker가 보는 것은 resolved
`repository_scope`뿐이다.

step 0이 **가장 앞**인 것이 계약이다 — grant나 contract artifact를 먼저 만든 뒤 staleness를 발견하는
경로는 금지된다(M1-7). 그래야 stale activation이 immutable artifact를 하나도 남기지 않는다.

**Builder authority boundary (M1-6).** Task Contract builder가 `repository_scope` 값을 파라미터로 받는
형태 자체는 무방하지만, **production SELECTED→ACTIVE 경로는 그 값을 반드시 위 resolution으로 만든다** —
`task.repository_scope_id` + batch-bound Compiled Profile Snapshot이 유일한 production source다. 아래는
금지된다:

```text
activateTask({ repository_scope: <caller가 정한 임의 값> })      # authority 없음
TaskDefinition / RepositoryAdapter / TaskSource config에서 추론
current registry의 최신 Profile 사용                            # batch에 bind된 것이어야 한다
```

builder가 두 입력에서 직접 resolve하든 Coordinator가 resolve해 넘기든 repo convention에 맞는 최소 구현을
고르면 된다. 격리된 fixture로 pure builder를 단위 테스트하는 것은 authority 주장이 아니므로 무방하다. 이 view는 **durable artifact도, envelope도, hash 대상도, 새 lifecycle state도
아니다** — final Task
Contract를 만들기 위한 builder input projection일 뿐이다. 별도 `TaskContractDraft` durable schema를
만들지 않는다. v1에서 requested boolean derivation은 §12.4대로 policy+role만으로 결정되므로 Broker는
이 view에 대해 **TD에 없는 path→capability inference를 하지 않는다**(예: "allowed_paths가 비어서
feature_write=false" 같은 규칙을 발명하지 않는다). view는 향후 task-specific capability restriction을
받을 seam을 보존하는 입력이다.

**Finalization order (확정):**

```text
0  durable SelectionBinding 로드 → fresh TaskDefinition + fresh canonical 읽기 →
   §19.3a exact equality 3건 (M1-7)
   불일치 → HELD(SELECTION_STALE) 후 STOP — 아래 어느 단계도 실행하지 않는다
1  Compiled Profile 확정
2  TaskDefinition / repository facts / validated selection(pipeline·profile·repository_scope_id 포함) 등
   final Task Contract의 pre-hash input 확정
3  `repository_scope_id`를 그 batch의 immutable Compiled Profile에서 resolve하여
   TaskContractCapabilityView { repository_scope } 구성 (M1-6)
4  RUNTIME/WORKFLOW/REPOSITORY/VERIFICATION Manifest 확정 + 각 envelope hash 계산
5  CoreExecutionRole별 requested capability 계산 (§12.4)
6  Runtime Manifest directional enforcement 계산 (§12.2a)
7  policy capability_requirements compatibility 검증 (§12.2 / V10)
8  CapabilityGrant(actor/auditor) 생성 + grant_hash 계산 (§12.5)
9  final Task Contract body에 backend_requirements 4-hash와 actor/auditor grant_id+grant_hash 삽입
10 Task Contract envelope hash 계산
11 immutable snapshot 저장
```

의존 방향은 `Task Contract inputs → Grant → final Task Contract Snapshot`이며 순환이 없다.

**Batch 경계.** 이 순서에 따라 기존 ordering이 유지된다 — Batch 5는 `TaskContractCapabilityView`
type/interface와 Broker·compatibility·receipt validation까지 구현하고, **Task Contract builder는 Batch 6**가
이 view를 구성해 Broker를 호출하고 grant hash를 final snapshot에 넣는다.

---

## 13. RuntimeAdapter TD — OpenClawRuntimeAdapter mapping

[계약] 이 절의 backend 주장은 §1.1 증거 등급 규칙의 적용 대상이다: §13.1의 각 mapping 행은
MEASURED/INFERRED/CANDIDATE 등급을 명시해야 하며(기존 "실측"/"정정" 표기는 MEASURED로, "우선 검토"/
"후보"는 CANDIDATE로 소급 해석), 등급 없는 행을 근거로 어떤 RA도 CLOSED될 수 없다.

Core interface는 Spec §27 그대로 — method identity와 spawn semantics는 유지한다. Spec §27은
**최소 interface**이므로 TD는 그 위에 concrete result contract를 얹는다 (M0-7):

```text
spawn_session(role, runtime_profile, cwd, bootstrap_context, capability_grant)
    -> RuntimeSpawnResult { session_handle: RuntimeSessionHandle,
                            enforcement_receipt?: CapabilityEnforcementReceipt }   # §12.6
```

`session_handle`은 Spec §27이 규정한 반환 그대로이고, `enforcement_receipt`의 존재 조건은 §12.6의
`receipt_supported` contract를 따른다. 나머지 method(§27 5종 + §13.3
`acquire_workflow_controller`)의 시그니처는 변경하지 않는다.

**`RuntimeOperationContextV1` (M1-8).** external Runtime operation은 §21의 write-ahead INTENT 대상이므로
Platform의 idempotency identity가 adapter까지 도달해야 한다. Spec §27의 **operation 종류는 그대로 두고**
TD concrete input만 정밀화한다:

```text
RuntimeOperationContextV1 { op_key }        # exact 1 field

spawn_session(operation_context, role, runtime_profile, cwd, bootstrap_context, capability_grant)
    -> RuntimeSpawnResult
send_turn(operation_context, session_handle, instruction)
    -> RuntimeTurnHandle
```

`op_key`의 목적은 **idempotency/recovery correlation 하나**다 — Model input도, repository/Task Contract
semantic authority도, hash artifact도 아니다. `AdapterContext<any>` / `metadata: {}` / headers / trace
context 같은 generic bag을 만들지 않는다; 다른 adapter가 실제로 필요해지면 그때 typed revision한다.

**spawn same-op semantics (M1-8).** 동일 `op_key` + 동일 material input(role / runtime_profile / cwd /
bootstrap context identity / capability grant)이면 **동일 logical RuntimeSession**과 동일 Platform-safe
`RuntimeSessionHandle`을 돌려주어야 하며 두 번째 session을 만들지 않는다. 동일 `op_key`에 material
input이 다르면 adapter-local deterministic conflict로 fail-closed한다(새 global Task reason을 만들지
않는다). OpenClaw mapping은 기존 `ensureSession` 재획득 primitive를 사용하며, raw `sessionKey`는 여전히
Platform durable state에 저장하지 않는다(I-TD5/I-TD7, §13.1).

**turn mapping과 그 한계 (M1-8).**

```text
RuntimeOperationContextV1.op_key  →  AcpRuntimeTurnInput.requestId  →  AcpRuntimeTurn.requestId
```

instruction body에 `op_key`를 삽입하지 않으며 Model이 request identity를 고르지 않는다(I-TD3). 다만
**현재 backend에서 `requestId`는 correlation identity일 뿐이다** — 2026-08 read-only source audit 결과:

```text
correlation                      = supported   (startTurn이 requestId를 echo, runId로 관측 기록에 사용)
same-requestId duplicate dedup   = NOT available
durable requestId → turn 재획득  = NOT available
```

acpx `startTurn`은 delegate로 pass-through하며 어떤 store도 조회하지 않고, control-plane은 `requestId`를
background task record의 `runId`와 signal log에만 쓴다(생성 전 존재 확인 없음). `activeTurnBySession`은
process-local `Map`이고 세션 meta에 turn identity가 persist되지 않는다. 따라서 **stable `op_key`가 있다는
이유로 backend dedup을 가정하지 않는다** — §21의 fail-closed 규칙이 그 자리를 대신한다.

Core API에 OpenClaw 타입을 노출하지 않으며 아래는 mapping 전용 절이다.

### 13.1 Mapping

| Generic | OpenClaw Backend v1 | 상태 |
|---|---|---|
| `RuntimeSessionHandle` | **adapter-derived opaque pair `(agentId, entry.sessionId)`** — 기존 persisted session entry의 non-secret 값만 사용 | **RA-1a CLOSED (adapter-only, OpenClaw patch 불필요).** OpenClaw 내부 식별자는 raw `sessionKey`(`agent:<agentId>:<rest>`)이고 그것은 `OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY`로 주입되는 trusted credential이라 Platform DB에 저장할 수 없다. 그러나 Core-facing handle은 OpenClaw 타입일 필요가 없다 — adapter가 `entry.sessionId`(`randomUUID()`, `src/gateway/sessions-patch.ts`)를 owner-partitioned store의 `agentId`로 scope해 opaque하게 들고, 필요할 때 기존 resolver로 sessionKey를 복원한다. raw credential은 adapter 프로세스 메모리에만 존재한다 |
| `spawn_session(...) -> RuntimeSpawnResult` (§12.6) | **OpenClaw ACP runtime managed-session path** — `AcpRuntime.ensureSession({ sessionKey, agent, mode, cwd, … })` (`extensions/acpx/src/runtime.ts`), 획득 경로는 `src/acp/control-plane/manager.runtime-handle-ensure.ts` | `[P]` — **IMPLEMENTATION GAP RA-1a**: 이 primitive는 실재하나 후속 연산의 식별자가 raw `sessionKey`이며 Platform-safe opaque handle 매핑이 미확정. **정정(2026-08 read-only 실측):** 종전에 근거로 적었던 `spawn_agent` + subagent registry는 성립하지 않는다 — `spawn_agent`는 `src/agents/harness/native-hook-relay-codec.ts`의 **Codex provider tool-name alias**(`agent → spawn_agent`)이고, subagent registry는 `state-migrations.subagent-registry*`가 스스로 밝히듯 **retired legacy store**다. **worktree 생성은 이 primitive의 일부가 아니다** — RepositoryAdapter 책임(§14.3) |
| `send_turn` | **`AcpRuntime.startTurn(input) -> AcpRuntimeTurn`** (`packages/acp-core/src/runtime/types.ts`, acpx 구현 `extensions/acpx/src/runtime.ts`) | **RA-1b CLOSED.** 계약이 "Preferred turn API — live events를 terminal result와 분리"라고 명시한다. input은 `{handle, text, attachments?, mode, requestId, signal?}`로 **handle을 그대로** 받고, 반환 `AcpRuntimeTurn = {requestId, events, result: Promise<AcpRuntimeTurnResult>, cancel, closeStream}`가 곧 `RuntimeTurnHandle`이다(`requestId`는 caller 공급이라 Platform의 `op:<attempt>:actor-turn:<n>`을 그대로 쓸 수 있다 — I-TD3 안전). **turn 완료 관측·structured result 수집은 RA-2**이며 여기서 닫지 않는다 |
| `get_turn_result` | §13.2 envelope 수집 | RA-2에 종속 |
| `get_session_status` | `acp_sessions` store + active-turns | 조회 가능, 안정 API로 노출 필요 (문서 §3 "expose as stable API") |
| `cancel_session` | acpx kill-tree | 프로세스 수준 존재, API 노출 필요 |
| `close_session` | session lifecycle | 동상 |
| `WorkflowControllerHandle` (§13.3) | **Managed Platform-Controller Session** (adapter가 관리, host가 identity 발급) | **IMPLEMENTATION GAP RA-3** — handle↔host-managed trusted controller identity 매핑의 실측 확정 필요 |
| `RuntimeResultChannel` (§13.2) | runtime-owned scratch 후보: session artifact 영역 / adapter 관리 temp dir (repository 밖) | RA-2에 종속 — 구체 위치/수집 방식은 실측 확정 |

**행별 증거 등급 소급 명시 ([계약], v1.3 — #6 checklist 종결):**

```text
RuntimeSessionHandle        MEASURED (sessions-patch.ts randomUUID entry.sessionId; RA-1a CLOSED 근거)
spawn_session               MEASURED (runtime.ts ensureSession / manager.runtime-handle-ensure.ts)
                            + 정정 원장: 구 spawn_agent/subagent registry 근거는 폐기(실측 반증)
send_turn                   MEASURED (acp-core runtime/types.ts startTurn 계약; RA-1b CLOSED 근거)
get_turn_result             CANDIDATE (RA-2 종속 — envelope 수집 경로 미실측)
get_session_status          INFERRED (store 존재는 확인, 안정 API 노출은 미실측)
cancel_session              INFERRED (kill-tree 존재, API 노출 미실측)
close_session               INFERRED (동상)
WorkflowControllerHandle    CANDIDATE (RA-3 — 매핑 자체가 조사 대상)
RuntimeResultChannel        CANDIDATE (RA-2 종속)
```

**Grant 적용 수단 (adapter-owned, M0-18).** Grant는 authorization contract만 담고 적용 수단을 담지
않으므로(§12.5), 아래는 **OpenClawRuntimeAdapter가 선택할 수 있는 backend 구현 수단의 예**이지 Core가
생성하는 값이 아니다: **(a)** Actor/Auditor session의 tool allowlist에서 write/shell 도구 제거(Auditor),
**(b)** 비-`approve-all` permissionMode, **(c)** worktree 경로만 cwd로 제공, **(d)** canonical checkout
경로를 Actor session 환경에 노출하지 않음. spawn 성공 시 adapter는 **실제 적용 내역을
`CapabilityEnforcementReceipt.applied_means`(§12.6)로 보고한다** — 이것이 유일한 보고 위치다.
이 수단들은 capability 문서 §5 판정대로 bypass 저항이 감사되지 않았으므로 Runtime Manifest의 해당
directional entry에 REDUCED/NOT_YET_AUDITED로 정직하게 선언된다. **prompt 지시만으로 적용했다고 주장하는
capability는 `ENFORCED`가 될 수 없다**(Spec §26) — 구체적으로 어떤 assurance가 되는지는 Manifest
producer/audit의 책임이며 Core Broker가 backend-specific 값을 추측하지 않는다.

### 13.2 RuntimeTurnResult contract (Q3 결정)

**Decision.** 공통 envelope (schema `platform/runtime-turn-result` v1):

```yaml
runtime_turn_result:
  session_handle: ...
  turn_handle: ...
  backend_status: COMPLETED | CANCELLED | TIMEOUT | RUNTIME_ERROR | SESSION_LOST
  termination_reason: string            # backend 서술, opaque
  started_at / completed_at: timestamp
  provenance:
    runtime_backend: openclaw-v1
    identity_authority: BACKEND         # BACKEND | UNKNOWN — Model 자기주장 불가
    result_channel: RUNTIME_RESULT_CHANNEL | STRUCTURED_PROTOCOL | TURN_TEXT
  structured_output:                    # optional
    protocol: platform-actor-result-v1 | agy-json | ...
    body: { ... }
  model_declared_outcome:               # optional, 항상 non-authoritative
    declared_status: DONE | BLOCKED | NEEDS_INPUT | FAILED
    summary: string
    refs: [ ... ]
  backend_native_refs: { ... }          # adapter_metadata로만 저장
```

- **`RuntimeResultChannel` (Decision, v1.1 수정):** Actor/Auditor의 structured 결과
  (`platform-actor-result-v1`, `platform-auditor-verdict-v1`)는 **repository 밖의, RuntimeAdapter가
  소유·제공하는 result channel**에 기록되고, adapter가 turn 종료 후 이를 수집해 `structured_output`으로
  반환한다 (`result_channel: RUNTIME_RESULT_CHANNEL`).
  - Core는 channel의 구현 세부(runtime-owned temp directory, session artifact 영역, structured protocol,
    adapter 관리 파일 등)를 알지 않는다 — session bootstrap 시 adapter가 기록 위치/방법을 role 지침에
    주입하고, 수집도 adapter가 수행한다.
  - **I-TD6 강제:** result artifact는 repository candidate artifact와 분리된다. 따라서
    **Auditor는 `repository.feature_write=false`인 채로 verdict를 제출할 수 있고**, Actor의
    "repository 변경 생산"과 "Platform에의 structured 결과 전달"이 서로 다른 경로가 된다.
    repository_scope/tracked-clean 검사에 result artifact가 섞이지 않는 부수 효과도 얻는다.
  - Rationale: (a) capability contract와의 모순 제거(read-only Auditor 성립), (b) RA-2(turn-text 파싱)
    미정 상태에서 backend-중립적으로 구현 가능, (c) 향후 다른 Runtime에도 동일 abstraction 적용 가능.
  - 결과 부재/파싱 실패 → `structured_output` 없음 + `result_channel: TURN_TEXT` + declared만 기록.
    Coordinator는 이를 실패로 처리하지 않고 **Verification이 candidate를 직접 판정**한다(§15).
    단 Auditor verdict는 structured 결과가 필수이므로 부재 시 §16.2의 `AUDIT_UNUSABLE` 경로.

**I-TD12 적용 ([계약], v1.3).** turn/session teardown 및 RuntimeResultChannel 정리 전, 해당
attempt의 authoritative record(envelope, audit verdict, evidence run ref)가 참조하는 아티팩트가
그 표면에만 존재하면 durable 캡처(content-addressed blob) 또는 명시적 손실 레코드가 선행되어야
한다. Auditor verdict envelope는 structured 필수이므로 손실 기록으로 대체 불가 — `AUDIT_UNUSABLE`
경로를 탄다.

### 13.2a Runtime execution observation (v1.5, prospective measurement source)

[계약, PROSPECTIVE_REQUIREMENT] sealed `platform/runtime-turn-result` v1은 변경하지 않는다. production
measurement를 지원하는 RuntimeAdapter는 schema_version `2`를 반환하며, v2는 v1 body에 다음 required
`execution_observation` 하나를 추가한다. 값이 없다는 이유로 field를 생략하지 않고 availability를
`UNKNOWN`으로 기록한다.

```text
RuntimeExecutionObservationV1 {
  op_key
  subject: { run_id } | { attempt_key }
  role: SUPERVISOR | ACTOR | AUDITOR
  role_profile_id
  runtime_profile
  requested_binding_ref?          # non-secret, adapter-resolved ref가 있을 때만
  actual:
    provider: { availability: REPORTED | UNKNOWN, value? }
    model:    { availability: REPORTED | UNKNOWN, value? }
    binding_ref: { availability: REPORTED | UNKNOWN, value? } # non-secret stable fingerprint/ref
  timing: { started_at, completed_at }
  usage:
    { kind: REPORTED, quantities: { <provider_metric>: { value, unit } }, source_ref? }
    | { kind: UNKNOWN }
  cost:
    { kind: REPORTED, value, currency, source_ref? }
    | { kind: ESTIMATED, value, currency, estimator_version, price_source_ref, calculated_at }
    | { kind: UNKNOWN }
  failure_attribution: FailureAttributionV1 | null
}
```

- `role_profile_id`/`runtime_profile`은 §13.5의 frozen authority chain에서 Core가 공급한다. Adapter가
  자연어 output이나 provider response에서 role/profile을 추론하지 않는다. provider/model/usage/cost는
  Backend가 실제 operation에 대해 보고한 값만 `REPORTED`다. model alias를 실제 underlying model로
  추측하거나 elapsed time에서 token/cost를 역산하지 않는다.
- `provider_metric`은 provider-owned 이름을 opaque하게 보존하되 numeric value와 unit을 함께 둔다.
  서로 다른 unit을 Core가 합산하지 않는다. raw provider response, prompt, secret-bearing id는 저장하지
  않는다(I-TD7).
- `started_at/completed_at`은 Runtime backend의 operation fact이며 `completed_at >= started_at`을
  validation한다. Platform stage duration은 이 값으로 덮지 않고 Store transition timestamps에서 별도로
  derive한다(§5.12).
- `failure_attribution`은 operation이 실패했을 때도 가능한 범위에서 반환한다. attribution을 세울 수
  없으면 `domain=UNKNOWN`; opaque `termination_reason` 문자열을 Core가 분류기로 파싱하지 않는다.
- completed turn의 redacted v2 envelope는 §5.12/§21대로 해당 op의
  `idempotency.DONE.result_json`에 보존한다. 이것은 measurement/evidence source이지 Task 성공,
  Verification PASS, retry, state transition authority가 아니다.

### 13.3 WorkflowControllerHandle (v1.1 신설)

Backend가 trusted context를 요구하는 workflow-control 호출(`workflow.start`/`audit_decide`)을 위해
Core가 소유하는 것은 **opaque `WorkflowControllerHandle`뿐이다** (I-TD5).

```text
acquire_workflow_controller() -> WorkflowControllerHandle     # RuntimeAdapter 제공
```

**WorkflowHandle ↔ controller association (M0-8).** `start(controller_handle, workflow_spec)` 성공 시
WorkflowAdapter는 반환한 `WorkflowHandle`을 그 start에 사용된 controller authority와 **associate한다.**
association 자체는 **Adapter/Runtime 소유 state**이며 Core에는 존재하지 않는다.

- Platform이 보관하는 `WorkflowHandle`은 **non-secret opaque handle일 뿐**이다 — raw session identity,
  token, Authorization header, secret credential, secret-bearing backend identifier를 **일절 포함하지
  않는다** (I-TD7). `WorkflowHandle → backend owner/controller identity` 해석은 adapter가 수행한다.
- Core는 어떤 계층에서도 raw identity를 제공하거나 복구하지 않는다 (I-TD5).
- 이 association은 §14.1의 `status`/`resume`/`cancel`/`recover`가 controller 인자 없이도 backend
  ownership context를 얻는 근거다.

- OpenClaw Backend v1 우선 검토안: adapter가 **전용 Managed Platform-Controller Session**을
  기동·유지하고 handle을 그 session에 매핑한다. identity(agentId/sessionKey)는 host가 발급·관리하며
  Core와 Platform DB에는 handle + redacted fingerprint만 존재한다(I-TD7). durable-jobs ownership
  gate(ENFORCED, live-verified)는 이 controller identity를 owner로 인식한다.
- 대안(durable-jobs가 명시적 service identity API를 제공하는 방식)은 **현재 Backend 문서에 근거가
  없으므로 채택하지 않는다** — 추측으로 채우지 않고 RA-3의 조사 항목으로만 남긴다.
- handle 유효성/수명은 RuntimeAdapter 소유 fact다: controller session 소실 시 Core는 재-acquire를
  요청할 뿐 identity를 복원하지 않는다. 재-acquire 후 기존 workflow ownership과의 정합은
  **IMPLEMENTATION GAP RA-3**의 일부다 (owner 고정 vs controller 교체 시 접근성 — 실측 확정, §30).
- **Invariant 재확인:** `RuntimeTurnResult ≠ semantic success`. `declared_status: DONE`은 어떤 transition의
  precondition에도 단독 사용되지 않는다. IMPLEMENTING→VERIFYING의 trigger는 "turn 종료 + candidate commit
  존재(RepositoryAdapter 확인)"이지 declared가 아니다.
- Alternatives rejected: turn-text 파싱(취약·RA-2 미정), MCP tool로 Actor가 Platform에 직접 보고
  (Actor에 Platform API 노출 = capability 확대, 거부).
- Failure behavior: SESSION_LOST/RUNTIME_ERROR → §22 recovery의 R-1 경로.
- MVP impact: MVP 1 Actor/Auditor 지침에 result 파일 규약 포함. RA-2가 향후 formalize되면
  `STRUCTURED_PROTOCOL` 채널로 이행하되 envelope는 불변.

`BACKEND CAVEAT:` AGY-only model runner(문서 §2)는 Platform에 영향 없음 — Actor는 Runtime session으로
실행되고 검증은 Platform-owned이므로 durable-jobs model runner를 요구하지 않는다.

---

### 13.4 Supervisor RuntimeSession lifecycle (MVP 1, M1-3)

Supervisor는 Platform Core 밖의 RuntimeSession이지만 **turn orchestration은 Coordinator가 소유한다.**
generic contract:

```text
platform_run 하나당 active Supervisor RuntimeSession 하나
```

이는 MVP 1 single-run orchestration contract이며 global agent manager를 만든다는 뜻이 아니다.

**SUPERVISOR CapabilityGrant 발급 시점.** 첫 Supervisor session spawn **이전에** Core가 run-scoped
grant를 발급한다. §12.4 그대로 **SUPERVISOR의 requested map은 12 capability 전부 false**이며 Backend
compatibility/enforcement는 §12.2/§12.6 semantics를 재사용한다. persistence는 §18.1a의 기존
`capability_grant` row(`run_id` non-null, `attempt_key` null, run당 partial unique)를 쓰며 **새 grant
schema는 없다.**

**session 생성/재사용.**

```text
run 초기화 후 첫 Supervisor turn 이전:
  Coordinator → RuntimeAdapter.spawn_session(role=SUPERVISOR, …, run-scoped grant)

성공한 RuntimeSessionHandle:
  adapter_metadata(entity_key = run_id) 에 non-secret opaque handle/ref로 보관 (§18.1c)
```

정상 경로에서 같은 run의 후속 Supervisor turn은 **같은 session handle을 재사용**한다. 이것을
same-Supervisor **automatic continuation**과 혼동하지 않는다(I-TD4, Spec §32/§66) — Coordinator가
**명시적으로 `send_turn`을 호출할 뿐**이며 worker terminal이 Supervisor를 자동 resume하는 경로는
어디에도 없다.

**session loss.** MVP 1에서 session 손실을 감지하면 기존 conversation memory를 authority로 삼지 않는다
(Spec §56). 재구성 basis는 Compiled Profile Snapshot · Platform durable state · fresh TaskSource facts ·
Repository facts · CapabilityGrant · pending decisions다. MVP 1이 허용하는 것은 **잃은 session을
재사용하지 않고 새 Supervisor session을 spawn하는 것**까지이며, 새 session에도 동일 run context를 다시
bootstrap한다. background session-recovery framework는 만들지 않는다 — 전면 external reconciliation은
MVP 4다(Spec §69).

**bootstrap context.** backend/project-specific raw config가 아니라 Platform이 생성하는 structured
context이며 최소 semantic content는:

```text
run_id
batch_id
compiled_profile_hash
compiled profile effective read model/reference
Platform role = SUPERVISOR
Platform API/MCP Proposal 제출 지침 (§5.1)
```

**변하는 값은 bootstrap authority로 동결하지 않는다** — task candidates, current task, pending
decisions, repository fact는 **각 turn의 fresh decision context**로 전달한다. 새 Prompt DSL을 만들지
않으며 실제 자연어 표현은 adapter implementation detail이다.

**turn decision context — exact model-facing projection (#60).** §26 step 4의 각 Supervisor turn마다
Coordinator는 아래 exact field set의 `SupervisorDecisionContextV1` 하나를 조립한다. 이것은 새 generic
DecisionContext framework가 아니라 `SupervisorProposalV1` producer 하나를 위한 좁은 typed DTO다.

```text
SupervisorDecisionContextV1 {
  run_id
  batch_id
  proposal_id

  compiled_profile: SupervisorCompiledProfileDecisionViewV1
  candidates: SupervisorTaskDecisionViewV1[]
  current_state: SupervisorCurrentStateViewV1
  repository: RepositoryValidationView
  open_decisions: PendingHumanDecisionV1[]
}

SupervisorCompiledProfileDecisionViewV1 {
  hash
  classifications       # effective.policy.classification_policy exact map
  pipelines             # effective.project.pipelines exact map
  actor_profiles        # effective.project.roles exact map; v1에는 role-type filter가 없음
  verification_profiles # effective.project.verification_profiles exact map
  repository_scopes     # effective.project.repository_scopes exact map
}

SupervisorTaskDecisionViewV1 {
  task_ref
  external_state: ExternalTaskState
  task_definition: TaskDefinition
  dependencies: TaskDependency[]
}

SupervisorCurrentStateViewV1 {
  batch: {
    status: BatchState
    admission_closed: boolean
    validation: DecisionValidationBatchView
  }
  tasks: SupervisorPlatformTaskStateViewV1[]
}

SupervisorPlatformTaskStateViewV1 {
  task_key
  task_ref
  platform_state: TaskState
  selection: {
    classification, pipeline_id, actor_profile, verification_profile,
    repository_scope_id, selection_binding: SelectionBindingV1
  } | null
  state_reason: StateReason | null
  current_attempt: {
    attempt_key, n, state: AttemptState, task_contract_hash,
    base_head, candidate_commit, rework_count, state_reason
  } | null
}
```

위 하위 타입과 vocabulary는 §7/§8/§9.2/§17/§18/§19의 기존 것을 그대로 재사용한다. `hash`는 해당
batch가 동결한 `compiled_profile_hash`이며 `compiled_profile`의 다섯 map은 그 immutable snapshot의
`effective`에서만 projection한다. 현재 Profile Registry나 bootstrap 시점의 다른 profile을 섞지 않는다.
`task_contract_hash`는 current Attempt의 `contract_snapshot_id`가 가리키는 immutable Task Contract hash다.
`current_state.tasks`에는 current batch의 durable task row가 ref당 정확히 하나씩 들어간다. admitted
task의 `selection`이 partial/null이거나 current Attempt/Contract binding을 exact하게 projection할 수 없으면
정상 context로 보정하지 않고 assembly를 실패시킨다.

**한 turn basis의 assembly.** `candidates`의 ref set은 같은 turn의 fresh `discover_tasks` 결과와
Supervisor decision이 필요한 current non-terminal durable task ref의 합집합이며 duplicate ref는 하나로
합친다. 각 ref에 대해 fresh `get_task` normalization, `get_dependencies`, `get_task_state`를 수행하되,
fresh discover 결과가 같은 ref의 `external_state`를 이미 제공했다면 §8.4처럼 그 한 관측을 사용하고
`get_task_state`를 중복 호출해 두 external-state 관측을 섞지 않는다. `task_ref ==
task_definition.task_ref`이고 `version`/`definition_hash`/`body`는 하나의 normalized TaskDefinition
관측에서 함께 와야 한다. `repository.canonical_head`는 RepositoryAdapter의 fresh projection,
`current_state`와 `open_decisions`는 조립 시점의 durable Platform state projection이다. 필수 read 실패,
identity mismatch, partial candidate assembly가 있으면 context를 보내지 않는다. stale durable
`external_snapshot`으로 missing TaskSource fields를 보완하지 않는다.

이 context는 authoritative sources의 **model-facing projection**이지 두 번째 authority가 아니다.
Supervisor가 Proposal에 넣는 값의 binding은 다음과 같다.

```text
proposal_id                    ← context.proposal_id를 exact echo

classification                ← keys(context.compiled_profile.classifications) 중 Supervisor 선택
pipeline_id                   ← keys(context.compiled_profile.pipelines) 중 Supervisor 선택
actor_profile                 ← keys(context.compiled_profile.actor_profiles) 중 Supervisor 선택
verification_profile          ← keys(context.compiled_profile.verification_profiles) 중 Supervisor 선택
repository_scope_id           ← keys(context.compiled_profile.repository_scopes) 중 Supervisor 선택

expected.task_version         ← selected candidate.task_definition.version
expected.task_definition_hash ← selected candidate.task_definition.definition_hash
expected.compiled_profile_hash← context.compiled_profile.hash
expected.base_head            ← context.repository.canonical_head
```

앞의 다섯 field는 **Supervisor-selected semantics**다. Coordinator/Core/Harness가 model result 뒤에
"declared default"를 채우거나 다른 choice로 교체하지 않는다. 뒤의 네 `expected` field는
**Supervisor가 그 turn에 본 authoritative basis를 명시적으로 bind하는 값**이다. 누락·오기는 Proposal
validation 실패이며 post-output completion 대상이 아니다. 제출 시 V3/V8은 context snapshot을 자기
자신과 비교하지 않고 TaskSource/Compiled Profile/Repository의 **fresh authoritative fact를 다시
관측**하므로 turn 뒤 drift를 계속 검출한다.

`open_decisions`는 category 문자열 목록이 아니라 existing `PendingHumanDecisionV1`의 OPEN record
projection이다. current project/batch 또는 `current_state.tasks`의 task를 subject로 하거나 그 범위를
blocking하는 record만 포함한다. `current_state`는 durable lifecycle을 보여줄 뿐 새로운 transition authority가 아니며,
Model이 그 값을 되돌려 썼다고 state가 바뀌지 않는다.

**Runtime structured-output 경계.** RuntimeAdapter/backend가 지원하면 위 context로 output schema의
`enum`(declared choice keys), `const`(`proposal_id`와 applicable expected 값), ULID `pattern` 등을 좁힐 수
있다. 이는 presentation/generation aid다. dynamic schema를 지원하지 않아도 같은 context + 기존
`SupervisorProposalV1` + Decision Validator로 Core architecture가 성립해야 하며, Runtime/backend는
Proposal authority나 validation owner가 아니다.

**#59 경계와 MVP 3 context v2.** D23의 `SupervisorDecisionContextV1`은 이미 존재하는 authoritative task의
Proposal basis만 projection하며 그대로 유지한다. Human-authorized #59 materialisation을 사용하는
Compiled Profile v3/MVP 3 turn은 V1 exact body에 아래 한 required field를 더한
`SupervisorDecisionContextV2`를 사용한다:

```text
subflow_materialization: {
  available: boolean
  remaining_task_capacity: integer >= 0
  operations: [{
    materialization_id
    parent_task_key
    child_definition_hash
    phase: INTENT | COMMITTED_NOT_OBSERVED | OBSERVED
    task_ref: string | null
  }]
}
```

`available`은 batch-bound Compiled Profile v3의 sole source/materializer binding에서만 derive한다.
`remaining_task_capacity`는 §9.2g reservation rule의 projection이고 authority가 아니다. `operations.phase`
는 new durable lifecycle state가 아니라 immutable snapshot + idempotency INTENT/DONE + task binding의 exact
read-only projection이다. `task_ref`는 OBSERVED일 때만 non-null이며 adapter receipt/TaskSource observation과
exact equality다.

F에서 Supervisor가 선택하는 semantic field는 `child.task_definition_body`와 explicit `parent`뿐이다.
Platform/Harness가 model output 뒤에 child text/parent를 채우지 않는다. materializer/source/external ref는
Model choice가 아니며 context에도 selectable backend vocabulary로 노출하지 않는다. OBSERVED child는 ordinary
`candidates`에도 포함되고, 그 뒤 E의 classification/pipeline/actor/verification/scope와 freshness binding은
D23 V1 규칙을 그대로 따른다.

Runtime structured schema는 F exact union과 parent kind/body constraints를 generation aid로 제공할 수 있지만
authority는 §9 Proposal + Validator + §8.4b round-trip이다. D23 proposal_id allocation/echo와 post-output
completion 금지는 변경되지 않는다.

**turn ↔ Proposal 관계.** 한 turn의 `RuntimeTurnResult`는 **turn 완료 / Runtime health / structured
diagnostics**용이다. Proposal 수락은 §5.1의 별도 MCP 제출로 결정된다. 따라서 turn result 본문에
`START_TASK`라고 적혀 있어도 **아무 authority가 없다.**

```text
Coordinator send_turn → Supervisor MCP Proposal 제출 → Platform이 Proposal 검증
```

turn이 끝났는데 valid Proposal이 제출되지 않았다면 **실행을 진행하지 않는다.** Coordinator는 bounded
retry/re-request를 할 수 있으나 **자연어 output을 파싱해 Proposal을 제조하지 않는다.** 구체 retry
count는 새 Core architecture field로 만들지 않는다.

**Idempotency (M1-15 — spawn identity 확정).** Supervisor session spawn과 Supervisor turn은 **서로 다른
external effect이고 서로 다른 crash window를 갖는다** — Actor(M1-8)/Auditor(M1-10)에서 이미 확정한 규칙과
같다. 따라서 하나의 idempotency record가 둘을 덮지 않는다. MVP 1 single batch의 stable key는 §6.1 D+
grammar 그대로:

```text
op:<batch_id>:supervisor-spawn:<n>    # 요청 turn n을 보내기 위해 필요한 run-level session의 생성/재생성
op:<batch_id>:supervisor-turn:<n>     # 현재 authoritative Supervisor session에 요청 turn n 발신
```

두 key는 **항상 서로 다르다.** `supervisor-operation:<n>` 같은 통합 key도, spawn+turn을 하나로 덮는
op도 만들지 않는다. 별도 turn/session table(`SupervisorSessionGeneration`, `SupervisorTurn`)도, tick
cursor도, scheduler state도 만들지 않는다 — `RuntimeSessionHandle` / `RuntimeTurnHandle` 같은 backend
ref는 §18.1c의 `adapter_metadata` projection으로 충분하다.

- **op key가 batch-scoped라는 사실이 session을 batch 소유로 만들지 않는다.** session lifetime은 위에서
  정한 대로 **run-scoped**이며 handle projection은 `adapter_metadata(entity_key = run_id)`다. MVP 1은
  active batch가 하나이므로 batch scope가 곧 그 run의 진행 축이 된다. 이후 multi-batch 작업에서 같은
  run-level session을 재사용하면 **새 `supervisor-spawn:<n>`은 수행되지 않는다.**
- **spawn operation이 존재하는 조건.** 요청 turn n에 대해:

```text
사용 가능한 run-level Supervisor session이 있음
  → spawn operation 없음 → supervisor-turn:<n> 하나만

사용 가능한 session이 없음
  → supervisor-spawn:<n> INTENT → spawn_session → (필요 시) receipt 검증
  → run-level opaque handle 영속 → spawn DONE
  → 그 다음에 supervisor-turn:<n> INTENT
```

  turn을 이미 보낸 뒤에 session spawn을 **투기적으로** 수행하지 않는다.
- **turn ordinal `<n>`.** 양의 정수, batch당 monotonic, durable하게 재구성 가능하며 process-local이
  아니다. 첫 요청은 `supervisor-turn:1`이고 이후의 **의도적인** 재요청이 2, 3 … 이다. 별도 ordinal
  컬럼이나 counter table을 만들지 않는다 — 이미 durable한 Supervisor-turn operation 이력에서 파생한다:

```text
next n = (이미 할당된 op:<batch_id>:supervisor-turn:<n> 중 최대 n) + 1
```

  generic op-key parser/framework는 필요 없다. 이 Core 소유 grammar 하나에 대한 좁은 helper로 충분하다.
- **crash 안전성.** `supervisor-spawn:<n>`은 기존 session-spawn semantics를 그대로 따른다: INTENT 선행,
  adapter가 같은 spawn 효과를 authoritative하게 재획득/증명할 수 있으면 same-op 재획득. acceptance가
  불확정이고 효과를 authoritative하게 재획득할 수 없으면 **추측으로 두 번째 Supervisor session을 만들지
  않는다.** `supervisor-turn:<n>`이 accepted일 수 있으나 `RuntimeTurnHandle`을 durable하게 확립하지
  못했다면 `supervisor-turn:<n>`을 다시 보내지도, `supervisor-turn:<n+1>`을 추측 대체로 쓰지도 않는다 —
  기존 indeterminate Runtime-turn semantics(`RECOVERY_CONFLICT` 계열)로 fail-closed한다. 새 recovery
  framework를 만들지 않으며 전면 background reconciliation은 MVP 4다.

### 13.5 Role/runtime/model binding authority (v1.5)

[계약, PROSPECTIVE_REQUIREMENT] provider/model 선택의 Platform-side authority는 Measurement Projection이
아니라 **frozen Project Profile role selection**이다. 세 role의 해소 chain은 다음뿐이다:

```text
SUPERVISOR
  batch-bound CompiledProfileV2.effective.project.supervisor_profile
  → roles[supervisor_profile].runtime_profile

ACTOR
  task.actor_profile (validated START_TASK selection)
  + task_contract.compiled_profile_hash
  → frozen effective.project.roles[actor_profile].runtime_profile

AUDITOR
  task_contract.pipeline_id
  + task_contract.compiled_profile_hash
  → frozen effective.project.pipelines[pipeline_id].auditor_profile
  → frozen effective.project.roles[auditor_profile].runtime_profile
```

- `runtime_profile`은 RuntimeAdapter가 해석하는 **requested binding ref**다. role/profile config가
  CapabilityGrant를 확대할 수 없고(§12.4), provider/model 실제 identity는 Backend observation이다(§13.2a).
  profile 이름에서 실제 model을 추정하지 않는다.
- exact model 비교/evaluation 대상이 되려면 RuntimeAdapter가 같은 Attempt 동안 stable한 non-secret
  `actual.binding_ref`를 보고할 수 있어야 한다. 보고할 수 없으면 실행 identity는 `UNKNOWN`으로 남고 그
  run을 exact provider/model 비교나 future automatic-routing evidence로 사용할 수 없다; 가장 가까운
  model alias로 보완하지 않는다.
- Actor selection fields와 resolved chain은 `SELECTED→ACTIVE`에서 Task Contract가 생성된 뒤 해당 Attempt
  동안 immutable하다. rework는 같은 Attempt/binding을 사용한다. binding 변경은 explicit Attempt
  invalidation + fresh Compiled Profile + new Task Contract + new Attempt로만 가능하다(§7.4/§11).
- Auditor는 pipeline이 고정한 profile을 쓰며 evaluation recommendation이 직접 교체하지 않는다.
  Supervisor binding은 batch-bound다. run-scoped Supervisor session을 다음 batch에서 재사용할 수 있는 것은
  resolved `runtime_profile`이 동일할 때뿐이다; 달라지면 첫 turn 전에 기존 session을 닫고 새 binding으로
  spawn한다. conversation memory는 authority가 아니다.
- 같은 logical Runtime session/Attempt에서 Backend가 `actual.binding_ref` 변경을 보고하면 그것을
  정상 fallback으로 정규화하지 않는다. lifecycle은 기존 `RUNTIME_FAILED` fail-closed 경로를 사용하고
  §24.1 `BINDING_CHANGED` attribution + §5.13 finding 후보를 남긴다. actual binding이 UNKNOWN이면 변화도
  미변화도 주장하지 않는다.
- **현재 automatic fallback은 없다.** provider unavailable/capacity/auth/config failure는 §24.1에 귀속한
  뒤 기존 recovery/HOLD semantics를 따른다. 더 싸거나 가용한 provider/model로 ongoing Attempt를
  자동 변경하지 않는다.
- 향후 fallback/automatic routing은 §5.14의 future Execution Policy seam을 통과해야 하며, 대체 binding도
  현재 operation과 동일한 CapabilityGrant, Backend Compatibility Gate, verification/audit assurance floor를
  만족해야 한다. 낮은 cost/latency는 capability/assurance floor를 완화하는 근거가 아니다.
- `RoutingRecommendationV1`은 Supervisor가 explicit `actor_profile` Proposal을 고를 때 evidence로 볼 수는
  있다. 그 경우에도 `Model proposes → Platform validates(V1–V11) → selection freeze` 경로가 유지된다.
  이는 ordinary model proposal이지 deterministic automatic-routing policy가 아니다. recommendation을
  읽은 Coordinator/RuntimeAdapter가 Proposal 없이 profile을 바꾸는 경로는 금지한다.

---

## 14. WorkflowAdapter TD · RepositoryAdapter/Gate TD

### 14.1 DurableJobsWorkflowAdapter mapping

| Generic (Spec §30) | durable-jobs (capability 문서 §4) | 상태 |
|---|---|---|
| `start(workflow_spec)` | `workflow` tool `action=start` | AVAILABLE `[D][L]` (idempotent start: `(ownerKey, requestId)`) |
| `status(handle) -> WorkflowObservation` | `action=status/list` | AVAILABLE |
| `resume(handle)` | `action=resume` (attempt N+1 + checkpointPolicy) | AVAILABLE `[D]` |
| `cancel(handle)` | `action=cancel` | AVAILABLE |
| `audit_decide(handle, verdict, evidence)` | `action=audit_decide` | interface AVAILABLE; **live round-trip DEFERRED** → `BACKEND CAVEAT`, §14.2 |
| `recover(handle)` | reconciler recovery scan | AVAILABLE `[D][L]` (record-level) |

Generic interface의 method 이름은 **Spec §30 그대로 유지**한다 — 관측 primitive는 `status(handle)`이며,
그 반환은 §14.2의 normalized `WorkflowObservation`이다 (M0-6).

**Concrete public signatures (M0-8 결정, W-B+):**

```text
start(controller_handle, workflow_spec)                      -> WorkflowHandle
status(workflow_handle)                                      -> WorkflowObservation
resume(workflow_handle)
cancel(workflow_handle)
audit_decide(controller_handle, workflow_handle, verdict, evidence)
recover(workflow_handle)
```

**호출 경로 (v1.1 · M0-8로 확정):** trusted context를 요구하는 호출은 **`start`와 `audit_decide` 둘뿐**이며
(§13.3), 이 둘만 `WorkflowControllerHandle`을 **명시적 인자로** 받는다 — Core는 handle을 넘길 뿐
identity를 만들지 않는다 (I-TD5). `status`/`resume`/`cancel`/`recover`는 controller 인자를 받지 않고,
adapter가 **`WorkflowHandle`에 연결된 기존 controller association**(§13.3)으로 필요한 backend ownership
context를 해석한다. 모든 operation에 controller를 붙이지 않으며, scoped surface/factory/context 같은
public abstraction도 두지 않는다.

`audit_decide`에서 adapter는 전달된 controller가 해당 `WorkflowHandle`의 original controller
association과 정합하는지 **backend-authoritative boundary에서 확인할 수 있어야** 하며, mismatch를
fail-open으로 처리하지 않는다 (§16.3).

handle↔host-managed identity 매핑, 그리고 controller 교체·소실 시 기존 workflow의 접근성/ownership 이동
여부는 여전히 **RA-3**(§30)이다 — M0-8은 이를 닫지 않는다. 특히 "새 controller 획득 시 기존 workflow를
암묵 rebind한다"는 규칙은 어디에도 도입하지 않는다.

**소유권 분리 (Spec §31 구체화):**

- durable-jobs가 소유: 개별 workflow durability, activity 실행, per-workflow attempt/checkpoint, audit gate primitive.
- Platform이 소유: task 선택, batch 상태, cross-task dependency, hold-and-continue, human decision,
  repository merge policy. **`durable-jobs workflow ≠ Platform Batch`** — Platform은 Task Attempt의
  stage 실행 단위(예: verification run)에 workflow를 사용할 수 있으나 Batch를 workflow로 표현하지 않는다.
- MVP 1의 사용 범위 (Decision): durable-jobs는 **(a)** 장시간 local activity(verification 실행)의 durable
  실행기, **(b)** audit gate(`PASSED`는 `MANUAL_APPROVAL|INDEPENDENT_AUDIT`만) 로 사용한다.
  Actor RuntimeSession lifecycle은 Platform Coordinator + RuntimeAdapter가 직접 관리한다
  (durable-jobs stage activity는 argv-only이며 ACP를 호출하지 않는다는 caveat과 정합 — 문서 §1).

### 14.2 Workflow 관측 contract (Q8 결정)

**Decision: poll 기반 observation을 유일한 Core contract로 한다.**

**Placement (M0-6, 정정).** 관측의 **Adapter public primitive는 `status(handle)` 하나뿐**이고,
`observe(handle)`은 **Coordinator-side operation**이다 — WorkflowAdapter의 public method가 아니다.

```text
WorkflowAdapter.status(handle) -> WorkflowObservation { state, stage, attempt, terminal?, refs }

Coordinator.observe(handle):
    observation = WorkflowAdapter.status(handle)
    return observation
```

`WorkflowObservation`은 Core-facing normalized 결과이며, adapter가 backend-native 표현을 이 형태로
정규화해 반환한다. WorkflowAdapter에 public `observe()`를 추가하지 않는다.

- Coordinator는 (a) 자체 tick(기본 30s, 설정 가능) + (b) 자기 transition 직후에 `status`를 poll한다.
  **이 30s scheduling은 MVP 1 production Coordinator의 설정이다 (M0-33).** MVP 0의 `interface + dummy`
  계층(§5.6a)은 timer를 갖지 않고 caller-driven single step만 제공한다.
- **Observation은 transition fact가 아니다 (M0-33).** `WorkflowObservation`의 `state`/`stage`/`refs`는
  backend가 정규화한 **관측**이고 그 vocabulary는 이 문서가 고정하지 않는다. 따라서 MVP 0에서
  `observe(handle)`은 **관측 반환까지만** 하며, opaque backend 어휘를 Core lifecycle 의미로 해석하는
  converter를 두지 않는다: `WorkflowObservationMapper`, generic observation mapping table,
  profile-driven mapping DSL, `backend state → AttemptState` 변환표를 만들지 않는다.
  §19의 typed authoritative fact는 MVP 0 테스트에서 **caller/deterministic fixture가 직접 공급**하고,
  Repository/Runtime/Workflow/Verification 관측을 조합해 그 fact를 만드는 일은 **MVP 1 Coordinator
  integration의 책임**이다.
- adapter는 event/callback을 **poll hint**로 전달할 수 있으나(latency 최적화), Core state transition은
  항상 `status` 재확인 후에만 수행한다. hint 유실은 정확성에 영향 없음(다음 tick이 수렴).
- OpenClaw same-Supervisor auto-continuation(구 P3-H H3/H4/H8)은 **어떤 계층에서도 사용하지 않는다.**
  Supervisor turn이 필요하면 Coordinator가 RuntimeAdapter `send_turn`으로 **요청**한다 (Spec §32).
- Rationale: 결정론·restart 안전·backend 최소 요구. Alternatives rejected: callback 필수화(backend 요구 과잉,
  deferred 경로 재종속), event-sourced push(이중 상태 원천).
- Failure behavior: status 연속 실패 → 해당 stage `HELD(WORKFLOW_UNOBSERVABLE)` → 임계 초과 시 PAUSED_SAFELY.
- MVP impact: MVP 1은 tick loop 하나로 종결. P3-H deferred smoke는 **Backend validation으로만 유지**하며
  Platform MVP 1의 Architecture Gate가 아니다 (지시서 §24).

`BACKEND CAVEAT (audit_decide):` durable-jobs `audit_decide`는 `[D]`-only(라이브 미검증, STATUS §5.2).
Platform은 이를 MVP 1 gate로 삼지 않되, §16.3의 Auditor 커밋 경로가 최초 사용 시 사실상의 라이브 검증이 된다.
실패 시 fail-closed(`WORKFLOW_AUDIT_UNAVAILABLE`)이므로 안전 방향 오류만 존재한다.

### 14.3 RepositoryAdapter contract

Spec §42 interface를 채택하고 두 구현을 둔다: `LocalGitRepositoryAdapter`(초기),
`GitHubProtectedRepositoryAdapter`(contract만, MVP 2 대안).

RepositoryAdapter = **facts와 primitive만** (HEAD 읽기, worktree 생성, lineage/clean 검증, diff,
prepare_merge/commit_merge의 기계적 실행). RepositoryGate = **policy enforcement + merge transaction**.
Adapter는 정책을 모르고 Gate는 git 명령을 직접 만들지 않는다.

**Mutation-reach 선언 (v1.2, I-TD9 적용, [계약]).** RepositoryAdapter의 모든 operation은 계약에
자기 mutation 도달 범위를 명시한다: `READ_ONLY`(HEAD/lineage/clean/diff 조회) /
`WORKSPACE_SCOPED`(해당 attempt의 feature worktree·branch 한정) / `CANONICAL`(prepare_merge/
commit_merge — Gate 전용). 선언 밖 mutation은 구현 결함이 아니라 boundary 위반으로 분류한다. 특히
`create_feature_workspace`의 **재획득(reuse/adopt) 경로는 기존 branch를 rebase/reset할 수 없다** —
동일 상태를 반환하거나 fail-closed한다(M1-8 same-op semantics와 정합; 근거: IO #303의 숨은
worktree-준비-중 branch mutation이 무관 브랜치를 오염시킨 라이브 사례). MEASURED 근거 없이 어떤
operation도 READ_ONLY로 분류하지 않는다.

**I-TD12 적용 ([계약], v1.3).** feature workspace teardown은 candidate commit이 canonical/feature
branch에 durable하게 존재함을 확인한 뒤에만 수행한다. uncommitted 상태로 워크스페이스를 파기해야
하는 경로(INVALIDATED 등)에서는 diff/상태 요약을 캡처하거나 손실을 명시 기록한다.

**`verify_lineage` generic semantics (M1-4).** Spec §42의 public operation set은 유지하고 새 operation을
추가하지 않는다 — `verify_candidate_reflected()` / `manual_merge_status()` / `merge_observation()` 같은
것을 만들지 않는다. 대신 기존 `verify_lineage`가 **두 commit 사이의 ancestor 관계**를 묻는 generic
primitive임을 명확히 한다:

```text
verify_lineage(ancestor_commit, descendant_commit) -> boolean
      # 현재 repo convention의 동등한 typed request/result 형태여도 된다
```

같은 primitive가 MVP 1의 두 곳에서 재사용된다:

```text
Actor candidate 검증        verify_lineage(base_head,     candidate_sha)   # §19.3
manual merge 관측(§19.4)     verify_lineage(candidate_sha, canonical_head)
```

구체 Git 명령은 Adapter implementation detail이며 Platform Core는 git을 직접 실행하지 않는다.

**Workspace operation identity (M1-8).** `create_feature_workspace`는 filesystem/git worktree를 실제로
만드는 **external mutation**이므로 §21의 write-ahead INTENT 대상이다(§19.3의 `op:<attempt>:contract`
같은 local-only 예외가 아니다). Spec §42의 **operation 종류는 늘리지 않고**(`find_workspace` /
`ensure_workspace` / `workspace_status` 등을 만들지 않는다) TD concrete request만 정밀화해 이 operation을
**idempotent create-or-reacquire** primitive로 만든다:

```text
CreateFeatureWorkspaceRequestV1 { base_head, op_key }     # exact 2 fields
   result = 기존 FeatureWorkspace 그대로

same op_key + same base_head       → 동일 logical FeatureWorkspace, 두 번째 worktree 생성 금지
same op_key + different base_head  → deterministic conflict, fail-closed
different op_key                   → 별개 logical workspace operation
```

`op_key`는 Model input이 아니고 repository semantic authority도 아니다 — external side-effect identity
하나다. **LocalGit allocation 정정:** 기존 first-free `ws-<base>-<n>` 방식은 재시작 시 같은 호출이 `-2`를
만들므로 retry identity가 아니다. MVP 1 production path에서는 **`op_key`가 path/branch identity를
결정**한다 — concrete filesystem/git encoding은 LocalGit adapter implementation detail이며, 필수 조건은
`same op_key → same path/branch` · `different op_key는 silent alias 금지` · `충돌은 fail-closed` 셋뿐이다.
generic identifier/HandleCodec framework를 만들지 않는다. 재획득된 workspace는 최소 op_key identity·
`base_head`·repository instance와 정합해야 하며, mismatch/ambiguous는 두 번째 workspace로 우회하지 않고
`RECOVERY_CONFLICT`로 fail-closed한다.

**Workspace 생성 소유권 (v1.1 수정):** repository/workspace의 facts와 primitive는 RepositoryAdapter가,
model session은 RuntimeAdapter가 소유한다 — 두 소유권을 섞지 않는다. 초기
`LocalGitRepositoryAdapter`는 표준 `git worktree` primitive를 직접 사용한다 (새 worktree engine을
만드는 것이 아니라 Git primitive 재사용이다). OpenClaw worktree service를 쓰는 구현은
**"OpenClaw-backed workspace implementation"이라는 backend-specific 선택지**로 두며, Core contract는
workspace 생성을 어떤 Runtime에도 종속시키지 않는다 — Runtime 교체가 RepositoryAdapter 교체를
강제하는 구조를 금지한다. `repository.create_workspace`는 Platform 전용 capability로 유지한다
(Actor에게 지급하지 않고 Platform이 생성해 경로만 제공).

### 14.4 Repository Gate — 전략과 MVP 2 기본 선택 (Q6 결정)

**공통 보장 (전략 무관):**

```text
G1  Actor는 canonical merge authority를 어떤 경로로도 갖지 않는다
G2  candidate SHA == Verification Evidence.target_commit == Audit 대상 SHA (hash 3중 일치)
G3  expected canonical state 검증 (HEAD CAS)
G4  race/불일치 → fail-closed (REPOSITORY_CONFLICT), 어떤 보정도 없음
G5  merge idempotency: op_key = op:<attempt_key>:merge:<candidate_sha>
     재실행 시 HEAD == merge 결과 SHA이면 idempotent success(MERGED), 아니면 RECOVERY_CONFLICT
```

**전략 A — Local guarded ff-only (MVP 2 기본 선택):**

```text
precondition (전부 RepositoryAdapter가 읽은 authoritative fact):
  canonical tracked clean
  current HEAD == expected HEAD (contract.base_head 이후 Platform이 기록한 expected)
  candidate parent == expected HEAD
  candidate tracked clean
  required Verification PASS + accepted assurance 충족 (§15)
  Audit PASS (§16)
  expected-file scope PASS (repository_scope 대조)
  no conflicting writer (Platform Store의 active writable attempt == 본 attempt 하나)
side effect:
  Store에 merge intent(op_key) 선기록 → git merge --ff-only → HEAD 재확인 → MERGED 기록
금지: 자동 rebase, merge commit
```

**전략 B — Protected Remote (contract 수준 설계, MVP 2 대안):**

```text
feature branch push (Actor grant: remote.feature_push=FEATURE_BRANCH_ONLY)
→ PR 생성 (Platform credential)
→ required checks (CIValidationAdapter가 Evidence로 수집, assurance=ARTIFACT_VERIFIED)
→ protected canonical + server-side merge (merge queue)
Platform 추가 검증 (Spec §45):
  Actor credential이 protection bypass 불가함을 구성 검증
  PR head SHA == Evidence.target_commit
  required check producer가 허용된 verifier 목록 내
  merge 후 canonical SHA reconcile (RepositoryAdapter로 재확인)
```

**Decision: MVP 2 기본 = 전략 A (Local guarded ff-only).**

- Rationale: (a) 초기 consumer의 canonical이 로컬 Git(Backend v1 구성, Spec §60), (b) Gate 실행 주체가
  Model session이 아닌 **Platform Core 프로세스**이므로 merge 자체의 인가 문제는 Gate 내부화로 해소,
  (c) 전략 B는 canonical의 GitHub 이전 + credential 분리 운영이라는 프로젝트 외 변경을 요구.
- 단, §12.3 귀결대로 Backend v1에서 `Actor canonical-write denial`이 UNENFORCEABLE인 동안
  `auto_merge` policy는 Compatibility Gate에서 거부된다. **MVP 2 활성화 전제조건(§14.5)** 충족 전까지
  전략 A는 "설계 완료·비활성" 상태다.
- Alternatives rejected: 전략 B 기본(운영 변경 과대), Runtime에 merge tool 제공(§43 위반),
  Gate 없는 policy-only merge(G1 위반).

`ADR-CANDIDATE: Local vs protected-remote RepositoryGate (기본 A, B는 정식 대안으로 유지)`

### 14.5 MVP 2 활성화 전제조건 (둘 중 하나)

```text
(P-a) OpenClaw capability-enforcement 감사 수행 →
      canonical-write denial / shell 제한이 ENFORCED 또는
      policy가 명시 수용한 REDUCED로 상향 판정
(P-b) 전략 B 채택 → canonical protection을 서버측으로 이전,
      Actor credential 분리로 denial을 GitHub 계층에서 ENFORCED 확보
```

전제 미충족 상태에서 auto_merge를 켜는 policy는 compile은 되지만 V10에서 항상 거부된다 —
"prompt로 보완해 강행"하는 경로가 존재하지 않는다 (Spec §13).

---

## 15. Verification TD

### 15.1 구조 (M1-9 정정)

```text
Verification Coordinator (Core)
        │  VerificationAdapter async lifecycle (§15.1a) — 이 경계 위에는 backend 기전이 없다
        ▼
LocalVerificationAdapter (초기, Backend v1)
   ├─ 필요 시 RuntimeAdapter backend-preflight / controller glue
   └─ WorkflowAdapter / durable-jobs local activity(argv) — durable 실행/retry/journal 재사용

CIValidationAdapter (extension point, MVP 2 전략 B에서 활성 후보)
   └─ 자체 backend의 start/observe 구현
```

**M1-9 경계 규칙.** Core는 선택된 Verification backend가 workflow engine을 쓰는지조차 알지 않는다.
`WorkflowAdapter`는 별개의 replaceable backend contract로 남고(§14), LocalVerificationAdapter가
그것을 **내부 구현으로 재사용**할 뿐이다 — `LocalVerificationAdapter → CIValidationAdapter` 교체가
Core 변경 없이 성립해야 한다는 것이 이 경계의 판정 기준이다(Spec §37).

- Platform이 실행을 **개시·소유**하고 대상 commit worktree를 지정하므로 LocalVerificationAdapter 결과의
  assurance는 `REEXECUTED`다. Actor가 자기 세션에서 돌린 동일 명령 결과는 언제나 `WORKER_REPORTED`이며
  두 경로는 코드에서 다른 producer id를 갖는다.
- check 정의는 Profile의 verification_profile이 선언(선언적 argv/timeout/expected artifact),
  Core는 명령 내용을 해석하지 않는다.

### 15.1a Asynchronous VerificationAdapter concrete contract (M1-9)

Spec §37은 Verification backend의 **conceptual minimum responsibility**를 정의한다
(`verification_profile` + `repository_snapshot` + `task_contract_snapshot` → `VerificationEvidence[]`).
MVP 1의 lifecycle은 `IMPLEMENTING → VERIFYING → AUDITING`으로 **명시적으로 분리**되어 있고 검증 실행은
`VERIFYING` 구간 전체에 걸쳐 있으므로, 동기 반환형 하나로는 그 lifecycle을 표현할 수 없다. TD는 같은
책임을 **비동기 concrete interface로 정밀화**한다. Spec은 바꾸지 않는다 — backend의 의미도, 가능한
backend 목록(Local / CI / RemoteSandbox)도 그대로다.

**v1 production callable surface는 아래 둘뿐이다.** 동기 `run_verification(...) -> Evidence[]`는 v1
callable surface에서 **제거**되며 병존하지 않는다 — execution authority가 둘이 되는 것을 막기 위해서다.
동기적으로 끝나는 backend도 이 lifecycle을 구현하고, 첫 observation에서 곧바로 terminal을 반환하면 된다.

```text
VerificationOperationContextV1 { op_key }        # exact 1 field
  — RuntimeOperationContextV1(§13)과 같은 패턴이되 별개의 typed contract다.
  — metadata / headers / trace bag / arbitrary JSON / backend context /
    WorkflowControllerHandle / WorkflowHandle 은 이 안에 들어가지 않는다.

start_verification(
  operation_context,          # VerificationOperationContextV1
  verification_profile,       # 기존 §7.1a 선언, Contract가 freeze한 값
  repository_snapshot,        # 기존 §42 RepositoryCanonicalSnapshot
  task_contract_snapshot,     # 기존 §10 snapshot
  candidate_commit            # RepositoryAdapter가 확인한 candidate SHA
) -> VerificationStartResult

VerificationStartResult =
  | { kind: "STARTED";  run_handle: VerificationRunHandle }
  | { kind: "BLOCKED" }                       # v1 variant는 이 둘뿐

get_verification_result(run_handle) -> VerificationRunObservation

VerificationRunObservation =
  | { state: "RUNNING" }
  | { state: "COMPLETED"; evidence: VerificationEvidence[] }
  | { state: "FAILED" }                       # v1 variant는 이 셋뿐
```

`candidate_commit`이 명시적 인자인 이유: verification identity, Evidence binding(§15.2), MVP 1의
op key(`op:<attempt>:verify:<candidate_sha>`)가 모두 candidate에 묶여 있기 때문이다.

**`VerificationRunHandle`.** opaque / non-secret / **VerificationAdapter 소유 identity**이며 restart
안정성은 선택된 backend가 보장하는 만큼이다. Core는 backend-native identity를 해석하지 않는다.
Backend v1 내부 매핑이 `VerificationRunHandle → durable-jobs WorkflowHandle`일 수는 있으나 generic
Core contract 경계에서 **`VerificationRunHandle ≠ WorkflowHandle`** 이다. 이 handle은 오직
VerificationAdapter의 lifecycle이 `VERIFYING` 구간에 걸쳐 있기 때문에 존재한다 — Runtime turn /
verification run / workflow / CI job을 공통 `JobHandle`·`ExecutionHandle` framework로 일반화하지 않는다.

**`STARTED`.** "이 operation에 대해 **동일한 논리적 verification run이 존재함을 adapter가 authoritative
하게 확정했다**"는 뜻이다. 새로 시작했는지 same-op으로 재획득했는지 Core는 구분하지 않는다.

**`BLOCKED`.** "verification external side effect가 **하나도 시작되지 않았음**을 adapter가 authoritative
하게 보장한다"는 뜻이다. Backend v1에서의 사유(예: 요구되는 backend preflight 미충족, workflow 생성 이전
controller 확보 불가)는 **adapter-local**이며 Core는 알지 않는다. Attempt는 `IMPLEMENTING`, Task는
`ACTIVE`로 남고, `VerificationRunHandle`은 없으며 `candidate_commit`은 전이와 함께 승격되지 않는다.
새 Task/Attempt state도, PendingHumanDecision도, retry counter/backoff/circuit breaker도 만들지 않는다.
같은 op_key로 나중에 재시도할 수 있다.

**`RUNNING`.** terminal이 아니라는 뜻뿐이다 — Attempt는 `VERIFYING`에 머물고, Evidence를 지어내지 않으며,
Auditor를 spawn하지 않는다. polling 주기는 Coordinator 설정이지 adapter state가 아니다.

**`COMPLETED { evidence }`.** backend 실행이 terminal이고 이 run에 대해 backend가 산출한 Evidence
집합이라는 뜻이다. **verification PASS를 뜻하지 않는다** — required check 충족, accepted assurance,
binding 유효성은 전부 Platform 소유의 결정적 판정으로 남는다(§15.2/§15.3).

**`FAILED`.** run 전체가 infrastructure 수준에서 terminal 실패라서 정상 Evidence 집합으로 표현할 수
없는 경우다. Core는 이를 기존 `VERIFICATION_INFRA` semantics로 매핑한다 — 두 번째 failure taxonomy를
만들지 않고, backend error text를 Core contract에 싣지 않는다(진단은 adapter/backend log 소관).
Evidence 내부의 `result: ERROR`는 **check 단위 verifier 결과**이며 run 전체 실패인 `FAILED`와 다르다.

**Same-op semantics (모든 구현 공통, Spec §57의 VerificationAdapter 수준 실현).**

```text
same op_key + same material input        → 동일 논리 VerificationRun
same op_key + different material input   → deterministic conflict, fail-closed
```

강제 방법은 adapter 소유다. Backend v1은 LocalVerificationAdapter → durable-jobs의
same-owner `(ownerKey, requestId)` idempotency로 이를 만족한다. Core는 `op:<attempt>:verify:<candidate_sha>`를
`VerificationOperationContextV1.op_key`로 넘길 뿐 backend requestId 매핑을 수행하지 않는다(§22).

**RA-4 placement.** Backend v1이 요구하는 preflight는 LocalVerificationAdapter의 구현 세부다. generic
Verification Coordinator는 OpenClaw packaging/preflight semantics에 의존하지 않는다 — CIValidationAdapter는
RA-4를 알 필요가 없다.

**I-TD12 적용 ([계약], v1.3).** verification sandbox/실행 표면 정리 전, Evidence가 참조하는
log/artifact digest의 원본이 그 표면에만 있으면 blob 캡처(§15.2의 `log_digest`/`artifact_digest`
대상) 또는 손실 명시 기록이 선행된다. 손실 기록된 Evidence는 저장되나 §31 seam 1의 보수 원칙대로
어떤 gate의 PASS 근거 강화에도 쓰이지 않는다.

### 15.2 Verification Evidence schema (확정, `platform/verification-evidence` v1)

```yaml
verification_evidence:
  evidence_id: ulid
  check_id: string
  result: PASS | FAIL | ERROR
  assurance_level: REEXECUTED | ARTIFACT_VERIFIED | LOG_VERIFIED | WORKER_REPORTED | INFERRED
  target_commit: <sha>              # RepositoryAdapter가 확인한 candidate SHA
  task_contract_hash: sha256:...
  executor_identity: platform-verifier@<host> | ci:<producer> | actor-session:<handle-fingerprint>
  run_reference: <non-secret VerificationRunHandle/실행 참조 — adapter_metadata ref>   # M1-9
  artifact_digest: sha256:... (optional)
  log_digest: sha256:... (optional)
  timestamp: ...
```

**Binding 규칙:** Evidence 저장 시 Coordinator가 `target_commit`을 RepositoryAdapter로 재확인하고
`task_contract_hash`를 attempt의 snapshot hash와 대조한다. 불일치 Evidence는 저장은 하되
`BINDING_INVALID`로 표시되어 어떤 gate에도 사용될 수 없다.

### 15.3 Merge verification policy 평가

Spec §41의 accepted_assurance set 방식 그대로: check별 `result==PASS ∧ assurance ∈ accepted`.
`WORKER_REPORTED`/`INFERRED`만으로 충족되는 구성은 Profile Compiler가 COMPILE_ERROR로 거부한다
(auto_merge=true인 policy에서 accepted가 이 둘만인 check 존재 시). durable-jobs의
`SUFFICIENT_VERIFICATION_LEVELS` 강제와 이중 방어가 된다.

### 15.4 Material fail-closed falsification validation (v1.5 Operator-evidence amendment)

[계약, PROSPECTIVE_REQUIREMENT] 신규 구현하거나 material하게 변경하는 **safety / authority /
fail-closed boundary**의 acceptance evidence에는, guarding behavior 또는 필요한 production wiring을 의도적으로
제거·우회한 bounded negative control에서 retained test가 실제로 실패함을 보이는 falsification validation이
최소 하나 포함되어야 한다. happy-path test의 존재나 owner implementation unit test PASS만으로 그 boundary의
보장을 주장하지 않는다.

- 적용 대상은 capability/authorization gate, exact-target/evidence binding, write-ahead/recovery refusal,
  canonical mutation guard처럼 제거 시 unsafe acceptance 또는 authority bypass가 가능한 material boundary다.
  모든 `[계약]` 문장과 모든 일반 validation에 mutation testing을 기계적으로 요구하지 않는다.
- 보장이 production composition root의 owner wiring에 의존하면 adapter/owner unit test만으로 충분하지 않다.
  production composition 또는 그 exact wiring contract를 통과하는 test가 owner 미주입/우회 시 실패해야 한다.
- negative fixture, guard를 제거한 injectable test double, disposable mutation 중 가장 작은 수단을 사용할 수
  있다. 전역 mutation-testing framework나 새 Verification backend는 요구하지 않는다. 남기는 회귀 test와
  falsification evidence는 §15.2의 exact candidate/Task Contract binding 규율을 따른다.
- 이 원칙은 sealed MVP 0/1 acceptance를 소급 재채점하지 않는다. expanded production/MVP 4 구현의 새
  material boundary와 이후 변경부터 binding이다.

---

## 16. Auditor TD

### 16.1 Lifecycle

```text
1. Coordinator가 Attempt의 immutable Task Contract에서 auditor grant를 **불러온다**
   (M1-10 정정 — `capability_grants.auditor`의 grant_id/grant_hash로 §18.1a 저장분을 load·검증.
    §12.4의 Broker 발급은 §12.7 activation에서 이미 끝났다. AUDITING 진입 시 새 grant를 발급하지
    않으며 새 grant_id도 만들지 않는다. 현재 policy로 재도출해 Attempt를 조용히 바꾸지 않는다.)
2. spawn_session(role=AUDITOR, cwd=검토 전용 read 경로)   # feature worktree의 read-only 노출
3. bind: 동일 Task Contract Snapshot(hash), base/candidate SHA, actual diff(RepositoryAdapter 산출),
   Verification Evidence 목록, repository lineage 요약
4. send_turn(audit instruction) → Auditor가 **RuntimeResultChannel(§13.2)**에
   `platform-auditor-verdict-v1` 기록 — repository write capability 불필요 (I-TD6)
   (M1-10: spawn과 turn은 **서로 다른 external operation**이다 — 아래 operation identity 참조.
    channel arming은 RuntimeAdapter가 `send_turn` 구현 안에서 backend turn 시작 **전에** 수행하며
    Core에는 channel 조작 operation이 존재하지 않는다. protocol은 session이 AUDITOR role로
    spawn되었다는 adapter-owned 사실에서 정해지고 Model이 고르지 않는다.)
5. Coordinator가 envelope 수집·검증 (16.2)
6. Coordinator가 audit decision을 durable하게 commit (16.3)
```

**Auditor Runtime operation identity (M1-10).** spawn과 turn은 서로 다른 external effect이고 서로 다른
crash window를 가지므로 하나의 INTENT가 둘을 덮지 않는다(M1-8과 동일 규칙).

```text
op:<attempt_key>:audit-spawn                      # Auditor RuntimeSession — Attempt 단위
op:<attempt_key>:auditor-turn-1:<candidate_sha>   # 그 candidate의 최초 Auditor turn
op:<attempt_key>:auditor-turn-2:<candidate_sha>   # 그 candidate에 허용된 단 한 번의 재시도
op:<attempt_key>:audit-decision:<candidate_sha>   # 그 candidate의 audit decision (§16.3)
```

재시도는 **동일 Auditor session**에 대한 새 turn이다 — verdict가 unusable한 것이지 session identity가
교체되는 것이 아니므로 `audit-spawn:2`를 만들지 않는다. 실제 session 소실은 기존 Runtime session-loss
semantics가 처리한다.

**multi-cycle identity (M1-13).** session은 Attempt 단위이지만 **candidate를 판정하는 operation은 전부
candidate 단위**다. `FIX_REQUIRED → REWORKING → 새 candidate → VERIFYING → AUDITING`으로 돌아오면
Attempt-wide key는 이전 cycle의 `DONE`을 만나 자기 cycle을 조용히 건너뛴다. candidate SHA를 §6.1
qualifier(단일 segment, `:` 없음)로 쓰며, audit-cycle counter도 audit-cycle table도 만들지 않는다.
"turn-1/turn-2"는 **그 candidate에 대한** 최초 turn과 유일한 재시도라는 뜻이고, Attempt 전체에서 Auditor
turn이 두 번뿐이라는 뜻이 아니다. 같은 candidate에 대한 `auditor-turn-3`은 존재하지 않는다.
durable turn projection도 같은 이유로 candidate별이다(`auditor_turn-1:<candidate_sha>`).

**Auditor runtime_profile authority (M1-10).** 다음 chain만이 authority이며 전부 immutable하다:

```text
Attempt → Task Contract.pipeline_id
        → Attempt/batch가 bound된 compiled_profile_hash의 Compiled Profile snapshot
        → effective.project.pipelines[pipeline_id].auditor_profile   (§7.1a, §7.3 S4a)
        → effective.project.roles[auditor_profile].runtime_profile
```

현재 mutable Profile Registry를 쓰지 않으므로 restart 후에도 동일 값이 재구성된다. Task Contract에
새 field는 필요 없다. Supervisor는 Auditor profile을 고르지 않고(§9.1 Proposal 불변), Core는 profile id를
hard-code하지 않으며, RuntimeAdapter는 default를 발명하지 않는다. `CoreExecutionRole(AUDITOR)` /
`role_profile_id(auditor_profile)` / `runtime_profile` 세 namespace는 계속 분리되고, immutable Auditor
Grant는 **authorization**만 정의한다 — 어느 쪽도 다른 쪽을 도출하지 않는다.

**Auditor cwd (M1-10).** B6가 만든 기존 feature workspace projection(§18.1c)을 그대로 읽기 경로로 쓴다.
read-only는 Auditor Grant의 `repository.feature_write=false`가 강제하며, 검토용으로 두 번째 workspace를
만들지 않고 repository scope를 넓히지도 않는다.

### 16.2 Verdict envelope (`platform-auditor-verdict-v1`)

```yaml
verdict: AUDIT_PASS | FIX_REQUIRED | HUMAN_REQUIRED
findings: [ { id, severity, description, evidence_refs[] } ]
required_fix: [ ... ]            # FIX_REQUIRED일 때
reviewed:                        # Auditor가 무엇을 근거로 판단했는지 — 검증 대상
  candidate_commit: <sha>
  task_contract_hash: sha256:...
  evidence_ids: [ ... ]
```

Coordinator 검증: `reviewed.*`가 attempt의 authoritative 값과 정확히 일치해야 한다.
불일치 → verdict 거부, `AUDIT_INVALID` 기록, **그 candidate에 대해** 재시도 1회
(`op:<attempt>:auditor-turn-2:<candidate_sha>`) 후 `HELD(AUDIT_UNUSABLE)`. 재시도 예산은
candidate 단위이며 Attempt 전역이 아니다 — rework로 새 candidate가 생기면 그 candidate가
자기 turn-1/turn-2를 새로 갖는다(§16.1, M1-13).
Auditor는 Git HEAD/Verification PASS/merge eligibility를 **선언할 수 없고 참조만 한다** (Spec §35) —
envelope에 해당 필드 자체가 없다.

**AuditorReviewContext — per-cycle binding (M1-13).** `reviewed.*` 일치를 요구하려면 Auditor에게 그
값들을 **알려주어야** 한다. 이 셋은 session bootstrap이 아니라 **매 Auditor review turn**에 실린다 —
rework 후 candidate와 Evidence는 바뀌지만 Attempt와 Auditor session은 이어지므로, spawn에 묶으면
정확히 필요한 순간에 낡는다.

```text
AuditorReviewContext (per audit cycle)
  candidate_commit    = Attempt.candidate_commit
  task_contract_hash  = immutable Task Contract snapshot hash
  evidence_ids        = 이 cycle에 공급된 Verification Evidence의 **정확한 순서 있는 sequence**
```

전부 Platform authoritative다 — model 파생값도, 현재 mutable Profile 값도 아니다. 별도 public generic
artifact를 신설하지 않고 deterministic Auditor instruction에 실을 수 있다.

**`reviewed.evidence_ids` 동등성 (M1-13).** **positional exact equality**다: 길이가 같고 모든 위치의
id가 같아야 한다. sequence의 정본은 `VerificationEvidenceStore.forAttempt`의 `ORDER BY evidence_id`
(ULID 순서 — restart 후에도 동일)이며, Auditor에게 건넨 그 sequence가 곧 비교 대상이다. verdict
validation 안에서 정렬하거나 dedup하지 않고(M0-13), semantic-set 비교도 하지 않으며, 두 번째 Evidence
snapshot/table도 만들지 않는다. Auditor는 Evidence를 **참조**할 뿐 verification authority를 만들지 않는다.

**schema 명확화 (M1-13 — 재설계 아님).** 현재 구현된 validator 의미를 그대로 기록한다:

```text
severity      non-empty string. Auditor/project semantic vocabulary이며 Core는 해석도 순위도 하지 않는다
              (enum 도입 금지, ordering 도입 금지)
required_fix  optional. FIX_REQUIRED에는 존재해야 하고, 존재하면 array이며 **빈 배열도 허용**된다
              (항목 shape은 TD가 고정하지 않는다)
```

exact top-level field set / unknown-field 거부 / `reviewed` 검증은 전부 그대로다.

### 16.3 Audit decision commit 경로 (Decision)

- **Platform Core는 trusted owner identity를 생성·주장하지 않는다 (I-TD5, v1.1 수정).**
  workflow의 trusted owner는 `WorkflowControllerHandle`(§13.3) 뒤의 **backend-authoritative
  controller identity**다 — Backend v1에서는 OpenClawRuntimeAdapter가 관리하는 Managed
  Platform-Controller Session이며, identity는 host가 발급한다. Coordinator는 stage workflow의
  `start`와 `audit_decide`를 **동일 controller handle 경유로** 수행하여 owner 일관성을 유지한다.
- Auditor session은 backend workflow를 직접 호출하지 않는다 (workflow tool이 Auditor allowlist에 없음).
- **settle ownership 정정 (M1-13).** generic Core는 `WorkflowAdapter.audit_decide`를 **직접 호출하지
  않는다.** 호출하려면 `WorkflowHandle`과 `WorkflowControllerHandle`이 필요한데, Core가 가진 것은
  B7/B8이 남긴 **opaque `VerificationRunHandle`뿐**이고 그 안을 들여다보는 것은 I-TD5/I-TD7 위반이다
  (`VerificationRunRefV1.workflow_id`, backend workflow id, ownerKey, sessionKey 전부 Core 밖).
  audit settlement는 **그 run을 시작한 adapter**, 즉 `VerificationAdapter` 경계에 둔다:

```text
AuditSettlementOperationContextV1 { op_key }

settle_audit(operation_context, run_handle, auditor_verdict, evidence)
  -> { kind: SETTLED } | { kind: UNAVAILABLE } | { kind: CONFLICT }
```

  backend workflow state를 노출하지 않고 metadata bag도 두지 않으며,
  `JobHandle`/`AuditHandle`/workflow-ref registry도 만들지 않는다.
- **`SETTLED`는 강한 주장이다.** 선택된 VerificationAdapter가 **자기 backend를 authoritative하게 재관측해**
  이 `VerificationRunHandle`의 audit gate가 요청한 논리 Platform verdict로 settle되었음을 증명한 경우에만
  쓴다. backend 호출 성공만으로는 부족하고, 요청 verdict의 echo도 model text도 부족하다.
- **Backend v1 매핑은 LocalVerificationAdapter 안에만 있다:** `AUDIT_PASS→PASS`, `FIX_REQUIRED→FAIL`,
  `HUMAN_REQUIRED→BLOCKED`. `WorkflowControllerHandle`/`WorkflowHandle`/backend evidence projection/
  `INDEPENDENT_AUDIT` producer semantics/stage inspection은 전부 adapter 소유다. `WorkflowAdapter`
  public contract는 바뀌지 않으며 durable-jobs도 바뀌지 않는다. `INCONCLUSIVE` 같은 backend-native
  verdict는 Platform verdict가 되지 않는다 — 요청과 다른 settle이므로 `CONFLICT`다.
- **settlement recovery (M1-13).** Platform idempotency identity는
  `op:<attempt>:audit-decision:<candidate_sha>`다. Backend v1은 audit 결정의 dedup을 증명하지 못하므로
  adapter는 observe-before-act / re-observe-after를 쓴다:

```text
AD1 Platform INTENT 없음                      → 효과 없음
AD2 INTENT 있음, backend가 authoritative하게 unsettled → 이 op으로 settle 적용 가능
AD3 backend가 이미 수용/적용했을 수 있음      → blind retry 금지, 먼저 재관측
      같은 settlement 관측 → SETTLED
      다른 settlement 관측 → CONFLICT
      관측 자체 불가       → UNAVAILABLE
AD4 SETTLED 관측, Platform 최종 TX 미완료      → 재관측 → SETTLED → commit 마무리 가능
AD5 Platform op DONE                          → backend 호출 없음
```

  adapter의 local process memory가 비었다는 이유만으로 UNSETTLED를 주장하지 않는다.
- Rationale: (a) ownership fail-closed 경계(ENFORCED, live-verified)를 **host-derived identity 그대로**
  활용 — Core가 identity issuer가 되는 무근거 가정을 제거, (b) Auditor에게 workflow-control
  capability를 지급하지 않음(권한 최소), (c) 구 P3-H continuation 경로 완전 비의존.
- **Blocker 명시:** controller handle↔host-managed identity 매핑이 확정되지 않으면 Coordinator는
  durable-jobs의 trusted workflow owner가 될 수 없다 → **MVP 1 구현 blocker RA-3** (§30).
- **Commit ordering (M1-4 정합, I-TD2).** `audit_record`는 external side effect보다 먼저 쓰이지
  **않는다.** side effect 이전에 필요한 durable write는 **idempotency INTENT**뿐이며(§21),
  validated `audit_record`는 `audit_decide`의 **확인된 settle 결과와 같은 Core transaction 흐름**에서
  commit된다. 실패한 `audit_decide`를 성공한 audit_record처럼 남기지 않는다:

  ```text
  FIX_REQUIRED / HUMAN_REQUIRED (§11 boundary를 넘지 않으므로 drift 평가 없음)
    Auditor envelope 수집 → §16.2 validation
    → op:<attempt>:audit-decision:<candidate_sha> INTENT
    → VerificationAdapter.settle_audit(...)
    → authoritative SETTLED
    → audit_record + lifecycle branch를 하나의 transaction으로

  AUDIT_PASS (AUDITING→READY_TO_MERGE는 §11 stage boundary다)
    Auditor envelope 수집 → §16.2 validation
    → §11 assembler/evaluator (AUDITING_TO_READY_TO_MERGE)
    non-CONTINUE → drift lifecycle 적용. audit settle side effect 없음, 이 결정의 audit_record 없음
    CONTINUE     → op:<attempt>:audit-decision:<candidate_sha> INTENT
                 → VerificationAdapter.settle_audit(...) → authoritative SETTLED
                 → audit_record + AUDIT_DECIDED + READY_TO_MERGE를 하나의 transaction으로
  ```

  boundary가 이미 전이를 불허하는데 외부 audit settle 효과를 내지 않는다. `AUDIT_DECIDED`는 그대로
  §19.2의 **AttemptFact**이며 state도 row도 flag도 아니다 — `drift_clear=false` 분기는 방어적으로
  유지하되 위 순서 때문에 production 경로가 거기에 닿지 않는다.
  `canonical_head.boundary=MERGE_ONLY`이므로 이 boundary에서 canonical 이동은 **관측 전용**이다:
  그것만으로 HOLD하지 않고 rebase도 `base_head` 변경도 없다(§11.2, §19.4).

- Failure behavior: gate 거부/관측 불가 → `HELD(AUDIT_GATE_UNAVAILABLE)` + 보고. fail-open 경로 없음.
  `settle_audit`가 `CONFLICT`(gate가 **다른** 결정으로 이미 settle됨)를 돌려주면 backend-authoritative한
  답을 덮어쓰지 않고 기존 fail-closed `RECOVERY_CONFLICT`로 간다. 이를 `FIX_REQUIRED`로 재해석하지 않는다.
- **AUDIT_INVALID의 durable 표현 (MVP1-B11).** 사용 불가능한 구조 결과는 `decision_log`의
  orchestration fact(`audit_observation`)로만 남는다 — `audit_invalid` / `invalid_audit_record` /
  `audit_attempt` table을 만들지 않으며, valid하고 settle된 결정만 `audit_record`가 된다(§18.1c).

---

## 17. PendingHumanDecision TD

### 17.1 Schema (`platform/pending-decision` v1, M0-31)

Spec §49 필드를 exact typed body로 닫는다. **`any`/opaque JSON bag은 존재하지 않으며 unknown field는
reject다.** 공통 top-level은 정확히 열세 개다:

```text
decision_id  subject  status  category  question  options  recommendation
blocking_scope  evidence_refs  dedup_key  created_from  gate_proposal  resolution
```

| field | contract |
|---|---|
| `decision_id` | ULID. **caller-supplied** — Core는 ID를 allocate하지 않는다(§18.2, §6.1 금지 목록) |
| `subject` | §17.1a tagged union. `task_id`라는 별도 필드는 두지 않는다(Spec §49의 `task_id`는 `subject.task_key`로 표현) |
| `status` | `OPEN` \| `RESOLVED` \| `CANCELLED` \| `STALE` |
| `category` | §17.1b exact vocabulary |
| `question` | non-empty string |
| `options` | non-empty `string[]`, 각 item non-empty, **order-sensitive**, **중복 item reject** (선택지는 집합적 identity를 가지므로 중복이 무의미하다) |
| `recommendation` | `string \| null`. **presentation only — execution authority가 아니다**(I-TD3) |
| `blocking_scope` | `TASK_ONLY` \| `DEPENDENCY_SUBTREE` \| `BATCH` \| `PROJECT` |
| `evidence_refs` | `string[]`, empty 허용, item non-empty, **순서 보존·중복 허용** — semantic set이 아니다(M0-13 목록 밖) |
| `dedup_key` | §17.1c |
| `created_from` | non-empty Core provenance ref (예: `proposal:<proposal_id>`, `transition:<seq>`) |
| `gate_proposal` | normalized `ProposalV1` exact copy \| `null`. **`HUMAN_GATE_APPROVAL`에서만 non-null** (§17.2a) |
| `resolution` | §17.1d — `status == OPEN`이면 반드시 `null` |

### 17.1a `subject` — generic tagged union

```text
{ kind: "TASK",    task_key:   <task_key> }
{ kind: "BATCH",   batch_id:   <batch_id> }
{ kind: "PROJECT", project_id: <project_id> }
```

`blocking_scope`와의 정합 규칙(넓은 scope는 좁은 subject에서 선언될 수 있으나 그 역은 불가):

```text
TASK_ONLY / DEPENDENCY_SUBTREE → subject.kind == TASK
BATCH                          → subject.kind ∈ {TASK, BATCH}
PROJECT                        → subject.kind ∈ {TASK, BATCH, PROJECT}
```

**placeholder `task_key` 금지.** task 없는 결정(예: `CLOSE_BATCH` Human Gate)은 `BATCH` subject를 쓴다 —
가짜 task identity를 durable public identity에 넣는 경로는 존재하지 않는다.

### 17.1b `PendingDecisionCategory` v1 (Core-fixed)

```text
HUMAN_GATE_APPROVAL   MERGE_APPROVAL   REATTEMPT_DECISION
CONTRACT_DECISION     RECOVERY_DECISION   AUDIT_DECISION
```

project-specific category를 Core enum에 넣지 않는다. 추가가 필요하면 TD/schema revision이다.
`category`는 `dedup_key`의 structural segment이므로 **`:`를 포함하지 않는다**(§6.1 D+).

**`AUDIT_DECISION` (M1-13).** validated Auditor `HUMAN_REQUIRED`가 여는 결정이다. 기존 category 중
이 의미를 소유한 것이 없다 — `HUMAN_GATE_APPROVAL`은 Proposal copy에 묶여 있고(§17.2a), `MERGE_APPROVAL`은
merge이며, drift 쌍은 §11, `RECOVERY_DECISION`은 §22다. 이것은 project vocabulary가 아니라 진짜
typed/schema revision이고, `pending_human_decision.category`가 SQLite `CHECK` enum이므로 **migration
v6**이 필요하다(table 재작성; table 수는 17 그대로, 새 table 없음).

```text
category       = AUDIT_DECISION
subject        = { kind: TASK, task_key }
blocking_scope = TASK_ONLY
options        = [ REQUEST_REWORK, ABANDON ]        # 정확히 이 둘, 이 순서
recommendation = null
gate_proposal  = null
evidence_refs  = [ audit_id ]                       # immutable audit_record 참조 (§18.1c)
created_from   = audit:<attempt_key>:<candidate_sha>  # cycle을 지목하는 Core 소유 provenance
```

- **`HUMAN_REQUIRED`에서 `AUDIT_PASS`로 가는 사람 우회는 MVP 1에 존재하지 않는다.**
  `ACCEPT_AUDIT_HOLD` / `FORCE_PASS` / `CONTINUE_WITHOUT_AUDIT` / `ACCEPT_AS_PASS` 같은 option을 만들지
  않는다. Auditor가 사람을 부른 것이지, 사람이 audit을 통과시키는 것이 아니다.
- **STALE validity basis (M1-12 방식 그대로, engine 없음).** OPEN `AUDIT_DECISION`은 다음이 유지되는
  동안 valid하다: 참조된 Attempt row가 존재하고, 그 Attempt가 여전히 `AUDITING`이며, 현재 candidate가
  감사된 그 candidate이고, 더 새로운 Attempt가 없으며, Task가 terminal이 아니다. rework가 새 candidate를
  만들면 그 질문은 지나간 것이다.

### 17.1c `dedup_key` — subject-generic (M0-31)

기존 `pd:<task_key>:…`는 task-scoped 전용이라 `BATCH`/`PROJECT` scope와 taskless `CLOSE_BATCH` gate를
표현할 수 없었다. subject key로 일반화한다:

```text
subject_key   TASK    → <task_key>            # task:<project_id>:<external_task_ref>
              BATCH   → <batch_id>            # batch:<run_id>:<n>
              PROJECT → project:<project_id>

dedup_key = pd:<subject_key>:<category>:<context_hash>
```

- injectivity(§6.1 D+)는 유지된다: 세 subject_key는 선두 token(`task:` / `batch:` / `project:`)이 서로 달라
  구조 경계가 확정되고, `category`(`:` 금지)와 terminal `context_hash`(§6 digest grammar)가 우측 경계를
  고정한다. `project_id`는 §6.1대로 `:`를 갖지 않는다.
- `context_hash` = `subject` · `category` · `created_from` 세 normalized field를 담은
  **`platform/pending-decision-context` v1** envelope의 §6 hash다.
- `HUMAN_GATE_APPROVAL`은 `created_from = proposal:<proposal_id>`를 사용한다.
- **이 hash는 Proposal hash가 아니다.** Proposal은 여전히 독립 hash artifact/snapshot/store를 갖지
  않는다(§9.1) — context envelope가 참조하는 것은 proposal **id**뿐이다.

### 17.1d `resolution` exact union (M0-31)

`status == OPEN` ⇔ `resolution == null`. terminal status(`RESOLVED`/`CANCELLED`/`STALE`)에서
`CANCELLED`/`STALE`은 resolution 없이 종결되며(사람의 답이 존재하지 않는다), `RESOLVED`만 다음을 갖는다:

```text
resolution = {
  kind:           "OPTION" | "FREE_FORM",
  chosen_option:  string | null,
  free_form:      string | null,
  resolved_by:    non-empty non-secret identity/reference,   # I-TD7
  resolved_at:    timestamp,
  approval_binding: { field_path: non-empty string,
                      approved_value: <§6 constrained JSON> } | null,
  applied_transition_ref: string | null                      # §17.1e
}
```

```text
kind == OPTION     → chosen_option non-null ∧ chosen_option ∈ options ∧ free_form == null
kind == FREE_FORM  → free_form non-empty    ∧ chosen_option == null
```

**기존의 arbitrary `applied_transition` 문자열 필드는 제거한다.** human choice vocabulary와 state-machine
transition identity는 서로 다른 것이며, 전자는 `chosen_option`이 소유한다.

### 17.1e `applied_transition_ref` (M0-31)

```text
applied_transition_ref = transition:<decision_log.seq>   |   null
```

- resolution 적용과 state transition이 **하나의 transaction에서 성공했을 때만** 그 `state_transition`
  로그 레코드(§18.2)의 ref를 기록한다.
- 사람 결정은 기록됐지만 §17.3 fresh revalidation 또는 transition guard가 실패했다면 **`null`**이다.
- `APPROVE_START` / `REATTEMPT` / `ABANDON` 같은 문자열을 transition identity로 저장하지 않는다.

### 17.1f terminal immutability와 `record_hash` (M0-31)

- PendingHumanDecision은 `OPEN` 동안만 lifecycle row다. `OPEN → {RESOLVED, CANCELLED, STALE}` 중
  **정확히 한 번** 전이하며, terminal → 다른 status 전이는 금지다. 특히 `RESOLVED → STALE`은 없다 —
  `STALE`은 **아직 OPEN인** 결정의 근거가 소멸했을 때의 terminal outcome이다.
- terminal 확정 시 `record_hash` = **최종 `platform/pending-decision` envelope의 §6 hash**를 envelope
  밖 컬럼에 기록한다(§18.1a). 이후 envelope/hash 수정은 없다.
- `record_hash`는 §7.2 rule 7의 `approval_hash` 대조 대상이며, `gate_proposal` copy까지 bind한다.

### 17.2 Lifecycle 규칙

- 생성: 해당 transition의 durable write와 **같은 트랜잭션**에서 기록 (유실 방지, Q2 보장).
  `decision_id`는 caller가 공급한다.
- 동일 `dedup_key` 재시도: **같은 semantic body면 기존 레코드 projection을 반환**(중복 생성 없음),
  **다른 semantic body면 fail-closed conflict**다.
- 알림: Report Outbox 경유 1회 idempotent (`op:...:report-pending:<decision_id>`).
  (§6.1 D+: operation은 단일 token `report-pending`, qualifier는 단일 segment `<decision_id>`.)
  enqueue는 같은 transaction 안에서 일어나고 **delivery는 §18.2대로 이후 batch 소관**이다.
- STALE: 근거 상태가 소멸하면 Coordinator가 OPEN 레코드를 STALE 전이 + 1회 알림. STALE은 자동
  RESOLUTION이 아니다 — 후속 조치는 여전히 사람 몫.
- **STALE 판정은 category별 validity basis로 한다 (M1-12).** "attempt가 INVALIDATED면 그 task의 OPEN
  decision을 전부 STALE로 만든다" 같은 **generic 규칙은 금지**다. `REATTEMPT_DECISION`은 애초에
  *"source Attempt가 INVALIDATED다"* 라는 조건 때문에 열리므로, 그 generic 규칙 아래에서는 생성 즉시
  STALE이 되어 버린다. 각 decision은 **자기가 해소하려는 조건이 유지되는 동안 valid**하다:

```text
CONTRACT_DECISION    referenced Attempt가 여전히 존재하고 hold 당시의 non-terminal stage에 있으며,
                     이후 transition이 그 질문을 대체하지 않았다
REATTEMPT_DECISION   referenced source Attempt가 여전히 INVALIDATED이고,
                     새 Attempt 생성이나 task terminal 해소가 그 질문을 대체하지 않았다
```

  판정 입력은 이미 durable한 것뿐이다 — `created_from`(§17.1c의 Core 소유 grammar), `subject`,
  transition reference, Attempt/Task state. generic decision-dependency engine이나 새 durable
  column/table은 만들지 않는다.
- Resolution 적용: **사람의 답이 곧 실행 권한이 아니다.** 적용 전 반드시 §17.3의 fresh revalidation을
  통과해야 하며, 통과한 경우에만 state machine transition이 발생한다.
  Profile/Policy 변경이 필요한 resolution은 진행 중 Contract를 mutate하지 않고
  (a) 다음 Batch 적용 또는 (b) INVALIDATE→새 Attempt 중 하나를 명시 선택하게 한다 (Spec §10/§23).
- blocking 계산 (v1.1 수정 — 별도 state 신설 금지): `TASK_ONLY`는 해당 task만
  `HELD(held_reason=BLOCKED_BY_DECISION:<decision_id>)`. `DEPENDENCY_SUBTREE`는 TaskSource
  dependency(HARD)의 transitive closure를 Coordinator가 계산해 대상 task들을 동일하게
  `HELD(BLOCKED_BY_DECISION:<id>)`로 전이 — "waiting"은 TaskState가 아니라 HELD의 blocking reason으로
  표현한다(§19.1). BATCH/PROJECT는 §20의 조건을 만족할 때 batch state를 `WAITING`으로 전이한다.

### 17.2a Human Gate → PendingHumanDecision 구성 (M0-31)

§9.2의 public result는 `HUMAN_GATE_REQUIRED` 하나이며 **이 계약은 열지 않는다.** Coordinator는 이미 가진
`proposal` + `compiled_profile`로 §9.2b의 gate predicate를 그대로 재사용해 Rule A/Rule B를 deterministic
하게 재계산할 수 있으므로, 추가 result field 없이 다음을 구성한다:

```text
category       = HUMAN_GATE_APPROVAL
subject        = A/B/C/E task-bearing Proposal → { kind: TASK, task_key }
                 F materialisation Proposal    → { kind: TASK, F.parent.task_key }
                 CLOSE_BATCH Proposal  → { kind: BATCH, batch_id }
question       = proposal.decision + proposal_id로부터 Core가 생성하는 deterministic presentation
options        = ["APPROVE", "REJECT"]
recommendation = null
created_from   = proposal:<proposal_id>
gate_proposal  = normalized ProposalV1 exact copy
```

- **Model이 question/options를 정하지 않는다.** 사람에게 제시되는 선택지는 Core 소유이며, 발화가
  execution authority로 승격되는 경로를 만들지 않는다(I-TD3).
- `gate_proposal`은 **PendingHumanDecision envelope의 일부**이며 terminal `record_hash`가 이를 bind한다.
  §9.1의 "Proposal은 hash 대상 artifact가 아니다"는 그대로 유지된다 — `ProposalStore`·`proposal_hash`·
  `platform/supervisor-proposal` envelope는 여전히 존재하지 않는다. 이 copy의 유일한 목적은 승인 이후
  **무엇을 재검증할 것인지**를 authoritative하게 보존하는 것이다.

### 17.3 Post-Human-Gate revalidation (HG-1, M0-31)

**Human approval ≠ execution authorization, ≠ V8/V10/V11 bypass.** 승인은 수분~수시간 뒤에 올 수 있고
(Spec §50), 그 사이 canonical HEAD·Backend Manifest·assurance·batch admission·Compiled Profile·
TaskDefinition이 모두 바뀔 수 있다. 승인만으로 실행하면 Spec §18과 Backend Compatibility Gate(A5)가
human-gated 경로에서 통째로 우회된다.

**Narrow entry point.** `core/decision`에 두 번째 진입점 하나만 허용한다 — ordinary API/result contract는
변경하지 않는다.

```text
validateDecisionAfterResolvedHumanGate(
  DecisionValidationInput,                 # §9.2와 동일, 전부 fresh authority input
  ResolvedHumanGateAuthorization
) -> DecisionValidationResult              # §9.2의 기존 4 kinds 그대로

ResolvedHumanGateAuthorization {
  decision_id
  record_hash
  normalized_gate_proposal
}
```

source는 RESOLVED `HUMAN_GATE_APPROVAL` PendingDecision의 projection이다. generic authorization
framework를 만들지 않는다.

**알고리즘 (순서 고정):**

```text
 1 PendingDecision final record_hash 검증
 2 status   == RESOLVED
 3 category == HUMAN_GATE_APPROVAL
 4 resolution.chosen_option == "APPROVE"
 5 stored gate_proposal == input normalized Proposal  (exact structural equality)

 6..11  V1 V2 V3 V4 V5 V6      — 전부 fresh authority input으로 재실행
 12     V7 gate 조건을 fresh Compiled Profile로 다시 계산
 13     resolved decision은 **이 exact V7 occurrence 하나만** 충족시킨 것으로 간주
 14..17 V8 V9 V10 V11          — 전부 fresh
```

즉 `V1–V6 → exact resolved V7 authorization → V8–V11`이며, first-failure precedence(§9.2)는 그대로다.

**F materialisation Proposal (#59).** F의 resolved gate도 같은 exact Proposal copy/proposal_id를 쓰고
V1–V7 + §9.2g fresh parent/capability/reservation을 모두 다시 계산한다. 통과한 뒤에만 §8.4b snapshot+INTENT를
기록한다. approval 전에 snapshot/external task는 0이다. 이후 E는 별도 Proposal/V7 occurrence이므로 이
approval을 admission에 재사용하지 않는다.

F가 Rule A로 gate될 때 TASK_ONLY blocker는 exact parent를
`HELD(BLOCKED_BY_DECISION:<decision_id>)`로 만든다. `gate_proposal.parent.kind`와 basis가 pre-gate origin을
동결한다. APPROVE 적용은 현재 HELD reason이 same decision이고 underlying basis가 다음처럼 여전히 exact한
경우만 허용한다:

```text
DISCOVERED_TASK origin → Attempt 없음 + fresh task ref/version/hash 동일
ACTIVE_ATTEMPT origin  → same Attempt/Contract/stage가 non-terminal로 그대로 존재
```

한 transaction에서 terminal decision application ref + materialisation snapshot + op INTENT를 기록하고
parent를 origin state(DISCOVERED 또는 ACTIVE)로 복원한다. external adapter 호출은 그 commit 뒤다. ACTIVE로
복원돼도 pending snapshot dispatch gate(§19.3e)가 Actor turn을 막으므로 approval과 publish 사이 race가 없다.
REJECT는 external effect 0, parent는 `HELD(MATERIALIZATION_REJECTED:<decision_id>)`로 남아 새 Supervisor
replan 또는 existing Human/recovery path를 요구한다. stale/mismatch approval도 parent를 복원하지 않는다.
generic “restore previous state” framework는 만들지 않고 F의 두 tagged origin에만 이 mapping을 허용한다.

**Human-gated reselection (M1-7).** `HELD(SELECTION_STALE)` 해소는 그 자체로 human decision이 아니다 —
staleness는 새 deterministic selection을 요구할 뿐이므로 **자동 PendingHumanDecision을 만들지 않는다**
(§20 "Human decides only where policy requires"). 사람이 개입하는 경우는 오직 하나, 새 reselection
`START_TASK` Proposal이 **기존 V7 policy에 의해** `HUMAN_GATE_REQUIRED`가 될 때다. 그때는 ordinary
`HELD(BLOCKED_BY_DECISION:<id>)` 경로를 그대로 타며, 그 HumanDecision의 의미는 **새 Proposal의
authorization**이지 "selection이 stale해진 것에 대한 승인"이 아니다.

승인 후에는 §17.3의 일반 절차 그대로 fresh V1–V10 + **RESELECTION mode V11**(§9.2e) + fresh M1-5
dependency fact를 다시 수행하고, 전부 통과한 경우에만 `HELD(BLOCKED_BY_DECISION:<same id>) → SELECTED`가
일어난다. frozen Proposal에는 새 `START_TASK`가 그대로 들어 있지만 **최종 `SelectionBinding`은 frozen
model 값에서 만들지 않는다** — resolution 후 fresh authoritative TaskSource/Repository fact가 Proposal
expected와 다시 일치했을 때 **그 authoritative fact로** 만든다. 사람 승인이 stale TaskDefinition이나
stale base_head를 bypass하지 않는다.

**Frozen `repository_scope_id` (M1-6).** Human Gate가 freeze하는 Proposal 사본에는 `repository_scope_id`도
그대로 들어 있고, 재검증의 V6가 그것을 **다시** declared reference로 확인한다. 승인 사이에 Profile이 바뀌어
그 scope id가 사라졌다면 `PROFILE_REFERENCE_UNKNOWN`으로 거부된다. 사람 승인은 scope id를 바꾸거나,
선언되지 않은 scope를 고르거나, scope body를 수정할 authority가 **아니다** — §17.3의 일반 원칙(승인은 동의이지
실행 권한 확장이 아니다)의 한 사례다.

**금지.** V7을 전역으로 끄는 경로를 만들지 않는다: `skipHumanGate` / `approved: true` / `bypassV7` /
human override token / generic approval token. resolved decision은 자기 `gate_proposal` 하나의 V7
occurrence에만 대응한다.

**실패 semantics.** 승인 지연 중 세계가 바뀌면 fresh validation이 정상적으로 fail-closed한다:

```text
task/profile drift  → POLICY_REJECTED(TASK_DRIFT | PROFILE_DRIFT)
repository drift    → POLICY_REJECTED(REPOSITORY_STATE_MISMATCH)
backend downgrade   → BACKEND_INCOMPATIBLE
capacity 변화       → POLICY_REJECTED(BATCH_MAX_TASKS_REACHED | CONCURRENCY_LIMIT_REACHED |
                                      WRITABLE_CONCURRENCY_CONFLICT)
```

이때:

- 사람이 실제로 결정한 사실은 그대로이므로 PendingDecision은 **RESOLVED를 유지한다**. STALE로 되돌리지
  않는다(§17.1f).
- `applied_transition_ref = null`.
- task/batch는 blocked state를 유지한다.
- 진행하려면 **현재 세계 기준의 새 Proposal**이 필요하다. 그 Proposal이 다시 gate를 요구하면 새
  `context_hash`의 PendingDecision이 생성된다.
- 승인된 old Proposal의 `expected` hash를 silent refresh하지 않는다.

**적용 transition.** fresh validation이 `ACCEPTED`일 때만 §19.3의 transition command를 호출한다.
Human Gate 생성 시 task가 `HELD(BLOCKED_BY_DECISION:<id>)`였다면 `START_TASK` 승인의 적용은
`HELD(BLOCKED_BY_DECISION:<same id>) → SELECTED`라는 explicit admission transition이며, ordinary
`DISCOVERED→SELECTED`와 **동일한 fresh durable admission guard**(§19.3a)를 사용한다. `CLOSE_BATCH`
승인의 적용은 `batch.admission_closed = true`다. `START_SUBFLOW` human-gate 적용은 prospective MVP 3에서
§9.2f/§19.5의 parent guard와 atomic admission을 **동일하게** 사용한다. normal `RESUME_PARENT`는 human-gate
또는 Supervisor discretion이 아니라 §19.5.3의 deterministic eligibility가 소유한다.

### 17.4 PendingDecision resolution application contract (v1.5 PR #43 amendment)

[계약, PROSPECTIVE_REQUIREMENT] **Decision resolution is not itself a lifecycle effect.** 사람/authority의
선택을 durable `RESOLVED`로 기록하는 것과 그 선택을 Task/Attempt lifecycle에 적용하는 것은 서로 다른
판정이다. category별 새 state machine은 만들지 않고 §19의 기존 transition command만 호출한다.

**공통 protocol (순서 고정):**

```text
resolved choice candidate
→ OPEN record/body/hash/options/category/created_from exact validation
→ fresh owner reads + Task/Attempt/Contract/Profile/Repository state revalidation
→ category + created_from origin + chosen_option exact mapping lookup
→ allowed source-state guard
→ existing deterministic transition command
   OR current-world START_TASK Proposal re-entry marker
→ success: RESOLVED record + state transition + applied_transition_ref, one transaction
→ guard/application failure: RESOLVED(applied_transition_ref=null), safe-held state 유지
```

- `record_hash`, `subject`, `created_from`, `evidence_refs`가 지목한 exact Attempt/candidate/Contract/transition을
  다시 읽는다. category 이름만 보고 "가장 최근 Attempt"를 고르지 않는다.
- mapping에 없는 category/origin/option, owner unavailable, stale/mismatched subject, changed authority,
  illegal source state는 적용하지 않는다. resolution text를 다른 option으로 재해석하거나 old Attempt를
  부활시키지 않는다.
- successful application만 `applied_transition_ref`를 갖는다. resolution terminal immutability 때문에
  `RESOLVED(null)`을 background retry로 나중에 재적용하지 않는다. current world에서 계속하려면 아래 mapping이
  요구하는 fresh Proposal 또는 새 PendingDecision/approved operator action을 통상 경로로 만든다.
- transition command가 실패하면 partial lifecycle write는 rollback하고 resolution fact만 `RESOLVED(null)`로
  commit한다. 사람의 답을 `STALE`/`OPEN`으로 되돌리지 않는다. task/batch는 기존 safe-held/paused 상태를
  보존한다.
- 아래 table은 **현재 v1 Core-created option/origin의 exhaustive mapping**이다. 새 `created_from` grammar나
  option을 추가하는 구현은 같은 변경에서 fresh read set, owner, allowed source, effect, Attempt reuse,
  successor artifact, fallback을 이 절에 추가해야 한다. generic "resolve any decision" dispatcher는 금지다.

| category / origin / chosen option | fresh authority/read set + allowed source | application owner / deterministic effect | old Attempt / successor | failure fallback |
|---|---|---|---|---|
| `AUDIT_DECISION`, `audit:<attempt>:<candidate>`, `REQUEST_REWORK` | exact audit evidence/candidate/Task Contract; task `HELD(BLOCKED_BY_DECISION:<id>)`; same Attempt `AUDITING`; remaining rework > 0; current drift/capability gates pass | Platform Coordinator → existing `AUDITING→REWORKING` + task `HELD→ACTIVE` in one transaction | same Attempt/Contract continues; no Proposal/Contract/Attempt creation | `RESOLVED(null)` + existing HELD; no rework side effect |
| `AUDIT_DECISION`, same origin, `ABANDON` | exact audit/Attempt/Contract; same blocker; task non-terminal; source Attempt still `AUDITING` | §19 state machine → Attempt `FAILED` + Task `FAILED(ABANDONED_BY_DECISION:<id>)` | old Attempt terminates; no successor | `RESOLVED(null)` + HELD |
| `REATTEMPT_DECISION`, `drift:<attempt>:<target>` or `merge-rejected:<attempt>:<candidate>`, `REATTEMPT_WITH_NEW_SNAPSHOT` | exact origin facts; same blocker; source Attempt is respectively `INVALIDATED` or `READY_TO_MERGE`; no newer Attempt; task non-terminal | §19 state machine: non-terminal source는 `INVALIDATED(REATTEMPT_REQUESTED)`, already INVALIDATED는 유지; Task reason을 `REATTEMPT_REQUIRED:<id>`로 바꾸는 `HELD→HELD` transition | old Attempt continuation **금지**; fresh `START_TASK` Proposal must pass V1–V11, then new Task Contract + Attempt `n+1` | `RESOLVED(null)` + existing HELD; old Attempt 불변 |
| `REATTEMPT_DECISION`, same origins, `ABANDON` | 위 exact origin/source guard | §19 state machine → non-terminal source Attempt `FAILED`, Task `FAILED(ABANDONED_BY_DECISION:<id>)`; already INVALIDATED는 그대로 | successor 없음 | `RESOLVED(null)` + existing HELD |
| `CONTRACT_DECISION`, `drift:<attempt>:<target>`, `ALLOW_FROZEN_SNAPSHOT_TO_COMPLETE` | exact drift origin; same blocker; source Attempt가 §17.2의 current non-terminal validity set에 있음; frozen capability floor/current boundary 재검사 통과 | §19 state machine → Task `HELD→ACTIVE`; Attempt state/Task Contract 불변 | same Attempt/Contract continues; 새 artifact 없음 | `RESOLVED(null)` + existing HELD |
| `CONTRACT_DECISION`, same origin, `INVALIDATE_ATTEMPT` | exact drift origin; same blocker; source Attempt current non-terminal; no newer Attempt | §19 state machine → Attempt `INVALIDATED(CONTRACT_DRIFT)` + Task `HELD→HELD(REATTEMPT_REQUIRED:<id>)` | old Attempt continuation 금지; fresh `START_TASK` Proposal → new Contract/Attempt `n+1` | `RESOLVED(null)` + existing HELD |
| `RECOVERY_DECISION`, `merge-mismatch:<attempt>:<candidate>`, `REATTEMPT_WITH_NEW_SNAPSHOT` | exact Repository/Audit/Attempt/Contract binding; same blocker; source Attempt `APPROVED_FOR_MANUAL_MERGE`; candidate still not canonical; no newer Attempt | §19 state machine → Attempt `INVALIDATED(RECOVERY_CONFLICT)` + Task `HELD→HELD(REATTEMPT_REQUIRED:<id>)` | old Attempt continuation/merge 금지; fresh `START_TASK` Proposal → new Contract/Attempt `n+1` | `RESOLVED(null)` + existing HELD/PAUSED_SAFELY 유지 |
| `RECOVERY_DECISION`, same origin, `ABANDON` | 위 exact recovery guard | §19 state machine → source Attempt `FAILED` + Task `FAILED(ABANDONED_BY_DECISION:<id>)`; batch pause는 별도 §22 authority가 해소할 때까지 유지 | successor 없음 | `RESOLVED(null)` + existing HELD/PAUSED_SAFELY |

`REATTEMPT_REQUIRED:<decision_id>`는 execution authority가 아니라 **next-owner/re-entry reason**이다. 이를
해소하는 `START_TASK`는 §9.2e의 `RESELECTION`으로 처리하여 이미 소비한 admission slot은 다시 소비하지
않되, TaskDefinition/Compiled Profile/canonical HEAD/dependency/capability/batch/writable facts를 전부 fresh로
검증한다. Proposal의 선택이 그대로 새 Task Contract가 되는 것이 아니라 §19.3a equality guard와 §12.7
finalization을 다시 통과해야 한다.

---

## 18. Platform Durable State — Store 설계 (Q2 결정)

**Decision: SQLite 단일 파일 + WAL, 단일 writer(Coordinator 프로세스), 트랜잭션 = state transition 단위.**

- Rationale: 1인·단일 호스트·MVP 0–1 규모에서 atomic multi-record write, crash-safe(WAL), 쿼리 가능성을
  가장 낮은 비용으로 제공. Antfarm류 선례가 규모 적정성을 방증하되 설계는 자체 schema를 따른다.
- Alternatives rejected: JSON 파일 저널(다중 레코드 원자성 부재 — durable-jobs가 이미 그 방식이며
  Platform까지 같은 제약을 질 이유 없음), Postgres(운영 과잉), 임베디드 KV(쿼리/reconcile 불리).
- Failure behavior: 트랜잭션 실패 = transition 미발생 (side effect는 I-TD2에 의해 intent 선기록 후이므로
  재시작 시 intent-비완료 레코드로 복구 판단). DB 손상 → PAUSED_SAFELY + 백업 복구 절차(운영 문서).
- MVP impact: MVP 0에서 schema 확정, migration은 `schema_migrations` 테이블로 관리.

`ADR-CANDIDATE: Platform durable store = SQLite(WAL) 단일 writer`

### 18.1 테이블 집합과 batch 소유권 (M0-29)

```text
# Batch 2 — foundation migration v1 (변경 금지)
schema_migrations(version PK, name, applied_at)
blob(content_hash PK, bytes)
decision_log(seq PK, ts, kind, ref_key, payload_json)
idempotency(op_key PK, state INTENT|DONE|FAILED, result_json, ts)

# Batch 8 — domain migration v2 (exact 10 tables, §18.1a)
compiled_profile_snapshot   platform_run   batch   task   task_attempt
task_contract_snapshot      capability_grant   pending_human_decision
operator_action             report_outbox

# MVP 1 — domain migration v3 (exact 3 tables, §18.1c / M1-2)
adapter_metadata        # non-secret backend ref projection (I-TD7)
verification_evidence   # §15.2 evidence의 durable row
audit_record            # §16.2 validated verdict의 durable row
```

**Domain migration 시점 (M0-23 → M0-29로 확정).** Batch 2는 foundation 4-table만 구현하도록 이미 닫혔고,
**Batch 6은 domain migration을 추가하지 않으며 Batch 2 migration도 변경하지 않는다.** M0-23의
`"…등 domain table"`이라는 열린 표현은 **위 exact 10-table set으로 교체한다** — 구현자가 "등"을 임의
확장하지 않는다.

```text
Batch 6  → TaskSource + TaskDefinition normalization/hash, contract-source snapshot/blob primitive,
           Task Contract schema/build bundle, B5 Grant issuance 통합 — 신규 domain migration 없음
Batch 8  → migration v2(위 10 table) + atomic transition persistence + §19/§20 state machine
Batch 9  → Coordinator MVP 0 shell (§5.6a, §22.4) — 신규 migration 없음
MVP 1    → migration v3(위 3 table, §18.1c) + Adapter orchestration + Report delivery
```

`platform_run`/`batch`가 v2에 포함되는 이유는 `task.batch_id` FK와 §9.2e의 세 read-model이 전부
batch-scoped이기 때문이고, `compiled_profile_snapshot`이 포함되는 이유는 §5.2가 Compiled Profile을
"immutable row + hash"로 보관한다고 이미 규정하기 때문이다 — hash만 참조하고 실제 immutable envelope를
버리는 구현은 금지한다. `report_outbox`가 포함되는 이유는 §17.2/§18.2가 pending 생성 transaction 안에서
outbox 기록을 요구하기 때문이며, **B8이 소유하는 것은 enqueue뿐이다**(§18.2).

### 18.1a Exact domain schema v1 (M0-29)

논리 schema다(물리 DDL은 구현 세부). 모든 table은 B2와 동일하게 `STRICT`를 사용하고,
**UPDATE/DELETE public mutation API를 갖지 않는 table은 immutable로 표시**한다.

```text
compiled_profile_snapshot                                             # immutable
  compiled_hash    TEXT PK          # §7.7 CompiledProfile envelope hash
  envelope_json    TEXT NOT NULL    # platform/compiled-profile v1 envelope 전체 (canonical JSON)
  created_at       TEXT NOT NULL

platform_run
  run_id                 TEXT PK          # §6.1 run:<ulid>
  project_id             TEXT NOT NULL    # ':' 금지 (§6.1)
  compiled_profile_hash  TEXT NOT NULL REFERENCES compiled_profile_snapshot(compiled_hash)
  status                 TEXT NOT NULL CHECK (status IN ('RUNNING','PAUSED_SAFELY','COMPLETED'))
  created_at             TEXT NOT NULL
  updated_at             TEXT NOT NULL

batch
  batch_id               TEXT PK          # §6.1 batch:<run_id>:<n>
  run_id                 TEXT NOT NULL REFERENCES platform_run(run_id)
  ordinal                INTEGER NOT NULL CHECK (ordinal >= 1)
  compiled_profile_hash  TEXT NOT NULL REFERENCES compiled_profile_snapshot(compiled_hash)
  status                 TEXT NOT NULL CHECK (status IN
                           ('RUNNING','WAITING','COMPLETED','PAUSED_SAFELY','FAILED'))
  admission_closed       INTEGER NOT NULL CHECK (admission_closed IN (0,1))
  created_at             TEXT NOT NULL
  updated_at             TEXT NOT NULL
  UNIQUE(run_id, ordinal)

task
  task_key               TEXT PK          # §6.1 task:<project_id>:<external_task_ref>
  batch_id               TEXT NOT NULL REFERENCES batch(batch_id)
  project_id             TEXT NOT NULL
  external_task_ref      TEXT NOT NULL    # opaque, ':' 허용 (§6.1 D+)
  platform_state         TEXT NOT NULL CHECK (platform_state IN
                           ('DISCOVERED','SELECTED','ACTIVE','HELD','DEFERRED','COMPLETED','FAILED'))
  classification         TEXT NULL
  pipeline_id            TEXT NULL
  actor_profile          TEXT NULL
  verification_profile   TEXT NULL
  repository_scope_id    TEXT NULL        # M1-6, migration v4 (§18.1d) — selection provenance
  selection_binding_json TEXT NULL        # M1-7, migration v5 (§18.1e) — SelectionBindingV1
  external_snapshot_json TEXT NOT NULL    # §8.3 ExternalTaskSnapshotV1
  admitted_at            TEXT NULL        # SELECTED를 최소 1회 통과한 단조 marker
  state_reason_code      TEXT NULL
  state_reason_log_seq   INTEGER NULL REFERENCES decision_log(seq)
  created_at             TEXT NOT NULL
  updated_at             TEXT NOT NULL
  UNIQUE(project_id, external_task_ref)

task_attempt
  attempt_key            TEXT PK          # §6.1 attempt:<task_key>:<n>
  task_key               TEXT NOT NULL REFERENCES task(task_key)
  n                      INTEGER NOT NULL CHECK (n >= 1)
  contract_snapshot_id   TEXT NOT NULL REFERENCES task_contract_snapshot(snapshot_id)
  state                  TEXT NOT NULL CHECK (state IN
                           ('READY','IMPLEMENTING','VERIFYING','AUDITING','REWORKING',
                            'READY_TO_MERGE','APPROVED_FOR_MANUAL_MERGE','MERGING','MERGED',
                            'INVALIDATED','FAILED'))
  base_head              TEXT NOT NULL
  candidate_commit       TEXT NULL
  rework_count           INTEGER NOT NULL CHECK (rework_count >= 0)
  state_reason_code      TEXT NULL
  state_reason_log_seq   INTEGER NULL REFERENCES decision_log(seq)
  created_at             TEXT NOT NULL
  updated_at             TEXT NOT NULL
  UNIQUE(task_key, n)
  UNIQUE(contract_snapshot_id)
  PARTIAL UNIQUE(task_key) WHERE state NOT IN ('MERGED','INVALIDATED','FAILED')   # §19.2 I1/I2

task_contract_snapshot                                                # immutable
  snapshot_id      TEXT PK          # §10.1 body의 snapshot_id와 일치해야 한다
  hash             TEXT NOT NULL UNIQUE
  envelope_json    TEXT NOT NULL    # platform/task-contract v1 또는 §10.1a subflow v2 envelope 전체
  created_at       TEXT NOT NULL

capability_grant                                                      # immutable
  grant_id         TEXT PK
  grant_hash       TEXT NOT NULL UNIQUE
  role             TEXT NOT NULL CHECK (role IN ('SUPERVISOR','ACTOR','AUDITOR'))
  run_id           TEXT NULL REFERENCES platform_run(run_id)
  attempt_key      TEXT NULL REFERENCES task_attempt(attempt_key)
  envelope_json    TEXT NOT NULL    # platform/capability-grant v1 envelope 전체
  created_at       TEXT NOT NULL
  CHECK ((role =  'SUPERVISOR' AND run_id IS NOT NULL AND attempt_key IS NULL) OR
         (role <> 'SUPERVISOR' AND run_id IS NULL     AND attempt_key IS NOT NULL))
  PARTIAL UNIQUE(run_id)           WHERE role = 'SUPERVISOR'
  PARTIAL UNIQUE(attempt_key, role) WHERE role IN ('ACTOR','AUDITOR')

pending_human_decision
  decision_id      TEXT PK          # caller-supplied ULID
  dedup_key        TEXT NOT NULL UNIQUE                       # §17.1c
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('TASK','BATCH','PROJECT'))
  subject_ref      TEXT NOT NULL
  status           TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','CANCELLED','STALE'))
  category         TEXT NOT NULL CHECK (category IN
                     ('HUMAN_GATE_APPROVAL','MERGE_APPROVAL','REATTEMPT_DECISION',
                      'CONTRACT_DECISION','RECOVERY_DECISION'))
  blocking_scope   TEXT NOT NULL CHECK (blocking_scope IN
                     ('TASK_ONLY','DEPENDENCY_SUBTREE','BATCH','PROJECT'))
  envelope_json    TEXT NOT NULL    # platform/pending-decision v1 envelope 전체
  record_hash      TEXT NULL        # OPEN → NULL, terminal → NOT NULL (§17.1f)
  created_at       TEXT NOT NULL
  updated_at       TEXT NOT NULL
  CHECK ((status =  'OPEN' AND record_hash IS NULL) OR
         (status <> 'OPEN' AND record_hash IS NOT NULL))

operator_action                                                       # immutable
  action_id            TEXT PK
  status               TEXT NOT NULL CHECK (status = 'RESOLVED')      # §7.6, M0-31
  field_path           TEXT NOT NULL
  approved_value_json  TEXT NOT NULL    # §6 constrained JSON, canonical
  recorded_by          TEXT NOT NULL
  recorded_at          TEXT NOT NULL
  record_hash          TEXT NOT NULL UNIQUE
  envelope_json        TEXT NOT NULL    # platform/operator-action v1 envelope 전체
```

```text
report_outbox
  op_key           TEXT PK          # §6.1 D+ delivery identity (§21.1)
  channel          TEXT NOT NULL
  payload_json     TEXT NOT NULL
  sent_at          TEXT NULL        # 확인된 delivery 이후에만 기록 — MVP 1 integration (§21.1, M0-33)
```

**공통 규칙.**

- **Policy 숫자를 row에 복제하지 않는다.** `max_tasks` / `concurrency` / `max_rework` / `completed_count`
  컬럼은 만들지 않는다. authoritative policy는 언제나
  `batch.compiled_profile_hash → CompiledProfile.effective.policy.batch_policy`다. 같은 값의 두 번째
  authority를 두면 drift가 필연이다.
- **각 batch가 자기 Compiled Profile hash를 동결한다.** `platform_run.compiled_profile_hash`는 run
  creation provenance일 뿐이며, Profile/Policy 변경은 §7.4대로 다음 Batch부터 적용되므로 run row의
  hash를 later batch authority로 재사용하지 않는다.
- **immutable table의 conflict semantics** (B2 BlobStore/idempotency 패턴 재사용, 새 framework 금지):
  같은 identity + 같은 canonical 내용 = idempotent success / 같은 identity + 다른 내용 = fail-closed
  conflict / 같은 hash + 다른 bytes = corruption. load 시 envelope를 §6로 **re-hash해 저장된 hash와
  일치**해야 한다. **body-only 저장 금지** — envelope 전체를 저장해야 재hash가 성립한다.
- **identifier는 되파싱하지 않는다.** §6.1대로 구성요소(`project_id`, `external_task_ref`, `ordinal`,
  `n`)를 별도 컬럼으로 보관하며 Core는 key를 parse해 복원하지 않는다.
- **secret 금지(I-TD7).** 위 어떤 컬럼에도 raw sessionKey/token/Authorization/secret env/backend agent
  identity를 저장하지 않는다. `base_head`/`candidate_commit`은 RepositoryAdapter 소유의 non-secret git
  fact이므로 허용된다(§6.1 예외). `adapter_metadata`는 아직 존재하지 않는다.
- **timestamp authority (M0-32).** `created_at`/`updated_at`은 B2가 이미 주입받는 store clock을 그대로
  쓴다(`DecisionLog`/`IdempotencyStore`와 동일 관행). `observed_at`/`resolved_at`/`recorded_at`은 외부·
  사람 사건의 fact이므로 **caller-supplied validated timestamp**다. 새 clock framework를 만들지 않으며,
  pure state machine은 `Date.now`/`new Date`를 authority로 사용하지 않는다.

### 18.1b Migration v2 semantics (M0-29)

B2 migration mechanism을 그대로 사용한다 — 새 migration framework를 만들지 않는다.

```text
v1 → foundation (Batch 2, 변경 금지)
v2 → domain schema (Batch 8, 위 10 table)

fresh DB       : v1 → v2 순서로 적용
existing v1 DB : v2만 적용
v2 실패        : v2 statements + schema_migrations(v2) 전부 rollback → 미기록
restart        : v2가 기록되지 않았다면 deterministic retry
```

B2 runner가 이미 (a) migration + `schema_migrations` insert를 한 transaction에 묶고, (b) version이
contiguous 1..n인지 검증하며, (c) 기록된 version보다 낮은 build를 거부하므로 위 요구는 전부 충족된다.

### 18.1c MVP 1 domain migration v3 — exact three tables (M1-2)

v1/v2는 **수정하지 않는다.** v3이 추가하는 table은 정확히 셋이며, 그 밖의 어떤 table도 만들지 않는다 —
특히 `runtime_session` / `runtime_turn` / `workflow` / `workflow_controller` / `workspace` /
`coordinator_state` / `scheduler_state` / `recovery_state` / `task_dependency` / `generic_event` /
`adapter_registry`는 **금지**다. B2 convention(`STRICT`, `foreign_keys ON`, `schema_migrations`,
단일 writer)을 그대로 따른다.

#### adapter_metadata

**Platform generic entity → adapter 소유 non-secret reference/current metadata의 projection**이며
**authoritative Platform lifecycle state가 아니다.** MVP 1에서 실제로 필요한 것만 저장한다:

```text
run     → Supervisor RuntimeSessionHandle
attempt → Actor / Auditor RuntimeSessionHandle, RuntimeTurnHandle,
          workspace ref, WorkflowHandle, WorkflowControllerHandle reference/fingerprint
```

```text
adapter_metadata
  entity_key   TEXT NOT NULL     # 기존 generic Platform identifier (§6.1)
  adapter_id   TEXT NOT NULL     # non-empty adapter namespace
  key          TEXT NOT NULL     # adapter 소유 non-empty metadata key
  value_json   TEXT NOT NULL     # §6 constrained JSON
  PRIMARY KEY (entity_key, adapter_id, key)
```

- **current projection**이므로 insert/update가 허용된다(immutable artifact가 아니다).
- lifecycle authority가 아니므로 state enum을 두지 않는다.
- hash artifact가 아니므로 envelope/hash를 **발명하지 않는다.**
- entity가 polymorphic이므로 **generic FK framework를 만들지 않는다** — `entity_key`는 plain 식별자다.

**I-TD7 강제 (M1-2).** raw `sessionKey` / token / Authorization / secret env / raw credential은 이
table을 포함해 **어디에도 저장하지 않는다**(§6.1). DB가 임의 backend secret의 의미를 완벽히 추론한다고
가정하지 않으므로 경계는 세 겹으로 강제한다:

```text
Adapter contract      Core-facing type은 opaque Platform handle / non-secret ref /
                      redacted fingerprint만 노출한다
Core write validation 알려진 secret-bearing key name을 reject한다
tests                 위 둘을 정적·동적으로 고정한다
```

새 secret scanner / DLP framework를 만들지 않는다.

#### verification_evidence

§15.2의 `platform/verification-evidence` v1 envelope가 **semantic source of truth**이며 durable row는
그 envelope와 조회에 필요한 projection을 함께 보존한다.

```text
verification_evidence                                                  # immutable
  evidence_id        TEXT PK
  attempt_key        TEXT NOT NULL REFERENCES task_attempt(attempt_key)
  check_id           TEXT NOT NULL
  result             TEXT NOT NULL CHECK (result IN ('PASS','FAIL','ERROR'))
  assurance_level    TEXT NOT NULL CHECK (assurance_level IN
                       ('REEXECUTED','ARTIFACT_VERIFIED','LOG_VERIFIED',
                        'WORKER_REPORTED','INFERRED'))
  target_commit      TEXT NOT NULL
  task_contract_hash TEXT NOT NULL
  executor_identity  TEXT NOT NULL
  run_reference      TEXT
  artifact_digest    TEXT
  log_digest         TEXT
  timestamp          TEXT NOT NULL
  binding_valid      INTEGER NOT NULL CHECK (binding_valid IN (0,1))
  envelope_json      TEXT NOT NULL
```

- **`binding_valid`는 Coordinator가 계산한다** — §15.2의 authoritative revalidation(`target_commit`을
  RepositoryAdapter로 재확인, `task_contract_hash`를 attempt snapshot과 대조) 결과이지 Verifier나
  Auditor의 주장이 아니다. `0`인 row는 저장은 되지만 어떤 gate에도 쓰일 수 없다.
- **immutable.** 같은 `evidence_id` + 같은 내용은 idempotent success, 다른 내용은 fail-closed
  conflict다(§18.1a 공통 규칙). evidence 내용을 UPDATE하지 않는다.
- **rework semantics.** 새 candidate의 검증은 **새 `evidence_id` row**를 만든다. generation/version
  컬럼을 두지 않는다 — gate는 언제나 현재 `attempt` · `candidate_commit` · `task_contract_hash`에
  bind된 row만 사용하므로 옛 candidate의 evidence가 새 candidate로 승격되는 경로가 없다.
- **lookup contract.** 최소 `forAttempt(attempt_key)` 하나이며 gate가 `target_commit` /
  `task_contract_hash` / `binding_valid` / `check_id` / `result` / `assurance_level`을 deterministic
  하게 필터한다. 논리적 index 기대치는 `attempt_key` 조회가 efficient할 것 하나뿐이고 physical index는
  구현 세부다. 새 evidence query framework를 만들지 않는다.

#### audit_record

**Coordinator가 §16.2 validation을 통과시킨 Auditor verdict의 durable record**다. malformed하거나
`reviewed.*`가 불일치하는 envelope는 `AUDIT_INVALID`로 `decision_log`에 남을 수는 있어도 **valid
`audit_record`로 승격되지 않는다.** rework 때문에 한 Attempt가 여러 valid audit cycle을 가질 수 있으므로
**attempt당 1행으로 제한하지 않는다.**

```text
audit_record                                                           # immutable
  audit_id           TEXT PK          # caller-supplied ULID
  attempt_key        TEXT NOT NULL REFERENCES task_attempt(attempt_key)
  candidate_commit   TEXT NOT NULL
  task_contract_hash TEXT NOT NULL
  verdict            TEXT NOT NULL CHECK (verdict IN
                       ('AUDIT_PASS','FIX_REQUIRED','HUMAN_REQUIRED'))
  envelope_json      TEXT NOT NULL    # validated platform-auditor-verdict-v1
  workflow_ref       TEXT
  committed_via      TEXT NOT NULL
  recorded_at        TEXT NOT NULL
```

- `candidate_commit` / `task_contract_hash`는 validated `reviewed` projection과 **일치해야 한다**(§16.2).
- `workflow_ref`는 raw backend secret이 아니라 `adapter_metadata`에 보관된 non-secret WorkflowHandle
  ref/key다(I-TD7).
- `committed_via`는 **generic audit commit provenance만** 표현한다 — backend-specific workflow state를
  이 table에 넣지 않는다.
- **immutable.** rework/재-audit마다 새 `audit_id`이며 동일 row UPDATE는 없다. §16.2의 실패한 첫
  시도는 audit_record가 아니라 `decision_log` / attempt orchestration fact다. 새 generic audit history
  framework를 만들지 않는다.

### 18.1d MVP 1 domain migration v4 — one nullable selection column (M1-6)

M1-6이 `repository_scope_id`를 selection provenance로 durable하게 만들면서 필요한 유일한 schema 변화다.
**migration history는 다시 쓰지 않는다** — v1/v2/v3는 그대로 두고 v4를 append한다.

```text
schema version = 4

migration v4:
  ALTER TABLE task ADD COLUMN repository_scope_id TEXT NULL
```

```text
tables = 17            # 변화 없음 — 새 table 0
```

**금지.** `repository_scope` / `scope_registry` / `task_scope` / `scope_history` / generic policy table을
만들지 않는다. scope **정의**의 authority는 Project Profile과 그것을 동결한 Compiled Profile Snapshot이며,
`task` row는 **선택된 id 하나**만 보관한다. 정의를 durable하게 복제하지 않으므로 scope definition의 단일
authority가 유지된다.

**왜 nullable인가.** task는 admission보다 먼저 materialize된다(§8.4). `DISCOVERED` row에
`repository_scope_id == NULL`인 것이 정상 상태이므로 column을 `NOT NULL`로 만들면 discovery
materialization 자체가 깨진다. lifecycle invariant — SELECTED를 통과한 task는 non-null id를 갖는다 — 는
column constraint가 아니라 Store/state-machine guard(§19.3, §19.3a)가 유지한다. 다른 네 selection field와
동일한 취급이다.

### 18.1e MVP 1 domain migration v5 — durable selection binding (M1-7)

M1-7이 요구하는 유일한 schema 변화다. **M1-6의 v4는 수정하지 않는다** — v4 contract는 이미 close-out으로
닫혔고, 그 record를 사후에 고쳐 M1-7 field까지 v4였던 것처럼 만들지 않는다. 구현 비용은 사실상 같으면서
architecture decision history가 정확히 보존된다.

```text
planned migrations
  v4   task.repository_scope_id     TEXT NULL      # M1-6 (§18.1d)
  v5   task.selection_binding_json  TEXT NULL      # M1-7

M1-7 구현 후 target
  schema version = 5
  tables         = 17                              # 새 table 0
```

v1/v2/v3의 **적용된** history는 어느 쪽에서도 rewrite하지 않는다(구현 시점 실제 schema는 아직 v3이며,
v4/v5는 둘 다 미적용 planned migration이다 — TD target history와 actual schema를 구분한다).

**금지.** `selection_binding` / `proposal_snapshot` / selection history / generic fact table / command
store를 만들지 않는다. binding은 `task` row의 exact typed body 하나이며, 그것을 재구성하기 위해
`decision_log`를 뒤지지 않는다(§18.2: journal은 history/audit substrate이지 execution input authority가
아니다).

**두 column을 절대 합치지 않는다.**

```text
external_snapshot_json    latest TaskSource observation projection (§8.3)
                          — SELECTED/HELD 상태에서도 discovery pass가 자유롭게 refresh한다
selection_binding_json    explicit Platform-validated selection basis (§19.3a)
                          — explicit selection transition에서만 쓰인다
```

`external_snapshot`의 refresh는 `selection_binding`을 **변경하지 않는다.** 전자를 selection authority로
재해석하면 관측 갱신이 조용히 selection basis를 덮어쓰게 된다.

### 18.1f MVP 3 subflow relation / terminal-success storage (v1.5 PR #43 amendment)

[계약, PROSPECTIVE_REQUIREMENT] existing task/attempt/decision-log primitives로 restart reconstruction이
injective하므로 새 table은 만들지 않는다. MVP 3 migration은 다음 additive semantic만 갖는다:

```text
task.platform_state        + SUSPENDED
task.parent_task_key       TEXT NULL REFERENCES task(task_key)   # child row only
task_attempt.state         + SUCCEEDED
task_attempt current-index terminal set
                           + SUCCEEDED
tables                     unchanged
```

- `parent_task_key`는 §19.5 atomic `START_SUBFLOW` admission에서만 `NULL→exact parent`로 정해진다. Task
  Contract build, scheduler, recovery, presentation이 값을 쓰거나 교체하지 않는다. 같은 child의 다른
  parent로 rewrite하는 것은 conflict다.
- parent `SUSPENDED` row는 `state_reason_code = SUBFLOW_CHILD:<child_task_key>`와
  `state_reason_log_seq = suspension transition seq`를 **반드시** 가진다. child의 `parent_task_key`, parent
  reason/ref, child Task Contract v2(§10.1a)를 합치면 parent/child/suspension cause/continuation point를
  restart 후 재구성할 수 있다.
- `SUCCEEDED`는 canonical publication을 뜻하지 않는다. frozen pipeline terminal-success가
  `RESUME_PARENT`인 Attempt의 terminal state다(§19.2/§19.5.2). `MERGED`와 alias하지 않는다.
- physical migration version number/table rewrite 방식은 implementation history가 정한다. 기존 v1–v6과
  MVP 0/1 schema seal을 수정하지 않고 append하며, constraint/index rewrite는 한 migration transaction에서
  수행한다.

### 18.1g MVP 3 child materialisation authority storage (#59 amendment)

[계약, PROSPECTIVE_REQUIREMENT] §18.1f의 “new table 0”은 D22의 **post-existing-child relation lifecycle**
자체에 대한 결정으로 유지된다. Human-authorized #59 pre-admission materialisation은 validated semantic input을
restart 뒤 재구성해야 하므로 별도 additive migration으로 정확히 한 immutable table과 task column 하나를
추가한다:

```text
child_materialization_snapshot                                  # immutable
  materialization_id  TEXT PK       # accepted Proposal.proposal_id ULID
  hash                TEXT NOT NULL UNIQUE
  batch_id            TEXT NOT NULL REFERENCES batch(batch_id)
  parent_task_key     TEXT NOT NULL REFERENCES task(task_key)
  envelope_json       TEXT NOT NULL # platform/child-task-materialization v1
  created_at          TEXT NOT NULL

task.materialization_binding_json TEXT NULL # ChildMaterializationBindingV1

tables +1
```

snapshot envelope는 load 때 §6으로 re-hash한다. `materialization_id/hash/batch_id/parent_task_key` columns와
envelope가 exact equality가 아니면 corruption이다. 같은 identity+same envelope는 idempotent, 다른 envelope는
conflict다.

`materialization_binding_json`은 §8.4b TaskSource round-trip transaction에서만 `NULL→exact binding`이
가능하다. ordinary discovery는 null을 유지하고, refresh/selection/activation/recovery가 rewrite/clear하지
않는다. `task.parent_task_key`는 D22대로 E admission transaction에서만 set하며 두 column의 의미를 합치지
않는다:

```text
materialization_binding_json = proposed/published child의 immutable pre-admission relation provenance
parent_task_key              = validated executable relation committed with parent suspension
```

external publish status/receipt는 existing `idempotency` INTENT/DONE/FAILED와 DONE `result_json`의 exact
`ChildTaskMaterializationReceiptV1`을 사용한다. snapshot table에 status/cursor/retry count를 넣거나 새
materialisation state machine/store/event framework를 만들지 않는다. physical migration number는 actual
implementation history가 정하며 MVP 0/1 applied migrations를 rewrite하지 않는다.

### 18.2 트랜잭션/이력 규칙 (M0-32)

- 하나의 state transition = 하나의 SQLite 트랜잭션: 상태 컬럼 갱신 + `decision_log` append +
  (필요 시) idempotency INTENT + pending_decision/outbox 기록.
- **transaction owner는 B8 transition commit 함수다.** B2의 `withTransaction`/`BEGIN IMMEDIATE`
  primitive를 재사용하며 nested transaction은 그대로 금지다. 고정 순서:

  ```text
  BEGIN IMMEDIATE
    현재 durable row read
    현재 read-model derive (§9.2e projection)
    state guard 평가

    state_transition decision_log append
      # 해당 transition의 seq를 state_reason_log_seq 또는 applied_transition_ref가
      # 참조해야 하는 경우 먼저 append한다.

    state/artifact/pending/outbox write 전부

  COMMIT
    # 어느 후속 write라도 실패하면 decision_log append까지 함께 rollback
  ```

  **read + guard + update가 반드시 같은 write transaction 안에 있어야 한다.** 단일 writer +
  `BEGIN IMMEDIATE`이므로 optimistic version 컬럼이나 CAS를 새로 만들지 않는다.

  **물리 순서 vs invariant.** `decision_log` append와 state write의 transaction **내부 물리 순서**는
  referential-integrity 요구에 따라 log-first일 수 있다 — §18.1a의
  `task.state_reason_log_seq` / `task_attempt.state_reason_log_seq`가
  `REFERENCES decision_log(seq)`이고 FK가 실제로 강제되므로, HELD/FAILED row는 자신을 설명하는
  바로 그 transition의 seq를 참조하려면 append가 선행되어야 한다. authoritative requirement는
  순서 자체가 아니라 다음 넷이다:

  ```text
  - guard 이전 log append 금지
  - log와 state mutation은 동일 BEGIN IMMEDIATE transaction
  - transition 실패 시 둘 다 rollback
  - committed state_transition log는 대응 durable transition과 atomic
  ```

  즉 **"writes before log"는 architecture invariant가 아니다.** invariant는
  **"guard 통과 후 log + state write가 하나의 atomic transaction"**이며, 후속 write 실패 시 append도
  함께 rollback되므로 **committed orphan `state_transition` 레코드는 계약상 발생할 수 없다.**
  이를 위해 FK를 제거하거나 `DEFERRABLE` 같은 새 schema mechanism을 도입하지 않는다.
- §10.2의 contract-source capture helper는 계속 **caller-owned transaction 안에서** 동작한다 — 위
  transaction이 그 caller다.
- **decision_log kind 분리.** `decision_validation`(§9.2, Batch 7)과 `state_transition`(이 절)은 서로
  다른 durable fact다. validation ACCEPTED 레코드를 transition 기록으로 재사용하지 않으며, 동일 사건을
  두 kind로 중복 append하지도 않는다. `state_transition` payload 최소 내용:

  ```text
  primary_entity_key
  task:    { from, to } | null
  attempt: { from, to } | null
  batch:   { from, to } | null
  reason_code: string | null
  pending_decision_id: string | null
  ```

  한 atomic transition에서 task와 attempt가 함께 바뀌면 **하나의 payload에 둘 다** 기록한다.
- decision_log는 append-only 이벤트 이력으로 상태 재구성·감사에 사용한다 (event/history 보존 요구).
- **Report Outbox 경계.** B8은 `report_outbox` **enqueue만** 소유한다 — PendingHumanDecision 생성
  transaction에서 `task/batch hold/wait 상태 변경` + `pending_human_decision insert` +
  `report_outbox insert` + `state_transition append`를 원자적으로 commit한다. **B8은 ReportAdapter를
  호출하지 않는다.** delivery·delivery 확인·`sent_at` 기록은 §21.1의 M0-5 contract 그대로 이후 batch
  소관이며, `op_key` identity/conflict semantics도 그대로 재사용한다.
- Backend ref는 adapter_metadata에만(non-secret 한정, I-TD7): generic 상태 쿼리가 backend 표현에
  오염되지 않는다. 해당 table은 §18.1대로 아직 존재하지 않는다.

---

## 19. Task / Attempt State Machine (v1.1 — 두 lifecycle 분리)

한 개념을 여러 state 이름으로 표현하지 않기 위해 상위 **TaskState**와 실행 **AttemptState**를 분리한다.

### 19.1 TaskState (v1 vocabulary — MVP 0/1 최소 집합)

```text
DISCOVERED  SELECTED  ACTIVE  HELD  DEFERRED  COMPLETED  FAILED
```

- `ACTIVE` = 현재 Attempt가 non-terminal 상태로 진행 중.
- `HELD`는 항상 `held_reason`을 동반한다 — 예: `BLOCKED_BY_DECISION:<id>`, `REWORK_LIMIT`,
  `SELECTION_STALE`(M1-7, pre-Attempt), `DRIFT_CHECK_UNAVAILABLE`(M1-11), `RECOVERY_CONFLICT`.
  **`WAITING_DECISION`이라는 별도 state는 존재하지 않는다** (HELD + blocking reason으로 표현, §17.2).
  M1-12: OPEN PendingDecision이 task를 막고 있으면 held_reason은 언제나
  `BLOCKED_BY_DECISION:<id>`다 — `CONTRACT_DRIFT`는 그 경우 **Task reason이 아니라 인과 fact**로
  transition/Attempt에 기록된다(§11.4). 두 개념을 이 column 하나에 겹쳐 넣지 않는다.
- `PAUSED_SAFELY`는 TaskState가 아니라 batch/run 수준 safety state이며 task 화면에는 투영만 된다.
- `SUSPENDED`는 **MVP 3 extension state**다: parent/child subflow 관계에서 parent task에만 도입하며
  (§18.1f `task.parent_task_key` + suspension reason/ref), MVP 0/1 vocabulary에는 포함하지 않는다. 생성·해소
  authority는 §19.5 하나뿐이다. parent의 current Attempt는 suspension 동안 state/Contract를 바꾸지 않는다.
- **Task completion은 frozen pipeline terminal-success predicate로 정한다.** MVP 0/1의
  `MERGE_GATE` concrete path는 Attempt `MERGED` → Task `COMPLETED`다. MVP 3 foundation/
  `RESUME_PARENT` path는 Attempt `SUCCEEDED` → Task `COMPLETED`다(§19.5.2). **Completion ≠ merge.**
  canonical merge가 없는 pipeline을 `MERGED`로 표시하지 않는다.
- **terminal set (M0-30).** `COMPLETED` / `FAILED` / `DEFERRED`가 terminal이다. **`HELD`는 terminal이
  아니다** — 정의상 사람 결정으로 재개되는 상태다(§17.2). `SELECTED`/`ACTIVE`도 당연히 아니다.
- **state reason (M0-29).** `HELD`와 `FAILED`는 `state_reason_code` + `state_reason_log_seq`를 **반드시**
  동반한다(§18.1a). reason 없는 generic HELD/FAILED는 금지다(§24). DB는 parameterized reason vocabulary
  전체를 CHECK enum으로 복제하지 않고, State Machine이 §24 taxonomy와 Core-fixed reason pattern
  (예: `BLOCKED_BY_DECISION:<decision_id>`)을 검증한다.
- **review-only pipeline (M0-30 판정).** `review_only`는 Spec §20의 Project Profile **pipeline template
  예시**이며, MVP 0 acceptance(§25)와 MVP 1 sequence(§26)의 실행 경로는 전부 ACTOR→VERIFY→AUDITOR→
  MERGE_GATE 형태다. TD 전체에서 review-only 실행을 요구하는 상위 authority는 없다. 따라서 v1에서
  review-only는 **Profile vocabulary의 future extension**이며 Batch 8의 executable transition에 포함하지
  않는다. `MERGED`를 "그냥 성공"으로 재해석해 repository merge가 없는 종결에 사용하는 경로는 만들지
  않으며, 새 terminal AttemptState도 만들지 않는다. review-only가 실제 실행 요구가 되면 그때
  typed lifecycle extension으로 설계한다. (§9.2e V11의 "ACTOR 없는 pipeline은 writable slot 불요"는
  validation 단계의 pipeline shape 규칙이므로 그대로 유효하다.) **이 defer는 Spec §20/§47/§68이 이미
  요구한 foundation `RESUME_PARENT` pipeline에는 적용되지 않는다** — 그 path의 typed terminal state와
  predicate는 §19.5가 닫는다.

### 19.2 AttemptState (v1 vocabulary)

```text
READY  IMPLEMENTING  VERIFYING  AUDITING  REWORKING
READY_TO_MERGE  APPROVED_FOR_MANUAL_MERGE  MERGING  MERGED
INVALIDATED  FAILED
```

- **`INVALIDATED`는 Attempt 상태다** (TaskState 아님). drift policy `INVALIDATE_AT_BOUNDARY`(§11) 또는
  명시적 사람 결정으로 진입한다. attempt INVALIDATED 시 인과 fact(`CONTRACT_DRIFT`)는 **Attempt row의
  reason과 transition 항목**에 남고, task는 함께 열리는
  PendingHumanDecision(`REATTEMPT_DECISION`: 새 snapshot으로 재시도 / 포기)에 의해
  `HELD(BLOCKED_BY_DECISION:<decision_id>)`로 전이한다 (M1-12 — §17.2의 단일 blocking 규칙) —
  새 Attempt 생성은 언제나 명시 사람 결정의 적용 결과다 (§17.3, silent 재시작 없음).
- `APPROVED_FOR_MANUAL_MERGE`는 MVP 1 human-merge 경로 전용(§19.4).
- `SUCCEEDED`는 **MVP 3 additive terminal state**이며 v1 vocabulary에는 소급 삽입하지 않는다. frozen
  pipeline의 terminal step이 `RESUME_PARENT`일 때 §19.5.2 predicate로만 진입한다. repository merge/
  publication fact가 아니며 `MERGED`와 상호 대체하지 않는다.
- **단일 state column (M0-30).** durable 표현은 `task_attempt.state` **하나**다(§18.1a). 기존 overview의
  `stage`+`status` 이중 컬럼은 같은 vocabulary를 둘로 쪼개 authority를 모호하게 만들고 drift를 허용하므로
  제거한다.
- **동시 Attempt 제한 (M0-30).** 한 task에 non-terminal Attempt는 **최대 하나**다. §18.1a의 partial
  unique index(또는 동등한 deterministic constraint)로 강제하며, 별도 attempt coordinator를 만들지 않는다.

**task↔attempt 정합 규칙 (M0-30 정정).** 기존의 `task ACTIVE ⇔ attempt ∈ {READY..MERGING}` **biconditional은
제거한다** — §19.4 human merge, §11.1 `HOLD_AT_BOUNDARY`, §19.3의 AUDIT `HUMAN_REQUIRED`가 모두
`task HELD + non-terminal attempt`를 **정상 경로**로 만들기 때문에, `⇔`를 guard/CHECK로 구현하면 그
경로들이 즉시 위반된다. 정확한 불변식은 단방향 넷이다:

```text
I1  task.state == ACTIVE          → 정확히 하나의 current non-terminal Attempt가 존재
I1a task.state == SUSPENDED       → 정확히 하나의 current non-terminal Attempt가 존재 (MVP 3)
I2  current non-terminal Attempt  → task.state ∈ { ACTIVE, HELD, SUSPENDED }
I3  task.state == HELD            → non-terminal Attempt가 있을 수도, 없을 수도 있다
I4  Attempt terminal({MERGED, SUCCEEDED, INVALIDATED, FAILED}) 진입 트랜잭션에서
    TaskState도 같은 트랜잭션에서 deterministic하게 결정된다
```

따라서 `task HELD + attempt READY_TO_MERGE`는 **valid**이며 §19.4 Human Merge 경로를 깨지 않는다.

### 19.3 주요 transition table

형식: `trigger / precondition / side effect / durable write / failure→ / op_key`.
표기: `T:` = TaskState 전이, `A:` = AttemptState 전이.

**열 소유권 (M0-32).** `precondition`(caller가 공급한 authoritative fact에 대한 판정), `durable write`,
`failure→`는 **Batch 8**이 소유한다. `trigger`의 관측과 `side effect` 실행은 **Coordinator**가 소유하며,
그 production 수행은 §26의 **MVP 1 integration**이다(§5.6a: MVP 0 Coordinator는 interface+dummy) —
B8 state machine production code는 어떤 Adapter도 import/call하지 않는다(§19.3b).

| Transition | 정의 |
|---|---|
| T: DISCOVERED→SELECTED | trigger: 검증된 START_TASK Proposal(V1–V11 통과, §9.2e) / pre: **§19.3a commit-time durable guard** + `hard_dependencies_clear == true`(§8.4a M1-5) / side: 없음 / write: task row(`platform_state`, selection fields = `classification`/`pipeline_id`/`actor_profile`/`verification_profile`/`repository_scope_id`(M1-6), `selection_binding_json`(M1-7), `admitted_at`) + batch(`admission_closed`) + decision_log / fail→ DISCOVERED (거부 기록) / op: — |
| child T: DISCOVERED→SELECTED + parent T: ACTIVE→SUSPENDED (MVP 3) | trigger: validated `SubflowSelectionProposalV1`(§9.2f) / pre: §19.5.1 full commit-time parent/child/batch/cycle/conflict guard / side: 없음 / write: child selection + `parent_task_key`, parent `SUBFLOW_CHILD:<child>` reason/ref, both state changes in one transition transaction / fail→ both rows unchanged / op: — |
| T: HELD→SELECTED (human gate) | trigger: RESOLVED `HUMAN_GATE_APPROVAL`의 §17.3 fresh revalidation ACCEPTED / pre: `held_reason == BLOCKED_BY_DECISION:<same decision_id>` + **§19.3a 동일 guard** + **재계산된** `hard_dependencies_clear == true`(§8.4a) / side: 없음 / write: 위와 동일 + `pending_human_decision.resolution.applied_transition_ref` / fail→ HELD 유지, transition 미발생(§17.3) / op: — |
| T: SELECTED→ACTIVE + A: (생성)→READY | trigger: Coordinator contract build / pre: **§19.3a selection binding equality 통과(M1-7 — 실패 시 아래 HELD(SELECTION_STALE) 행)** → §12.7 finalization order대로 `task.repository_scope_id`를 batch-bound Compiled Profile에서 resolve(M1-6) → grant 발급(V10 재확인) 후 Task Contract Snapshot 생성 성공(backend_requirements + grant refs 포함, §10.1) / side: snapshot·grant immutable 기록 / fail→ T: FAILED(CONTRACT_BUILD_ERROR) 또는 HELD(POLICY_BACKEND_INCOMPATIBLE) / op: `op:<attempt>:contract` — **local logical operation reference이며 idempotency row를 요구하지 않는다(§21, M0-32)** |
| T: SELECTED→HELD(SELECTION_STALE) (M1-7) | trigger: activation 직전 fresh TaskDefinition/canonical이 `selection_binding`과 불일치 / pre: Attempt 부재 / side: 없음 / write: task row(`platform_state`, `state_reason_code=SELECTION_STALE`, `state_reason_log_seq`) + decision_log(mismatch provenance) — `selection_binding_json`·selection fields·`admitted_at`은 **그대로 유지** / fail→ — / op: — |
| T: HELD(SELECTION_STALE)→SELECTED (M1-7, explicit reselection) | trigger: 검증된 **새** START_TASK Proposal(V1–V10 + RESELECTION mode V11, §9.2e) / pre: `state_reason_code == SELECTION_STALE` + Attempt 부재 + `admitted_at != null` + **§19.3a reselection guard** + 재계산된 `hard_dependencies_clear == true`(§8.4a) / side: 없음 / write: selection fields + `selection_binding_json`을 새 validated 값으로 교체, `state_reason_*` clear — `admitted_at`과 `batch.admission_closed`는 **불변** / fail→ HELD(SELECTION_STALE) 유지 / op: — |
| A: READY→IMPLEMENTING | trigger: Coordinator 실행 개시 / pre: **§19.3e 순서 전체** — RA-4 preflight PASS(step 0) → workspace/spawn/turn 각각 INTENT 선행 후 수행 → 세 op DONE + 세 ref durable + **§19.3d receipt 조건부 검증** / side: create_feature_workspace + spawn_session(actor) + send_turn / write: attempt.state, workspace ref·session handle(opaque)·turn handle→adapter_metadata, **receipt는 §19.3d 조건에서만** / fail→ T: HELD(RUNTIME_FAILED) · HELD(CAPABILITY_BOUNDARY_CHANGED) · HELD(RECOVERY_CONFLICT)(§19.3e T2/T3) / op: `op:<attempt>:workspace`, `op:<attempt>:actor-spawn`, `op:<attempt>:actor-turn:1` |
| A: IMPLEMENTING→VERIFYING (M1-9 정정) | trigger: Actor turn terminal 관측 / pre: RepositoryAdapter가 candidate commit 존재+lineage(base_head 자식)+tracked clean 확인. **declared_status는 precondition 아님(I-TD3)** / side: `VerificationAdapter.start_verification(op_key, frozen verification request)` — **generic 경로에 WorkflowAdapter도 WorkflowControllerHandle도 등장하지 않는다(§15.1a)** / write(STARTED): VerificationRunHandle projection + verify op DONE + candidate_commit + A: VERIFYING + log을 **한 transaction**으로 / BLOCKED: A는 IMPLEMENTING 유지, candidate_commit 미승격, RunHandle 없음, 전이 없음 / fail→ (commit 없음·lineage 불일치) REWORKING(잔여 rework>0) 또는 T: HELD, backend infra 실패는 `VERIFICATION_INFRA` / op: `op:<attempt>:verify:<candidate_sha>` |
| A: VERIFYING→AUDITING (M1-9 정정) | trigger: `VerificationAdapter.get_verification_result(run_handle)` 관측 — `RUNNING`이면 VERIFYING 유지, `FAILED`면 `VERIFICATION_INFRA`, `COMPLETED`면 반환 Evidence를 envelope 검증 + `target_commit`/`task_contract_hash` 재확인 + Coordinator 계산 `binding_valid`로 저장(§15.2) 후 required check·accepted assurance 평가(§15.3) / pre: 모든 required check Evidence 수집 + PASS + binding_valid + accepted assurance. **WorkflowObservation에서 verification 성공을 유도하지 않는다** / side: **없음** — Evidence gate 성립은 durable Evidence rows로만 남고 gate marker를 쓰지 않는다(M1-9) / fail→ VERIFICATION_FAILED 처리: REWORKING(rework<limit) else T: HELD |
| A: VERIFYING→AUDITING launch (M1-10) | pre: durable Evidence + frozen policy로 gate 자격을 **재계산**(저장된 표시를 믿지 않는다) → §11 VERIFYING→AUDITING drift gate → RA-4 preflight. 이 셋이 통과하기 전에는 어떤 Runtime side effect도 없다 / side: `spawn_session(role=AUDITOR, …)` 후 `send_turn(…)` — **서로 다른 두 external operation** / write: spawn INTENT→DONE + Auditor RuntimeSessionHandle(+§19.3d receipt 조건부), 그 다음 turn INTENT→DONE + RuntimeTurnHandle + A: VERIFYING→AUDITING을 **하나의 transaction**으로 / fail→ spawn/turn 실패는 기존 `RUNTIME_FAILED` / `CAPABILITY_BOUNDARY_CHANGED` / `RECOVERY_CONFLICT` semantics. preflight BLOCKED는 VERIFYING 유지(side effect 0) / op: `op:<attempt>:audit-spawn`(Attempt 단위 session), `op:<attempt>:auditor-turn-1:<candidate_sha>`(이 candidate의 최초 review). `op:<attempt>:auditor-turn-2:<candidate_sha>`는 §16.2의 unusable-verdict 재시도 소관이며 이 launch에 속하지 않는다 — Attempt 전역 Auditor turn counter는 없다(M1-13) |
| A: AUDITING→READY_TO_MERGE | trigger: verdict=AUDIT_PASS + §16.3 settle 성공 / pre: drift policy 평가(§11) 통과 / write: audit_record / fail→ FIX_REQUIRED→REWORKING, HUMAN_REQUIRED→T: HELD + `AUDIT_DECISION` PendingDecision. 구조 결과가 unusable하면 1회차는 `AUDIT_INVALID` + `op:<attempt>:auditor-turn-2:<candidate_sha>`, 2회차는 T: HELD(`AUDIT_UNUSABLE`) — 같은 candidate에 3번째 turn 없음. valid verdict인데 settlement를 authoritative하게 확립하지 못하면 T: HELD(`AUDIT_GATE_UNAVAILABLE`) / op: `op:<attempt>:audit-decision:<candidate_sha>` |
| A: REWORKING→IMPLEMENTING | trigger: Coordinator rework 개시 / pre: rework_count<max_rework, 동일 snapshot 유효(§11) / side: 동일 Actor session 재사용 가능(send_turn n+1) / write: rework_count++ / fail→ T: HELD(REWORK_LIMIT) / op: `op:<attempt>:actor-turn:<n>` |
| A: READY_TO_MERGE→(MVP 1 경로) | §19.4 human-merge sequence |
| A: READY_TO_MERGE→MERGING (MVP 2) | trigger: policy auto_merge=true + §14.5 전제 충족 / pre: Gate precondition 전체(G1–G5, §14.4) / side: merge intent INTENT / fail→ T: HELD(REPOSITORY_CONFLICT) — fail-closed / op: `op:<attempt>:merge:<candidate_sha>` |
| A: MERGING→MERGED + T: ACTIVE→COMPLETED | trigger: ff-only 성공 + HEAD 재확인(RepositoryAdapter) / write: idempotency DONE, task COMPLETED, projection update(best-effort) / fail→ (HEAD 불일치) RECOVERY_CONFLICT→PAUSED_SAFELY |
| child A: AUDITING→SUCCEEDED + T: ACTIVE→COMPLETED (MVP 3 foundation) | trigger: §19.5.2 frozen `RESUME_PARENT` terminal-success predicate / pre: exact verification PASS + settled AUDIT_PASS + no blocker/drift/recovery conflict, all bound to child Attempt/candidate/Task Contract / side: repository mutation 없음 / write: Attempt+Task terminal states / fail→ existing rework/HELD/recovery semantics, `SUCCEEDED` 미기록 |
| parent T: SUSPENDED→ACTIVE (MVP 3 normal resume) | trigger: §19.5.3 eligibility를 Platform Coordinator가 authoritative rows에서 derive / pre: exact successful child relation + suspension cause/ref + parent continuation binding current + no blocker/drift/recovery conflict / side: 없음 / write: parent state + transition; parent Attempt state/Contract 불변 / fail→ SUSPENDED 유지 또는 §22의 existing HELD/PAUSED path |
| A: (drift)→INVALIDATED | trigger: §11 `INVALIDATE_AT_BOUNDARY` 또는 명시 결정 / write: attempt terminal(reason `CONTRACT_DRIFT`) + `REATTEMPT_DECISION` + T: HELD(`BLOCKED_BY_DECISION:<id>`) — M1-12 |
| T: HELD→(재개/재진입) | Human Gate는 §17.3, 나머지 category는 §17.4의 exact origin×option mapping과 fresh guard만 사용한다. successful transition ref만 `resolution.applied_transition_ref`에 기록한다. mapping 없는 자동 재개 없음 |
| T: any→FAILED | 회복 불가 오류. FAILED는 §24 taxonomy code를 반드시 동반 |
| batch/run→PAUSED_SAFELY | §52 circuit breaker 조건 (task 투영) |

T: DEFERRED — Supervisor DEFER_TASK proposal 검증 통과 시 SELECTED 이전 상태에서만 진입.

F materialisation은 Task/Attempt transition이 아니다. snapshot/publish/round-trip 뒤 child는 DISCOVERED,
parent는 원래 상태다. `ChildMaterializationBindingV1`이 있는 child는 E 외의 admission trigger를 받을 수 없다.

### 19.3a Commit-time durable admission guard (M0-30)

§9.2e V11과 이 guard는 **역할이 다르다**: V11은 Proposal validation, 이것은 commit 직전의
TOCTOU/durable-state recheck다. duplicate policy authority가 아니라 같은 정책의 마지막 방어선이며,
Supervisor turn·human approval 지연으로 validation과 commit 사이에 세계가 바뀔 수 있기 때문에 필요하다.

`DISCOVERED→SELECTED`와 human-gate `HELD→SELECTED` transaction **안에서**, 현재 durable fact로 다시:

```text
batch.admission_closed == false
admitted_task_count  <  batch_policy.max_tasks
active_task_count    <  batch_policy.concurrency
선택된 pipeline에 ACTOR가 있으면
  active_writable_candidate_count < 1
hard_dependencies_clear == true          # §8.4a, Coordinator가 공급한 typed boolean
```

materialisation relation guard를 같은 transaction에서 추가한다:

```text
A START_TASK:
  task.materialization_binding_json == null

E START_SUBFLOW:
  binding == null                         # pre-existing child, D22 path
  OR
  binding.parent_task_key == E.parent.task_key
  AND fresh child.definition_hash == binding.child_definition_hash
  AND referenced materialization snapshot/binding exact equality
```

A가 bound child를 top-level로 admit하거나 E가 다른 parent/body로 consume하면 row/state/count 변화 0이며
§9.2g reason으로 reject한다. successful E만 D22의 `parent_task_key`를 binding과 같은 parent로 기록한다.

세 count는 §9.2e의 durable projection(§19.3c) 그대로이고, `batch_policy`는
`batch.compiled_profile_hash`가 가리키는 immutable Compiled Profile에서 읽는다.

**SelectionBindingV1 (M1-7).** admission이 검증한 **selection basis**를 durable하게 남긴다. logical
contract는 exact 3 field이며 unknown field는 reject다:

```text
SelectionBindingV1 {
  task_version:         <non-empty string>
  task_definition_hash: sha256:<lowercase-hex>
  base_head:            <non-empty repository commit identity>
}
```

세 값의 authority는 **Model Proposal body가 아니다.** `DISCOVERED→SELECTED` commit 직전에 V3/V8을
통과시킨 authoritative fact 그 자체다:

```text
task_version          ← normalized fresh TaskSource.get_task(task_ref).version
task_definition_hash  ← 같은 하나의 normalized TaskDefinition 관측의 definition_hash
base_head             ← fresh RepositoryAdapter canonical HEAD fact
```

`Proposal.expected`와 equality를 통과했으므로 값은 같지만, durable binding의 의미는 "Model claim
snapshot"이 아니라 **Platform-validated selection basis**다 — 이것을 `Proposal.expected snapshot`이라고
부르지 않으며, Proposal은 여전히 hash artifact가 아니다(§9.1). `task_version`과 `task_definition_hash`는
**반드시 같은 관측**에서 오고, `body_copy`는 이 단계에서 binding에 넣지 않는다(activation이 동일 hash를
산출하는 fresh body를 쓴다, §10.1). generic extension map도, 별도 envelope/hash artifact도 만들지 않는다.

**Activation equality gate (M1-7).** `SELECTED→ACTIVE` 시작 시 Coordinator는 fresh
`TaskSource.get_task(task_ref)`와 `RepositoryAdapter.snapshot_canonical()`을 읽는다. fresh read는 binding을
**대체하지 않고 비교 대상**이다:

```text
fresh_task.version           == selection_binding.task_version
fresh_task.definition_hash   == selection_binding.task_definition_hash
fresh_repository.canonical_head == selection_binding.base_head
```

셋 모두 exact equality일 때만 §12.7 finalization으로 진행한다. 하나라도 불일치면 **Contract build를
시작하지 않는다** — 새 TaskDefinition body를 옛 selection에 silent하게 붙이지 않고, activation-time fresh
HEAD를 새 base로 자동 채택하지도 않는다(silent contract rebasing 금지, §11.3). 이때
`task_contract_snapshot` / `capability_grant` / `task_attempt` / 이 activation이 만들었을 blob은
**하나도 생성되지 않는다**: staleness 판정은 반드시 contract build **이전**에 일어난다.

**Reselection guard (M1-7).** `HELD(SELECTION_STALE)→SELECTED` transaction은 initial admission과 **다른**
guard를 쓴다:

```text
task는 정확히 HELD(SELECTION_STALE) + Attempt 부재 + admitted_at != null
active_task_count < batch_policy.concurrency
선택된 pipeline에 ACTOR가 있으면 active_writable_candidate_count < 1
hard_dependencies_clear == true                      # §8.4a, fresh 재계산

다시 소비하지 않는 것:
  admitted_task_count / max_tasks       # 이 task는 이미 admitted slot을 소비했다
  batch.admission_closed                 # 새 admission의 차단이지 진행 차단이 아니다
```

`admitted_at`은 최초 admission 값 그대로 유지되고 `admitted_task_count`는 증가하지 않으며
`batch.admission_closed`도 변경되지 않는다 — 같은 task를 몇 번 reselection해도 batch slot을 추가로
소비하지 않는다(§9.2e의 monotonic marker 의미 보존). 다른 HELD reason에서 `START_TASK`를 reselection
escape hatch로 쓰지 않는다.

**Selection projection (M1-6).** 두 transition이 성공하면 validated Proposal의 네 selection field와 함께
`repository_scope_id`와 `selection_binding_json`(M1-7)이 같은 transaction에서 기록된다 — 하나의 단위이며
부분 기록은 금지다. 이는 initial `DISCOVERED→SELECTED`, human-gate `HELD→SELECTED` initial admission,
그리고 `HELD(SELECTION_STALE)→SELECTED` reselection 세 경로 모두에 동일하게 적용된다(reselection은
`admitted_at`만 유지하고 나머지를 새 validated 값으로 교체한다). SELECTED 이후 이 값의 silent 변경은 금지된다(§19.3 selection re-write 금지와 동일 규칙): scope를
바꾸려면 새 selection이 필요하고, 이미 ACTIVE인 Attempt는 Task Contract에 동결된 resolved scope를 계속 쓴다.

`hard_dependencies_clear`(M1-5)는 count와 성격이 다르다: durable row에서 읽히는 값이 아니라
Coordinator가 §8.4a 규칙으로 계산해 transition에 넘기는 **typed boolean fact**다. B8은 그것을 소비만
하며 TaskSource를 호출하지 않는다(§19.3b). `false`면 두 transition 모두 일어나지 않는다 — human gate
경로에서도 마찬가지이며, 사람 approval은 dependency guard를 bypass하지 않는다(§17.3).

**admission close (M0-30).** 새 task admission은 `admission_closed == true` **또는**
`admitted_task_count >= max_tasks`이면 닫힌다. `max_tasks`에 도달시키는 selection transaction은 그
selection을 성공시킨 뒤 같은 transaction에서 `admission_closed = true`를 함께 기록한다. 검증된
`CLOSE_BATCH` Proposal도 `admission_closed = true`를 기록하며, 이는 **진행 중 task를 강제 종료하지
않는다**. TaskSource discovery가 소진되어 더 이상 안전한 task가 없으면 Coordinator가 `CLOSE_BATCH`
Proposal을 제출해 같은 경로로 닫는다 — 따라서 별도 `discovery_exhausted` durable boolean을 만들지 않는다.

B8은 V8/V10의 external fact를 **직접 재계산하지 않는다**. 그것은 §17.3의 post-gate 경로와 Coordinator의
fresh input assembly가 담당하며, **authoritative owner에게 질의하는 production assembly는 MVP 1
integration**이다(§5.6a). MVP 0에서는 caller/fixture가 공급한다.

### 19.3b Batch 8 state-machine 범위 (M0-32)

B8은 §19.1/§19.2의 **state vocabulary 전부와 §19.3의 generic transition guard 전부**를 구현하되,
external action 자체는 실행하지 않는다. Repository/Runtime/Workflow/Verification/Audit precondition은
**Coordinator가 공급하는 typed authoritative fact를 입력으로** 평가한다 — MVP 0에서는 caller/fixture가,
MVP 1부터는 Coordinator가 §22.1 authoritative owner에서 관측해 조립한다. 따라서 B8 테스트는 deterministic synthetic
fact만으로 `READY → IMPLEMENTING → VERIFYING → AUDITING → READY_TO_MERGE → …` generic lifecycle을 왕복
검증할 수 있다(MVP 0 A1/A4).

허용되는 seam은 transition별 explicit typed command/guard 함수뿐이다. 다음은 만들지 않는다: generic
event sourcing engine, workflow DSL, transition registry framework, statechart framework, command bus,
event bus, generic approval framework.

### 19.3c V11 durable projection (M0-30)

§9.2e의 세 count는 다음 durable query로 정의된다. 별도 counter column도, hidden active flag도 만들지
않는다.

```text
admitted_task_count
  = COUNT(task WHERE batch_id = ? AND admitted_at IS NOT NULL)
    # admitted_at은 SELECTED를 최소 1회 통과한 단조 marker이며 이후 COMPLETED/HELD/FAILED가 되어도
    # 지우지 않는다. task row 존재만으로는 셀 수 없다 — DISCOVERED row도 durable하기 때문이다.

active_task_count
  = COUNT(task WHERE batch_id = ? AND platform_state = 'ACTIVE')
    # 모든 non-terminal attempt를 세지 않는다. HELD + non-terminal attempt(§19.4 human merge,
    # §11.1 HOLD_AT_BOUNDARY, AUDIT HUMAN_REQUIRED)는 정상 상태이고, Spec §48 Hold-and-Continue가
    # 그 상황에서도 독립 task 진행을 허용하므로 execution concurrency slot을 소비하지 않는다.

active_writable_candidate_count
  = COUNT(task WHERE batch_id = ?
                 AND platform_state = 'ACTIVE'
                 AND 선택된 pipeline.steps 에 ACTOR 포함
                 AND current non-terminal attempt.state ∈ {READY, IMPLEMENTING, REWORKING})
    # READY는 Actor 실행 전 writable slot 예약으로 센다.
    # VERIFYING / AUDITING / READY_TO_MERGE / APPROVED_FOR_MANUAL_MERGE / MERGING 은 소비하지 않는다.
    # HELD task는 포함하지 않는다 — HELD candidate와 새 task 사이의 repository/dependency 충돌은
    # Coordinator의 independent-task safety 판정(§20, Spec §48)이 별도로 처리한다.
```

MVP 0 v1은 Project Profile당 canonical repository가 하나(§7.1a `repository` 단수)이므로 "동일 canonical
repository" scope는 해당 project/run의 repository scope와 동일하다.

### 19.3d Receipt 검증은 Manifest 조건부다 (§12.6 정합)

종전 §19.3 문구는 `READY→IMPLEMENTING`의 precondition을 "spawn 후 CapabilityEnforcementReceipt가 grant와
정합"이라고 **무조건**처럼 적었다. 그러나 §12.6은 `receipt_supported=false`를 valid Backend Capability
Manifest state로 명시한다. §12.6이 authoritative이므로 §19.3을 아래로 좁게 정합화한다 — 새 state·reason·
result type을 만들지 않는다.

```text
Runtime Manifest.receipt_supported == true
  성공한 spawn 결과는 receipt를 반드시 포함한다
  receipt.session_handle == RuntimeSpawnResult.session_handle
  receipt가 Grant/Policy와 정합해야 한다
  불일치/부재 → T: HELD(CAPABILITY_BOUNDARY_CHANGED), send_turn 미실행
  receipt는 durable하게 기록된다

Runtime Manifest.receipt_supported == false
  성공한 spawn 결과는 receipt를 포함하지 않아야 한다
  receipt를 요구하는 Policy는 이미 spawn 이전 V10에서 거부되었어야 한다(§9.2d)
  receipt row를 durable하게 기록하지 않는다
  receipt 검증은 N/A
```

**dummy receipt 금지.** `receipt_supported=false` backend에서 requested map을 applied로 복사하거나
설정 의도를 적용 사실로 기록해 receipt를 합성하지 않는다(§12.6, §13 관측 원칙). receipt 부재는
RuntimeAdapter 사용 불가를 뜻하지 않는다 — 고신뢰 Policy가 receipt를 요구하면 V10이 spawn **이전에**
막는 기존 semantics가 그대로 그 역할을 한다.

### 19.3e READY→IMPLEMENTING external operation ordering (M1-8)

**MVP 3 pending-materialized-child dispatch gate (#59).** parent Attempt가 READY이거나 새 Actor/rework turn을
보내려는 시점에, 같은 parent task key의 non-FAILED materialisation snapshot이 아직 admitted되지 않은 child를
가리키면 phase가 INTENT/COMMITTED_NOT_OBSERVED/OBSERVED 어느 것이든 Coordinator는 Actor external INTENT를
만들지 않는다. 앞의 두 phase는 §21/§22 reconcile을 먼저 수행하고 Supervisor에게 존재하지 않는 task_ref를
고르게 하지 않는다. OBSERVED가 하나 이상이면 parent/Attempt state를 그대로 두고
`SupervisorDecisionContextV2` turn을 요청해 E 선택을 받는다. Supervisor가 child를 선택하며 Coordinator가
priority를 추론하지 않는다. child가 여러 개면 D22의 one-current-child 규칙대로 하나씩 admit/complete/resume한
뒤 다음 turn에서 다시 선택한다. pending operation/child가 0일 때만 아래 Actor ordering으로 진행한다. 이
gate는 새 state/cursor/scheduler가 아니라 existing snapshot/idempotency/task binding의 commit-time predicate다.

세 external operation은 서로 다른 crash window를 가지므로 **각자의 `op_key`와 INTENT/DONE**을 갖는다.
하나의 INTENT가 셋을 덮는다고 가정하지 않는다. adapter 호출은 **SQLite transaction 밖**에서 수행한다.

```text
Attempt READY

0  RA-4 backend preflight (§30.2)
     BLOCKED → Attempt READY 유지 / Task ACTIVE 유지
               workspace INTENT 0 · workspace side effect 0 · spawn INTENT 0 · turn INTENT 0
               새 HELD reason 없음, POLICY_BACKEND_INCOMPATIBLE로 매핑하지 않음(V10 mismatch가 아니다)
               PendingHumanDecision 없음, retry counter/backoff/circuit breaker 없음
               다음 Coordinator invocation이 read-only preflight를 다시 평가한다

1  TX { guard(READY/contract/grant/현재 fact) ; idempotency(op:<attempt>:workspace, INTENT) } COMMIT
2  RepositoryAdapter.create_feature_workspace({ base_head, op_key })          # §14.3
3  TX { workspace ref → adapter_metadata ; workspace op DONE(+result) } COMMIT

4  TX { idempotency(op:<attempt>:actor-spawn, INTENT) } COMMIT
5  RuntimeAdapter.spawn_session({op_key}, …)                                   # §13
6  TX { RuntimeSessionHandle → adapter_metadata ; receipt는 §19.3d 조건에서만 ; spawn DONE } COMMIT

7  TX { idempotency(op:<attempt>:actor-turn:1, INTENT) } COMMIT
8  RuntimeAdapter.send_turn({op_key}, session_handle, instruction)

9a TX { RuntimeTurnHandle → adapter_metadata ; turn DONE ; A: READY→IMPLEMENTING ; log } COMMIT
     — turn DONE과 전이를 **하나의 transaction**으로 묶어 T4 window를 제거한다
9b step 8 accepted 이후 9a durable commit 이전 crash
     → 재시작 시 turn INTENT만 존재, 효과 존재/부재 판정 불가
     → **재호출 금지**, A: HELD(RECOVERY_CONFLICT)
```

**RA-4 preflight가 workspace보다 앞인 이유.** RA-4는 Runtime readiness 검사지만 B6의 workspace는 Actor
Runtime 실행을 위해서만 만드는 resource다. Runtime이 이미 BLOCKED임을 알면서 고아 worktree를 만들 이유가
없으므로 이 sequence에 한해 preflight를 첫 단계로 둔다 — 모든 Repository operation의 global rule이 아니다.

**crash window별 최종 semantics.**

```text
W1 INTENT → 호출 전 crash        same-op 재호출 허용
W2 생성 성공 → persist 전 crash   same op_key + same base_head로 reacquire, 두 번째 worktree 금지
W3 result durable → DONE 전       존재·binding 확인 후 DONE 승격
W4 DONE → crash                   저장된 result 재사용, adapter 재호출 불필요

S1 INTENT → 호출 전 crash        same-op 재호출 허용
S2 spawn 성공 → handle persist 전 same op_key로 동일 logical session reacquire (§13)
S3 handle durable → DONE 전       authoritative session 관측 후 DONE
S4 DONE → crash                   저장된 handle 재사용

T1 INTENT → 호출 전 crash        재시작 후의 durable state는 T2와 구별되지 않는다(둘 다 turn
                                  INTENT만 존재). 따라서 §21의 generic rule이 그대로 적용된다:
                                  RuntimeAdapter가 효과 **부재**를 authoritative하게 증명할 때에만
                                  same op_key 재호출이 허용된다. Backend v1은 same-requestId dedup도
                                  durable requestId→turn lookup도 제공하지 않으므로(§13) 그 증명이
                                  불가능하고, 실제 semantics는 T2와 동일하다 —
                                  **재시도 금지**, A: HELD(RECOVERY_CONFLICT).
                                  이는 generic contract를 "INTENT-only는 항상 conflict"로 바꾸는 것이
                                  아니다. absence를 authoritative하게 관측하는 RuntimeAdapter가
                                  생기면 §21대로 재호출이 다시 허용된다.
T2 accepted → persist 전 crash    현재 backend는 dedup도 재획득도 제공하지 않는다(§13)
                                  → **재시도 금지**, A: HELD(RECOVERY_CONFLICT)
T3 handle durable → DONE 전       durable ref + 가용한 Runtime 관측으로 §21대로 reconcile,
                                  확인 가능하면 DONE 승격, 불가능하면 동일하게 RECOVERY_CONFLICT (재시도 금지)
T4 turn DONE → 전이 전            9a 결합으로 window 제거
```

**MVP 1 invariant.** RuntimeAdapter가 효과 **부재**를 authoritative하게 증명할 수 있는 경우가 아니면,
첫 호출이 이미 accepted되었을 수 있는 INTENT에 대해 Platform은 `startTurn`을 두 번째로 호출하지 않는다.
따라서 duplicate Actor turn은 **구조적으로 0**이다. `RECOVERY_CONFLICT` 진입 자체로 PendingHumanDecision을
자동 생성하지 않으며(기존 recovery/operator path 사용) MVP 3/4의 unattended recovery policy를 당기지 않는다.

### 19.4 MVP 1 Human Merge semantics (v1.1 신설, M1-14 close-out)

**사람의 APPROVE와 실제 merge 완료를 동일시하지 않는다.** MVP 1에서도 `MERGED` fact의 authority는
RepositoryAdapter다.

```text
A: READY_TO_MERGE
  → PendingHumanDecision(MERGE_APPROVAL) 생성 (task는 HELD(BLOCKED_BY_DECISION), 1회 알림)
  → Human resolution = APPROVE  → §19.4c의 fresh authority 통과 시
                                   A: APPROVED_FOR_MANUAL_MERGE + T: ACTIVE   # 승인 사실만 — MERGED 아님
  → [외부] 사람이 직접 repository merge 수행 (Platform side effect 아님)
  → Coordinator tick: §19.4e의 3-way 관측
  → Human resolution = REJECT → §19.4d
```

- 관측 판정은 전부 RepositoryAdapter fact 기반이며 사람의 "머지했다"는 보고는 **어떤 분기에도 입력되지
  않는다.**
- **경계 (C-11 CLARIFICATION, v1.3):** 이 MVP 1 경로(사람이 외부에서 merge하고 Platform이 관측)는
  IO Foundation의 특수 authority chain — exact candidate hold → exact-A Human approval →
  deterministic finalizer(A→B) → expected-old-head CAS publication — 과 **동일하지 않다.** 후자는
  machine-owned authority step을 포함하는 별도 경로이며, ADP에서의 일반화 여부는 §31의 C-12
  architecture-reopening 후보로만 관리한다. 이후 설명에서 두 경로를 generic "Human merge"로
  축약하지 않는다.
- **§17.3은 `HUMAN_GATE_APPROVAL` 전용이다 (M1-14 확인).** `validateDecisionAfterResolvedHumanGate`는
  `category == HUMAN_GATE_APPROVAL` + 저장된 `gate_proposal`과 입력 Proposal의 동일성을 요구하는데,
  §17.1의 generic 계약상 `MERGE_APPROVAL.gate_proposal`은 **항상 `null`**이다. 따라서 MERGE_APPROVAL
  resolution을 그 경로로 흘리지 않으며, 타입을 맞추려고 §17.3을 generic approval framework로 넓히지도
  않는다. Human Merge는 Proposal authorization이 아니다.

#### 19.4a MERGE_APPROVAL 생성 계약 (M1-14)

```text
category       = MERGE_APPROVAL
subject        = { kind: TASK, task_key }
blocking_scope = TASK_ONLY
question       = Core 소유 deterministic 문장 (attempt / candidate / audit_id를 지목)
options        = [ APPROVE, REJECT ]        # 정확히 이 둘, 이 순서
recommendation = null
gate_proposal  = null
evidence_refs  = [ audit_id ]
created_from   = merge:<attempt_key>:<candidate_sha>
dedup_key      = computeDedupKey(subject, category, created_from)   # §17.1c 그대로
```

- **`evidence_refs = [audit_id]` 하나로 binding이 충분한 이유.** §18.1c의 `audit_record`는 immutable이며
  `attempt_key` / `candidate_commit` / `task_contract_hash` / `verdict`를 **모두** 담는다. 즉 그 한 참조가
  "어느 Attempt의, 어느 candidate를, 어느 계약 아래에서, AUDIT_PASS로 감사한 cycle"을 restart 후에도
  재구성한다. 그 body들을 decision에 복사하지 않는다(§9.1의 "복사본을 두 번째 authority로 만들지 않는다").
- **`created_from`이 candidate를 담는 이유.** `decision_id`는 매 호출마다 caller가 새로 할당하므로 dedup
  identity에 쓸 수 없다. `attempt + candidate`는 durable하고 restart-stable하며, rework로 새 candidate가
  생기면 그것은 다른 merge 질문이다. `audit_id`를 넣지 않는 것도 같은 이유다 — 재시작 후 재할당된다.
- **APPROVE/REJECT 문자열은 §17.2a의 Human Gate와 같지만 교차 인가는 불가능하다.** 인가는 option이 아니라
  `category`로 막힌다(§17.3 step 2). 새 option vocabulary를 만들지 않는다.
- 생성은 §17.2 그대로 **차단 전이와 같은 transaction**이며, 알림은 report outbox 1회 idempotent다.
  Human Merge 전용 notification transport를 만들지 않고, delivery 성공을 durable 생성의 전제로 삼지 않는다.

#### 19.4b MERGE_APPROVAL OPEN validity / STALE basis (M1-14, M1-12 방식)

generic "Attempt가 바뀌면 전부 STALE" 규칙은 금지다. OPEN `MERGE_APPROVAL`은 다음이 **전부** 유지되는
동안 valid하다:

```text
참조된 Attempt row가 존재한다
그 Attempt가 여전히 READY_TO_MERGE다
Attempt.candidate_commit == created_from의 candidate_sha
그 candidate에 대한 AUDIT_PASS audit_record(= evidence_refs[0])가 여전히 존재한다
더 새로운 Attempt가 그 task에 없다
Task가 terminal이 아니다
```

- **canonical HEAD 이동은 이 predicate에 들어가지 않는다 (선택: B).** canonical은 사람이 승인을 고민하는
  동안 정상적으로 움직일 수 있고, 그것만으로 질문이 무의미해지지는 않는다. canonical은 §19.4c의
  **resolution-time merge-boundary 검증**이 단독으로 소유한다 — 하나의 canonical 이동에 두 authority를
  두지 않는다(M1-11 원칙).
- 이 predicate는 이미 관측된 durable fact만 받는 **순수 함수** 하나다. decision-dependency engine도,
  새 durable column도 만들지 않는다.

#### 19.4c APPROVE 적용 계약 — 좁은 진입점 (M1-14)

§17.3을 쓸 수 없으므로 B12는 **하나의 좁은 진입점**을 갖는다(개념적으로 `applyResolvedMergeApproval`).
`GenericApprovalEngine` / `GenericAuthorizationToken` / generic decision interpreter가 아니다.

**(1) 결정 레코드 자체 검증** — §17.3 steps 1–4와 같은 계열이며, 실패는 caller-contract error다
(전이 없음, reason code 없음, fail-closed throw — `resolvedHumanGateAuthorization`의 기존 처리 그대로):

```text
record 존재
status == RESOLVED
category == MERGE_APPROVAL
terminal record_hash != null AND == hashPendingDecision(body)      # §17.1f 재계산
subject == { TASK, 이 task_key }
blocking_scope == TASK_ONLY
resolution.chosen_option ∈ { APPROVE, REJECT }                     # 정확히 §19.4a의 option 집합
```

**(2) fresh authority (지연 승인 대비) — 정확히 이 넷.** V1–V11을 기계적으로 재사용하지 않는다: 저장된
Proposal이 없고 이것은 Proposal 인가가 아니다. `automatic_merge` V10 requirement도 재실행하지 않는다 —
MVP 1은 Platform merge side effect를 수행하지 않으므로 그 operation의 capability를 요구할 근거가 없다.

```text
F1 Attempt identity   store   attempt는 여전히 그 task의 현재 Attempt이고 READY_TO_MERGE이며
                              candidate_commit == created_from의 candidate_sha
F2 audit basis        store   evidence_refs[0]의 audit_record가 존재하고
                              verdict == AUDIT_PASS, attempt_key/candidate_commit 일치
F3 contract binding   store   그 audit_record.task_contract_hash == attempt의 contract snapshot hash
F4 stage-boundary     §11     M1-11 assembler/evaluator를 merge boundary로 1회 실행 (§19.4f)
```

- **Verification Evidence 재평가는 하지 않는다.** Evidence rows는 immutable이고 gate policy는 Attempt에
  동결되어 있으므로 결과가 움직일 수 없다 — 같은 답을 두 번 계산하지 않는다. *정책*이 움직였다면 그것은
  F4의 `capability_requirements` / `verification_profile` target이 이미 소유한다.
- 사람의 승인은 **"수동 merge를 수행해도 좋다"는 허가**일 뿐이다. Git HEAD / verification PASS /
  audit PASS / candidate identity / Task Contract identity / merge 완료 중 **어느 것의 authority도 아니다.**

**(3) 실패 매핑.** 모든 경우 Platform repository side effect = 0, Attempt는 READY_TO_MERGE 유지,
결정은 **RESOLVED로 남고** `applied_transition_ref`는 `null`이다(§19.4g).

```text
F1/F2/F3 불일치        → T: HELD(RECOVERY_CONFLICT)      새 PendingDecision 없음
F4 = HOLD              → M1-11/M1-12 lifecycle 그대로: T: HELD + CONTRACT_DECISION
F4 = INVALIDATE        → A: INVALIDATED(CONTRACT_DRIFT) + REATTEMPT_DECISION
F4 = UNAVAILABLE       → T: HELD(DRIFT_CHECK_UNAVAILABLE)    새 PendingDecision 없음
(1) 검증 실패          → 전이 없음, throw
```

repository/lineage read 실패는 **F4 안에서** `DRIFT_CHECK_UNAVAILABLE`로 수렴한다 — 별도의 "approval
invalid" catch-all을 만들지 않는다.

**(4) endpoint.** 원자적으로:

```text
A: READY_TO_MERGE → APPROVED_FOR_MANUAL_MERGE
T: HELD(BLOCKED_BY_DECISION:<merge decision>) → ACTIVE   (state_reason 제거)
resolution.applied_transition_ref = transition:<seq>
```

APPROVE는 `MERGED` / `MERGING` / repository mutation / merge INTENT /
`prepare_merge` / `commit_merge` 중 **어느 것도 만들지 않는다.**

#### 19.4d REJECT 계약 (M1-14)

sealed guard(`MANUAL_MERGE_REJECTED`)가 이미 `needs_human_decision`을 요구하므로 후속 결정은 선택이
아니라 필수다. M1-12의 cause/blocker 분리를 그대로 적용한다:

```text
인과 fact      MERGE_REJECTED        # §24에 이미 존재 (M1-14 확인 — 누락 아님)
                                     #   transition 항목에 남는다
A              READY_TO_MERGE 유지   # 사람이 거절했을 뿐, 후보가 무효화된 것은 아니다
T              HELD(BLOCKED_BY_DECISION:<new decision_id>)
후속 결정      category = REATTEMPT_DECISION
               options  = [ REATTEMPT_WITH_NEW_SNAPSHOT, ABANDON ]   # 기존 문자열 그대로
               subject  = { TASK, task_key }, blocking_scope = TASK_ONLY
               evidence_refs = [ audit_id ]
               created_from  = merge-reject:<attempt_key>:<candidate_sha>
```

- **새 category를 만들지 않는다.** `REATTEMPT_DECISION`의 의미는 "새 snapshot으로 다시 하거나 그만두거나"
  이며 merge 거절이 요구하는 질문과 정확히 같다. drift가 여는 것과 `created_from` prefix로 구분된다.
- 그 후속 결정의 validity basis는 drift 쪽과 다르다(§17.2 category별 규칙): 참조된 Attempt가 존재하고
  **여전히 READY_TO_MERGE**이며, 더 새로운 Attempt가 없고, Task가 terminal이 아닌 동안 valid하다.
  (drift 쪽 predicate는 `INVALIDATED`를 요구하므로 재사용하지 않는다.)
- **REJECT만으로 Attempt N+1을 만들지 않는다.** 새 Attempt는 언제나 그 결정의 명시적 적용 결과다(§17.3).

#### 19.4e Post-approval 관측 — 정확한 3-way projection (M1-4, M1-14 확정 순서)

`APPROVED_FOR_MANUAL_MERGE`에서 Coordinator는 §14.3의 기존 두 primitive만 쓴다. 새 Git graph API를
만들지 않는다. 읽기 순서는 다음으로 고정한다:

```text
1  snapshot_canonical()                        # 실패 → 전이 없음 (관측 실패는 사실이 아니다)
2  head == candidate_sha                       → MERGE_OBSERVED
3  head == attempt.base_head                   → 전이 없음, APPROVED_FOR_MANUAL_MERGE 유지
4  verify_lineage(candidate_sha, head)         → true  → MERGE_OBSERVED
5  else                                        → MERGE_MISMATCH_OBSERVED (§19.4f)
```

- **3이 4보다 앞서도 되는가: 그렇다.** candidate는 §19.3에서 `base_head`의 자식임이 확인된 commit이므로
  `head == base_head`이면 candidate가 head의 조상일 수 없다. 즉 4는 반드시 false이고, 값싼 동등 비교를
  먼저 두는 것이 관측 결과를 바꾸지 않는다. 호출 1회가 줄 뿐이다.
- 결과는 전부 §19.3의 **기존 typed `AttemptFact`**에 공급된다 — 새 AttemptFact를 만들지 않는다.
- 어느 분기에도 사람의 "merge 완료" 보고는 입력되지 않는다.

#### 19.4f canonical_head `MERGE_ONLY`의 MVP 1 집행 지점 (M1-14 — 선택 A)

§11.2의 `canonical_head: { action: HOLD_AT_BOUNDARY, boundary: MERGE_ONLY }`는 "merge를 인가하는 전이
직전"에서 집행된다. 자동 경로(MVP 2)에서는 `READY_TO_MERGE → MERGING`이고, **MVP 1 human 경로에서는
`READY_TO_MERGE → APPROVED_FOR_MANUAL_MERGE`**다 — MVP 1은 `MERGING`에 들어가지 않으므로 그곳에서만
집행하면 MERGE_ONLY가 MVP 1에서 한 번도 작동하지 않는다.

```text
B12는 StageBoundary에 READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE를 추가하고,
evaluator의 merge-boundary 집합을 그 둘로 만든다. 다른 boundary 의미는 바뀌지 않는다.
```

- **승인 이후 canonical 이동은 §11이 다시 판정하지 않는다.** `APPROVED_FOR_MANUAL_MERGE` 구간의 canonical
  이동은 §19.4e의 3-way projection이 **단독으로** 소유한다 — 사람이 merge하는 것이 곧 canonical을
  움직이는 일이므로, 같은 이동을 drift로 한 번, 관측으로 또 한 번 해석하면 하나의 사실에 authority가 둘이
  된다. (이전 판의 "APPROVED_FOR_MANUAL_MERGE에서 canonical이 전진하면 §11 drift policy를 그대로 적용"
  문장은 그 이유로 여기서 정정한다.)
- 자동 rebase 없음. `attempt.base_head` 변경 없음.

#### 19.4g `applied_transition_ref` (M1-14)

```text
APPROVE가 실제로 적용됨   → resolution.applied_transition_ref = transition:<seq>
                            (§17.1e의 기존 recordAppliedTransition을 그 transaction 안에서)
RESOLVED이지만 적용 불가  → 결정은 RESOLVED로 유지, applied_transition_ref = null
```

**적용이 실패했다는 이유로 사람의 답을 STALE로 다시 쓰지 않는다.** 둘은 다른 사실이다:

```text
OPEN 결정이 해소 전에 근거를 잃음        → STALE (§17.2, §19.4b)
RESOLVED 결정의 요청을 지금 안전하게 적용할 수 없음 → RESOLVED 유지 + §19.4c(3)의 실패 매핑
```

#### 19.4h MERGE_OBSERVED / HUMAN_MERGE_MISMATCH endpoint (M1-14)

```text
MERGE_OBSERVED            A: APPROVED_FOR_MANUAL_MERGE → MERGED,  T: COMPLETED
                          (§20.2의 batch COMPLETED 조건은 Coordinator가 별도 fact로 평가한다)
```

**`HUMAN_MERGE_MISMATCH`의 HELD vs PAUSED_SAFELY는 결정론이다 (M1-14 신규 확정).** Spec §52는 "canonical
HEAD mismatch"/"lineage corruption"을 safety stop **후보**로 나열할 뿐 판정식을 주지 않았고, 현재 source에도
없다. B12가 "canonical 안전성 의심"을 발명하지 않도록 여기서 닫는다 — 기존 두 primitive만 쓰고 repository
risk engine을 만들지 않는다:

```text
mismatch 분기에서 verify_lineage(attempt.base_head, head) 를 1회 더 호출한다

true   canonical이 이 Attempt의 base에서 정상 전진했고 candidate만 반영되지 않았다
       → 설명 가능한 task-level 충돌
       → T: HELD (인과 fact HUMAN_MERGE_MISMATCH) + PendingDecision
       → batch/run 불변

false  이 Attempt의 base가 canonical history에 더 이상 없다 — Platform이 설명할 수 없는 lineage
       (Spec §52 "lineage corruption" / "last safe checkpoint 불명")
       → 위와 동일한 task-level 처리에 더해 §20의 기존 CIRCUIT_BREAKER fact로 batch → PAUSED_SAFELY

throw  관측 자체 실패 → 전이 없음. mismatch로 분류하지 않는다
```

- `MERGE_MISMATCH_OBSERVED` sealed guard가 `needs_human_decision`을 요구하므로 결정은 필수다. M1-12대로
  인과와 차단을 분리한다: 인과 `HUMAN_MERGE_MISMATCH`는 transition 항목에, 현재 blocker는
  `BLOCKED_BY_DECISION:<id>`. 후속 결정은 `RECOVERY_DECISION`
  (options `[ REATTEMPT_WITH_NEW_SNAPSHOT, ABANDON ]`,
  `created_from = merge-mismatch:<attempt_key>:<candidate_sha>`, `evidence_refs = [ audit_id ]`).
- PAUSED_SAFELY는 §20의 기존 batch-level fact이며 task-level 처리를 대체하지 않는다. 자동 복구 없음.

#### 19.4i MVP 1에 Platform merge side effect는 없다 (M1-14)

```text
prepare_merge / commit_merge   호출 없음
op:<attempt>:merge:<candidate> 생성 없음     # Platform 소유 merge 실행의 identity이며, 외부 사람 행위에 쓰지 않는다
auto_merge                     MVP 1 = NO
```

Platform이 하는 일은 정확히 셋이다: **승인을 기록하고, repository fact를 관측하고, 그 관측으로 lifecycle을
정산한다.**

### 19.5 MVP 3 subflow suspension / completion / normal resume (v1.5 PR #43 amendment)

#### 19.5.1 Atomic START_SUBFLOW admission / suspend authority

[계약, PROSPECTIVE_REQUIREMENT] successful `START_SUBFLOW` admission의 authority chain은 정확히 다음이다:

```text
SubflowSelectionProposalV1
→ V1–V11 + §9.2f explicit parent validation
→ commit-time fresh parent/child/batch/relation revalidation
→ one transaction:
     child DISCOVERED→SELECTED + selection/admission facts + parent_task_key
     parent ACTIVE→SUSPENDED + SUBFLOW_CHILD:<child> reason + transition ref
→ child Task Contract v2 freezes committed relation
→ child Attempt may start
```

transaction은 E의 parent `task_key/attempt_key/task_contract_hash/attempt_state`, child freshness, same
batch/project, parent source state, no blocker/recovery conflict, no cycle/current child relation, dependency,
post-suspension concurrency/writable projection을 current durable rows에서 다시 확인한다. 하나라도 실패하면
child SELECTED, parent SUSPENDED, relation, admission count가 모두 0이다. parent가 HELD/SUSPENDED/terminal이거나
merge stage에 들어간 뒤에는 normal START_SUBFLOW를 적용하지 않는다.

child에 `ChildMaterializationBindingV1`이 있으면 transaction은 §9.2g의 parent/hash/snapshot equality도
다시 확인하고 committed `parent_task_key`를 binding의 exact parent로만 설정한다. binding은 provenance로
남으며 relation commit 뒤에도 clear하지 않는다. binding null인 pre-existing child에는 이 추가 guard가
N/A이고 D22 기존 chain이 그대로다. F snapshot/receipt/Human approval은 이 transaction의 fresh E Proposal,
parent eligibility, dependency, capacity를 대체하지 않는다.

child execution의 첫 external INTENT보다 먼저 parent suspension provenance와 child `parent_task_key`가
durable해야 한다. Task Contract v2 builder는 이 committed relation을 freeze할 뿐 parent를 고르지 않는다.
child contract build/activation이 이후 실패하면 이미 기록된 parent relation을 지우거나 다른 parent로
갈아끼우지 않는다. parent는 SUSPENDED를 유지하고 §22/current PendingDecision 경로가 recovery를 결정한다.

#### 19.5.2 Frozen pipeline terminal-success authority

[계약, PROSPECTIVE_REQUIREMENT] **Task completion = current Attempt가 frozen pipeline의 terminal-success
predicate를 만족함**이다. owner는
`Task Contract.pipeline_id + compiled_profile_hash → immutable Compiled Profile pipeline definition`이며
현재 Project Profile이나 Supervisor 설명으로 terminal을 바꾸지 않는다.

지원되는 두 concrete predicate는 다음뿐이다:

```text
terminal step MERGE_GATE
  existing §14/§19.4 repository authority establishes MERGED
  → Attempt MERGED + Task COMPLETED

terminal step RESUME_PARENT
  current child Task Contract is schema v2 and exact subflow_binding is current
  AND every required Verification Evidence is PASS, binding_valid,
      accepted assurance, exact child candidate + Task Contract hash
  AND settled audit_record is AUDIT_PASS for the same Attempt/candidate/Task Contract
  AND no unresolved PendingDecision, blocker, missing required ref,
      contract drift, recovery conflict, or circuit-breaker condition
  → Attempt AUDITING→SUCCEEDED + child Task ACTIVE→COMPLETED, one transaction
  → repository prepare/commit/merge operation = 0
```

Verification backend `COMPLETED`, Model-reported PASS, TaskSource external CLOSED, canonical merge, issue closure
중 어느 하나도 foundation terminal-success의 대체 authority가 아니다. predicate를 완전히 계산할 수 없으면
`SUCCEEDED`를 만들지 않고 기존 rework/HELD/§22 semantics로 간다. review-only/HUMAN_GATE 등 다른 terminal
shape는 이 amendment가 실행 의미를 발명하지 않으며 typed extension 전까지 fail-closed한다.

#### 19.5.3 RESUME_PARENT eligibility / restart catch-up

[계약, PROSPECTIVE_REQUIREMENT] normal resume eligibility owner는 Supervisor/Model이 아니라 deterministic
Platform lifecycle/Coordinator다:

```text
child Attempt == SUCCEEDED
AND child Task == COMPLETED
AND child Task Contract v2 subflow_binding == current durable relation
AND parent_task_key == bound parent
AND parent Task == SUSPENDED
AND parent.state_reason == SUBFLOW_CHILD:<exact child>
AND parent suspension_transition_ref == bound ref
AND parent current Attempt/Contract/state == frozen continuation binding
AND parent Task/Attempt non-terminal
AND no parent drift, OPEN blocker, recovery conflict, or circuit-breaker conflict
→ RESUME_PARENT eligible
→ parent SUSPENDED→ACTIVE; parent Attempt/Contract/state unchanged
```

child terminal commit과 parent resume는 각각 idempotent transition이다. 같은 Coordinator tick에서 연속 적용할
수 있으나 하나의 거대 transaction일 필요는 없다. 둘 사이 crash가 나면 restart의 §22 reconciliation/
ordinary tick이 child `SUCCEEDED` + durable relation에서 같은 eligibility를 재계산해 정확히 한 번 catch-up한다.
parent identity, child identity, suspension cause/ref, continuation point는 §18.1f + child Contract v2만으로
재구성한다.

authoritative child PASS 뒤에 새 discretionary Supervisor Proposal을 기다리지 않는다. 기존 DecisionType
`RESUME_PARENT`는 exceptional manual/recovery request로만 남는다. 그 Proposal 하나는 transition authority가
아니며 normal predicate를 다시 관측하게 할 수 있을 뿐이다. predicate를 우회해야 하는 exceptional resume는
exact relation에 bind된 RESOLVED `RECOVERY_DECISION` 또는 §7.6 approved operator action과 §17.4 mapping이
먼저 필요하다. child failure/abandon, relation drift, parent continuation mismatch에서는 parent를 자동 resume
하지 않고 SUSPENDED/HELD/PAUSED_SAFELY의 existing recovery authority를 보존한다.

## 20. Batch State Machine

상태: `RUNNING WAITING COMPLETED PAUSED_SAFELY FAILED`.

| 상황 | 처리 |
|---|---|
| HELD task 존재 + independent task 존재 | batch RUNNING 유지. Coordinator가 dependency graph(HARD)·repository writer 제약(writable 동시 1)·policy로 독립 task 선별 → Supervisor에게 다음 제안 요청 turn (Spec §48) |
| §20.1 WAITING 조건 성립 | batch → WAITING. Pending 알림은 이미 발송됨(중복 없음). §20.1의 복귀 조건에서 RUNNING |
| circuit breaker | batch(필요시 run) → PAUSED_SAFELY. 신규 side effect 전면 중지, 진행 중 turn은 cancel_session 시도 후 관측만. **자동 복구 실행 없음** — 사람 resolution 필요 |
| admission closed + 잔여 task 종결 | batch → COMPLETED + summary 1회 (§20.2) |
| restart | §22 reconciliation 후 판정: 설명 가능 → 원상 복귀, 불가 → PAUSED_SAFELY |

`platform_run.status`는 `RUNNING | PAUSED_SAFELY | COMPLETED` 3값이다(§18.1a). **run-level `FAILED`를
v1에 도입하지 않는다** — 설명 불가능하거나 safety-critical한 상태는 Spec §52대로 전부 `PAUSED_SAFELY`로
수렴한다. `COMPLETED`는 모든 batch가 terminal complete된 뒤의 run completion에 쓴다.

**MVP 1 terminal endpoint (M1-15 — 분류 정정).** run completion은 optional이 아니라 **MVP 1 integration
필수**다. 위 문장이 이미 규범이며, MVP 1은 batch가 하나이므로 그 batch가 COMPLETED가 되는 순간 "모든
batch가 terminal complete"가 성립한다. 성공한 단일 Task 경로의 최종 상태는 정확히 넷이다:

```text
Attempt MERGED
Task    COMPLETED
Batch   COMPLETED     + batch-complete summary outbox row 1건 (§20.2)
Run     COMPLETED     platform_run.status
```

기존 `RunStore`의 status surface를 쓴다. `RUN_COMPLETED` AttemptFact도, run transition framework도,
새 run state도, 새 table도 만들지 않는다 — `platform_run.status`가 이미 이 projection을 소유한다.
report delivery 확인은 §21.1대로 같은 tick이거나 이후 caller-driven tick일 수 있으며, **transport 실패가
Batch/Run completion을 되돌리지 않는다.**

### 20.1 WAITING exact condition (M0-30)

WAITING은 "아무 일도 안 하는 중"이라는 generic state가 아니다. §20의 기존 문구 "모든 task가
HUMAN_REQUIRED/HELD"에서 **`HUMAN_REQUIRED`는 TaskState가 아니다**(§16.2 auditor verdict이자 §24
taxonomy code다) — 서술이었을 뿐 판정 조건이 될 수 없다. exact 조건:

```text
batch.status == RUNNING
AND 적어도 하나의 admitted non-terminal task 존재
AND ACTIVE 또는 SELECTED task가 없음
AND 현재 progress를 block하는 OPEN PendingHumanDecision이 존재
AND safe_independent_runnable_exists == false
→ batch WAITING
```

`safe_independent_runnable_exists: boolean`은 **Coordinator가 공급하는 입력**이다 — TaskSource
dependency graph와 repository conflict 관측의 결과이며(Spec §48), B8은 이 fact를 직접 계산하기 위해
Adapter를 호출하지 않는다(§19.3b).

복귀: `safe_independent_runnable_exists == true`가 되거나 BATCH/PROJECT blocking decision이 해소되어
progress가 가능해지면 `WAITING → RUNNING`.

**사람 결정과 무관한 HELD 하나만으로 WAITING을 만들지 않는다** — 예컨대 `HELD(REWORK_LIMIT)` task가
있어도 독립 task가 진행 가능하면 batch는 RUNNING이다.

### 20.2 COMPLETED exact condition (M0-30)

```text
admission is closed        # admission_closed == true  OR  admitted >= max_tasks (§19.3a)
AND count(admitted task WHERE platform_state NOT IN ('COMPLETED','FAILED','DEFERRED')) == 0
→ batch COMPLETED
```

- task terminal set은 `COMPLETED` / `FAILED` / `DEFERRED`다. **`HELD`는 terminal이 아니며**
  `SELECTED`/`ACTIVE`도 아니다(§19.1) — 따라서 HELD task가 남아 있는 batch는 COMPLETED가 되지 않는다.
- `max_tasks` 미도달 + TaskSource 소진은 특례가 아니다: Coordinator가 `CLOSE_BATCH` Proposal로
  admission을 닫은 뒤(§19.3a) **동일한 규칙**을 적용한다.
- `completed_count` durable counter를 만들지 않는다 — 위 query로 결정된다(§18.1a).

### 20.3 FAILED (M0-30)

`FAILED`는 §20 vocabulary 호환을 위해 schema/CHECK에는 남기되(§18.1a), **MVP 0/1에서 automatic
incoming transition을 갖지 않는다.** 기존 failure/safety taxonomy(§24)는 전부 task `HELD` 또는 batch/run
`PAUSED_SAFELY`로 수렴하며, TD 어디에도 batch FAILED 진입 조건이 정의된 적이 없다. 임의 조건을
발명하지 않는다 — 실제로 필요해지면 explicit policy + TD revision으로 도입한다.

## 21. Idempotency TD

- 모든 side effect는 §6.1 `op_key`를 갖고, 수행 직전 `idempotency(op_key, INTENT)`를 transition 트랜잭션에
  선기록한다(I-TD2). 완료 시 DONE+result. `op_key`는 stable idempotency identity이므로 §6.1의
  **D+ positional injectivity composition rule**을 따른다 — 동일 logical operation은 재시작 이후에도
  동일 `op_key`를 만들고(determinism), 서로 다른 operation이 같은 `op_key`로 합쳐지지 않는다(injectivity).
  이 두 속성이 아래 재시작 판정과 `idempotency(op_key PRIMARY KEY)`(§18.1)의 전제다. 재시작 시:
  - INTENT & 외부 효과 확인 가능(예: workflow 존재, merge SHA 일치) → DONE으로 승격(중복 수행 금지).
  - INTENT & 외부 효과 부재 → 재수행 허용.
  - 확인 불가 → 해당 attempt HELD(RECOVERY_CONFLICT) 또는 PAUSED_SAFELY (효과가 canonical mutation류일 때).
- **적용 범위 (M0-32).** I-TD2의 write-ahead INTENT는 **external/canonical side effect**를 위한 것이다.
  `SELECTED→ACTIVE`의 contract persistence처럼 **local SQLite-only atomic transition**에는 적용하지
  않는다 — retry safety가 이미 (a) 하나의 transaction과 (b) immutable PK/hash conflict 검사(§18.1a)로
  보장되기 때문이다. 따라서 §19.3의 `op:<attempt>:contract`는 **local logical operation reference**이며
  idempotency row 생성 의무로 해석하지 않는다. local operation을 위한 별도 idempotency framework를
  만들지 않는다.
- **Child materialisation (#59).** exact external operation identity:

  ```text
  op:<batch_id>:materialize-child:<materialization_id>
  ```

  `materialization_id`는 accepted F Proposal의 Platform-assigned `proposal_id`이며 snapshot PK와 같다.
  INTENT transaction은 immutable `ChildTaskMaterializationSnapshotV1` insert + decision log + idempotency
  INTENT를 함께 기록한다. adapter 호출은 transaction 밖이고 COMMITTED receipt만 DONE `result_json`에
  기록한다. 같은 op_key/different snapshot hash는 conflict다.

  ```text
  CM1 snapshot/INTENT 전 crash             external effect 0
  CM2 INTENT durable, adapter 호출 전       same-op 호출 허용
  CM3 external create, receipt persist 전    reconcile_child_materialization(same op_key)
      NOT_FOUND                             same-op 호출 허용
      COMMITTED(exact receipt)              DONE 승격, duplicate 0
      UNKNOWN                               blind retry 금지, batch PAUSED_SAFELY/recovery
  CM4 DONE, TaskSource round-trip 전 crash   stored exact ref로 fresh read 재개
  CM5 round-trip/task binding committed      두 번째 create/read-materialization 없음
  ```

  definitive no-effect failure만 FAILED로 기록한다. COMMITTED 뒤 body mismatch/visibility 문제를 rollback,
  external delete 또는 새 materialization id로 덮지 않는다. §22가 exact receipt/ref/snapshot을 reconcile한다.
- 대상: Batch start, Task attempt start, **Feature workspace creation(M1-8 — `op:<attempt>:workspace`,
  §14.3의 idempotent create-or-reacquire)**, Actor session spawn, Actor turn,
  **Verification run(M1-9 — `op:<attempt>:verify:<candidate_sha>`를 `VerificationOperationContextV1.op_key`로
  전달; backend requestId 매핑은 adapter 소유, §15.1a)**, Workflow start(durable-jobs
  `(ownerKey, requestId)` — Backend v1에서 LocalVerificationAdapter가 내부적으로 재사용),
  **Auditor 관련 operation (M1-10에서 분리, M1-13에서 candidate 한정)**:

```text
Auditor RuntimeSession spawn    op:<attempt>:audit-spawn
Auditor initial review          op:<attempt>:auditor-turn-1:<candidate_sha>
Auditor unusable-result retry   op:<attempt>:auditor-turn-2:<candidate_sha>
Audit settlement decision       op:<attempt>:audit-decision:<candidate_sha>
```

  **session identity = Attempt-wide, candidate judgement identities = candidate-wide.** rework로
  새 candidate가 생기면 그 candidate의 turn-1/turn-2/decision은 전부 새 identity이며, 이전 cycle의
  `DONE`이 새 cycle을 건너뛰게 만들지 않는다. audit-cycle counter도 audit-cycle table도 없다.
  이어서 PendingHumanDecision(dedup_key UNIQUE), Merge, Report(outbox PK).

- **Auditor launch crash windows (M1-10).** Actor(M1-8)와 동일 규칙이며 Auditor 전용 변형을 두지 않는다.

```text
AT1 auditor-turn INTENT 이전 crash        turn effect 없음
AT2 INTENT durable, send_turn 호출 전      send_turn 1회 호출 가능
AT3 send_turn accepted, handle 미영속       효과 판정 불가 → **재시도 금지**, HELD(RECOVERY_CONFLICT)
AT4 handle 획득, 최종 TX 실패               AT3와 동일한 accepted-불명 사례 → 두 번째 turn 없음

AT3/AT4의 "두 번째 turn 없음"은 **같은 logical turn을 blind retry하지 않는다**는 뜻이다. §16.2의
`auditor-turn-2:<candidate_sha>`와 모순되지 않는다 — 그 재시도는 turn이 authoritative하게 COMPLETED로
관측되고 그 구조 결과가 unusable할 때만 시작되며, AT3/AT4에서는 애초에 authoritative한 결과가 없다.
AT5 handle + DONE + AUDITING commit        다음 batch가 정상 관측

spawn window는 M1-8 그대로: INTENT 후 미호출이면 same-op 재호출, accepted 후 handle 미영속이면
same-op `spawn_session`이 동일 logical session을 재획득, DONE 이후에는 두 번째 session을 만들지 않는다.
```

  ResultChannel slot의 존재/부재는 turn accepted 여부의 증거가 **아니다**. arming이 backend turn 시작
  전에 실패하면 backend turn을 시작하지 않으며(adapter-local precondition 실패), Core는 turn op를 INTENT로
  두고 Attempt를 VERIFYING에 유지한다 — RuntimeTurnHandle을 지어내지 않는다.

- **Verification start crash windows (M1-9).** `start_verification`은 외부 효과를 만들 수 있으므로
  §21의 write-ahead 쌍을 그대로 따른다: `TX{verify op INTENT}` → adapter 호출(트랜잭션 밖) →
  `TX{RunHandle projection + op DONE + candidate_commit + A: VERIFYING}`.

```text
V1 INTENT 이전 crash                  아무 일도 없음
V2 INTENT durable, adapter 호출 전     same-op 재시도 허용
V3 run 시작됨, handle/DONE 이전 crash   same-op start_verification이 동일 논리 run 재획득 → duplicate run 0
V4 run_handle durable, DONE/전이 중단   동일 run 확인 후 DONE 승격 + candidate_commit + VERIFYING
V5 DONE + VERIFYING durable            저장된 결과 재사용, 두 번째 start 없음
```

  `BLOCKED`는 **외부 효과 부재의 authoritative 결과**이므로 durable INTENT가 이미 존재해도 안전하다 —
  row를 0으로 만들려고 INTENT를 지우거나 고쳐 쓰지 않는다. 다음 invocation이 같은 op_key로 재시도한다.
  Backend v1은 V3을 LocalVerificationAdapter → durable-jobs same-owner `(ownerKey, requestId)`
  idempotency로 만족한다.
- **재수행 금지 규칙 (M1-8).** stable `op_key`가 존재한다는 사실이 **backend dedup을 뜻하지 않는다.**
  INTENT의 external effect 존재 여부를 **authoritative backend fact로 판단할 수 없으면 재수행하지 않고**
  위 세 번째 분기(`HELD(RECOVERY_CONFLICT)`)로 간다. adapter가 효과 부재를 authoritative하게 증명할 수
  있을 때만 retry가 허용된다. 이 규칙은 generic하며 특정 backend 구현을 Core rule로 끌어들이지 않는다.
  `RECOVERY_CONFLICT`는 **fail-closed safety state이지 성공적인 자동 복구가 아니다** — MVP 1은 안전한
  crash 처리를 보장하되 모든 Runtime crash window의 무인 복구를 보장하지 않는다(Spec §69의 MVP 4
  full Platform↔Backend reconciliation / Runtime recovery 범위).

### 21.1 Reporting — ReportAdapter contract (M0-5 결정)

Report policy와 payload 생성은 Core, transport는 Adapter다(Spec §59). Core-facing 최소 contract:

```text
deliver({ op_key, channel, payload }) -> ReportDeliveryResult { delivered: true, backend_ref? }
```

- `payload`는 §6의 제한 JSON data model을 만족하는 **Platform-owned generic payload**다. 별도
  `platform/report-event` envelope를 신설하지 않는다. `channel`은 adapter가 해석하는 opaque 문자열이다.
- **`op_key` = delivery idempotency identity** (§6.1 D+ 형태, 단순 metadata가 아니다). 동일
  `op_key + channel + payload`의 재호출은 **하나의 logical notification**으로 취급되어야 하며, 재시작·재시도로
  같은 request가 다시 들어와도 두 번째 알림을 만들지 않는다. 재시도는 항상 **동일 `op_key`**를 사용한다.
- 동일 `op_key`에 **다른 `channel` 또는 `payload`** → `REPORT_IDEMPOTENCY_CONFLICT`(또는 동등한
  deterministic failure)로 **fail-closed**.
- `delivered: false`는 정상 result가 아니다. 전송 성공을 확인할 수 없으면 호출이 **실패**해야 한다.
- **Batch 경계 (M0-33).** `report_outbox` **enqueue**는 §18.2대로 state transition transaction이 소유하고
  이미 구현되어 있다. **delivery·delivery 확인·`sent_at` 기록은 MVP 1 Coordinator integration**이다 —
  Core가 outbox row를 `ReportDeliveryRequest`로 projection해 `deliver`를 호출하는 경로가 그때 생기며,
  미발송분의 restart 회수는 §22.2/Spec §69의 MVP 4 범위다. **MVP 0 Coordinator shell은
  `ReportAdapter.deliver`를 호출하지 않고 `sent_at`을 변경하지 않으며 drain loop을 갖지 않는다** —
  FakeReportAdapter를 쓴다고 해서 production responsibility가 MVP 0으로 당겨지지 않는다.
  §5.10/§21.1의 Core-owned outbox ↔ Adapter transport 경계 자체는 변경하지 않는다.
- **확인된 delivery 이후에만** Core가 outbox `sent_at`을 기록한다. 미확인 delivery는 `sent_at NULL`로
  남아 다음 재개 시 동일 `op_key`로 재발송된다 — 이 구간에서 Spec §58/§71의 중복 알림 금지를 지탱하는 것이
  위 idempotency contract다.
- `backend_ref`는 optional·adapter 소유의 **non-secret** opaque ref다. raw token/credential 등
  secret-bearing identifier는 포함할 수 없다(I-TD7).
- Transport-specific semantics(채널 주소 체계, 재시도 백오프, 메시지 포맷)는 이 contract에 넣지 않는다 —
  production ReportAdapter 구현 세부다.

## 22. Recovery / Reconciliation (Q5 결정)

### 22.1 Authority map (Spec §55 채택, 재확인)

```text
Profile/Policy → Profile Registry        Task external 정의 → TaskSource
Platform transition → Platform Store     Runtime session fact → RuntimeAdapter
Workflow execution fact → WorkflowAdapter   Repository fact → RepositoryAdapter
Verification fact → Verification backend    Human resolution → Platform Decision record
Child decomposition semantics → immutable ChildTaskMaterializationSnapshotV1
Child external creation/ref → ChildTaskMaterializationAdapterV1 receipt
Post-publish child definition → fresh TaskSource observation
Pre-admission parent intent → ChildMaterializationBindingV1
Executable parent relation/suspension → Platform Store §19.5 transaction
Runtime trusted identity 발급/보관 → Runtime(host) / RuntimeAdapter — Platform Core 아님 (I-TD5)
Workflow controller identity → WorkflowControllerHandle 뒤의 backend identity (Core는 handle만)
Model conversation → authority 없음 (항상)
```

### 22.2 절차

```text
startup → active run/batch/attempt 로드
→ unfinished child materialisation 처리 (#59): immutable snapshot마다 stable op_key를 재구성하고
    idempotency INTENT/DONE/FAILED를 §21 CM1–CM5로 판정한다. INTENT는 adapter reconcile이 NOT_FOUND를
    authoritative하게 증명할 때만 same-op 재호출, COMMITTED면 exact receipt로 DONE 승격, UNKNOWN이면
    duplicate를 만들지 않고 batch PAUSED_SAFELY. DONE인데 task binding이 없으면 stored external ref로
    같은 TaskSource fresh round-trip을 다시 수행한다. exact body/hash면 DISCOVERED row+binding을 commit하고,
    mismatch/collision/unreadable source면 parent state를 바꾸지 않은 채 PAUSED_SAFELY. FAILED definitive
    no-effect snapshot만 reservation에서 제외한다.
→ READY attempt의 세 external op 정합 (M1-8): `op:<attempt>:workspace` / `:actor-spawn` /
    `:actor-turn:<n>`의 idempotency row를 §21 규칙으로 각각 판정한다. workspace·spawn은 adapter가
    same-op 재획득으로 효과 존재를 authoritative하게 확인할 수 있으므로 DONE 승격 또는 재수행이
    가능하다. **actor-turn은 현재 backend에서 효과 존재/부재를 확인할 수 없으므로 재수행하지 않고
    HELD(RECOVERY_CONFLICT)로 fail-closed한다**(§19.3e T2/T3). turn 자체는 canonical mutation이 아니므로
    run 전체를 PAUSED_SAFELY로 올리지 않는다.
→ pre-activation task 처리 (M1-7): platform_state == SELECTED 이고 Attempt가 없는 task는
    corruption이 아니라 정상 recoverable state다. durable selection_binding_json + fresh
    TaskSource/Repository fact로 §19.3a equality를 검사한다 — 일치하면 CONSISTENT로 두고 activation을
    이어서 진행할 수 있고, 불일치는 설명 가능한 staleness이므로 PAUSED_SAFELY로 승격하지 않고
    HELD(SELECTION_STALE) transition이 소유한다. HELD(SELECTION_STALE) + Attempt 부재 역시 설명 가능한
    durable state이며, restart가 binding을 최신값으로 자동 rewrite하지 않는다(새 Supervisor Proposal이
    필요하다). 어느 경우에도 옛 Proposal이나 Model conversation은 필요하지 않다.
→ hash 검증: compiled_profile / contract snapshot / grant hash / backend_requirements(manifest hash) /
  CapabilityEnforcementReceipt / adapter version — Store 내부 무결성
→ approval reference 정합: privilege-expanding override의 approval_ref가 여전히 존재·hash 일치(§7.2)
  — 불일치 시 해당 compiled profile 사용 run 전체 PAUSED_SAFELY (위조/유실 의심)
→ capability 재대조: Task Contract의 backend_requirements(시작 시 Manifest)
     vs 현재 Backend Capability Manifest
     vs (session 재사용 시) 최신 CapabilityEnforcementReceipt
  → 현재 backend가 시작 시점보다 약해짐 (예: ENFORCED → AVAILABLE_WITH_REDUCED_ASSURANCE)
     = CAPABILITY_BOUNDARY_CHANGED → 자동 재개 금지 →
       policy(execution_policy.recovery_policy.capability_downgrade: HOLD | PAUSE) 에 따라
       attempt HELD 또는 PAUSED_SAFELY. silent downgrade 재개 경로 없음
→ 각 authority에 fact 질의 (adapter별)
→ attempt별 분류:
   CONSISTENT            → 재개
   EXPLAINABLE           → 대응 transition을 catch-up으로 적용 (decision_log에 RECOVERY 표기)
   UNEXPLAINED           → attempt HELD(RECOVERY_CONFLICT); canonical mutation 관련이면 PAUSED_SAFELY
→ idempotency INTENT 정리 (§21)
→ PendingDecision 정합(근거 소멸 → STALE)
→ report outbox 미발송분 발송 (production recovery behavior이며 MVP 0 dummy 요구가 아니다 — §22.4;
     idempotent — §21.1 ReportAdapter의 op_key contract 사용:
     동일 op_key 재발송은 하나의 logical notification, 확인된 delivery 후에만 sent_at 기록)
```

### 22.4 MVP 0 recovery seam — interface + dummy (M0-34)

§22.2는 **long-term production recovery**를 정의하고 Spec §69는 Platform↔Backend 전면 reconciliation을
**MVP 4**에 둔다. §25가 MVP 0에 요구하는 것은 그에 대한 `interface + dummy` 하나뿐이므로, MVP 0
`recover(run_id)`의 범위를 다음으로 확정한다.

**결과 타입 — 새 enum을 만들지 않는다.** §22.2가 이미 쓰는 3-value 분류를 그대로 typed result로 승격한다:

```text
RecoveryClassification v1 = CONSISTENT | EXPLAINABLE | UNEXPLAINED
```

`NO_ACTION` / `RETRY` / `RECREATE_SESSION` / `HOLD` / `PAUSE` / `RECOVERED` 같은 **별도 recovery-action
enum을 신설하지 않는다.** 상태 변경은 언제나 §19/§20의 B8 transition command가 소유한다.

**MVP 0에서 판정 가능한 것은 Platform 소유 durable integrity뿐이다.** 외부 backend를 질의하지 않으므로
확인 대상은 다음으로 한정되며, 전부 §18.1a store의 기존 load/re-hash semantics를 **재사용**한다 —
별도 recovery hash 구현을 만들지 않는다.

```text
compiled_profile_snapshot integrity
task_contract_snapshot     integrity (존재할 때)
capability_grant           integrity (존재할 때)
pending_human_decision     terminal hash/invariant (존재할 때)
```

**판정 규칙 (MVP 0 local-only).**

```text
required Platform-owned durable artifact가 전부 기존 Store invariant를 만족  → CONSISTENT
missing when required / hash-corrupt / structurally impossible /
referentially inconsistent                                                  → UNEXPLAINED
```

`EXPLAINABLE`은 **MVP 0 dummy가 생성할 필요가 없다.** authoritative external observation이 존재해
Platform projection의 지연을 설명할 수 있게 되는 MVP 1+ 통합에서 사용하며, vocabulary에는 그대로 남는다.

**`NOT_APPLICABLE`을 만들지 않는다.** MVP 0 recovery는 external backend field를 애초에 input contract에
포함하지 않으므로 Runtime/Workflow/Repository/Verification/TaskSource 관측의 부재는 `UNAVAILABLE`도
`UNEXPLAINED`도 아니라 **단순히 범위 밖**이다. MVP 1/MVP 4의 recovery input semantics를 MVP 0 schema로
미리 고정하지 않는다.

**side effect 없음.** MVP 0 `recover(run_id)`는 Runtime spawn, Workflow recover, Repository inspection,
TaskSource query, Verification query, PendingDecision STALE 전이, catch-up transition, outbox delivery,
idempotency INTENT 정리를 **수행하지 않는다** — 전부 §22.2의 later-MVP behavior다. MVP 0 seam은
**classification only**이며, `UNEXPLAINED`를 반환했다고 해서 스스로 `PAUSED_SAFELY` mutation을 하지
않는다. 그 전이는 이후 production Coordinator가 B8 transition command로 수행한다.

**"canonical mutation 관련" 분기 (§22.2)는 MVP 0에서 구현하지 않는다.** MVP 0은 canonical repository
관측 자체를 하지 않으므로 판정 근거가 없다. `canonical_mutation_risk: boolean` 같은 caller-controlled
authority field를 만들지 않으며, 이 분기는 RepositoryAdapter fact가 존재하는 MVP 1+ 통합에서 수행한다.

**authority map은 그대로다.** §22.1의 owner별 질의(TaskSource→Task fact, RuntimeAdapter→Runtime fact,
WorkflowAdapter→Workflow fact, RepositoryAdapter→repository fact, Verification backend→verification
fact, Platform Decision record→human fact)는 향후 Coordinator가 직접 수행한다. generic
`AuthorityRegistry`를 만들지 않고, MVP 0 `recover(run_id)`가 그 future input shape를 미리 노출하지도
않는다.

### 22.3 요구된 conflict 사례별 판정

| Conflict | Authority 판독 | 결과 |
|---|---|---|
| Platform=IMPLEMENTING, Runtime=dead, candidate commit 존재 | session fact: 소멸(RuntimeAdapter). commit fact: 존재+lineage 유효(RepositoryAdapter) | **recover**: turn op는 실패 처리하되, candidate가 lineage/clean을 통과하면 VERIFYING으로 catch-up (검증이 model 무관하게 판정). lineage 불통과 → REWORKING(잔여>0) or HELD. Model conversation은 어떤 판단에도 사용 안 함 |
| Platform=VERIFYING, Workflow=BLOCKED | workflow fact authoritative | **hold**: Evidence 미완으로 간주, `VERIFICATION_FAILED(WORKFLOW_BLOCKED)` → REWORKING 또는 HELD(BLOCKED 사유가 infra성이면 HELD(VERIFICATION_INFRA)) — 반복 시 circuit breaker |
| Platform=READY_TO_MERGE, canonical HEAD advanced | repository fact authoritative | **hold (fail-closed)**: §11 표의 규칙 — merge 금지, HELD + PendingDecision(INVALIDATE→새 attempt or ABANDON). 자동 rebase 없음 |
| PendingHumanDecision=OPEN, TaskSource=CLOSED | external 정의는 TaskSource, Platform transition은 Store | **hold**: decision → STALE(1회 알림), task → HELD(EXTERNAL_CLOSED). 외부 폐쇄가 Platform 상태를 자동 종결하지 않음(§15 분리) |

- Failure behavior: reconcile 중 adapter 질의 실패 → 해당 attempt UNEXPLAINED 취급.
- MVP impact: MVP 1은 위 절차의 단선 구현(attempt 1개)으로 충분; MVP 4에서 전체 폭 적용.

### 22.5 Monitoring / liveness trigger contract (v1.5, prospective production slice + MVP 4 full loop)

[계약, PROSPECTIVE_REQUIREMENT] **Monitoring is observation, not authority. An anomaly is not a lifecycle
fact.** time/staleness/retry-count는 authoritative re-observation을 요청할 수 있을 뿐, 그 자체로 state
transition, failure, retry, external actuation을 승인하지 않는다. I-TD10의 monitoring 적용은 다음
단일 흐름이다:

```text
derived anomaly signal
→ authoritative owner별 re-observation (§22.1)
→ §22.2 CONSISTENT | EXPLAINABLE | UNEXPLAINED reconciliation
→ 기존 §19/§20 transition command 또는 §21 retry-safety semantics
```

Monitor가 직접 `HELD`, `FAILED`, `PAUSED_SAFELY`, retry, session spawn, workflow resume, issue creation을
수행하는 API는 없다. 특히 오래된 `INTENT`도 §21의 "효과 부재를 authoritative하게 증명할 때만 재수행"
조건을 우회하지 않는다.

`AnomalyObservationV1`은 §5.11과 같은 derived read model이며 authority artifact가 아니다:

```text
AnomalyObservationV1 {
  anomaly_kind
  subject_ref
  signal_refs[]                  # Store/adapter 관측 ref + per-field provenance
  observed_at
  observed_window: { from, to }  # point observation이면 from == to
  coverage: COMPLETE | PARTIAL | JOINED_MID_SUBJECT
  coverage_basis_refs[]          # durable/re-readable source와 window coverage 근거
  trigger_config_ref
  recommended_reobservation_scope
}
```

**durable observability / coverage ([계약], v1.5 Operator-evidence amendment).** historical window에 대한
derived signal의 material fact는 durable Store record 또는 subscriber/observer의 존재와 무관하게
authoritative owner에서 재조회 가능한 fact로 재구성되어야 한다. subscriber가 있을 때만 materialize되는
ephemeral stream, UI buffer, process-local callback은 보조 signal일 수 있으나 단독 근거가 될 수 없다. persisted
payload가 encoded/opaque이면 declared producer/decoder contract로 읽기에 성공해야 `readable`이다. raw text
search가 0건이라는 사실은 payload 내부 fact의 부재 증거가 아니다.

- `COMPLETE`는 signal이 요구하는 전체 `observed_window`를 위 source로 재구성할 수 있을 때만 사용한다.
  monitor가 restart/rejoin했어도 durable source로 전 window를 재구성하면 COMPLETE일 수 있다. 재구성하지
  못한 일부 window가 있으면 `PARTIAL`, subject를 처음 본 시점 이전 구간을 보지 못했고 재구성도 못하면
  `JOINED_MID_SUBJECT`다. restart 직후 0개를 관측했다는 이유로 과거 window를 COMPLETE로 만들지 않는다.
- coverage는 confidence score나 lifecycle fact가 아니다. PARTIAL/JOINED observation도 authoritative
  re-observation을 요청할 수 있지만, 완전 관측과 같은 표현으로 보고하거나 과거 반복/absence를 단정하지
  않는다. 이 metadata는 §5.11 provenance/freshness의 window 적용이며 새 monitor state machine을 요구하지
  않는다.

**absence-derived anomaly precondition ([계약]).** `INTENT_UNRESOLVED`, `EXPECTED_SUCCESSOR_MISSING`,
`REQUIRED_REF_MISSING`, `NEXT_OWNER_MISSING` 및 향후 모든 absence-derived signal은 단순히 record/event를 찾지
못했다는 이유만으로 `ABSENT`를 주장하지 않는다. 최소한 다음을 해당 window에 대해 증명해야 한다:

```text
authoritative owner readable
+ source available
+ required observation/materialization path active independent of subscribers
+ declared representation/decoder successfully applied
+ coverage sufficient to have observed presence
→ absence-derived anomaly may be emitted

otherwise → UNKNOWN / UNAVAILABLE / PARTIAL observation
            (re-observation request는 가능, confident ABSENT 주장은 금지)
```

이 일반 규칙이 아래 `REQUIRED_REF_MISSING`의 owner 조회 분리를 포함한다. 각 signal은 자기 presence가
무엇이며 어느 durable/re-readable source에서 보였어야 하는지를 `signal_refs/coverage_basis_refs`로 설명해야
한다. 별도 monitoring store나 event materializer를 만들라는 요구가 아니다.

MVP 4 monitor는 최소 아래 signal을 표현할 수 있어야 한다. 이름은 diagnostic vocabulary이며 state/reason
enum에 추가하지 않는다.

| anomaly_kind | derived signal | re-observation owner |
|---|---|---|
| `DURABLE_PROGRESS_STALE` | non-terminal machine-owned state의 최근 committed transition이 threshold보다 오래됨 | Store + 현재 stage의 adapter |
| `EXTERNAL_COMPLETION_UNPROJECTED` | external operation terminal 관측과 Platform non-terminal projection 불일치 | Runtime/Workflow/Repository/Verification adapter + Store |
| `INTENT_UNRESOLVED` | `idempotency.INTENT`가 오래 미해소 | 해당 external-effect owner + §21 |
| `TERMINAL_DIVERGENCE` | Backend/Repository terminal과 Platform non-terminal 불일치 | 해당 adapter + Store |
| `EXPECTED_SUCCESSOR_MISSING` | committed transition 뒤 pipeline/state-machine이 요구하는 next op의 INTENT/DONE이 없음 | Store/idempotency; 필요 시 해당 adapter |
| `RECOVERY_OR_HOLD_REPEATED` | 같은 subject/reason의 recovery/hold가 설정된 window에서 반복 | decision_log + Store |
| `REQUIRED_REF_MISSING` | active state가 요구하는 contract/grant/evidence/receipt/ref를 세울 수 없음 | 그 artifact authority (§22.1) |
| `NEXT_OWNER_MISSING` | terminal/HELD/blocked record에서 I-TD8 derivation 불가 | Store/PendingDecision projection |

- `EXPECTED_SUCCESSOR_MISSING`의 expected는 새 workflow engine이 아니라 frozen `pipeline_id`, §19/§20
  transition table, §21의 existing op-key grammar에서만 도출한다. Model prose/issue label/UI 상태로
  successor를 발명하지 않는다.
- `REQUIRED_REF_MISSING`은 missing 자체를 곧 실패로 승격하지 않는다. authoritative owner 조회에서
  진짜 ABSENT/corruption인지, projection delay인지, owner unavailable인지 분리한 뒤 §22가 판정한다.
- `HELD/BLOCKED`의 next-owner는 §5.11/I-TD8의 deterministic derivation이다. owner가 없다는 관측은 finding
  후보지만 monitor가 사람/Coordinator를 임의 배정하지 않는다.
- 한 authority 조회 실패는 전체 monitor packet을 폐기하지 않는다. §5.11 partial-result/provenance를
  재사용하고 미관측 값을 stale/fresh로 추정하지 않는다.

**threshold/cadence owner.** `monitor_once(scope, now, trigger_config)`의 invocation cadence, staleness
duration, repetition window/count는 **deployment/operational config**가 소유한다. 이유는 이 값들이 오직
read-only re-observation을 scheduling하기 때문이다; Core invariant에 숫자를 고정하지 않고 Compiled
Profile에 복제하지 않는다. injected clock을 사용하며 wall clock 자체는 lifecycle authority가 아니다.
단 threshold resolver는 deployment-wide 숫자 하나만 가정하지 않고, subject에 해당 identity가 존재하면
최소한 frozen `pipeline_id` + current lifecycle `state` + concrete `stage/operation kind`로 threshold를
해소할 수 있어야 한다. 여러 key에 같은 값을 명시하는 것은 허용하지만 key를 잃고 우연히 같은 global
default를 적용한 것으로 표현하지 않는다. 해소된 key/value/version은 `trigger_config_ref` 또는 signal
provenance에서 확인 가능해야 한다. pipeline/stage가 없는 run/batch signal은 명시적 typed default를 쓸 수
있으며, 새 `WorkflowProfile`은 만들지 않는다.
향후 어떤 threshold가 retry/transition/actuation을 직접 허용하게 하려면 그것은 observation config가
아니라 automation authority이므로 새 `ExecutionPolicy` version + Compiled Profile freeze + explicit TD
개정이 필요하다. 현재 계약에서는 금지한다.

Anomaly는 §5.11 Diagnostic Projection에 표시하거나, authoritative evidence가 확보된 뒤 §5.13 Finding의
`observation_refs`로 승격할 수 있다. 둘 어느 것도 두 번째 state store/monitoring state machine을 만들지
않는다. implementation은 caller-driven read-only scan + 기존 scoped reconciliation entry point면 충분하다.

**implementation timing / seal boundary ([계약]).** Spec §65의 sealed MVP 1 FORMAL acceptance와 기존 구현은
변경하지 않는다. 다만 그 baseline에서 시작하는 **신규 production/live integration이 unattended operation을
claim하기 전**에는 caller-driven read-only `monitor_once`가 최소 `DURABLE_PROGRESS_STALE`,
`INTENT_UNRESOLVED`, `EXTERNAL_COMPLETION_UNPROJECTED`를 위 provenance/coverage 계약으로 표현할 수 있어야
한다. 이는 `PROSPECTIVE_REQUIREMENT`이며 MVP 1 seal의 새 합격조건이나 기존 구현의 retroactive defect가
아니다. 전체 anomaly vocabulary, anomaly→Finding promotion, full-width/background reconciliation과 그
operational config surface는 계속 Spec §69/§27의 MVP 4 범위다.

## 23. Trust / Security Model

| Threat | Authoritative owner | Prevention | Detection | Failure state |
|---|---|---|---|---|
| Model이 identity 위조 | RuntimeAdapter/Runtime (host-managed) | identity는 backend가 부여, envelope `identity_authority=BACKEND`만 수용; tool 인자 identity 미사용 (durable-jobs ownership ENFORCED) | ownership gate 거부 로그 | 요청 거부(OWNER_UNRESOLVED류), 반복 시 circuit breaker |
| Supervisor의 capability 확대 요청 | Capability Broker/Platform | Grant 계산에 Supervisor 입력 없음; Proposal schema에 capability 필드 부재 | V-검증에서 schema 위반 | POLICY_REJECTED |
| Actor의 canonical 직접 수정 | RepositoryAdapter fact + Grant | worktree 격리, canonical 경로 비노출, allowlist(REDUCED/NOT_AUDITED로 정직 선언) | Gate precondition의 canonical clean/HEAD CAS, lineage 검증 | REPOSITORY_CONFLICT → fail-closed; capability violation → PAUSED_SAFELY |
| Auditor write 시도 | Grant + Runtime tool boundary | write/shell tool 미지급 (REDUCED — §12.3 정직 선언) | worktree fingerprint/tracked-clean 검사, diff 재확인 | AUDIT_INVALID → HELD |
| Actor 자기 PASS 주장 | Verification backend | 자기보고=WORKER_REPORTED 고정, gate accepted set에서 배제, durable-jobs `SUFFICIENT_VERIFICATION_LEVELS` 이중 방어 | Evidence producer id 검증 | 해당 Evidence 무효(BINDING_INVALID 아님—단지 불충분) |
| stale candidate 검증 후 다른 commit merge | RepositoryAdapter | G2 3중 SHA 일치 + G3 CAS | Gate precondition 불일치 | REPOSITORY_CONFLICT |
| Task Contract drift | Platform Store(snapshot) | immutable snapshot + §11 boundary 검사 | hash 비교 | INVALIDATED/HELD |
| Backend restart로 duplicate side effect | Platform idempotency + backend dedup | §21 write-ahead INTENT, durable-jobs requestId dedup | INTENT 상태 스캔 | 중복 미수행; 불명 → RECOVERY_CONFLICT |
| TaskSource ↔ Platform divergence | 각자 (분리 저장) | §8.3 물리 분리 | reconcile 대조 | STALE/HELD, 자동 동기화 없음 |
| Supervisor child Proposal이 direct external mutation으로 우회됨 | Platform materialisation boundary | Model credential/adapter call 금지, exact F validation + write-ahead snapshot/INTENT | receipt/TaskSource round-trip/binding 대조 | 거부 또는 TASK_MATERIALIZATION_* / PAUSED_SAFELY |
| materialisation retry가 duplicate external child를 생성 | MaterializationAdapter receipt + idempotency | stable op_key, same-op reconcile, UNKNOWN blind retry 금지 | receipt ref와 TaskSource exact ref/body 대조 | PAUSED_SAFELY |
| 위조/가짜 Approved Override (YAML `approved_by` 자칭) | Platform Human Decision / operator_action record | 권한 확대 override는 approval_ref+approval_hash 필수, Compiler가 존재·scope·value·hash 일치 검증(§7.2). 문자열은 authority 불인정 | compile 시 검증, recovery 시 ref 정합 재검사(§22.2) | COMPILE_ERROR; 사후 불일치 발견 → PAUSED_SAFELY |
| restart 후 capability downgrade (Backend 약화 상태로 재개) | Backend Capability Manifest + contract의 backend_requirements + EnforcementReceipt | Manifest/grant/receipt hash를 계약에 동결(§10.1, §12.6), 재개 전 재대조(§22.2) | 재대조에서 하향 감지 | CAPABILITY_BOUNDARY_CHANGED → HELD 또는 PAUSED_SAFELY, silent 재개 없음 |
| secret runtime identity가 Platform DB에 저장됨 | Runtime 자체 store / secret storage abstraction | I-TD7: schema에 secret 필드 부재, adapter는 opaque handle/redacted fingerprint만 반환 | 저장 계층 정적 검사(스키마) + 저장 전 redaction 검증 | 위반 코드 경로 = 결함으로 취급, 발견 시 PAUSED_SAFELY + 해당 레코드 폐기 |
| Auditor result 제출이 repository write를 요구하게 되는 회귀 | RuntimeAdapter(ResultChannel) | I-TD6: verdict는 RuntimeResultChannel로만 수집, Auditor grant에 write 부재 | worktree tracked-clean/diff 재확인에 result artifact 미검출 | write 시도 흔적 → AUDIT_INVALID → HELD |
| 사람이 APPROVE만 하고 실제 merge와 불일치 (미수행 또는 예상 밖 commit merge) | RepositoryAdapter (canonical fact) | APPROVE ≠ MERGED 분리(§19.4), MERGED는 canonical 관측으로만 확정 | tick마다 canonical HEAD/ancestry 대조 | 미수행 → APPROVED_FOR_MANUAL_MERGE 유지; 예상 밖 commit → HUMAN_MERGE_MISMATCH → HELD/PAUSED_SAFELY |

## 24. Failure Semantics — taxonomy

```text
POLICY_REJECTED                  # validation 거부 (transition 미발생)
POLICY_BACKEND_INCOMPATIBLE      # V10 — spawn 전 거부
CONTRACT_BUILD_ERROR             # SELECTED→READY 실패 → FAILED
RUNTIME_FAILED                   # session/turn 계층 → HELD 또는 recovery
WORKFLOW_FAILED / WORKFLOW_UNOBSERVABLE
VERIFICATION_FAILED / VERIFICATION_INFRA
AUDIT_FIX_REQUIRED → REWORKING
AUDIT_HUMAN_REQUIRED → HELD+PendingDecision
AUDIT_INVALID                    # M1-13 — Auditor structured result 한 번의 unusable 관측
                                 #   (구조 결과 부재 / 잘못된 protocol / malformed / reviewed 불일치).
                                 #   그 candidate에 대해 auditor-turn-2 한 번을 허용하는 retryable fact
AUDIT_UNUSABLE                   # M1-13 — 같은 candidate에 대한 **두 번째** unusable 관측.
                                 #   재시도 소진 → Task HELD. 세 번째 turn도, settle도, record도 없다
AUDIT_GATE_UNAVAILABLE           # M1-13 — valid verdict는 있으나 audit settlement를 authoritative하게
                                 #   확립하지 못함 → Task HELD. FIX_REQUIRED로 재해석하지 않는다
SELECTION_STALE                  # pre-Attempt selection binding이 fresh TaskDefinition/canonical과
                                 #   불일치 → Task HELD (§19.3a M1-7). 자동 HumanDecision 없음
TASK_MATERIALIZATION_FAILED      # definitive no-effect adapter failure; snapshot은 audit로 남고 reservation 해제
TASK_MATERIALIZATION_UNOBSERVABLE # COMMITTED/INTENT 효과 또는 exact TaskSource round-trip을 확립하지 못함
                                  #   duplicate/guess 금지 → batch PAUSED_SAFELY (§8.4b/§21/§22)
TASK_MATERIALIZATION_CONFLICT    # same identity/ref에 다른 snapshot/body/parent binding → PAUSED_SAFELY
MATERIALIZATION_REJECTED:<decision_id> # Human이 exact F publish를 거부; parent HELD, external effect 0
CONTRACT_DRIFT → drift를 **관측해서 확정**한 경우의 인과 fact (§11). M1-12: HOLD/INVALIDATE 어느 쪽이든
                 §17 PendingDecision이 함께 열리므로 Task의 현재 reason은 `BLOCKED_BY_DECISION:<id>`이며,
                 이 code는 transition 항목과 (INVALIDATE의 경우) Attempt reason에 남는다
DRIFT_CHECK_UNAVAILABLE          # M1-11 — drift 존재 여부를 authoritative하게 **판정하지 못함**
                                 #   → 해당 boundary에서 Task HELD, Runtime side effect 0 (§11.3, §11.4).
                                 #   "변경되었음을 증명했다"와 "변경 여부를 알 수 없다"는 다른 사실이므로
                                 #   같은 code로 접지 않는다 — §11.3이 이미 이 이름을 쓰고 있었고
                                 #   taxonomy에 빠져 있던 것을 채운다.
REATTEMPT_REQUIRED:<decision_id> # §17.4 — resolved choice가 old Attempt continuation을 금지하고
                                 #   current-world START_TASK Proposal/새 Contract/Attempt를 요구하는 HELD reason
REATTEMPT_REQUESTED              # §17.4 — 사람의 fresh-snapshot 선택으로 old Attempt를 INVALIDATED한 인과 fact
ABANDONED_BY_DECISION:<decision_id> # §17.4 — exact resolved ABANDON의 terminal Task reason
SUBFLOW_CHILD:<child_task_key>   # §18.1f/§19.5 — parent SUSPENDED의 exact relation/cause
REPOSITORY_CONFLICT → HELD (merge fail-closed)
HUMAN_MERGE_MISMATCH             # 승인과 다른 canonical 변화 관측 → HELD/PAUSED_SAFELY (§19.4)
RECOVERY_CONFLICT → HELD 또는 PAUSED_SAFELY
CAPABILITY_BOUNDARY_UNAVAILABLE  # 실행 중 boundary 상실 → PAUSED_SAFELY
CAPABILITY_BOUNDARY_CHANGED      # spawn/restart 시 downgrade 감지 → HELD 또는 PAUSED_SAFELY (§12.6, §22.2)
PAUSED_SAFELY                    # circuit breaker 종착 — 자동 복구 없음
```

모든 FAILED/HELD 레코드는 taxonomy code + decision_log ref를 동반한다. generic FAILED 단독 사용 금지.

### 24.1 Diagnostic failure attribution (v1.5 — lifecycle code와 분리)

[계약, PROSPECTIVE_REQUIREMENT] 위 taxonomy는 lifecycle/recovery routing용이다. quality/cost 평가에서는
같은 `RUNTIME_FAILED`라도 provider capacity와 model task failure를 분리해야 하므로 다음 read-only
attribution을 함께 보존한다. 이것은 state transition reason을 대체하거나 retry를 승인하지 않는다.

```text
FailureAttributionV1 {
  domain: PROVIDER_AVAILABILITY | PROVIDER_AUTH_CONFIG |
          RUNTIME_INFRASTRUCTURE | WORKFLOW_INFRASTRUCTURE |
          VERIFICATION_INFRASTRUCTURE | REPOSITORY_INFRASTRUCTURE |
          MODEL_TASK | MODEL_PROTOCOL | CONTRACT_OR_AUTHORITY |
          HUMAN_PENDING | UNKNOWN
  detail_code                      # typed backend/adapter code가 있을 때; 없으면 UNKNOWN
  source_ref
  reporter: BACKEND | PLATFORM | VERIFIER | AUDITOR | HUMAN
  retryable: { availability: REPORTED | UNKNOWN, value? }
}
```

- `PROVIDER_AVAILABILITY`는 unavailable/capacity/rate-limit처럼 provider가 task quality를 판정하지 못한
  failure, `PROVIDER_AUTH_CONFIG`는 credential/config/model-access failure다. 둘 다 `MODEL_TASK` denominator에
  넣지 않는다.
- `MODEL_TASK`는 provider/runtime가 정상 completion을 제공했지만 task의 semantic/acceptance 결과가 실패한
  경우, `MODEL_PROTOCOL`은 required structured result malformed/missing 등 protocol failure다. Auditor
  `AUDIT_INVALID/AUDIT_UNUSABLE`은 원인 ref가 있을 때 후자에 귀속할 수 있다.
- `RUNTIME/WORKFLOW/VERIFICATION/REPOSITORY_INFRASTRUCTURE`는 각 authoritative adapter/verification
  observation으로만 판정한다. timeout 하나만 보고 provider 또는 model을 추정하지 않는다.
- `BINDING_CHANGED`는 §13.5의 actual binding change를 나타내는 `RUNTIME_INFRASTRUCTURE` detail code다.
  lifecycle은 기존 `RUNTIME_FAILED`를 유지한다.
- `retryable=true`는 Backend observation일 뿐 실행 authority가 아니다. 실제 retry는 §21 effect-absence,
  idempotency, Execution Policy, state guard를 모두 통과해야 한다.
- 근거가 없으면 `UNKNOWN`이다. dashboard/evaluation 구현이 UNKNOWN을 가장 가까운 known bucket에 강제
  배분하는 것은 금지한다.

## 25. MVP 0 Detailed Design

Module 경계 (단일 repo, 언어 결정은 TD 범위 밖 — 인접성상 TypeScript/Node가 유력하나 구현 시 확정):

```text
core/schemas          # §6 envelope, 전 schema 정의 + canonicalizer + hasher
core/profile          # Registry, Compiler(§7), COMPILE_ERROR 계열
core/tasksource       # generic contract + ProjectDocumentTaskSource adapter
core/decision         # Proposal schema + Validator(V1–V11)
core/capability       # vocabulary, Manifest 로더, Broker(§12)
core/contract         # Task Contract 빌더 + blob store 접근
core/store            # SQLite schema/migrations, 트랜잭션 헬퍼, idempotency, decision_log
core/statemachine     # §19/§20 transition table (데이터로 표현), guards
core/coordinator      # tick loop, observation(§14.2), recovery(§22) — MVP 0에선 인터페이스+더미
                      #   MVP 0 exact seam: §5.6/§5.6a(tick_once·observe) + §22.4(recover)
                      #   timer·production side effect·fact assembly·outbox delivery는 MVP 1
adapters/interfaces   # Runtime/Workflow/Repository/Verification/Report 5 interface
testdoubles/          # Fake 5종 — 최소 deterministic: 스크립트된 응답 큐 + 호출 기록. 제품 기능 없음
```

MVP 0 acceptance → deterministic test 설계 (코드는 작성하지 않음):

```text
A1 OpenClaw 없이 Core policy/state test  → testdoubles만으로 V1–V11·state transition 시나리오 구동
A2 infra-scanner 없이 Core test          → 가상의 profile fixture(다른 classification 명) 사용
A3 ACP identifier 없이 state 표현        → store schema에 backend 필드 부재를 정적 검사 + fixture 검증
A4 READY_ITEM 없이 lifecycle test        → A2 fixture로 전 lifecycle 왕복
A5 Backend capability mismatch 사전 차단  → Manifest fixture를 약화시켜 V10 거부 검증
+ hash 안정성 test(동일 입력·필드 순서 셔플 → 동일 hash), drift policy(§11) 전 action 시나리오,
  idempotency INTENT/DONE 재시작 시나리오, PendingDecision dedup/STALE 시나리오,
  (v1.1) 권한 확대 override의 approval_ref 부재/불일치 → COMPILE_ERROR 시나리오,
  (v1.1) EnforcementReceipt < grant → CAPABILITY_BOUNDARY_CHANGED 시나리오,
  (v1.1) restart 시 Manifest 하향 → 자동 재개 거부 시나리오,
  (v1.1) schema 정적 검사: secret-bearing 필드 부재(I-TD7), Task/Attempt state vocabulary 일치(§19),
  (v1.1) human-merge 관측: APPROVE 후 미머지=MERGED 아님 / 예상 밖 commit=HUMAN_MERGE_MISMATCH
```

## 26. MVP 1 Detailed Design — sequence

각 단계: **호출자 / 선행 durable write / 외부 side effect 시점 / 실패 transition**.

```text
 1 Human→Core: run 개시 (CLI/MCP)          | write: platform_run, batch | fail: 시작 안 함
 2 Core(Profile Compiler): compile          | write: compiled snapshot   | fail: COMPILE_ERROR 보고
 3 Core(TaskSource Coordinator): discover   | write: external_snapshot   | fail: 보고 후 대기
 4 Core: §13.4의 authoritative reads로 exact SupervisorDecisionContextV1 조립 + proposal_id 사전 할당
  → RuntimeAdapter Supervisor turn 요청 ("context의 declared choice에서 선택하고, 같은 turn freshness
  basis와 proposal_id를 명시한 Proposal 제출")
                                            | write: turn op INTENT      | fail: HELD(RUNTIME_FAILED)
 5 Supervisor→MCP Adapter: Proposal 제출
 6 Core(Decision Validator): V1–V11         | write: decision_log        | fail: POLICY_REJECTED → 4 재요청
                                            (HUMAN_GATE_REQUIRED → §17 PendingHumanDecision 경로, §9.2b)
 7 Core(Contract 빌더): snapshot+blob+grant  | write: 동일 트랜잭션        | fail: CONTRACT_BUILD_ERROR
 8 Core: **RA-4 preflight(step 0)** → workspace INTENT → 생성/재획득(RepositoryAdapter — LocalGit
   `git worktree`, §14.3) → spawn INTENT → Actor spawn_session/재획득 → EnforcementReceipt 대조(§12.6,
   §19.3d 조건부) → turn INTENT → send_turn                    — 정확한 순서는 §19.3e
                                            | write: 세 op 각각 INTENT 선행 + DONE, workspace/session/turn ref
                                            | fail: preflight BLOCKED→READY 유지(side effect 0) /
                                                    HELD(RUNTIME_FAILED | CAPABILITY_BOUNDARY_CHANGED |
                                                    RECOVERY_CONFLICT — §19.3e T2/T3)
 9 [외부] Actor 구현 + feature commit; structured 결과는 RuntimeResultChannel에 기록(§13.2)
10 Core: turn terminal 관측 → RepositoryAdapter candidate authority 검증 → verify INTENT →
   VerificationAdapter.start_verification(§15.1a)
     STARTED → RunHandle + candidate_commit + VERIFYING (한 transaction)
     BLOCKED → IMPLEMENTING 유지, 외부 효과 0, 같은 op_key 재시도 가능
                                            | write: verify INTENT 선행   | fail: REWORKING/HELD
11 Core: VerificationAdapter.get_verification_result
     RUNNING   → VERIFYING 유지
     FAILED    → VERIFICATION_INFRA
     COMPLETED → Evidence 수집·envelope 검증·binding·policy 평가
                                            | write: evidence rows       | fail: VERIFICATION_FAILED→REWORKING
12 Core: Evidence 자격 재계산 → §11 drift gate → RA-4 preflight →
   audit-spawn INTENT → spawn_session(AUDITOR, immutable auditor grant, receipt 대조) →
   auditor-turn-1:<candidate_sha> INTENT → send_turn(AuditorReviewContext 포함, §16.2) →
   RuntimeTurnHandle + VERIFYING→AUDITING (한 transaction)
                                            | write: 두 op 각각 INTENT 선행 + DONE, session/turn ref
                                            | fail: preflight BLOCKED→VERIFYING 유지(side effect 0) /
                                                    HELD(RUNTIME_FAILED | CAPABILITY_BOUNDARY_CHANGED |
                                                    RECOVERY_CONFLICT — §21 AT3/AT4)
13 [외부] Auditor verdict envelope를 RuntimeResultChannel에 기록 (repository write 불필요, I-TD6)
14 Core: envelope 검증(16.2, reviewed.* 정확 일치) →
   audit-decision:<candidate_sha> INTENT 선기록 → VerificationAdapter.settle_audit (§16.3 — Core는
   WorkflowHandle/controller를 갖지 않는다) → authoritative SETTLED 확인 후 audit_record commit
                                            | write: INTENT 선행, 확인 후 audit_record | fail: AUDIT_* 분기
15 verdict 분기: FIX_REQUIRED  → REWORKING (≤max_rework)
                              → 8'로 회귀: 동일 Actor session에 `op:<attempt>:actor-turn:<n>` 1회.
                                `<n>`은 durable `attempt.rework_count`에서만 파생한다 (M1-15):

                                  최초 Actor turn        rework_count = 0 → actor-turn:1
                                  REWORK_STARTED 이후    rework_count = c+1 → n = rework_count + 1
                                  동등한 전이 이전 식      n = (이전 rework_count) + 2
                                  ⇒ 첫 rework turn은 actor-turn:2 이며 actor-turn:1이 아니다

                                process-local Actor turn counter를 authority로 쓰지 않는다. 동일
                                immutable Task Contract 기준이며 Profile/Policy/Contract를 갱신하지
                                않고 Attempt N+1도 만들지 않는다.
                HUMAN_REQUIRED → AUDIT_DECISION (§17.1b, M1-13)
                AUDIT_PASS     → READY_TO_MERGE
16 Core: PendingHumanDecision(MERGE_APPROVAL, §19.4a) 생성 + report outbox 1회 알림
                                            | write: pending+outbox 동일 트랜잭션 | task HELD(BLOCKED_BY_DECISION)
17 [외부] Human APPROVE → Core: §19.4c의 record 검증 + F1–F4 fresh authority
     통과 → A: APPROVED_FOR_MANUAL_MERGE + T: ACTIVE + `applied_transition_ref` (MERGED 아님)
     실패 → §19.4c(3)의 매핑 (RECOVERY_CONFLICT / drift lifecycle). 결정은 RESOLVED로 남는다
   → 사람이 직접 merge 수행 (Platform side effect 0)
   REJECT → §19.4d: A는 READY_TO_MERGE 유지, 인과 `MERGE_REJECTED`,
            후속 `REATTEMPT_DECISION`(merge-reject provenance)
18 Core tick: RepositoryAdapter 관측으로만 MERGED 확정(§19.4e — 고정된 3-way 순서)
     candidate 반영 확인 → MERGED + COMPLETED
     예상 밖 commit → HUMAN_MERGE_MISMATCH → T: HELD + `RECOVERY_DECISION`.
       §19.4h의 `verify_lineage(base, head)`로 HELD 단독인지 batch PAUSED_SAFELY 동반인지 결정론적으로 판정
     미머지 → APPROVED_FOR_MANUAL_MERGE 유지
    자동 merge 없음. MVP 2에서만 Gate가 canonical mutation을 수행.
19 Core tick: §20.2 조건 충족 시 batch COMPLETED + summary 1회 (§20.2). run completion은
   모든 batch가 terminal complete된 뒤의 `platform_run.status = COMPLETED`다(§20).
```

**MVP 3 #59 pre-admission extension (Human-authorized Spec amendment).** 기존 MVP 1 sequence를
소급 변경하지 않고 Supervisor step 4–6과 activation/Actor launch 사이에 다음 bounded branch를 추가한다:

```text
F1 Supervisor→MCP: F(child body + explicit DISCOVERED_TASK|ACTIVE_ATTEMPT parent) 제출
F2 Core: V1–V7 + §9.2g capability/reservation/fresh parent validation
   reject/gate → external side effect 0
F3 accepted/resolved → snapshot + materialize op INTENT atomic write
F4 Coordinator→ChildTaskMaterializationAdapter.materialize_child(same op_key)
F5 COMMITTED receipt → idempotency DONE
F6 same TaskSource fresh get_task(ref) exact round-trip
F7 §8.4 DISCOVERED row + materialization binding atomic write

DISCOVERED whole-intent parent였으면:
F8 Supervisor는 ordinary A START_TASK로 parent selection/admission/activation 수행
F9 Actor external turn 전 pending-child gate가 side effect를 막고 새 Supervisor turn 요청

ACTIVE parent 또는 F8 이후:
F10 Supervisor는 observed child에 ordinary E START_SUBFLOW 제출
F11 existing D22: fresh E validation → atomic child admission + parent suspension → child execution
```

F1이 여러 child에 반복돼도 한 Proposal/operation은 child 하나다. selection order는 F9/F10 Supervisor가
결정하고 Coordinator가 graph/priority를 생성하지 않는다. F Proposal에서 E를 합성하거나 external
task_ref/version/hash를 사후 채우지 않는다.

**MVP 1 production integration 책임 (명시).** 위 sequence를 실제로 구동하는 것은 MVP 1 Coordinator이며,
다음 셋은 명시적으로 그 책임이다: (a) Repository/Runtime/Workflow/Verification 관측을 typed
authoritative fact로 만들어 기존 use-case에 공급하는 것, (b) report outbox의 **delivery·확인·`sent_at`
기록**(§21.1 — 미발송분의 restart 회수는 MVP 4), (c) durable Task/Attempt state 기반의 state-driven
dispatch. Coordinator는 use-case를 **호출**할 뿐 그 내부 semantics를 재구현하지 않으며, in-memory
workflow cursor·durable tick cursor·work queue·scheduler table을 만들지 않는다. cadence(§14.2의 기본
30s)는 **deployment invocation**이며 `tick_once()`는 계속 caller-driven single-step deterministic이다.

MVP 1에서 same-Supervisor auto-continuation은 어디에도 없다. Supervisor turn은 항상 4/16의
Coordinator 발신 요청이다.

## 27. MVP 2–4 Extension Points

- **MVP 1 이후 production/live integration operability slice (PROSPECTIVE, sealed MVP 1 acceptance 아님):**
  unattended claim 전 §22.5의 caller-driven read-only `monitor_once` 최소 3-signal과 provenance/coverage를
  제공한다. 이 slice는 observation만 반환하며 Finding promotion, reconciliation scheduling, transition,
  retry, actuation을 소유하지 않는다.
- MVP 2: RepositoryGate 활성(전제 §14.5) — 전략 A 구현 + G1–G5; 전략 B는
  `GitHubProtectedRepositoryAdapter`+`CIValidationAdapter` 추가로 동일 Gate contract 뒤에서 교체.
- MVP 3: §7.1e/§8.1b/§8.4b/§9.2f–g/§10.1a/§18.1f–g/§19.5 AUTO_SUBFLOW — bounded child body +
  explicit parent materialisation Proposal, Platform-only idempotent publish, TaskSource exact round-trip,
  그 뒤 existing explicit-parent admission, atomic child SELECTED+parent SUSPENDED, frozen-pipeline
  `SUCCEEDED`, deterministic normal RESUME_PARENT. `parent_task_key`/`SUSPENDED`/`SUCCEEDED`와 one immutable
  snapshot table/task binding column은 sealed MVP 0/1을 고치지 않는 prospective additive migration이다.
  dynamic pipeline/workflow/model topology synthesis는 포함하지 않는다.
  dependency graph 평가, PendingDecision queue UI 없이 Slack 목록 명령, batch≤N.
- MVP 4: §22 전체 폭 reconciliation + §22.5 read-only monitoring/liveness trigger, circuit breaker 전 조건,
  장기 무인 운용(silent 정상 progress — §21 outbox 정책은 MVP 1부터 동일). operational anomaly는
  authoritative re-observation 없이 lifecycle fact가 되지 않으며, improvement loop는 §5.13의
  Finding→projection→normal admission을 사용한다. §5.12/§13.2a의 measurement와 §5.14 evaluation은
  이 lifecycle 위의 read-only operability contract이고 MVP 4 state machine을 늘리지 않는다. 네 non-merge
  decision category의 safe-held endpoint는 §17.4 exact origin×option application까지 구현해야 full
  convergence를 claim할 수 있다.

## 28. Backend v1 Mapping 요약

| Backend | 재사용 항목 | 잔여 caveat |
|---|---|---|
| OpenClaw | persistent Supervisor session, host-managed identity, **managed ACP session spawn(`AcpRuntime.ensureSession`, §13.1)**, **Managed Platform-Controller Session(§13.3 — WorkflowControllerHandle 매핑)**, RuntimeResultChannel 구현, Slack surface; worktree service는 **선택적** workspace 구현(§14.3) | RA-1(a: safe handle / b: turn start)/RA-2/**RA-3** IMPLEMENTATION GAP; capability enforcement 미감사(§12.3); **receipt_supported=false 실측 확정**(§12.6 — valid state, adapter 사용 불가 아님); **ACPX/core 패치 미배포** — RA-4 preflight(C1–C7)가 Runtime side effect 이전에 fail-closed 검사(`BACKEND CAVEAT`) |
| durable-jobs | workflow store/advance/resume/idempotent start/restart reconcile/audit gate/verification-level 강제/redaction — 호출은 controller handle 경유(§14.1) | `audit_decide` live round-trip DEFERRED(H4) — Platform gate 아님, fail-closed라 안전측; 명시적 service identity API는 **문서상 근거 없음**(§13.3 — 추측 채택 금지); P3-H H3/H8은 미사용 경로라 무관 |
| local Git | `git worktree`/lineage/ff-only primitive (LocalGitRepositoryAdapter가 직접 사용, Runtime 비종속 §14.3) | ff-only merge activity는 신규 구현(Gate 내부) |
| optional GitHub | protected branch/required checks/server merge | 전략 B 채택 시에만 |
| Slack | 보고 채널(frozen route) | Report Outbox 뒤에만 위치 |

## 29. Decisions / ADR Candidates

```text
D1 (Q1) canonical JSON(JCS 부분집합, float 금지) + sha256 envelope hash      → ADR-CANDIDATE
D2 (Q2) SQLite WAL 단일 writer, transition=트랜잭션, write-ahead INTENT      → ADR-CANDIDATE
D3 (Q3, v1.1) RuntimeTurnResult envelope + RuntimeResultChannel(repository 밖, adapter 소유) — I-TD6
D4 (Q4) 12-capability vocabulary, set 기반 enforcement 판정, NOT_YET_AUDITED 불인정 → ADR-CANDIDATE
D5 (Q5) authority map + CONSISTENT/EXPLAINABLE/UNEXPLAINED 3분류, 표 §22.3
D6 (Q6) MVP 2 기본 = Local guarded ff-only (전제 §14.5), 전략 B 정식 대안     → ADR-CANDIDATE
D7 (Q7, v1.1) contract_drift_policy를 Execution Policy로 이동 — 4-action vocabulary,
    silent migration은 policy로도 불가(§11.3)
D8 (Q8) poll 기반 workflow observation, auto-continuation 완전 비의존
D9 (v1.1) Core ≠ trusted identity issuer — workflow start/audit_decide는 WorkflowControllerHandle
    경유(OpenClaw: Managed Platform-Controller Session), Auditor는 무권한, verdict는 Coordinator가 커밋 → ADR-CANDIDATE
D10 Contract Source = content copy(blob) + raw sha256
D11 (v1.1) Backend Capability Manifest hash + grant hash를 Task Contract에 동결(backend_requirements)
    + CapabilityEnforcementReceipt로 requested≠enforced durable 추적, downgrade는 fail-closed
D12 (v1.1) 권한 확대 Approved Override는 human-decision/operator-action 레코드 binding 필수 — 문자열 authority 불인정
D13 (v1.1) Platform store secret 금지(I-TD7) — opaque handle + redacted fingerprint만
D14 (v1.1) TaskState/AttemptState 분리 — INVALIDATED=Attempt, WAITING_DECISION=HELD+reason,
    SUSPENDED=MVP 3 extension; APPROVED_FOR_MANUAL_MERGE로 APPROVE≠MERGED 분리, MERGED 확정은
    RepositoryAdapter 관측만(§19.4)
D15 (v1.1) LocalGitRepositoryAdapter는 표준 git worktree 직접 사용 — workspace 생성의 Runtime 비종속
D16 (v1.2) 문서 규율 — §1.1 층위/규범 표기 계약 + backend 주장 증거 등급(MEASURED/INFERRED/CANDIDATE)
    + I-TD8~I-TD11 (ownerless 상태 금지 / mutation-reach 선언 / 관측≠actuation / presentation≠routing)
    + §31 Seam Register. architecture 재개방 없음, 소급 무효화 없음                → ADR-CANDIDATE
D17 (v1.3) intake batch fold — TRANSFER_KIND 이전 규율(§1.1), I-TD12 승격(좁힌 문구),
    Diagnostic/Measurement Projection 계약(§5.11/§5.12), §19.4 C-11 경계, C-03/C-12는 §31
    reopening 후보로만 등록(채택 아님), §13.1 등급 소급 명시. 재개방/소급 무효화 없음
D18 (v1.4) practitioner hardening — I-TD12 executable predicate + PROSPECTIVE 선언,
    §5.11 partial-result, §5.12 handoffs/interventions·cost provenance·attempt-aggregate,
    §1.1 DesignEvidenceGrade 네임스페이스 분리, applicability map의 main-sync gate 격상,
    문서 계층 경계 guidance. SPEC_FIT=PASS, MAIN_SYNC=CONDITIONAL_GO 조건 A 충족(설계측)
D19 (v1.4 rev.2) main-sync 준비 완료 — §31a Gate-B rev.2(소스 재대조 정정: I-TD9
    PROSPECTIVE/MEASURED, I-TD10 근거 교체, I-TD11 근거 보강, I-TD12 close/호출부 정정),
    §31 gate row RESOLVED, authority provenance 문구를 승격 후에도 참이 되게 교체.
    조건 B 충족 → MAIN_SYNC=GO. D18은 조건 A 시점의 기록으로 소급 수정하지 않는다([원장] 규율)
D20 (v1.5) MVP 4 operability closure — §22.5 monitoring observation≠authority,
    §5.13 evidence-derived Finding≠issue/task authority, §5.12/§13.2a/§24.1 honest measurement source and
    failure attribution, §5.14/§7.1d/§13.5 role-specific evaluation + recommendation-only routing seam.
    ProjectProfile/CompiledProfile v2는 Supervisor profile ref 하나만 additive로 동결하며 v1 seal 불변.
    automatic evidence-based routing/fallback은 미채택 future Execution Policy authority seam.
    IO #23은 observed-need/evidence source일 뿐 mechanism/state topology는 이전하지 않음
D21 (v1.5 Operator-evidence amendment) PR #42 comment 5477209602의 measured operations를 portable
    failure mode로 번역 — durable/re-readable signal + absence/coverage honesty, Finding-derived presentation
    collapse, state/stage-aware threshold resolution, prospective early read-only monitor_once, evaluation input
    completeness, material fail-closed falsification validation. §22.5의 observation≠authority를 강화하며
    Spec 변경/architecture reopening/retroactive seal impact/new monitoring state machine 없음
D22 (v1.5 PR #43 contract-gap amendment) resolution≠application(§17.4 exact origin×option re-entry),
    uniqueness≠relationship authority(§9.2f explicit parent + §19.5 atomic binding), completion≠merge
    (§19.5 frozen pipeline terminal-success + MVP3 SUCCEEDED + deterministic normal RESUME_PARENT).
    existing Proposal/Task Contract/Attempt/decision_log/§22 primitives만 재사용하며 Spec gap, architecture
    reopening, new table, MVP0/MVP1 retroactive seal impact 없음
D23 (v1.5 Issue #60 decision-basis amendment) SupervisorDecisionContextV1 exact projection +
    Platform-allocated proposal_id echo binding + semantic-choice/freshness-echo 분리. 제출 뒤 field completion
    금지, V3/V8 fresh re-observation 유지, Runtime schema constraint는 generation aid only.
    Spec/Backend contract/new store/state machine/MVP0·1 schema·state·validator retroactive seal impact 없음.
    B13 context evidence는 충족 증거가 아니며 #59는 독립 OPEN(당시 기록; 후속 D24 참조).
D24 (v1.5 Issue #59 Human-authorized Spec/TD amendment) Supervisor는 F START_SUBFLOW materialisation
    Proposal로 bounded child TaskDefinitionBodyV1 + explicit DISCOVERED/ACTIVE parent intent를 제안한다.
    Platform만 Compiled Profile v3/Execution Policy/Human Gate/parent/capacity를 검증하고 immutable snapshot +
    write-ahead idempotent ChildTaskMaterializationAdapter publish + exact TaskSource round-trip을 수행한다.
    OBSERVED child만 existing E/D22 admission path로 들어가며 F는 admission/suspension/Task Contract authority가
    아니다. child external identity는 adapter, 이후 definition은 TaskSource, executable relation은 §19.5
    transaction이 소유한다. one immutable table + task binding column은 prospective MVP3 additive state이며
    MVP0/1 seal 비소급. #7 C-03 미채택; dynamic pipeline/workflow/model topology 및 generic planner/graph/DSL 없음.
```

## 30. Remaining Implementation Questions (architecture 아님 — 구현 전 확정)

### 30.1 MVP 0 blocker (architecture decision 아님 — 구현 상세만)

```text
M0-1 (구 R6) 구현 언어/런타임 확정 (D2·adapter 인접성 고려; Core contract 무영향)
M0-2 (구 R5) ProjectDocumentTaskSource parser v1의 문서 포맷 합의 (Profile config 값 — Core 무관)
     — CLOSED: §8.2 `markdown-sections-v1` (heading-anchored + labeled fields).
       외부 Markdown parser dependency 없이 line-oriented scanner로 구현 가능하며,
       config는 exact {paths, parser}로 ready_marker를 제거했다. adapter-local
       implementation detail close-out이며 architecture decision으로 승격하지 않는다.
M0-3 canonicalizer/hasher의 세부 (허용 유니코드 정규화 여부 등 — D1 범위 내 마이크로 결정)
M0-4 generic identifier의 component domain / injective composition rule
     (MVP 0 Batch 1 구현 중 발견 — §6.1이 delimiter만 확정하고 caller-provided component의
      domain도 injective 합성 규칙도 남기지 않아, §18.1 key·§21 idempotency identity의 전제가
      미충족이었다)
     — CLOSED: §6.1 D+ positional injectivity.
       adapter-scoped opaque `external_task_ref`의 domain은 제한하지 않고(§8.1 보존),
       Core/Profile-owned structural boundary component에만 최소 grammar를 부여한다.
       codec·escaping·surrogate 미도입, decoding은 Core 요구 아님.
M0-5 ReportAdapter minimum interface
     (MVP 0 Batch 3 preflight에서 발견 — Spec §64가 MVP 0 산출물로 요구하나 Spec/TD 어디에도
      method/input/result contract가 없었다. 나머지 4개 adapter와 대조)
     — CLOSED: Core-owned outbox projection + op_key-idempotent deliver contract (§5.10, §21.1).
M0-6 WorkflowAdapter status/observe placement
     (§14.1은 status를, §14.2는 observe를 Core contract로 서술해 adapter surface가 모호했다)
     — CLOSED: status(handle) -> WorkflowObservation은 Adapter primitive,
       observe(handle)은 Coordinator-side poll operation (§14.1, §14.2).
M0-7 RuntimeAdapter spawn result / CapabilityEnforcementReceipt delivery
     (Batch 3 재감사에서 발견 — §12.6이 "spawn_session 성공 시 영수증을 반환"을 요구하나
      generic interface에 이를 실을 통로가 없었다)
     — CLOSED: spawn_session(...) -> RuntimeSpawnResult{ session_handle, enforcement_receipt? }.
       presence authority는 Manifest `receipt_supported` 단일 원천이며 UNSUPPORTED value를 두지 않는다.
       별도 receipt query method·spawn outcome framework 미도입 (§12.6, §13.1).
M0-8 WorkflowControllerHandle placement
     (§14.1의 "status/recover도 동일 handle 경유를 기본" 표현이 전달 기전을 정하지 않았고
      resume/cancel의 ownership context는 아예 미정이었다)
     — CLOSED: explicit controller on start/audit_decide;
       나머지 operation은 opaque WorkflowHandle의 adapter-owned controller association으로 해석한다
       (§13.3, §14.1, §16.3). RA-3는 그대로 OPEN.
M0-9  Project Profile v1 schema
      (Spec §6의 top-level 10개 중 7개가 `...` placeholder였고 TD §7.1의 validate(schema v1)에
       대응하는 정의가 없었다)
      — CLOSED: §7.1a `platform/project-profile` v1 — 10 top-level all-required,
        strict wrapper + opaque config, ExecutionDisposition/PipelineStep Core vocabulary 고정,
        authority field는 §7.5로 reject.
M0-10 Execution Policy v1 schema + classification policy path
      (human_gate/verification/capability policy가 `...`뿐이었고, §7.2 rule 2가 참조하는
       classification 명시값의 위치가 문서에 없었다)
      — CLOSED: §7.1b `platform/execution-policy` v1 — 12 top-level all-required,
        `classification_policy` 신설로 P3 해소, RemotePushMode 대문자 canonical,
        capability_policy → capability_requirements 단일화(§11.2 키도 정정).
M0-11 Approved Override scope / privilege ordering / authority binding
      (override 가능 field·privilege ordering·no-op semantics·operator-action 레코드가 미정이었다)
      — CLOSED: §7.1c whitelist(Execution Policy field 한정) + §7.2 rule 5–7
        (no-op = COMPILE_ERROR, 전 whitelist field의 ordering, restrictive=approval 금지 /
        permissive=approval 필수), §7.6 `platform/operator-action` v1 레코드 + §18.1 테이블 등재,
        lookup은 주입형 ApprovalBindingView(새 framework 없음).
M0-12 Compiled Profile v1 schema + merge rules binding
      (envelope schema name·compiled_version 관계·merge_rules_version 포함 여부·effective shape 미정)
      — CLOSED: §7.7 `platform/compiled-profile` v1 — self-referential hash field 금지,
        compiled_version == schema_version == 1, merge_rules_version을 hash body에 bind,
        effective.policy는 완전 해소된 단일 소비 지점.
M0-13 Semantic-set canonical ordering
      (§7.1b/§7.1c가 일부 collection을 order-insensitive로 선언했으나 canonical order를 정의하지 않아
       hash 안정성이 미결이었다 — Batch 4에서 stop-condition으로 발견)
      — CLOSED: schema-declared semantic set에 한해 Unicode code-point 오름차순 정규화(§6),
        대상은 required_decisions / accepted_assurance / capability accepted / overrides items
        (items는 field_path 기준). generic array는 계속 order-sensitive이며 Batch 1 serializer는
        변경하지 않는다. 이는 merge_rules_version 1의 **완성**이므로 version을 올리지 않는다.
M0-14 Backend Capability Manifest v1 schema / component scope
      (Spec §11 예시 어휘가 §12.1/§12.2 canonical vocabulary와 불일치했고, envelope schema name·
       identity·capability map path·omission semantics가 전부 미정이었다)
      — CLOSED: §12.2a `platform/backend-capability-manifest` v1 — 4 component(RUNTIME/WORKFLOW/
        REPOSITORY/VERIFICATION), 공통 5필드 + RUNTIME 전용 receipt_supported·capability_enforcement,
        12 capability 전부 명시(omission 금지), features는 opaque provenance로 policy authority 아님,
        set invariant 위반은 MANIFEST_SET_INVALID, aggregate manifest hash 미도입.
M0-15 CapabilityGrant v1 schema / directional enforcement / CoreExecutionRole
      (grant_hash 대상 envelope 부재 + body 내부 self-reference, requested shape 모순,
       capability polarity 미정, Role vocabulary 부재)
      — CLOSED: §12.5 `platform/capability-grant` v1 — body는 grant_id/role/
        source_runtime_manifest_hash/requested/enforcement 5필드, grant_hash는 envelope hash로 body 밖,
        requested·enforcement 모두 12 key full map, directional rule(requested true→allow,
        false→deny)로 polarity table 없이 결정, CoreExecutionRole = SUPERVISOR|ACTOR|AUDITOR이며
        role_profile_id·runtime_profile과 분리.
M0-16 Capability Broker requested derivation + compatibility
      (§12.4가 산문 예시여서 12 boolean 도출 규칙이 없었다)
      — CLOSED: §12.4 normative baseline(SUPERVISOR 전부 false, ACTOR/AUDITOR 확정,
        remote.feature_push만 policy 파생, remote.create_pr은 authority field 부재로 false),
        authority input은 effective.policy + CoreExecutionRole뿐이고 role config는 확대 불가,
        compatibility는 §12.2의 directional set membership.
M0-17 Task Contract ↔ Grant finalization ordering / Batch boundary
      (Broker input의 Task Contract와 Task Contract body의 grant hash가 순환)
      — CLOSED: §12.7 TaskContractCapabilityView(비-durable builder projection) + 11단계
        finalization order로 `inputs → Grant → final snapshot` 확정. §10.1/§19.3 문구 정정.
        B5는 view type과 Broker까지, Task Contract builder는 B6 — 기존 batch ordering 유지.
M0-18 Runtime application vs Receipt authority + capability hash chain
      (backend_application을 adapter가 채운다는 문구가 immutable Platform grant와 충돌,
       receipt_supported/backend_manifest_hash 의미와 applied 완전성 미정)
      — CLOSED: §12.5에서 backend_application 제거(적용 수단은 §12.6 applied_means가 유일 보고 위치),
        receipt_supported=RUNTIME Manifest field, backend_manifest_hash=RUNTIME Manifest hash,
        applied=12 capability complete map, pure validation 8항목을 assurance ordering 없이 exact
        equality로 규정하고 orchestration은 Coordinator Batch로 분리.
M0-19 Receipt-required policy expressibility
      (§12.6이 "receipt를 요구하는 Policy를 V10에서 거부"라고 서술했으나 ExecutionPolicyV1에 이를
       표현할 field가 없어 deterministic implementation이 불가능했다)
      — CLOSED: MVP 0 v1에는 independent receipt-required policy를 두지 않는다.
        `receipt_supported`는 Runtime spawn-result attestation availability만 의미하고,
        V10은 §12.2 capability compatibility만 평가한다(false 자체는 incompatibility 아님).
        accepted set에서 receipt requirement를 암묵 추론하지 않으며, future receipt requirement는
        explicit policy schema revision으로만 추가한다.
M0-20 TaskDefinition v1 exact shape / hash identity
      — CLOSED: §8.1a — `platform/task-definition` v1, normalized body 정확히 4 field
        (title/description/references/acceptance_notes), body-only envelope hash,
        task_ref·version은 hash body 밖, adapter 제공 hash는 재계산·exact 대조(fail-closed).
M0-21 Task Contract v1 exact body / hash placement / completion_conditions
      — CLOSED: §10.1 — `platform/task-contract` v1, top-level 정확히 12 field,
        self hash를 body 밖으로(§7.7·§12.5 원칙 동일), body_copy = normalized TaskDefinition body,
        completion_conditions = acceptance_notes의 immutable copy(독립 authority 아님),
        storage_ref 제거.
M0-22 Contract Source capture / storage boundary
      — CLOSED: §10.2 — pre-read raw bytes 입력, raw SHA-256, 기존 BlobStore 재사용,
        content_hash가 유일한 blob identity, contract builder에 direct fs 없음,
        caller-owned transaction 안에서 동작.
M0-23 Batch 6 domain persistence boundary
      — CLOSED: §18.1 — B6는 task_contract_snapshot/capability_grant/task/task_attempt migration을
        추가하지 않고 Batch 2 migration도 변경하지 않는다. atomic domain persistence는 Batch 8.
M0-24 TaskSourceV1 callable surface / discovery context
      (Spec §14·TD §8.1이 discover_tasks(context)와 optional update_task_projection(...)만 제시해
       MVP 0 public interface의 context 타입과 projection payload 타입이 미정이었다)
      — CLOSED: TaskSourceV1 required surface는 four read methods.
        TaskDiscoveryContextV1은 caller-supplied `observed_at` 하나만 갖고,
        TaskCandidate.discovered_at이 그 값을 사용한다(정의 hash 무관).
        update_task_projection은 required surface가 아니라 future typed optional extension point이며,
        ProjectDocumentTaskSource v1은 projection capability를 expose하지 않는다.
        any/unknown/opaque projection payload를 발명하지 않는다.
M0-25 ProposalV1 exact variants / expected freshness
      (Spec §18의 "Task version 일치"가 TD V3에 없었고, expected.compiled_profile_hash는 어떤 V step도
       비교하지 않는 unused field였으며, 단일 flat shape가 CLOSE_BATCH에도 task field를 강제했다)
      — CLOSED: §9.1 — Proposal은 non-hashed structured input, four structural variant,
        expected.task_version 추가, V3는 task_version → task_definition_hash → compiled_profile_hash
        순서로 비교하며 TASK_DRIFT / PROFILE_DRIFT로 결정적으로 갈린다. M0-20은 reopen하지 않는다.
M0-26 Decision authorization / Human Gate result
      (V5 "Compiled Profile이 decision을 허용"의 mapping이 0건이었고, §5.4의 결과 3종으로는
       "거부 아닌 gate 분기"를 표현할 수 없었다)
      — CLOSED: §9.2a disposition↔decision 표, allow_auto_subflow는 human gate로 우회 불가,
        PROPOSE_MERGE는 auto_merge와 무관하게 V5 PASS(§19.4 Human Merge 보존),
        §9.2b HOLD_HUMAN routing, 그리고 네 번째 결과 HUMAN_GATE_REQUIRED(§5.4).
M0-27 V8–V10 authoritative input / capability operation mapping
      (§9.2는 validator가 RepositoryAdapter를 호출하는 것처럼 읽혔고 §5.4 input 목록과 충돌했으며,
       V9의 "dry-run"과 decision→operation_id mapping이 정의돼 있지 않았다)
      — CLOSED: §9.2 pure validator + caller 공급 read-model, §9.2c는 Grant 발급 없는
        ACTOR/AUDITOR derivation, §9.2d의 validator-referenced operation은 정확히
        actor_execution / auditor_execution / automatic_merge이며 decision→operation mapping 고정,
        미선언 requirement는 empty set = compatible, auto_merge=false의 Human Merge를 막지 않는다.
M0-28 V11 read-model / result reason vocabulary / precedence
      (V11이 비교할 상태 field가 없었고 POLICY_REJECTED reason이 TASK_DRIFT 하나뿐이었다)
      — CLOSED: §9.2e DecisionValidationBatchView exact 3 counts와 max_tasks/concurrency/writable
        세 규칙, lifecycle legality는 §19.3/§20 유지, MVP0 seal 당시 §9.2의 DecisionRejectReason exact
        12종과 V1→V11 first-failure precedence. 후속 D22/D24 prospective vocabulary는 이 historical
        close-out을 소급 rewrite하지 않는다.
M0-29 Durable domain schema / migration
      (§18.1이 "…등 domain table"로 열려 있었고 컬럼·PK·FK·CHECK·nullability가 전무했으며,
       §5.2가 요구하는 Compiled Profile immutable row에 durable home이 없었다)
      — CLOSED: §18.1 exact 10-table set(migration v2) + §18.1a exact 논리 schema + §18.1b
        migration semantics. verification_evidence/audit_record/adapter_metadata는 해당 integration
        batch로 defer. policy 숫자 컬럼 복제 금지, batch별 compiled_profile_hash 동결,
        §8.3 ExternalTaskSnapshotV1에 version 추가, immutable table conflict/re-hash 규칙 통일.
M0-30 State-machine invariants / durable read models
      (§19.2의 `task ACTIVE ⇔ attempt ∈ {READY..MERGING}`이 §19.4·§11.1·§19.3의 정상 경로와 모순,
       task_attempt stage/status 이중 state, admitted/active/writable projection 근거 부재,
       §20 WAITING이 TaskState가 아닌 HUMAN_REQUIRED를 조건으로 사용, COMPLETED/FAILED 조건 미정)
      — CLOSED: §19.2 I1–I4 단방향 불변식 + 단일 `state` 컬럼 + task당 non-terminal attempt 1개,
        §19.3a commit-time durable admission guard와 admission_closed, §19.3c 세 projection 확정,
        §20.1/§20.2/§20.3 exact 조건. review-only pipeline은 MVP 0/1 executable lifecycle이 아니라
        Profile vocabulary future extension으로 판정(§19.1) — 새 terminal AttemptState를 만들지 않고
        MERGED를 "그냥 성공"으로 재해석하지 않는다.
M0-31 PendingHumanDecision / approval binding / post-gate freshness (HG-1)
      (§17.1이 개념 필드만 갖고 category/question/options/타입/required가 전부 미정,
       dedup_key가 task-scoped 전용이라 taskless CLOSE_BATCH gate 표현 불가,
       applied_transition vocabulary 전무, PendingDecision에 §7.2 rule 7이 요구하는
       field_path/approved_value/record_hash 부재, §7.6 operator-action의 immutable+REVOKED 모순,
       그리고 승인 이후 fresh 재검증 규칙 부재로 human-gated 경로가 V8/V10/V11을 우회 가능)
      — CLOSED: §17.1 exact 13-field body + §17.1a subject union + §17.1b category v1 +
        §17.1c subject-generic dedup + §17.1d resolution union + §17.1e applied_transition_ref +
        §17.1f terminal immutability/record_hash, §17.2a Human Gate 구성(B7 result 무변경,
        gate_proposal exact copy를 record_hash가 bind — Proposal은 여전히 non-hashed),
        §17.3 post-gate 알고리즘(V1–V6 → exact resolved V7 → V8–V11 fresh, bypass token 금지,
        실패 시 RESOLVED 유지·applied_transition_ref null·새 Proposal 필요),
        §7.2 rule 7 projection 조건, §7.6 v1 RESOLVED-only immutable.
M0-32 Atomic transition / logging / outbox boundary
      (transaction 소유자·guard 평가 시점이 미정이고, B7 decision_validation 로그와 transition 로그의
       경계가 없었으며, report_outbox의 B8 포함 여부와 local operation의 INTENT 의무가 불명)
      — CLOSED: §18.2 transition commit이 BEGIN IMMEDIATE 소유·read+guard+write 동일 transaction·
        CAS/version 컬럼 불필요, `state_transition` kind와 최소 payload 확정, report_outbox는
        B8 enqueue만·delivery/sent_at은 이후 batch, §21에 local-only operation은 idempotency row
        불요 명시, §19.3 열 소유권과 §19.3b B8/B9 경계 확정.
M0-33 Coordinator MVP 0 public seam / MVP boundary
      (§25는 core/coordinator를 "interface + dummy"로만 요구하는데 §5.6이 두 줄뿐이라 tick의
       input/output·timer 여부·fact assembly 시점·outbox delivery 소유가 전부 미정이었고,
       §14.2의 30s tick과 §19.3a/b의 "B9가 공급"이라는 문구가 MVP 0을 production orchestration으로
       읽히게 했다)
      — CLOSED: §5.6/§5.6a — logical surface는 tick_once·observe·recover 셋이며 이름은 구현 세부.
        MVP 0 tick은 caller-driven single step이고 timer/background loop/self-rescheduling 금지,
        반환값에 새 vocabulary(TickResult/CoordinatorEvent/CoordinatorCommand) 없음.
        Coordinator는 stateless — coordinator_state/tick_cursor/durable queue 없음, migration 없음.
        §14.2: 30s는 MVP 1 scheduling이며, observation은 transition fact가 아니므로 MVP 0에
        WorkflowObservation→AttemptFact converter/mapping table/DSL을 만들지 않는다.
        §19.3/§19.3a/§19.3b: production fresh fact assembly는 MVP 1 Coordinator integration이고
        MVP 0에서는 caller/fixture가 typed fact를 공급한다(B8 contract 무변경).
        §21.1/§18.1a: outbox enqueue는 B8, delivery·sent_at은 MVP 1, 미발송분 회수는 MVP 4.
        §8.3: TaskSource materialization semantics는 MVP 1 integration으로 defer하며 MVP 0에서
        발명하지 않는다(§26 step 3, Spec §65).
M0-34 MVP 0 recovery seam — interface + dummy
      (§22.2가 절차와 3-value 분류를 주지만 MVP 0 helper가 반환할 typed result와 입력 범위가
       없어, 구현자가 recovery action enum이나 external input schema를 발명할 여지가 있었다)
      — CLOSED: §22.4 — recover(run_id) -> RecoveryClassification이며 vocabulary는 §22.2의
        CONSISTENT | EXPLAINABLE | UNEXPLAINED 그대로(새 action enum 금지).
        MVP 0은 Platform 소유 durable integrity만 판정하고(기존 store load/re-hash 재사용)
        external Adapter를 질의하지 않으며 side effect가 없다 — UNEXPLAINED가 스스로
        PAUSED_SAFELY를 일으키지 않는다. EXPLAINABLE은 authoritative external observation이
        생기는 MVP 1+ 통합용으로 예약. NOT_APPLICABLE schema를 만들지 않고 "canonical mutation
        관련" 분기는 MVP 1+로 유보하며, §22.1 authority map과 generic registry 금지 원칙은 유지.
```

MVP 0은 backend 없이(test doubles) 구현 가능하므로 **backend blocker가 없다.**

### 30.1a MVP 1 platform contract close-out (M1-1 ~ M1-8)

M1-1 ~ M1-5는 architecture decision이 아니라 구현 상세 확정이다. **M1-6과 M1-7은 예외로, 인간이 내린
architecture decision이다** — M1-6은 exact v1 contract를, M1-7은 durable state model과 lifecycle을 바꾼다.
각 record에 그 성격과 근거를 함께 남긴다.

§30.2의 RA item과 **분리된 목록**이다: 아래는 Platform-local 계약이고 RA는 backend 실측이다.
M0-1 ~ M0-34는 이 close-out으로 변경되지 않는다.

```text
M1-1 TaskSource materialization / observation refresh
     (§8.3이 MVP 1 preflight로 명시 defer했던 15개 semantics — 어느 batch에 materialize되는지,
      최초 insert와 재관측 refresh의 구분, version/definition_hash drift, external state·CLOSED 처리,
      pass 실패 원자성, ordering authority가 전부 미정이었다)
     — CLOSED: §8.4 — caller는 Coordinator이고 TaskSource는 batch를 고르지 않는다.
       required read는 discover_tasks + get_task 둘뿐이며 get_dependencies/get_task_state는 durable
       payload가 아니다. 최초 insert = DISCOVERED(admission 미소비), 재관측 = snapshot refresh만,
       version/hash drift와 external state 변화는 lifecycle을 바꾸지 않는다(V3와 §11이 소유),
       external CLOSED ≠ COMPLETED이며 ACTIVE 중 CLOSED도 silent terminate하지 않는다,
       pass는 fail-closed(부분 commit 없음, TASK_NOT_FOUND로 위장 금지), 반환 순서는 priority가 아니다.

M1-2 MVP 1 durable schema v3 — exact three tables
     (M0-29가 defer하면서 verification_evidence/audit_record/adapter_metadata의 컬럼 정의를 문서에서
      제거해, MVP 1 구현자가 durable shape를 발명해야 하는 상태였다)
     — CLOSED: §18.1c — v3은 정확히 세 table이며 v1/v2는 불변. adapter_metadata는
       (entity_key, adapter_id, key) PK의 current projection(hash/envelope 없음, lifecycle authority
       아님)이고 I-TD7은 adapter contract + Core write validation + tests 세 겹으로 강제한다.
       verification_evidence는 immutable이며 binding_valid를 Coordinator가 §15.2 재검증으로 계산하고
       rework는 새 evidence_id로 표현한다(generation 컬럼 없음). audit_record는 immutable이고
       attempt당 복수 행을 허용하며 validated verdict만 승격된다.

M1-3 Supervisor RuntimeSession lifecycle / bootstrap / MCP Proposal submission context binding
     (Supervisor session을 누가 언제 만드는지, SUPERVISOR grant 발급 시점, bootstrap 내용,
      그리고 MCP 제출이 어느 run/batch에 속하는지가 미정이었다)
     — CLOSED: §5.1 + §13.4 — Proposal ingress authority는 Platform API/MCP Adapter 하나이며
       RuntimeTurnResult는 Proposal authority가 아니다(I-TD3). run당 active Supervisor session 하나,
       첫 spawn 이전에 run-scoped SUPERVISOR grant 발급(requested 12개 전부 false, §12.4),
       handle은 adapter_metadata(entity_key=run_id)에 non-secret으로 보관, 후속 turn은 같은 session을
       재사용하되 그것은 automatic continuation이 아니라 Coordinator의 명시적 send_turn이다(I-TD4).
       bootstrap은 불변 값만 담고 변하는 값은 매 turn fresh context로 전달한다.
       제출 transport는 { run_id, batch_id, proposal } context를 갖고 Core가 durable state로 검증하며
       Proposal body(§9.1)와 hash 대상은 변경하지 않는다.

M1-4 MVP 1 manual-merge Repository fact contract
     (§19.4의 3분기를 판정할 관측 primitive가 boolean 시그니처로는 표현되지 않았고,
      §26 step 14의 audit_record write가 external side effect보다 먼저인 것처럼 읽혔다)
     — CLOSED: §14.3 + §19.4 + §16.3 — 새 Repository operation을 추가하지 않고 기존 verify_lineage를
       generic ancestor→descendant 관계로 명확화해 candidate 검증과 merge 관측에 재사용한다.
       three-way projection(정확 일치 / ancestor 포함 / 미머지 / 그 외 mismatch)은 기존 typed
       AttemptFact에 공급되며 새 fact를 만들지 않는다. APPROVE ≠ MERGED와 "사람 보고는 authority가
       아니다"는 그대로다. audit commit은 INTENT → audit_decide → 확인 → audit_record 순서로 I-TD2와
       정합화했다.

M1-5 Direct HARD dependency admission fact
     (§8.4가 admission 직전 fresh dependency read를 요구하고 §19.3이 "dependency 미차단"을
      precondition으로 두었지만, HARD dependency satisfaction rule이 문서·코드 어디에도 없어
      MVP1-B4 구현이 dependency guard에서 멈췄다)
     — CLOSED: §8.4a + §19.3/§19.3a — SOFT는 MVP 1 admission blocker가 아니다. 평가 대상은
       get_dependencies(current_task_ref)가 직접 반환한 HARD dependency뿐이며 재귀 조회하지 않는다.
       각 dependency에 대해 fresh get_task_state(depends_on_ref)와 durable target row를 함께 읽는다
       (materialized snapshot의 external_state는 authority가 아니다). durable row가 없거나
       admitted_at == null이면 Platform에 execution history가 없으므로 fresh external == CLOSED일 때만
       satisfied이고, admitted_at != null이면 platform_state == COMPLETED AND external == CLOSED를
       모두 요구한다 — 한쪽만으로는 (a) Platform의 미완료·실패를 external CLOSED가 덮어쓰거나
       (b) 재개된 prerequisite를 무시하고 진행하게 되기 때문이다. divergence는 자동 reconcile하지 않고
       dependency target lifecycle도 바꾸지 않는다(MVP 4). UNKNOWN은 satisfied가 아니며
       get_task_state 실패는 fail-closed operational failure이지 TASK_NOT_FOUND가 아니다.
       Coordinator가 hard_dependencies_clear를 계산하고 state machine은 typed boolean만 소비한다
       (human gate resolution 시 재계산). V12/새 DecisionRejectReason·dependency persistence·
       transitive scheduler·cycle framework를 만들지 않는다.

M1-6 Task Contract repository_scope authority  — **architecture decision (인간 결정), breaking v1 correction**
     (§10.1이 repository_scope를 required로 두고 §12.7이 Broker input으로, §14.4가 merge gate 대조로
      쓰는데도 그 값의 authoritative source가 Spec에도 TD에도 없었다. 그대로 두면 Task Contract
      builder의 caller가 execution mutation 경계를 임의로 정한다)
     — DECISION: Project Profile이 named repository scope의 선언 authority다(§7.1a
       `repository_scopes`, required, MVP 1 최소 1 entry, body는 exact RepositoryScopeV1).
       Supervisor는 body가 아니라 **declared id 하나**만 고르고(§9.1
       `TaskSelectionProposalV1.repository_scope_id`, selection variant 전용),
       V6가 네 번째 declared reference로 검증한다(§9.2, 기존 PROFILE_REFERENCE_UNKNOWN 재사용 —
       새 V-step도 새 reason code도 없다). 검증된 id는 admission transaction에서 다른 네 selection
       field와 함께 durable하게 기록되고(§18.1a `task.repository_scope_id`, §18.1d migration v4 —
       nullable column 하나, 새 table 0, tables=17 유지), activation이 그 id를 **해당 batch에 bind된
       immutable Compiled Profile**에서 resolve해 TaskContractCapabilityView를 구성한 뒤(§12.7 step 3)
       final Task Contract가 resolved allowed/forbidden paths를 동결한다(§10.1).
     — REJECTED alternatives: ① TaskDefinition ownership — 권한 경계를 매 submission fresh 재읽기되고
       drift가 정상인 값에 두게 되며, repository 안의 task 문서를 쓸 수 있는 주체가 이후 task의 scope를
       넓힐 수 있다. ② classification coupling — permission 축과 ExecutionDisposition 축을 영구 결합해
       scope 변경이 실행 성향을 바꾸고, scope 표현용 가짜 classification을 만들게 한다.
       ③ pipeline coupling — pipeline은 lifecycle template이므로 책임 혼합이고 재사용을 깨뜨린다.
       ④ arbitrary caller input — authority 부재 그 자체. ⑤ RepositoryAdapter authority — Adapter는
       실제 변경 path의 fact owner이지 allowed scope owner가 아니다.
     — 축 분리 유지: repository_scope(어디를) / repository.feature_write(쓸 수 있는가, §12.4) /
       capability_requirements(어떤 assurance가 필요한가, §12.2)는 서로 추론되지 않으며 §12.7의
       path→capability inference 금지도 그대로다. implicit default·whole-repo scope·새 glob/regex/path
       DSL을 만들지 않는다.
     — drift: scope 정의는 Project Profile의 일부이므로 project_profile hash → compiled_hash 축으로만
       움직인다. TaskDefinition hash에는 들어가지 않고 새 drift category도 만들지 않는다. 실행 전에는
       Proposal.expected.compiled_profile_hash의 fresh 검증(V4)이, 실행 중에는 Task Contract에 동결된
       immutable copy가 silent scope migration을 막는다.
     — VERSION: **pre-production breaking v1 correction**이며 호환 변경이 아니다. schema_version을 2로
       올리지 않는 근거는 TD가 Draft이고, 외부에 serialized Profile/Proposal 호환 계약이 없으며, live
       run이 없고, Task Contract activation이 아직 시작되지 않았고, 지금 v2로 가면 backward
       compatibility를 요구하는 consumer가 하나도 없는데 ProjectProfileV2/CompiledProfileV2/ProposalV2
       machinery만 연쇄되기 때문이다. 대신 **기존 v1 ProjectProfile/TaskSelectionProposal fixture는
       무효가 되며 구현과 테스트를 함께 이전해야 한다**는 사실을 명시한다 — 과거 serialized production
       artifact의 migration을 지원한다고 주장하지 않는다. `STATUS_common_platform_mvp0.md`는 MVP 0
       시점의 historical evidence이므로 이 변경으로 다시 쓰지 않는다.

M1-7 Selection→Activation fact binding / restart safety  — **architecture decision (인간 결정)**
     GAP: durable SELECTED row가 V3/V8이 검증한 selection basis를 하나도 보관하지 않았다.
       task_version / task_definition_hash / base_head는 Task Contract required인데, Proposal은 durable
       artifact가 아니고(§9.1), external_snapshot은 mutable observation projection이며(§8.3), §11 drift는
       stage boundary = post-Attempt 전용이고, §22.2 restart는 attempt 단위만 분류한다. 즉 crash 후
       SELECTED task의 Contract를 만들 authority가 문서상 존재하지 않았다.
     DECISION: exact `SelectionBindingV1 { task_version, task_definition_hash, base_head }` (3 field,
       unknown reject, 별도 envelope/hash artifact 아님). authority는 Model Proposal body가 아니라
       DISCOVERED→SELECTED commit 직전 V3/V8을 통과시킨 authoritative fact이며, version과 hash는 반드시
       같은 관측에서 온다. Proposal.expected와 값은 같지만 의미는 "Platform-validated selection basis"다.
     STORAGE: `task.selection_binding_json`, migration **v5 append**. M1-6의 v4는 수정하지 않는다 —
       그 close-out record를 사후에 고쳐 M1-7 field까지 v4였던 것처럼 만들지 않기 위해서이며, 구현
       비용은 사실상 같다. target = schema v5 / tables 17 / 새 table 0.
     ACTIVATION: §12.7 step 0에서 fresh TaskDefinition + fresh canonical을 읽어 세 값 exact equality를
       검사하고, 통과할 때만 finalization으로 진행한다. fresh read는 binding을 대체하지 않고 비교
       대상이다. Task Contract의 task.version/definition_hash/body_copy는 그 하나의 fresh 관측에서
       함께 오고, Attempt.base_head == SelectionBinding.base_head == TaskContract.base_head다.
     MISMATCH: `SELECTED → HELD(SELECTION_STALE)` 단일 transition. contract build **이전**에 판정하므로
       snapshot/grant/attempt/blob이 하나도 생기지 않는다. **자동 PendingHumanDecision을 만들지 않는다** —
       staleness는 새 deterministic selection 요구이지 policy가 요구한 human decision이 아니다.
     RECOVERY: fresh Supervisor `START_TASK` Proposal로 **explicit reselection**한다. 새 DecisionType
       (RESELECT_TASK / REBASE_TASK / REFRESH_SELECTION)을 만들지 않고, initial admission과의 구분은
       durable task state에서 Coordinator가 판정한 typed `SelectionAdmissionKind`(§9.2e)가 담당한다 —
       Proposal field가 아니다.
     RESELECTION: 이미 admitted된 task이므로 V11 rule 1(max_tasks)과 `admission_closed`를 다시 소비하지
       않고, rule 2/3(concurrency·writable)과 M1-5 dependency fact는 fresh로 다시 본다. `admitted_at`
       불변, `admitted_task_count` 불변, `batch.admission_closed` 불변. selection fields와
       selection_binding은 한 transaction에서 새 validated 값으로 교체된다.
     HUMAN: 새 reselection Proposal이 기존 V7로 HUMAN_GATE_REQUIRED일 때**만** PendingDecision이 생기며,
       그 승인의 의미는 새 Proposal authorization이지 staleness 승인이 아니다. 승인 후에도 fresh V1–V10 +
       RESELECTION V11 + fresh dependency를 다시 통과해야 하고, 최종 binding은 frozen model 값이 아니라
       resolution 시점 authoritative fact로 만든다.
     BOUNDARIES: Proposal은 여전히 non-artifact다(proposal_snapshot/hash/envelope 없음).
       `external_snapshot_json`(latest observation)과 `selection_binding_json`(validated basis)은 절대
       합치지 않는다. `decision_log`는 history/audit substrate이며 binding을 그곳에서 복원하지 않는다.
       pre-Attempt staleness(M1-7)와 post-Attempt drift(§11)는 별개 system이고, canonical 이동은 두
       구간에서 의도적으로 다르게 다뤄진다(전자는 재선택, 후자는 MERGE_ONLY fail-closed). 어느 쪽에도
       silent contract rebasing은 없다. Runtime/Workflow side effect는 이 구간 전체에서 0이다.

M1-8 READY→IMPLEMENTING external operation identity / idempotent recovery
     (§19.3이 workspace 생성을 idempotency INTENT **앞**에 두어 I-TD2와 충돌했고, workspace external
      mutation에 op_key가 없었으며, generic RuntimeAdapter input에 Platform op_key를 전달할 자리가
      없었다. 세 external operation — workspace / spawn / turn — 은 서로 다른 crash window를 가지는데
      하나의 INTENT가 셋을 덮는 것처럼 읽혔다)
     — CLOSED:
       · workspace op identity `op:<attempt>:workspace` + §21 대상 추가. Spec §42 operation set은
         늘리지 않고 `create_feature_workspace`를 `CreateFeatureWorkspaceRequestV1 {base_head, op_key}`의
         **idempotent create-or-reacquire**로 정밀화(§14.3). LocalGit의 first-free `ws-<base>-<n>`는
         retry identity가 아니므로 production path에서 op_key가 path/branch를 결정한다.
       · `RuntimeOperationContextV1 { op_key }` (exact 1 field)를 spawn_session/send_turn의 TD concrete
         input으로 추가(§13). Spec §27 operation 종류 불변, generic context bag 없음.
       · spawn same-op 재획득 의무(§13) — 동일 op_key+동일 material input은 동일 logical session.
       · turn `op_key → AcpRuntimeTurnInput.requestId` mapping(§13), instruction body 삽입 금지.
       · RA-4 preflight를 READY→IMPLEMENTING의 **step 0**으로 고정(§19.3e) — workspace보다 앞.
       · 세 operation 각각의 INTENT/DONE ordering과 adapter 호출의 transaction 외부 수행(§19.3e).
       · READY→IMPLEMENTING durable 경계: preflight PASS + 세 op DONE + 세 ref durable + §19.3d
         receipt 조건. turn DONE과 전이를 한 transaction으로 결합해 T4 window 제거.
     — MVP 1 KNOWN LIMITATION (backend fact, 2026-08 read-only audit):
       OpenClaw `startTurn`의 `requestId`는 **correlation identity일 뿐**이다 — same-requestId dedup도,
       restart 후 durable turn 재획득도 제공하지 않는다(§13). 따라서 startTurn accepted 이후 durable
       persist 이전 crash는 효과 판정이 불가능하며 **재시도하지 않고 HELD(RECOVERY_CONFLICT)** 로
       fail-closed한다(§19.3e T2). 같은 이유로 **T1(호출 전 crash)도 재시도하지 않는다** — 재시작
       시점의 durable state(turn INTENT만 존재)는 T1과 T2를 구별하지 못하므로 §21의 generic rule
       ("효과 부재를 authoritative하게 증명할 때만 retry")이 Backend v1에서는 충족되지 않는다.
       generic contract 자체는 그대로이며, absence를 관측할 수 있는 RuntimeAdapter가 생기면 retry가
       다시 허용된다. 이는 자동 복구가 아니라 **duplicate Actor turn이 구조적으로 0**
       이라는 안전 보장이다. full Runtime turn reconciliation / durable turn ledger / backend dedup은
       Spec §69의 **MVP 4** 범위이며 MVP 1 blocker가 아니다 — backend enhancement candidate로만 남긴다.
       이 한계 때문에 OpenClaw를 수정하지 않으며 RA-1(CLOSED)/RA-2(OPEN) 경계도 바뀌지 않는다:
       turn **completion 관측·structured result**는 RA-2 소관이고 여기서 다루지 않는다.

MVP1-B13 Production Coordinator integration (구현 기록)
     — **분류: composition batch. 새 architecture 방향이 아니다.**
     구현:
       `core/coordinator/production-coordinator.ts`(state-driven `tickOnce`),
       `core/coordinator/report-delivery.ts`(§21.1 delivery + 확인 후 `sent_at`),
       `core/execution/start-rework.ts`(REWORKING→IMPLEMENTING, `actor-turn:<rework_count+1>`),
       `core/execution/supervisor-session.ts` + `supervisor-operations.ts`(M1-15 identity),
       `core/execution/actor-operations.ts`(Actor op identity 분리),
       `ReportOutboxStore.markSent`(확인된 delivery 기록. transport는 여전히 adapter 소유).
     sealed source 정정 3건 — 전부 같은 원인(“한 Attempt에 candidate는 하나”라는 가정이
     rework 경로가 없던 시점에 들어간 것):
       (a) §19.3 verification 후보 guard: “다른 candidate의 operation이 존재”가 아니라
           “다른 candidate의 verification이 **미완료**”일 때 fail-closed. 보호 대상(열린 run 2개 금지,
           다른 commit용 intent 재사용 금지)은 그대로다.
       (b) B9 completion guard: attempt당 DONE verify op이 정확히 1개가 아니라, **현재 candidate의**
           verify op이 DONE인지를 본다. candidate가 그 operation의 qualifier이므로 더 정확하다.
       (c) verification gate/Auditor review context의 evidence 선택을 **현재 candidate**로 한정한다.
           evidence는 immutable이므로 rework 후에도 이전 candidate의 row가 남고, 한 check에 두 row가
           보이면 `AMBIGUOUS`로 읽힌다. evaluator 자체는 바뀌지 않았다.
     불변:
       Spec 변경 없음. schema v6 / 17, migration 없음. B1–B12 semantics는 Coordinator 안에
       재구현되지 않는다. timer/cursor/queue/scheduler table 없음. MVP2 automatic merge,
       MVP3 scheduler/subflow, MVP4 reconciliation 전부 미구현.
     남은 것:
       RA-4 live BLOCKED(C2,C3,C4,C5) — B13 PASS는 live pilot readiness를 뜻하지 않는다.
       AUDIT_DECISION / REATTEMPT_DECISION / CONTRACT_DECISION / RECOVERY_DECISION의 적용은
       safe-held endpoint 그대로다.

     CORR1 (활성화 배선 정정 — 최초 구현의 결함과 그 정정을 함께 남긴다):
       결함: 최초 B13은 §26 step 7(SELECTED→activation)을 `tickOnce()`에 배선하지 않았다.
         `#advanceTask`가 Attempt 부재 시 곧바로 반환했고, E2E는 `activateSelectedTask`를 직접
         호출해 그 경계를 건너뛰었다. 따라서 최초 B13 보고의 "activation이 Coordinator를 통해
         배선되었다"는 서술은 사실이 아니었고 그 seal은 무효였다.
       정정: production Coordinator가 `Task SELECTED` + Attempt 부재를 기존
         `activateSelectedTask`로 dispatch한다. Coordinator는 caller-allocated identity 3개와
         frozen profile이 선언한 Contract Source bytes(§11의 동일한 `ContractSourceReader`)만
         공급하며, selection binding gate·repository scope 해소·§12.7 compatibility·Grant/Contract
         구성·전이는 전부 기존 use-case 소유 그대로다. E2E의 직접 호출과 그 fixture wrapper는
         제거했고, 두 E2E 모두 이제 `tickOnce()`로 그 경계를 넘는다.

M1-15 Supervisor spawn identity / MVP 1 completion endpoint
     — **분류: Platform-local contract close-out (documentation only). B13 전제.**
     gap (source + TD audit로 확인됨):
       §13.4는 Supervisor **turn**의 stable key(`op:<batch_id>:supervisor-turn:<n>`)만 정의하고
       그 앞의 `spawn_session`에는 operation identity를 주지 않았다. 그런데 I-TD2는 모든 external
       effect에 durable INTENT를 요구하고, M1-8/M1-10은 spawn과 turn이 서로 다른 crash window를
       갖는 별개 operation임을 이미 확정했다. 현재 source에도 `supervisor-` op key는 존재하지 않는다.
     결정:
       · `op:<batch_id>:supervisor-spawn:<n>` 신설. `supervisor-turn:<n>`과 항상 별개이며 하나의
         idempotency record가 둘을 덮지 않는다. 통합 op·session/turn table·tick cursor 없음.
       · session lifetime은 **run-scoped 그대로**(M1-3 불변). op key가 batch-scoped인 것과 무관하며
         handle은 `adapter_metadata(entity_key = run_id)`다. 재사용 가능한 run session이 있으면
         spawn operation 자체가 없다.
       · `<n>`은 durable Supervisor-turn operation 이력에서 파생한다(max+1). ordinal 컬럼도 counter
         table도 process-local counter도 없다. 첫 요청은 `supervisor-turn:1`.
       · spawn/turn 모두 불확정 acceptance는 추측 재시도 없이 기존 fail-closed 처리를 따른다.
         `RuntimeTurnResult`는 여전히 Proposal authority가 아니다(§13.4, I-TD3).
     정정:
       · **run completion은 OPTIONAL이 아니라 REQUIRED_MVP1_INTEGRATION이다.** §20이 이미 규범이며
         직전 integration audit의 분류가 틀렸다 — "구현이 없다"는 것은 scope 판단이 아니라 미구현
         항목이라는 뜻이다. MVP 1 성공 종점은 Attempt MERGED / Task COMPLETED / Batch COMPLETED /
         Run COMPLETED 넷이다(§20).
       · rework Actor turn ordinal을 §26 step 15에 명시: 첫 rework turn은 `actor-turn:2`다.
     불변:
       Spec 변경 없음. schema v6 / 17 그대로. §27의 MVP 2/3/4 경계도 그대로다
       (직전 audit의 MVP2=Gate·MVP3=scheduler/subflow·MVP4=reconciliation 분류는 §27과 일치하며
       정정할 오류가 없었다).
     영향:
       MVP1-B13 구현 준비 완료. B13은 §13.4의 두 operation identity를 그대로 쓴다.

M1-14 MVP 1 Human Merge contract close-out
     — **분류: Platform-local contract close-out (documentation only).**
     gap (source audit로 확인됨):
       (a) §17.3의 `validateDecisionAfterResolvedHumanGate`는 `category == HUMAN_GATE_APPROVAL` +
           저장된 `gate_proposal` 동일성을 요구하는데 §17.1상 `MERGE_APPROVAL.gate_proposal`은 항상
           `null`이다 → MERGE_APPROVAL resolution을 그 경로로 흘릴 수 없다.
       (b) MERGE_APPROVAL에 AUDIT_DECISION 수준의 builder/validity 계약이 없었다.
       (c) `canonical_head: MERGE_ONLY`가 `READY_TO_MERGE→MERGING`에만 걸려 있어 MVP 1(그 state에
           진입하지 않음)에서는 한 번도 집행되지 않는다.
       (d) 이전 §19.4는 승인 이후 canonical 이동에 §11 drift와 3-way 관측 **둘 다** 적용한다고 읽혔다.
       (e) `HUMAN_MERGE_MISMATCH`의 HELD vs PAUSED_SAFELY 판정식이 TD에도 source에도 없었다
           (Spec §52는 후보 나열일 뿐이다).
       (f) sealed `MANUAL_MERGE_APPROVED` outcome이 `task_state`를 돌려주지 않아 승인 후 task가
           해소된 결정에 계속 HELD로 남는다.
     확인(gap 아님):
       `MERGE_REJECTED`와 `HUMAN_MERGE_MISMATCH`는 §24와 `TRANSITION_REASON_CODES`에 **이미 둘 다**
       존재한다 — 의심되던 taxonomy 누락은 사실이 아니다. schema 변경도 필요 없다
       (`MERGE_APPROVAL` category는 v2부터 존재).
     결정: §19.4a–§19.4i (builder / STALE basis / 좁은 APPROVE 적용 계약 / fresh authority 4개 /
       실패 매핑 / MERGE_ONLY 집행점 = APPROVE 직전 / 3-way 읽기 순서 / mismatch 판정식 /
       applied_transition_ref / repository mutation 0).
     영향:
       MVP1-B12 구현 준비 완료. B12는 sealed `MANUAL_MERGE_APPROVED` outcome에
       `task_state: "ACTIVE"`를 더하고 `StageBoundary`에 merge-approval boundary를 추가한다 —
       그 둘이 이 close-out이 지목한 유일한 sealed-source 변경이다.

M1-13 Auditor binding / audit settlement / audit human decision / multi-cycle identity
     — **분류: Platform-local contract close-out + B10 narrow prerequisite correction.**
     gap (source audit로 확인됨):
       (a) B10이 Auditor에게 `task_contract_hash`도 `evidence_ids`도 주지 않아 §16.2의 `reviewed.*`
           일치 요구를 충족시킬 방법이 없었다 → 첫 turn이 구조적으로 항상 `AUDIT_INVALID`가 된다.
       (b) audit operation key가 Attempt-wide여서 rework 후 두 번째 audit cycle이 이전 cycle의
           `DONE`을 만나 조용히 건너뛴다.
       (c) §16.2/§13.2는 `AUDIT_UNUSABLE`을, §16.3은 `AUDIT_GATE_UNAVAILABLE`을 요구하는데 구현된
           `TRANSITION_REASON_CODES`에는 **둘 다 없다**.
       (d) validated Auditor `HUMAN_REQUIRED`를 담을 PendingDecision category가 없다.
       (e) §16.3은 Core가 `WorkflowAdapter.audit_decide`를 부르라고 적었지만 Core가 가진 것은 opaque
           `VerificationRunHandle`뿐이고 `WorkflowHandle`/controller는 B7/B8 adapter 소유다.
     결정:
       · `AuditorReviewContext`(candidate/contract hash/ordered evidence_ids)를 **매 review turn**에
         싣는다. spawn에 묶지 않는다 — rework가 정확히 그 값들을 바꾸기 때문이다.
       · `reviewed.evidence_ids`는 **positional exact equality**. 정본 순서는 store의 `ORDER BY
         evidence_id`이며 정렬·dedup·set 비교를 하지 않는다.
       · session은 Attempt 단위, candidate 판정 operation은 candidate 단위
         (`auditor-turn-1|2:<sha>`, `audit-decision:<sha>`). counter도 table도 없다.
       · `AUDIT_INVALID`(retryable 관측) / `AUDIT_UNUSABLE`(재시도 소진, terminal) /
         `AUDIT_GATE_UNAVAILABLE`(settle 확립 실패)을 §24와 Core vocabulary에 확정한다.
       · `AUDIT_DECISION` category 신설 + migration v6(table 재작성, 17 tables 유지).
         `HUMAN_REQUIRED → AUDIT_PASS` 사람 우회는 만들지 않는다.
       · audit settlement는 `VerificationAdapter.settle_audit`에 둔다. `SETTLED`는 adapter가 자기
         backend를 재관측해 증명한 경우에만 쓰며, Backend v1 dedup 부재 때문에 observe-before-act /
         re-observe-after가 계약이다. `WorkflowAdapter` public contract도 durable-jobs도 안 바뀐다.
     불변:
       Spec 변경 없음. schema table 수 17 유지. `AUDIT_DECIDED`는 계속 AttemptFact다.
       `canonical_head.boundary=MERGE_ONLY`이므로 AUDITING→READY_TO_MERGE에서 canonical 이동은 관측 전용.
     영향:
       MVP1-B10 재봉인(per-cycle binding + multi-cycle identity 정정 포함). MVP1-B11 구현 준비 완료.

M1-12 Drift cause vs PendingDecision blocking reason
     — **분류: Platform-local representation close-out. 새 architecture 방향이 아니다.**
     gap (확인됨):
       §17.2는 `subject.kind == TASK` + `blocking_scope == TASK_ONLY`인 OPEN PendingDecision이
       `HELD(BLOCKED_BY_DECISION:<decision_id>)`를 만든다고 규정한다. 그런데 §11.4/§19.2는 drift
       결과를 `Task HELD(CONTRACT_DRIFT)` + PendingDecision으로 적었다. 두 문장은 같은 durable
       `task.state_reason_code`를 동시에 요구하므로 양립할 수 없다. B10 구현이 이를 노출했다 —
       HOLD는 `CONTRACT_DRIFT`를, INVALIDATE는 `BLOCKED_BY_DECISION:<id>`를 남겨 **비대칭**이었다.
     결정:
       · 두 개념을 분리한다. **인과(cause)** = `CONTRACT_DRIFT`(transition fact, INVALIDATE의 경우
         Attempt reason), **현재 차단(blocker)** = `BLOCKED_BY_DECISION:<decision_id>`.
         §17.2의 blocking 규칙이 정본이며 drift 예외를 만들지 않는다 — `HUMAN_GATE_APPROVAL` /
         `MERGE_APPROVAL` / `CONTRACT_DECISION` / `REATTEMPT_DECISION`이 TASK_ONLY인 한 전부 동일하다.
       · 인과 provenance는 기존 durable 기록으로 충분하다: transition 항목(+`pending_decision_id`),
         `PendingHumanDecision.category`, `created_from = drift:<attempt_key>:<target>`,
         그리고 Attempt reason. `cause_reason` 같은 새 column도 새 table도 만들지 않는다.
       · `UNAVAILABLE`은 PendingDecision을 열지 않으므로 현재 blocker가 없고,
         `HELD(DRIFT_CHECK_UNAVAILABLE)`이 그대로 Task reason으로 남는다 — 이 code를
         `BLOCKED_BY_DECISION`으로 바꾸지 않는다.
       · **blocking 표현 구현은 하나뿐이다.** `commitAttemptFact(..., decision)`이 이미 §17.2를
         정확히 집행하므로 HOLD도 그것을 쓰고, drift 전용 PendingDecision 삽입 경로
         (`within` + 별도 export)는 제거한다.
       · §17.2 STALE 규칙을 category별 validity basis로 닫는다(위 §17.2 참조) — generic
         "attempt INVALIDATED → 그 task의 decision 전부 STALE"은 금지이며, 그 규칙 아래에서는
         `REATTEMPT_DECISION`이 생성 즉시 STALE이 된다.
     불변:
       Spec 변경 없음. schema v5 / 17 tables. §17.1b category vocabulary·§24 taxonomy 그대로.
       M1-11이 고정한 evaluator/read seam/`DriftObservationV1`은 건드리지 않는다.
     영향:
       MVP1-B10의 마지막 seal 조건. drift 인과는 구조화된 필드로 계속 조회 가능하며(자유 텍스트
       파싱 불필요), HOLD와 INVALIDATE가 같은 blocking 표현을 쓴다.

M1-11 Stage-boundary contract drift evaluation
     — **분류: Platform-local concrete contract refinement. 새 architecture 방향이 아니다.**
     gap:
       §11이 stage boundary마다 drift를 집행하라고 정하지만 그 **평가자의 구체 계약이 없었다.**
       B10은 `StageBoundaryDrift = () => DriftOutcome` seam만 갖고 있어 caller가 허용적인 결과를
       그냥 넘길 수 있었다 — Core가 근거 사실을 증명하지 않는다. 또한 §11.3은 이미
       `HELD(DRIFT_CHECK_UNAVAILABLE)`을 쓰는데 §24 taxonomy에 그 code가 없어 유효한 reason으로
       기록할 수 없는 모순이 있었다.
     decision:
       · §11.4에 concrete evaluator 계약을 고정: authoritative owner read → `DriftObservationV1`
         → 순수 `evaluateStageBoundaryDrift` → `DriftOutcome{CONTINUE|HOLD|INVALIDATE|UNAVAILABLE}`.
         §9.2 Decision Validator와 같은 read-model 경계를 재사용하고 registry/engine/bus를 만들지 않는다.
       · 7개 target 각각의 frozen baseline / 현재 authority / 비교 규칙을 matrix로 고정.
         component 두 개는 `compiled_hash`가 아니라 `{id,version,hash}` component ref로 비교해야
         어느 target이 움직였는지 귀속된다.
       · `verification_profile`/`capability_requirements`는 상위 component 안에 살므로 함께 잡히며,
         heuristic attribution 대신 precedence로 해소한다.
       · precedence는 action 강도만으로 결정한다: `INVALIDATE > UNAVAILABLE > HOLD > CONTINUE`.
         숫자 severity를 발명하지 않고 object 순회 순서에 의존하지 않는다.
       · **§24에 `DRIFT_CHECK_UNAVAILABLE` 추가** (Option A). "변경되었음을 증명했다"와 "변경 여부를
         알 수 없다"는 다른 사실이고 후자는 audit/safety상 구분되어야 한다. §11.3이 이미 그 이름을
         쓰고 있었으므로 이것은 누락을 채우는 것이지 새 vocabulary가 아니다.
       · Core에 없는 두 authority를 좁은 read seam으로 도입: `ProfileSource`(현재 Project Profile /
         Execution Policy)와 `ContractSourceReader`(현재 원본 bytes). §7이 Registry persistence/파일
         접근을 Core 밖으로 명시했으므로 TaskSource/RepositoryAdapter와 같은 계열이다.
       · **correction 1 — ProfileSource read shape.** 최초 기술은 `{id,version,hash}`만 돌려준다고 했는데
         그것으로는 §11.4가 요구하는 sub-body 비교(verification_profile / capability_requirements)와
         REEVALUATE의 현재 pipeline/roles 확인을 할 수 없었다. 정확히 두 호출로 **ref + 정규화된 typed
         body를 함께** 돌려주는 것으로 고정한다. ref는 component 귀속용, body는 sub-body 비교용이며
         둘 다 필요하다. data bag(get(path)/json-pointer/metadata)은 노출하지 않고, YAML/파일 접근은
         seam 구현 안에 남으며 pure evaluator는 I/O를 하지 않는다.
       · **correction 2 — REEVALUATE capability basis (최종).** backend 기준을 구현 선택지로 남기지
         않는다. 기준은 **Attempt-frozen Auditor CapabilityGrant**의 `requested`/`enforcement`이며,
         `grant.source_runtime_manifest_hash == contract.backend_requirements.runtime_manifest_hash`가
         provenance binding이다. Runtime Manifest **body**는 필요하지 않다 — Task Contract v1은 hash만
         durable하게 갖고 manifest body registry도 hash→manifest resolver도 없으므로 body를 요구하면
         restart 재구성이 정의되지 않는다. 그리고 그 body를 현재 Backend에서 읽어 hash로 대조하는 방식은
         **금지**다: 진짜 Backend 변경이 §12.6/§22.2/RA-4보다 먼저 §11의 `DRIFT_CHECK_UNAVAILABLE`로
         소비되어 하나의 사실에 두 authority가 다시 생긴다. (이 지점은 직전 초안이 틀렸던 곳이며 여기서
         정정한다.) 비교는 §12.2 set semantics 그대로 `current_requirement[c].accepted ∋
         grant.enforcement[c]`이고, 기존 `evaluateCapabilityRequirements`는 Manifest body를 입력으로
         받으므로 그대로 쓰지 않는다 — 그 함수의 마지막 단계를 동결된 `enforcement`에 적용하는 좁은 pure
         projection을 쓴다(판정 규칙·vocabulary 동일, 두 번째 authority 아님).
         Grant 부재/hash 불일치/role 불일치/`source_runtime_manifest_hash` 불일치는 Backend 변경의 증거가
         아니라 **동결 basis 자체를 세우지 못한 것**이므로 §18.1a의 load·re-hash 의미대로 전이 없이
         fail-closed하며, 새 §24 code를 만들지 않는다.
       · ABSENT(현재 값을 읽었으나 항목이 사라짐) 와 UNAVAILABLE(읽지 못함)을 구분한다. 전자는 성공한
         관측이며 곧 drift다 — key가 없다는 이유로 UNAVAILABLE로 접지 않는다.
       · `StageBoundaryDrift = () => DriftOutcome` seam은 **제거한다**(구현 시 §23 option B보다 강한
         쪽을 택함). seam을 남기고 production composition만 실제 evaluator에 묶는 방식은 "caller가
         허용적인 결과를 건네줄 수 있다"는 구멍을 타입에 남긴다. 대신 use-case는 세 read seam
         (`ProfileSource` / `TaskSourceV1` / `ContractSourceReader`)만 받고 스스로 관측을 조립해
         순수 evaluator를 호출한다 — drift 결과는 인자가 될 수 없다. test double은 결과가 아니라
         **관측**을 script하며, 순수 evaluator는 구성된 `DriftObservationV1`로 직접 시험한다.
     불변:
       Spec 변경 없음. §11.1 action vocabulary·§11.3 불변 규칙·stage boundary 4개 모두 그대로.
       schema v5 / 17 tables 유지 — `contract_drift` table도 drift registry도 만들지 않는다.
       §17 PendingDecision은 기존 category로 충분하다(INVALIDATE→`REATTEMPT_DECISION`,
       HOLD/축소 REEVALUATE→`CONTRACT_DECISION`) — §17 gap 없음.
       §11 `capability_requirements`(정책 요구 변경)와 §12.6/§22.2(Backend enforcement 변경)의
       authority 분리 유지.
     영향:
       이 record가 고정한 evaluator는 VERIFYING→AUDITING 한 boundary에 통합되어 구현되었다.
       나머지 세 boundary의 lifecycle 통합은 이 record의 범위가 아니다. B10의 마지막 seal 조건은
       M1-12(drift 인과 vs blocking reason 분리)였다.

M1-10 Auditor Runtime launch contract
     — **분류: Platform-local concrete contract refinement. 새 architecture 방향이 아니다.**
     gap A (확인됨):
       §19.3의 VERIFYING→AUDITING row와 §26 step 12가 "Auditor spawn → turn"을 하나의
       `op:<attempt>:audit-spawn` 아래 묶어 적었다. spawn과 turn은 서로 다른 external effect이고
       서로 다른 crash window를 가지므로 M1-8이 Actor에 대해 이미 분리한 규칙과 충돌한다.
     gap B (확인됨):
       `spawn_session(role=AUDITOR, runtime_profile=?)`의 authority가 어디에도 없었다 —
       `PipelineEntry`는 `{steps}`만 갖고(`validate-project-profile.ts`가 `exactKeys(["steps"])`로 강제),
       Proposal(§9.1)에는 `actor_profile`만 있으며, Task Contract 12 field에도 Auditor profile이 없다.
       naming convention으로 유추할 수 있는 것은 authority가 아니다.
     decision:
       · operation identity 분리: `op:<attempt>:audit-spawn` + `op:<attempt>:auditor-turn:<n>`.
         §16.2가 허용하는 단 한 번의 AUDIT_INVALID 재시도는 **동일 session의** `auditor-turn:2`이며
         `audit-spawn:2`를 만들지 않는다. crash semantics는 M1-8 그대로(AT1–AT5, §21).
         (**M1-13이 이 항목의 operation identity만 대체한다** — turn key는 candidate 한정
         `auditor-turn-1|2:<candidate_sha>`, decision key는 `audit-decision:<candidate_sha>`가
         현행이다. spawn이 Attempt 단위라는 점과 crash semantics는 그대로다. 위 문장은 M1-10
         시점의 기록이며 현행 규범은 §16.1/§21이다.)
       · Auditor runtime profile authority: Project Profile의 pipeline body에 `auditor_profile`
         (role_profile_id reference)를 추가하고, steps에 AUDITOR가 있을 때만 필수로 강제한다(§7.1a, §7.3 S4a).
         해소 chain은 `Task Contract.pipeline_id + 고정된 compiled_profile_hash → pipelines[…].auditor_profile
         → roles[…].runtime_profile`이며 전부 immutable이라 restart 후 동일하게 재구성된다.
       · §16.1의 "Broker에서 auditor grant 확보" 표현을 정정: grant는 §12.7 activation에서 이미
         발급되어 Task Contract에 frozen되어 있으므로 AUDITING 진입 시에는 **load·검증·재사용**이다.
       · transition commit point: Auditor session이 authoritative하게 존재하고 최초 turn이 accepted되고
         RuntimeTurnHandle을 durable하게 쓸 수 있을 때에만 AUDITING이 된다. 그 전까지 Attempt는 VERIFYING이다
         — Auditor turn을 특정할 수 없는 durable AUDITING을 만들지 않기 위해서다.
     대안을 버린 이유:
       actor runtime_profile 재사용 / `"auditor"` 하드코딩 / roles 첫 entry / 설치된 유일 profile /
       adapter default / instruction 안의 model 지정 / `CapabilityGrant.role==AUDITOR`로부터의 유추는
       모두 authority가 아니다 — `CoreExecutionRole`·`role_profile_id`·`runtime_profile`은 서로 다른
       namespace이고, grant는 authorization이지 runtime 선택이 아니다(§12, §13). Proposal에
       `auditor_profile`을 추가하는 안은 Spec이 Supervisor에게 준 것이 **Actor** profile 선택 권한뿐이므로
       채택하지 않았다.
     불변:
       Spec 변경 없음(pipelines의 body는 Spec이 고정하지 않으며 TD가 이미 `{steps}`로 정밀화했다).
       Supervisor Proposal 변경 없음. Task Contract 12 field 변경 없음. Compiled Profile은 refine된
       Project Profile을 그대로 실어 나르므로 별도 변경 없음. schema v5 / 17 tables 유지 —
       `auditor_session`/`audit_launch`/`audit_turn`/`runtime_operation`/`result_channel` table 금지.
       ResultChannel arming은 RuntimeAdapter 소유이며 Core에 channel operation을 만들지 않는다(RA-2b).
     영향:
       B7/B8/B9의 결과는 그대로다. B10은 이 record가 고정한 순서로만 구현한다:
       Evidence 자격 재계산 → §11 drift gate → RA-4 preflight → spawn INTENT/DONE → turn INTENT →
       send_turn → (turn ref + turn DONE + VERIFYING→AUDITING) 원자 commit.

M1-9 MVP 1 asynchronous VerificationAdapter lifecycle
     — **분류: Platform-local concrete contract refinement. 새 architecture 방향이 아니다.**
       이미 확정된 `Verification Coordinator → VerificationAdapter → replaceable Verification Backend`
       경계를 MVP 1 lifecycle이 실제로 표현할 수 있게 만드는 정밀화다.
     gap:
       동기 `run_verification(...) -> VerificationEvidence[]` 하나로는
       `IMPLEMENTING → VERIFYING → AUDITING`을 표현할 수 없었다. 검증 실행은 VERIFYING 구간 전체에
       걸쳐 있는데, 동기 계약으로는 (a) Evidence가 나올 때까지 blocking해 VERIFYING을 붕괴시키거나
       (b) 빈 배열/placeholder Evidence를 "시작됨"으로 오버로드하는 두 길밖에 없고 **둘 다 금지**다.
       그 결과 §19.3/§26이 generic transition을 `Core → WorkflowAdapter.start`로 적어
       §5.7/§15.1 및 Spec §37의 backend 경계와 충돌했다 — 즉 `LocalVerificationAdapter →
       CIValidationAdapter` 교체가 Core 변경 없이 성립하지 못했다.
     decision:
       · v1 concrete VerificationAdapter를 **async start/observe**로 정밀화(§15.1a):
         `start_verification(operation_context, verification_profile, repository_snapshot,
         task_contract_snapshot, candidate_commit) -> STARTED{run_handle} | BLOCKED`,
         `get_verification_result(run_handle) -> RUNNING | COMPLETED{evidence} | FAILED`.
       · `VerificationOperationContextV1 { op_key }` (exact 1 field) — RuntimeOperationContextV1과
         같은 패턴이되 별개 contract. `VerificationRunHandle` 신설 — opaque/non-secret/adapter 소유,
         generic 경계에서 `WorkflowHandle`과 동일하지 않다.
       · 동기 `run_verification`은 v1 production callable surface에서 **제거**하며 병존하지 않는다
         (execution authority 이중화 금지). 동기 backend는 첫 observation에서 곧바로 terminal을 반환한다.
       · `COMPLETED`는 backend 실행의 terminal일 뿐 verification PASS가 아니다 — binding(§15.2)과
         policy(§15.3) 판정은 Platform이 계속 소유하고 `binding_valid`도 Coordinator가 계산한다.
         `FAILED`는 기존 `VERIFICATION_INFRA`로 매핑한다. Evidence 내부 `ERROR`(check 단위)와 다르다.
     boundary:
       Core → VerificationAdapter. LocalVerificationAdapter → (필요 시 RuntimeAdapter preflight/controller
       glue) → WorkflowAdapter/durable-jobs. verification 실행 경로에서 `WorkflowControllerHandle`은
       **VerificationAdapter 아래**에서 소비된다. RA-3는 CLOSED로 유지된다 — 이미 닫힌 primitive를
       어느 adapter 층이 소비하는지만 바뀐다. §16.3의 audit gate는 계속 Core가 `WorkflowAdapter.audit_decide`를
       controller handle로 호출한다(그 경로는 이 record가 건드리지 않는다).
     불변:
       Spec 변경 없음. `platform/verification-evidence` v1 변경 없음. schema 변경 없음
       (v5 / 17 tables — `verification_run`/`workflow`/`verification_job`/job registry 신설 금지;
       durable projection은 `adapter_metadata` + `idempotency` + `verification_evidence`로 충분).
       WorkflowAdapter/RuntimeAdapter 공개 contract 변경 없음. 새 failure reason 신설 없음
       (`VerificationStartResult.BLOCKED`는 adapter operation 결과이지 Task/Attempt taxonomy 값이 아니다).
       Runtime turn / verification run / workflow / CI job을 공통 JobHandle framework로 일반화하지 않는다.
     영향:
       MVP1-B7의 repository/candidate mechanics(단일 candidate 관측, candidate-bound op_key, lineage·
       tracked-clean, frozen contract hash/profile, 트랜잭션 밖 외부 호출, 원자적 최종 commit,
       duplicate external effect 0)는 전부 그대로 유지되고 **adapter 소유권/lifecycle contract만** 바뀐다.
```

### 30.2 MVP 1 backend blocker (실측 확정 — 추측으로 닫지 않는다)

```text
RA-1  **CLOSED** (2026-08 read-only deep audit) — OpenClaw managed session spawn.
      measured / resolved:
        - actual spawn primitive: `AcpRuntime.ensureSession({sessionKey, agent, mode, cwd, …})`
          (`extensions/acpx/src/runtime.ts`; 획득 경로 `src/acp/control-plane/manager.runtime-handle-ensure.ts`)
          — 종전 근거였던 `spawn_agent`(Codex tool-name alias)와 subagent registry(retired legacy store)는
          성립하지 않는다
        - role/runtime_profile 매핑: `ensureSession.agent` → agent registry 이름. Platform adapter의
          config glue로 가능(발명 불필요)
        - tool allow/deny mechanism: 존재 (`src/mcp/plugin-tools-serve.ts`의 explicit allowlist/denylist
          수집 경로)
        - permissionMode: 존재하며 값 집합이 확정적 — `approve-all | approve-reads | deny-all`
          (`extensions/acpx/src/config-schema.ts`)
        - cwd/workspace: `ensureSession.cwd` 전파 존재, 패치 셀에서 host-authoritative
          `OPENCLAW_TOOLS_MCP_WORKSPACE_DIR`로 주입(model 입력 아님). **filesystem sandbox는 아니다**
        - receipt_supported: **false** — backend source 전체에 enforcement-receipt/applied-means 개념이
          존재하지 않는다. allowlist/permissionMode/workspace는 configuration intent이지 적용 사실의
          회신이 아니다. §12.6이 허용하는 valid state이며 그 자체로 RA-1 실패가 아니다
      위 measured 항목 어느 것도 §12.3의 conservative enforcement assurance를 승격하지 않는다.
      RA-1a  **CLOSED (adapter-only — OpenClaw patch 불필요).** Core-facing RuntimeSessionHandle은
             OpenClaw 타입일 필요가 없다(§13.1). OpenClawRuntimeAdapter가 기존 persisted non-secret
             metadata만으로 구성한다:
             ```text
             RuntimeSessionHandle (Core에는 opaque) = { agentId, session_id }
               agentId     = 세션 store의 owner partition 키
                             (`resolveStorePath(storeConfig, {agentId})` — "resolved database is
                              partitioned per owner"), spawn 시 adapter가 이미 알고 있다
               session_id  = entry.sessionId = randomUUID() (`src/gateway/sessions-patch.ts`)
                             — "assigning an id makes them real"이므로 실 세션 entry에는 항상 존재
             resolution: loadCombinedSessionStoreForGateway(cfg, {agentId}) 로 owner store에 한정 →
               resolveSessionKeyFromResolveParams({sessionId, agentId}) → canonical sessionKey
               → ensureSession(...) 로 AcpRuntimeHandle 재획득 → startTurn/getStatus/cancel/close
             ```
             "sessionId can collide across stores"(`src/gateway/sessions-resolve.ts`)는 **owner store
             간** 충돌이므로 `agentId` scope가 제거하고, 남는 ambiguity는 기존 resolver가 이미
             `INVALID_REQUEST`로 **fail-closed** 처리한다(다중 매치 시 조용히 고르지 않는다).
             spawn-side 도출도 추가 조회가 필요 없다 — ensure 경로가 이미 호출하는
             `upsertAcpSessionMeta`가 `SessionEntry`를 반환한다.
             raw `sessionKey`는 adapter 프로세스 메모리에서만 사용되고 Platform durable state에는
             `{agentId, session_id}`만 남는다(§18.1c `adapter_metadata`, 새 table·registry·identity
             scheme 없음). handle은 authority가 아니라 **재식별용 non-secret reference**이며 실제
             trusted identity 소유는 계속 OpenClaw Runtime에 있다.
      RA-1b  **CLOSED.** `AcpRuntime.startTurn(input) -> AcpRuntimeTurn` (§13.1). 단 `requestId`를
             restart-safe result lookup으로 확대 해석하지 않는다 — 그것은 RA-2다.
RA-2  **CLOSED** (RA-2a CLOSED / RA-2b CLOSED).
      RA-2a **CLOSED — existing primitive.** `AcpRuntimeTurn.result: Promise<AcpRuntimeTurnResult>`가
             terminal authority다(`packages/acp-core/src/runtime/types.ts`). exact shape은
             `{status:"completed"|"cancelled", stopReason?}` 또는 `{status:"failed", error:{message,
             code?, detailCode?, retryable?}}` — 3-상태 union이며 output/timestamp/usage/session id는
             없다. `src/acp/control-plane/manager.turn-stream.ts`의 `consumeAcpTurnStream`이 result와
             event stream을 함께 정규화하고 result가 terminal 판정을 소유한다(event `done`은 legacy
             fallback). backend_status mapping: COMPLETED←`completed`, CANCELLED←`cancelled`,
             RUNTIME_ERROR←`failed`, TIMEOUT←adapter 소유 deadline(acpx는 `timeoutMs:0`으로
             중립화되고 OpenClaw가 deadline을 소유한다 — `AcpRuntimeError{code:"ACP_TURN_FAILED",
             detailCode:"TURN_TIMEOUT"}`), SESSION_LOST←`detailCode:"SESSION_RESUME_REQUIRED"`
             (cause chain 포함). `started_at`/`completed_at`은 backend native timestamp가 없어
             adapter 관측값이다 — semantic authority가 아니다(§13.2). live `AcpRuntimeTurn`↔
             Platform `RuntimeTurnHandle` 연결은 **process-local ephemeral**이며 restart 후
             재획득 불가 — 기존 §19.3e/§21 fail-closed semantics를 유지한다.
      RA-2b **CLOSED — adapter/plugin-only glue** (2026-08 구현 + deterministic 검증).
             gap이었던 것: managed plugin-tools MCP server는 **session당 한 번 spawn되는 subprocess**이고
             (`extensions/acpx/src/config.ts` — `command: process.execPath, args:[plugin-tools-serve.js]`,
             env에 host가 session identity를 주입), agent가 그 subprocess와 **직접** MCP로 말하므로
             host가 tool call마다 turn identity를 끼워 넣을 지점이 없다. gateway의 `activeTurnBySession`은
             다른 프로세스에 있고 session으로만 keyed되며 requestId를 담지 않는다(`manager.turn-runner.ts`),
             `markAcpTurnActive`는 session liveness boolean이고, turn identity를 노출하는 gateway RPC는
             없다. 즉 **submit 쪽에서 turn을 알 방법이 없다.**
             해결: turn binding을 반대쪽에서 세운다 — adapter가 turn 시작 전에 session별 slot을
             **arm**하고, tool은 자기 session에 arm되어 있는 slot에 payload만 쓰며, adapter는 자기가 arm한
             turn과 일치할 때만 **collect**하고 닫는다. Model은 identity를 전혀 공급하지 않는다(§8):
             turn을 지목할 수도, 다른 session의 slot에 닿을 수도, 이전 turn의 write를 다음 turn의 결과로
             만들 수도 없다. T1–T5 전부 성립하며 **OpenClaw core patch는 필요 없다**(G1–G7 모두 불성립).
             저장은 repository 밖의 ephemeral host-owned 디렉터리이므로 candidate diff에 섞이지 않는다
             (I-TD6). Auditor는 `repository.feature_write=false`인 채로 `platform-auditor-verdict-v1`를
             제출할 수 있고, envelope 검증은 §16.2 validator를 그대로 쓴다(Coordinator 소유의 의미 검증은
             하지 않는다). 동일 payload 재제출은 idempotent, 다른 payload는 fail-closed다.
             **미검증 잔여:** 이 구현은 deterministic test로만 증명되었고 live 환경에서 실행되지 않았다 —
             RA-4 preflight가 여전히 `BLOCKED(C2,C3,C4,C5)`이고, 제출 tool을 담을 Platform 소유 plugin의
             배포는 RA-4 host binding에 종속된다.

RA-3  **CLOSED — adapter-only glue** (2026-08 read-only deep source audit). Platform
      WorkflowControllerHandle은 durable-jobs가 실제로 쓰는 owner tuple에 매핑된다.
      - **owner identity 실측:** `computeOwnerKey`(durable-jobs `dist/workflow-service.js`)는
        trusted context에서 `agent:<agentId>|session:<sessionKey>`, context-free에서
        `agent:<agentId>|ws:<resolve(workspaceDir)>`이다 — lone sessionKey도 deliveryRoute도
        identity가 아니다. workflow record는 `ownerKey` + `parent{agentId, sessionKey, sessionId,
        requesterOrigin}`를 persist하고, `authorizeWorkflowAccess`는 trusted 경로에서
        **agentId와 sessionKey 둘 다** 정확히 일치할 것을 요구한다(2-factor).
      - **audit_decide owner equality:** `authorizeAuditor`는 `ctx.sessionKey`가 있고
        `parent.agentId`/`parent.sessionKey`와 정확히 일치할 때만 통과한다
        (`WORKFLOW_AUDIT_ACCESS_DENIED`). context-free owner·worker·다른 session은 workflow id를
        알아도 거부된다 → §16.3의 controller equality가 backend에서 강제된다. Core가 owner를
        주장할 자리는 없다.
      - **controller identity 형태:** ACP session key는 config로부터 결정적으로 파생된다
        (`buildConfiguredAcpSessionKey` → `agent:<agentId>:acp:binding:<channel>:<accountId>:<hash16>`,
        `src/acp/persistent-bindings.types.ts`) — 난수가 아니므로 **ordinary restart에 안정적**이다.
        따라서 Managed Platform-Controller Session은 `(agentId, sessionKey)` 쌍으로 재획득 가능하고,
        adapter는 §13.1의 `AcpRuntime.ensureSession` 경로로 같은 session을 다시 연다. Core는 계속
        opaque handle만 보유한다(RA-1a의 non-secret `{agentId, session_id}` scheme 재사용 — 두 번째
        identity framework를 만들지 않는다).
      - **restart:** ordinary process/Gateway restart → 같은 owner로 접근 유지. STATUS_workflow_harness
        §5.2가 이를 live로 관측했다(workflow record + frozen parent identity가 Gateway restart를
        생존, 같은 session이 restart 후 접근). **true identity loss**(sessionKey 자체가 바뀜) →
        `WORKFLOW_FORBIDDEN`으로 fail-closed하며 **owner가 자동 이전되지 않는다**. MVP 1은 이
        fail-closed를 수용하고, owner migration/reconciliation은 later recovery scope다.
      - **start idempotency:** `(ownerKey, requestId)` 기준으로 동일 payload는 같은 workflow를
        재사용하고 다른 payload는 `WORKFLOW_REQUEST_CONFLICT`다 — Platform op_key → requestId
        매핑이 owner identity를 약화시키지 않는다.
      - **service identity API: PARTIAL / unsuitable.** durable-jobs config의 `owners[]`
        (`ownerAgentId`/`ownerSessionKey`/`workspaceDir`/`allowedRoots`/`deliveryRoute`)는 owner를
        *인가*할 뿐이며, context-free 호출은 static owner sessionKey를 채택하지 않는다(rotation rot
        방지). context-free owner는 `audit_decide`가 거부되므로 controller identity를 대체할 수 없다.
        따라서 TD의 managed-controller-session 접근을 그대로 유지한다 — 새 service identity API를
        발명하지 않는다.
      - **남는 조건은 RA-3가 아니라 RA-4다.** trusted `agentId`/`sessionKey`를 tool context로
        전달하는 managed plugin-tools binding이 없으면 `workflow.start`가 context-free로 떨어져
        gate가 fail-closed한다(STATUS_workflow_harness §5.1). 이는 RA-4 preflight가 이미 기록한
        미배포 patch(C2–C5)이며 §30.2의 environment readiness 항목이지 새 backend gap이 아니다.
      - **미검증 잔여:** `audit_decide` owner-equality는 **source-proven이며 live 미실행**이다
        (`workflowAuditEnabled=false`, STATUS_workflow_harness §5.2 — H4/H5/H6 DEFERRED).
RA-4  **CLOSED** (2026-08 read-only audit) — ACPX/core 패치 preflight self-check의 구체 검사 항목 확정.
      preflight는 **어떤 Runtime external side effect보다 먼저** 실행되며 결과는 `READY` 또는
      `BLOCKED(reason[])` 둘뿐이다. generic environment-health framework를 만들지 않는다.
      ```text
      C1  core dist에 OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY mechanism 존재
      C2  core dist에 OPENCLAW_TOOLS_MCP_WORKSPACE_DIR mechanism 존재
      C3  @openclaw/acpx 설치·해석 가능
      C4  acpx에 resolveOpenClawCoreDistEntry behavior 존재
      C5  해석된 core dist entry가 patched plugin-tools serve 구현을 실제로 가리킴
      C6  permissionMode가 유효 값으로 명시 설정됨
      C7  core/acpx version provenance 기록 (보조 — version 문자열 단독은 PASS authority가 아니다)
      READY  ⟺ C1–C6 통과.  그 외 → BLOCKED(reason[])
      ```
      검사는 version string이 아니라 **required behavior/symbol/path의 실재**를 본다. source naming이
      이후 바뀔 수 있으므로 구현 시 현재 tree에서 심볼을 재확인한다.
      **CLOSED는 preflight contract가 닫혔다는 뜻이지 현재 환경이 READY라는 뜻이 아니다.** 실측된 현재
      live install(`openclaw 2026.7.1-2`)은 C2/C3/C4/C5 실패 → `backend preflight = BLOCKED`. 패치 lab
      source에는 필요한 host fix가 있으나 working-tree 상태이며 배포 가능한 패키지가 아니다
      (`source capability evidence ≠ clean distributable backend package`). packaging 개선은 아래
      §30.4 backend caveat/deployment work로 남는다 — preflight가 그 차이를 fail-closed로 잡기 때문에
      RA-4 자체는 CLOSED로 둘 수 있다.
```

### 30.3 MVP 2 blocker (기존 유지)

```text
capability enforcement audit (P-a, §14.5)
Actor canonical write denial의 실제 boundary 확보
merge bypass resistance 검증
optional: GitHub protected-remote 전략(P-b) 채택 여부 결정
```

RA-1–RA-4는 MVP 1 구현 착수 시 backend 실측으로 닫는다. 30.3은 MVP 2 전 별도 backend 작업이다.
어떤 항목도 본 TD의 architecture decision을 재개방하지 않는다.

---

## 31. Platform Seam / Hotspot Register (v1.2 신설)

[계약] 이 register의 운영 규칙: **evidence-only**다. 여기의 행은 구현 leaf의 admission 근거가 아니고,
로드맵/우선순위 authority도 아니다. 각 행은 resolve trigger가 실제로 발화할 때만 통상 절차로
소비된다. 행 추가/변경은 material change에 한하며, 상태(pass/fail)는 여기 복제하지 않는다 —
STATUS/HANDOFF가 이긴다. (형식은 IO fork Atlas #309의 hotspot 규율 준용.)

| 중요도 | Seam | 왜 위험한가 | 근거 상태 | Resolve trigger |
|---|---|---|---|---|
| High | Verification run metadata의 candidate 비한정 | 좁은 crash/rework 창에서 이전 candidate의 run 관측이 이후 candidate에 보수적으로 귀속될 수 있음. Evidence target binding이 false PASS는 막으므로 영향은 liveness/불필요 rework | FACT (deterministic; HANDOFF §19) | live 재현 시 §17 이슈 패킷으로 회수. 선제 재설계 금지 |
| High | RA-2 잔여 — turn 완료 관측 신호 + RuntimeResultChannel 구체 경로 | envelope 계약은 닫혔으나(§13.2) 수집 채널의 실체가 미확정. TURN_TEXT fallback은 Verification이 흡수하지만 Auditor verdict는 structured 필수 | 부분 MEASURED(RA-1b) / 잔여 INFERRED | 첫 live Actor/Auditor turn |
| High | RA-3 — controller session 재-acquire와 기존 workflow ownership 정합 | owner-고정 semantics에서 controller 교체 시 기존 workflow 접근성이 미실측 | INFERRED | controller session 재시작 실험 (RA-4 READY 이후) |
| High | RA-4 C2–C5 — 배포 환경 조건 | patched source ≠ 배포 가능 패키지. preflight가 fail-closed로 잡음 | FACT (§30.2 원장; 현재 상태는 STATUS 소유) | production composition root 착수 시 remediation |
| Medium | `receipt_supported=false` 경로의 live 거부 | 고신뢰 operation의 V10 거부가 deterministic으로만 증명됨 | FACT(테스트) / live 미증명 | RA-4 READY 후 첫 spawn |
| Medium | audit_decide live round-trip DEFERRED | `[D]`-only. 실패 방향이 fail-closed(`WORKFLOW_AUDIT_UNAVAILABLE`)라 안전측 오류만 존재 | FACT (harness STATUS §5.2) | 첫 live Auditor commit (§16.3) |
| Medium | EXPLAINABLE recovery 분류 미생산 | MVP 0 recovery는 무결성 분류만. 외부 authority 관측이 붙기 전까지 catch-up 부재 | FACT (STATUS mvp0 §7) | MVP 4 reconciliation 착수 |
| ~~High~~ | ~~I-TD8~I-TD12 applicability map 미작성 — main-sync gate~~ | **RESOLVED (v1.4 rev.2)** — §31a에 5개 invariant 분류 완료(소급 무효화 0건, sealed 코드 변경 요구 0건). gate 조건 B 충족 | 원장 | — |
| Low | TD monolith 분리 — 운영성 계약(§5.11/§5.12)의 별도 Ops/readout 문서화 | 문서 계층 경계(§1.1 [설명]) 유지 비용 — main TD를 더 키우지 않기 위함 | FACT (v1.4, practitioner review 권고) | main-sync 시 분리 여부 결정 |
| High | **C-03** — strong Spec/TD → bounded work graph **one-shot Plan Compilation seam** (pre-TaskSource compiler) | Spec/TD-only input 전체를 run 전 graph로 compile하는 문제. D24/#59의 Human-authorized runtime **one-child** materialisation seam과 input/timing/parent authority가 다르며 D24는 C-03을 채택·해결하지 않는다. C-03을 구현하려면 별도 compiler + approval + idempotent graph publish와 아래 reopening trigger가 여전히 필요. **ARCHITECTURE REOPENING 필요 — 채택 아님** | CANDIDATE (material assessment; "one-shot 충분성"은 hypothesis, MEASURED 아님) | (a) 수동 graph 작성 비용/오류 실측, (b) compiler input/output·provenance·approval·idempotency·graph validity 계약 합의, (c) 수동 대비 bounded one-shot 실험 유의미 — 셋 충족 시 reopening 절차 |
| Medium | **C-12** — exact-approved deterministic finalization + expected-old-head **CAS publication**의 composed transaction | 구성 원리(exact binding, frozen proposal, fresh revalidation, CAS, write-ahead)는 각각 보유하나 native composed path 부재. **ARCHITECTURE REOPENING 필요 — 채택 아님.** #5(DELTA-3)와 원리는 같고 대상이 다름 — C-12=Task candidate publication chain, #5=플랫폼 자기 배포 승격. 중복 생성 금지 | CANDIDATE (IO Foundation #20 단일 사례; upstream native 존재는 INFERRED 부정 — C-13) | Foundation 외 두 번째 use case 출현, 또는 ADP 자기 deployment promotion에서 Human-authorized deterministic transform이 실제 필요 + exact input/output/failure/reconciliation 계약 합의 |
| Low | Diagnostic/Measurement Projection의 component 승격 여부 | §5.11/§5.12는 contract로 시작 — heavyweight component화는 미결정 | FACT (v1.3 신설) | 라이브 파일럿에서 구현 경험 축적 후 |
| Medium | automatic evidence-based model routing authority | §5.14 recommendation은 read-only이고 current Runtime binding은 §13.5로 고정. Measurement를 policy로 직접 소비하거나 mid-attempt fallback할 authority는 없음 | DEFERRED / CANDIDATE (v1.5; 채택 아님) | role별 comparable corpus와 충분한 sample이 축적되고, Human이 Execution Policy의 eligibility/window/floor/fallback/rebind/recovery contract를 승인할 때 |
| ~~Low~~ | ~~§13.1 기존 행의 증거 등급 소급 표기~~ | **RESOLVED (v1.3)** — §13.1 하단에 행별 명시 등급 목록 추가 | 원장 | — |

---

## 31a. I-TD8~I-TD12 Applicability Map (main-sync gate 산출물, v1.4 — rev.2)

[원장] §31의 main-sync gate 조건 B 이행. 목적은 conformance 채점이 아니라 **`new design requirement
≠ old implementation retroactively invalid`**를 durable하게 고정해, 구현자가 `FORMAL COMPLETE`와 새
MUST 사이를 임의 해석하지 않게 하는 것이다. MVP 0/1 FORMAL seal은 이 map으로 변경되지 않는다.

근거: main `20264c4` (TD blob `e738921`) 기준 read-only 확인 — 파일/메서드/호출부 직접 열람.
DesignEvidenceGrade 병기(§1.1). **rev.2**: 소스 재대조로 rev.1을 정정했다 — I-TD9 분류·등급 조정,
I-TD10 근거 교체, I-TD11 근거 보강, I-TD12의 존재하지 않는 `discard` 및 durable-before-close 주장
철회(원장은 §31a 말미).

| Invariant | 분류 | 근거 (read-only) | 구현자에게 주는 의미 |
|---|---|---|---|
| **I-TD8** ownerless 상태 금지 | `PROSPECTIVE_REQUIREMENT` | **MEASURED** — sealed core에 표준 `next_owner` 필드/canonical derivation 없음(검색 0건). HELD reason · PendingDecision · outbox 등 **원천 fact는 존재**하나 v1.4가 요구하는 explicit derivation은 미존재 | sealed 코드 수정 불요. next-owner는 **도출(derivation)** 로 신설하며 첫 소비자는 §5.11/§5.12. 신규 HELD/terminal reason 추가 시 "도출 가능성"이 binding |
| **I-TD9** mutation-reach 선언 | `PROSPECTIVE_REQUIREMENT` | **MEASURED** — `adapters/interfaces/repository-adapter.ts` interface 전수 확인: `snapshot_canonical / create_feature_workspace / inspect_candidate / get_diff / verify_tracked_clean / verify_expected_files / verify_lineage / verify_canonical_head / prepare_merge / commit_merge` 10개 operation에 reach 분류 metadata 없음(`READ_ONLY|WORKSPACE_SCOPED|mutation_reach` 0건) | 계약 선언 추가이며 기존 동작 변경이 아님 — 그래서 DELTA가 아니라 PROSPECTIVE다. 신규 operation은 선언 없이 추가 불가 |
| **I-TD10** 관측 ≠ actuation (scope-bound admission 포함) | `ALREADY_CONFORMANT` | **MEASURED** — 주 근거: ProductionCoordinator가 durable state에 따라 단일 use-case를 dispatch하고 lifecycle rule을 중복 구현하지 않으며, 외부 operation이 attempt/op identity + repository scope binding 위에서만 움직임. 보조: `WorkflowObservation`이 transition fact가 아님(STATUS mvp0 §6) | 변경 없음. MVP 3 scheduler 설계 시 사전 구속으로 작동 |
| **I-TD11** presentation ≠ routing | `ALREADY_CONFORMANT` | **MEASURED** — envelope 기반 전진, model text 비권위(CORR1 봉인) **+ durable state/PendingDecision ≠ Report Outbox transport**: report 전송 실패가 완료된 lifecycle fact를 롤백하지 않음(MVP1 STATUS; HANDOFF §20) | 변경 없음. 라이브 runner가 Coordinator를 우회하면 그것이 finding(HANDOFF §11) |
| **I-TD12** capture-before-teardown | `PROSPECTIVE_REQUIREMENT` | **MEASURED** — sealed scope의 ephemeral 파기 primitive는 `RuntimeResultChannel.close(session_ref, turn)`(armed turn 일치 시 `rmSync`). 공개 메서드는 `arm / submit / collect / close`이며 `discard`는 존재하지 않는다. `collect`는 결과 객체를 읽어 반환할 뿐 durable store에 쓰지 않고 `close`는 독립 메서드이므로 **채널 자체로는 durable-capture-before-close가 증명되지 않는다**. 추가 사실: core/adapters에 `collect`/`close` **production 호출부가 아직 없음** — 순서 보장은 향후 호출부에서 성립시켜야 함. worktree/verification sandbox teardown path는 sealed scope에 미존재 | sealed teardown path 소급 적용 없음(§2 PROSPECTIVE 선언과 일치). teardown-DENY predicate는 **라이브 composition에서 신설되는 파기 경로 + 그 호출부의 순서 보장**부터 binding. `PILOT_BOUND_VALIDATION`으로 낮추지 않음 — 요구는 지금 존재하고 pilot은 증명 장소일 뿐 |

**Gate 판정 (rev.2):** 조건 B 충족 — 5개 invariant 분류 완료, 소급 무효화 0건, sealed 코드 변경
요구 0건. I-TD9·I-TD12 근거는 직접 열람으로 MEASURED. 잔여는 통상 절차의 leaf가 되며 main-sync를
막지 않는다.

**[원장] rev.1 오류와 정정.** rev.1은 I-TD12 근거를 `rmSync` 주변만 grep해 메서드명(`discard`)과
호출 순서(durable-before-close)를 추정해 적었고, I-TD9를 "코드 변경 0건"이라면서 동시에
`IMPLEMENTATION_DELTA_REQUIRED`로 분류하는 taxonomy 모순을 담았다. §1.1의 `MEASURED`는 "해당 경로를
열어 확인"이며 grep 히트 확인이 아니다. 이는 v1.2가 §13.1 매핑을 추측으로 적었다가 실측에 반증된 것과
동일한 실패 유형이다. rev.1 본문은 원장 규율에 따라 소급 삭제하지 않고 이 기록으로 정정한다.

---

*End of Technical Design v1.5 (design-track canonical). 이 문서 이후 구현은 시작하지 않는다.*
