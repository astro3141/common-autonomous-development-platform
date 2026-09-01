Common Autonomous Development Platform — Specification v0.3
Status: SPECIFICATION BASELINE Supersedes: v0.2 Scope: 장기 아키텍처, 책임 경계, 신뢰 모델, 공통 계약, MVP 범위 Non-scope: Technical Design, 구체 클래스/파일 구조, 구현 언어, 데이터베이스 선택, 특정 Runtime 설정
Amendment — ADP #59 Human architecture decision:
Supervisor는 실행 중 whole intent를 bounded child task로 decomposition하고, 완전한 child TaskDefinition
semantics와 explicit parent-child intent를 structured Proposal로 제안할 수 있다. Platform만 Compiled
Profile/Execution Policy/authority boundary를 검증하고 authoritative materialisation을 수행한다. Supervisor는
TaskSource/backend를 직접 mutate하지 않는다. 이 권한은 Profile-declared pipeline/role/verification profile의
선택까지이며 dynamic pipeline/workflow/model topology synthesis를 포함하지 않는다.
이 Specification의 목표는 “또 하나의 coding-agent 제품”을 만드는 것이 아니다.
기존 Runtime·Workflow·Git·CI·Workspace 기능은 가능한 한 재사용하고, 프로젝트 의미·자동화 권한·실행 계약·검증 증거·사람 판단을 deterministic하게 통제하는 공통 Control Plane만 자체 자산으로 만든다.

1. 목적
   Common Autonomous Development Platform은 여러 프로젝트에서 다음 사이클을 안전하게 반복하는 공통 개발 감독 계층이다.
   Project Profile

- Execution Policy
  ↓
  Compiled Profile Snapshot
  ↓
  Supervisor Model
  ↓
  Structured Decision Proposal
  ↓
  Platform deterministic validation
  ↓
  Capability-authorized execution
  ↓
  Actor
  ↓
  Platform-controlled Verification
  ↓
  Independent Auditor
  ↓
  Repository Gate / Human Decision / Rework
  플랫폼은 특정 Runtime 또는 특정 Model을 전제로 하지 않는다.
  다음 교체가 Platform Core 재작성으로 이어져서는 안 된다.
  OpenClaw
  → other Runtime

durable-jobs
→ other Workflow Backend

local Git
→ protected remote repository

local verification
→ CI / sandbox verification

Claude
→ Codex / other model

2. 최상위 불변조건
   다음은 장기 Architecture Invariant다.
   Runtime ≠ Platform
   MCP ≠ Platform Core
   ACP ≠ Platform
   OpenClaw ≠ Platform
   durable-jobs ≠ Platform
   Claude ≠ Platform
   infra-scanner ≠ Platform
   TaskSource ≠ Platform durable state
   CI ≠ Platform
   GitHub ≠ Platform
   책임 경계:
   Model proposes.
   Platform validates.
   Capability boundary authorizes.
   Runtime executes.
   Verification proves.
   Auditor reviews.
   Repository Gate merges.
   Human decides only where policy requires.
   그리고:
   Project-specific semantics
   = Project Profile

Automation authority
= Execution Policy

Execution contract
= Immutable Task Contract Snapshot

Runtime authority
= Backend-authoritative identity/capability boundary

Platform lifecycle / safety policy
= Generic Core

3. 시스템 토폴로지
   초기 OpenClaw 기반 deployment의 논리 구조:
   Human / Slack / UI
   │
   ▼
   ┌───────────────────────────┐
   │ Agent Runtime │
   │ OpenClaw │
   │ │
   │ Supervisor RuntimeSession │
   └────────────┬──────────────┘
   ▼
   Supervisor Model
   │
   │ MCP
   ▼
   ┌────────────────────────────────┐
   │ Common Platform API Adapter │
   ├────────────────────────────────┤
   │ Common Platform Core │
   │ │
   │ Profile Compiler │
   │ TaskSource Coordinator │
   │ Decision Validator │
   │ Capability Broker │
   │ Durable State │
   │ Task / Batch Coordinator │
   │ Verification Coordinator │
   │ Repository Gate │
   │ Pending Human Decisions │
   └──────────────┬─────────────────┘
   │
   Backend Contracts
   ┌─────────┼─────────┬──────────────┐
   ▼ ▼ ▼ ▼
   Runtime Workflow Repository Verification
   Adapter Adapter Adapter Adapter
   현재 Runtime 내부에서 Supervisor가 ACP를 사용할 수 있으나:
   ACP
   =
   OpenClawRuntimeAdapter 구현 세부사항
   이다.
   현재 Supervisor가 Platform을 MCP로 호출할 수 있으나:
   MCP
   =
   Platform API transport
   일 뿐 Platform Core 자체가 아니다.

4. Platform이 직접 만드는 것
   본 프로젝트의 핵심 자체 자산은 다음이다.
   Project Profile Contract

Execution Policy Contract

Profile Compiler

Compiled Profile Snapshot

Decision Validator

TaskSource Contract

Child Task Materialisation Contract

Immutable Task Contract Snapshot

CapabilityGrant / Capability Broker

Generic Task / Batch State Machine

Platform Durable State

Verification Policy / Evidence Binding

PendingHumanDecision

Repository Gate Policy

Recovery / Reconciliation Policy
이 영역은 특정 Agent Runtime이나 Git provider에 종속시키지 않는다.

5. Platform이 다시 만들지 않는 것
   기존 Backend가 적절한 기능을 제공한다면 다음을 Platform Core에서 다시 구현하지 않는다.
   coding agent implementation

terminal emulator

generic process runner

Git worktree engine

GitHub/Jira client

PR UI

diff viewer

CI engine

model provider client

chat UI

Slack transport

agent session manager

generic workflow engine
예:
OpenClaw
→ Runtime/session primitive 재사용

durable-jobs
→ durable workflow primitive 재사용

Git
→ repository primitive 재사용

GitHub
→ protected branch / CI / merge primitive 선택적 재사용
Platform은 이 기능들을 Adapter contract 뒤에서 사용한다.

6. Project Profile
   Project Profile은 프로젝트가 무엇인지 정의한다.
   자동화 권한의 최종 Source of Truth는 아니다.
   예:
   project_profile:
   id: infra-scanner
   version: 1

repository:
...

task_sources:
...

contract_sources:
...

classifications:
READY_ITEM:
default_execution_policy: AUTO_EXECUTE

    THIN_FOUNDATION:
      default_execution_policy: AUTO_SUBFLOW

    MAJOR_FOUNDATION:
      default_execution_policy: HOLD_HUMAN

    CONTRACT_CHANGE:
      default_execution_policy: HOLD_HUMAN

roles:
...

pipelines:
...

verification_profiles:
...

hooks:
...
Project Profile 책임:
Repository identity/location

Task Sources

Contract Sources

Project-specific classifications

Pipeline definitions

Verification Profiles

Role preferences

Project-specific hooks

Project semantics
다음 용어는 Platform Core가 이해하지 않는다.
READY_ITEM
THIN_FOUNDATION
MAJOR_FOUNDATION
CONTRACT_CHANGE
U-54
Primitive
Evidence
PROJECT_STATUS

7. Execution Policy
   Execution Policy는 어느 정도의 자율성과 권한을 허용할 것인가를 정의한다.
   예:
   execution_policy:
   id: autonomous-safe
   version: 1

auto_merge: true
allow_auto_subflow: true

batch_policy:
max_tasks: 3
max_rework: 2
concurrency: 1

repository_policy:
remote_push: feature_branch_only
direct_canonical_write: false
allow_force_push: false
allow_tag_change: false
allow_git_clean: false
allow_reset_hard: false

human_gate_policy:
...

verification_policy:
...

capability_policy:
...
같은 Project Profile을 다른 Execution Policy와 사용할 수 있어야 한다.
infra-scanner + human-merge

infra-scanner + guarded

infra-scanner + autonomous-safe
Platform Core는 프로젝트의 “성숙도”를 판단하지 않는다.
다음 Core abstraction은 만들지 않는다.
DISCOVERY_MODE
GUARDED_MODE
AUTONOMOUS_MODE
MATURITY_LEVEL
자동화 강도 차이는 Execution Policy로 표현한다.

8. Remote Push 정책
   remote push 자체를 Platform 전체의 Non-goal로 두지 않는다.
   Execution Policy가 허용 여부와 범위를 결정한다.
   예:
   DENY

FEATURE_BRANCH_ONLY

PLATFORM_MANAGED_ONLY
어떤 경우에도 Actor에게 canonical branch의 직접 mutation 권한을 기본 제공하지 않는다.

9. Compiled Profile Snapshot
   실행 시 Platform은 다음을 합성한다.
   Project Profile

- Execution Policy
- Explicit Approved Overrides
  ↓
  Compiled Profile Snapshot
  예:
  compiled_profile:
  project_profile:
  id: infra-scanner
  version: 1
  hash: ...

  execution_policy:
  id: autonomous-safe
  version: 1
  hash: ...

  approved_overrides:
  hash: ...

  compiled_version: 1
  compiled_hash: ...

  effective:
  ...
  Compiled Profile은:
  Supervisor bootstrap
  Decision validation
  CapabilityGrant 생성
  Task Contract 생성
  Merge eligibility 판단
  의 authoritative input이다.

10. Profile 변경 불변성
    진행 중 Task Attempt는 Profile/Policy 변경을 자동 상속하지 않는다.
    기본:
    new Project Profile
    or
    new Execution Policy

→ next Task 또는 next Batch부터 적용
현재 Attempt에 변경을 적용하려면 명시적으로:
INVALIDATE_ATTEMPT
→ new Compiled Profile
→ new Task Contract Snapshot
→ new Attempt
를 수행한다.
Silent Profile Migration은 금지한다.

11. Backend Capability Manifest
    Backend 교체 가능성을 유지하되 모든 Backend가 같은 기능을 제공한다고 가정하지 않는다.
    각 Adapter는 자신의 capability를 Platform에 선언할 수 있어야 한다.
    개념 예:
    backend_capabilities:
    runtime:
    persistent_session: true
    structured_turn_result: PARTIAL

        authoritative_session_identity: true

        capability_enforcement:
          repository_read: ENFORCED
          feature_write: ENFORCED
          canonical_write_denial: REDUCED
          shell_restriction: NOT_AUDITED

repository:
guarded_merge: true

verification:
provenance_binding: true
Capability Manifest는 특정 OpenClaw feature 이름을 사용하지 않는다.

12. Runtime Identity 요구사항
    Common Platform은 모든 Runtime에게 ACP sessionKey 같은 특정 identity 형식을 요구하지 않는다.
    Generic requirement:
    Runtime이 session identity의 authoritative owner여야 한다.

Model이 자신의 identity를 임의 주장할 수 없어야 한다.

Platform은 결과를 authoritative RuntimeSessionHandle과 연결할 수 있어야 한다.

Runtime session lifecycle을 조회할 수 있어야 한다.
예:
OpenClaw
→ host-managed ACP identity

다른 Runtime
→ server-issued session/workspace identity
모두 가능하다.

13. Backend Compatibility Gate
    Compiled Profile이 요구하는 capability를 선택된 Backend가 제공하지 못하면 실행 전 거부한다.
    예:
    Execution Policy:
    automatic merge allowed

requires:
actor canonical-write denial = ENFORCED
verification provenance = trusted
repository protected merge = available
Backend가 요구사항을 만족하지 못하면:
POLICY_BACKEND_INCOMPATIBLE
또는 동등한 deterministic state로 실행을 거부한다.
Backend 한계를 prompt로 보완해 고위험 작업을 강행하지 않는다.

14. TaskSource Contract
    Platform Core는 PROJECT_STATUS, GitHub Issue, Jira 등을 직접 이해하지 않는다.
    최소 interface:
    discover_tasks(context)
    -> TaskCandidate[]

get_task(task_ref)
-> TaskDefinition

get_dependencies(task_ref)
-> TaskDependency[]

get_task_state(task_ref)
-> ExternalTaskState

update_task_projection(...)
-> optional
구현 예:
ProjectDocumentTaskSource

GitHubIssueTaskSource

JiraTaskSource

StaticTaskSource

TaskSource의 discovery/read authority와 별도로 Platform은 configured TaskSource가 다시 관측할 수 있는 외부
task representation을 만드는 **Child Task Materialisation Contract**를 가질 수 있다. 이것은 generic
TaskSource write API가 아니며 Supervisor에게 direct mutation authority를 주지 않는다. materialisation은
Platform-owned validation과 idempotent actuation 경계를 거쳐야 하고, 성공한 publish 결과도 fresh
TaskSource observation 전에는 executable task admission authority가 아니다.

15. TaskSource와 Durable State의 분리
    TaskSource는 task discovery/input의 authoritative source일 수 있다.
    하지만:
    TaskSource
    ≠
    Platform execution state
    이다.
    예:
    GitHub Issue: OPEN

Platform Task:
VERIFYING
두 상태는 서로 다른 의미다.
Platform은 필요하면 외부 상태를 projection한다.

16. Supervisor 역할
    Supervisor는 판단 모델이다.
    Supervisor 책임:
    Task 후보 평가

bounded child TaskDefinition 및 explicit parent-child intent 제안

Project classification 수행

pipeline 선택

Actor profile 선택

Verification profile 선택

rework / hold / next proposal

merge proposal
Supervisor는 durable coordinator 자체가 아니다.
다음 권한을 가지지 않는다.
자기 CapabilityGrant 확대

Profile 변경

Execution Policy 변경

새 arbitrary pipeline 생성

canonical 직접 mutation

verification PASS 확정

Backend identity 주장

Human Gate 제거

Supervisor는 child의 external identity를 할당하거나 TaskSource/backend mutation을 직접 수행하지 않는다.
child Proposal에서도 pipeline, Actor profile, Verification profile은 Project Profile에 선언된 선택지만 사용할
수 있으며, 새 pipeline/workflow/model topology를 생성할 수 없다.

17. Supervisor Decision = Proposal
    Supervisor의 모든 의미 있는 action은 구조화된 Proposal이다.
    예:
    {
    "decision": "START_TASK",
    "task_ref": "U-XX",
    "classification": "READY_ITEM",
    "pipeline_id": "standard_implementation",
    "actor_profile": "implementation",
    "verification_profile": "collector_changed",
    "reason_refs": [...]
    }
    Platform이 실제 실행 전에 deterministic validation을 한다.

17A. Supervisor Decomposition / Child Task Materialisation
     Supervisor는 한 번의 structured Proposal에서 child 하나의 완전한 task semantics와 explicit parent
     intent를 제안할 수 있다. 여러 child decomposition은 batch/task limit 안에서 이 bounded Proposal을
     반복한다. 한 Proposal이 임의 graph나 dynamic workflow를 생성하지 않는다.

     authority chain:

     Supervisor structured child Proposal
     → Platform schema / Compiled Profile / Execution Policy / parent / batch validation
     → 필요한 Human Gate
     → Platform-owned materialisation operation
     → configured TaskSource-visible representation publish
     → fresh TaskSource re-observation
     → normal discovery / admission / Task Contract / execution path

     child body의 semantic source는 validated Supervisor Proposal이다. Platform/Harness는 Proposal 수신 뒤
     title, description, references, acceptance, parent 또는 Profile 선택을 임의 생성·보완하지 않는다.
     external task identity/version은 materialisation target의 authoritative adapter가 할당하며 Model이
     발명하지 않는다.

     materialisation은 admission이 아니다. publish만으로 parent를 suspend하거나 child를 SELECTED/ACTIVE로
     만들거나 Task Contract를 freeze하지 않는다. TaskSource가 published body를 exact하게 재관측한 뒤에만
     child는 기존 discovery path로 DISCOVERED가 될 수 있고, 기존 START_SUBFLOW validation/admission이
     fresh parent relation과 Profile-declared execution choices를 별도로 검증한다.

     모든 materialisation side effect는 durable validated intent와 stable idempotency identity가 먼저
     기록되어야 한다. restart에서 exact published task를 authoritative하게 재획득할 수 없으면 duplicate를
     만들지 않고 fail-closed한다. title/body 유사성은 identity나 duplicate 판단 authority가 아니다.

     Execution Policy가 materialisation/subflow를 허용하지 않으면 side effect는 0이다. Human Gate가
     요구되면 publish 전에 적용하며, approval은 invalid Proposal이나 stale parent를 우회하지 않는다.

     Dynamic pipeline synthesis, workflow graph language, runtime/model topology creation은 이 authority에
     포함되지 않는다. 그런 기능은 별도 future Spec decision이다.

18. Decision Validation
    최소 검증:
    Task 존재

Task version 일치

classification 존재

Compiled Profile에서 허용

Pipeline 존재

Runtime profile 허용

Verification profile 허용

Capability 요구 충족

Human Gate 여부

Repository expected state 일치

Backend capability 요구 충족

Child materialisation Proposal에는 추가로:

완전한 child definition body

explicit parent identity / freshness

configured materialisation boundary 존재

subflow policy 허용

batch/task materialisation bound

동일 materialisation identity의 content 일치

실패하면 side effect를 수행하지 않는다.

19. Generic Lifecycle
    Platform Core는 프로젝트 분류명이 아니라 generic lifecycle을 이해한다.
    Task state 예:
    DISCOVERED
    SELECTED
    READY
    IMPLEMENTING
    VERIFYING
    AUDITING
    REWORKING
    READY_TO_MERGE
    MERGING
    MERGED
    HELD
    DEFERRED
    FAILED
    PAUSED_SAFELY
    Generic flow:
    OBSERVE
    → DECIDE
    → VALIDATE
    → EXECUTE
    → VERIFY
    → AUDIT
    → TRANSITION

20. Pipeline Contract
    Project Profile은 허용된 Pipeline Template을 정의한다.
    예:
    pipelines:

standard_implementation: - ACTOR - VERIFY - AUDITOR - MERGE_GATE

foundation: - ACTOR - VERIFY - AUDITOR - RESUME_PARENT

review_only: - AUDITOR - HUMAN_GATE
Supervisor는 Profile에 없는 pipeline을 생성할 수 없다.

21. Immutable Task Contract Snapshot
    각 Task Attempt 시작 시 실제 실행 계약을 동결한다.
    task_contract_snapshot:
    snapshot_id: ...
    version: 1
    hash: ...

task:
id: ...
version: ...
hash: ...

attempt: 1

base_head: ...

compiled_profile_hash: ...

contract_sources: - path: SPECIFICATION.md
content_hash: ... - path: TECHNICAL_DESIGN.md
content_hash: ...

pipeline_id: ...

verification_profile: ...

repository_scope: ...

capability_grants: ...

completion_conditions: ...

22. Task Contract 목적
    Immutable Snapshot은 다음을 보장한다.
    Actor와 Auditor가 같은 계약을 본다.

실행 중 문서가 바뀌어도 계약이 silent하게 변하지 않는다.

restart 후 동일 조건을 재구성할 수 있다.

어떤 계약으로 결과가 만들어졌는지 감사 가능하다.

23. Contract Drift
    실행 도중:
    Profile
    Policy
    Task definition
    Contract Source
    Canonical HEAD
    가 변경될 수 있다.
    Platform은 자동 migration하지 않는다.
    정책에 따라:
    현재 Attempt를 기존 계약으로 완료

또는

INVALIDATE
→ new Snapshot
→ new Attempt
중 하나만 명시적으로 수행한다.

24. CapabilityGrant
    권한 차이를 prompt에만 의존하지 않는다.
    Actor 예:
    capability_grant:
    role: actor

repository:
read: true
feature_write: true
canonical_write: false
merge: false

shell:
execute: true

runtime:
spawn_child: false

remote:
push: FEATURE_BRANCH_ONLY

destructive:
git_clean: false
reset_hard: false
Auditor:
capability_grant:
role: auditor

repository:
read: true
feature_write: false
canonical_write: false
merge: false

shell:
read_only_or_sandboxed: true

25. Capability Broker
    Capability Broker는 다음을 합성한다.
    Compiled Profile

- Role
- Task Contract
- Backend Capability Manifest
  ↓
  Effective CapabilityGrant
  CapabilityGrant의 authoritative owner는 Platform이다.
  Model은 Grant를 확대할 수 없다.

26. Capability Enforcement Assurance
    Backend의 capability enforcement는 다음처럼 표현할 수 있다.
    ENFORCED

AVAILABLE_WITH_REDUCED_ASSURANCE

UNENFORCEABLE_CAPABILITY_BOUNDARY

NOT_YET_AUDITED
Prompt instruction만 존재하는 경우 ENFORCED로 간주하지 않는다.
Execution Policy는 특정 operation에 필요한 최소 enforcement를 요구할 수 있다.

27. RuntimeAdapter
    최소 interface:
    spawn_session(
    role,
    runtime_profile,
    cwd,
    bootstrap_context,
    capability_grant
    ) -> RuntimeSessionHandle

send_turn(
session_handle,
instruction
) -> RuntimeTurnHandle

get_turn_result(
turn_handle
) -> RuntimeTurnResult

get_session_status(
session_handle
) -> RuntimeSessionStatus

cancel_session(
session_handle
)

close_session(
session_handle
)

28. RuntimeTurnResult
    Runtime 결과는 단순 자연어 문자열만으로 취급하지 않는다.
    최소한 다음을 표현할 수 있어야 한다.
    Runtime/session identity

Turn identity

Termination reason

Structured model output if available

Model-declared outcome

Execution metadata

Result provenance

Backend-native references
Actor의 model-declared outcome은 authoritative success가 아니다.

29. Runtime 선택
    초기 Backend:
    OpenClawRuntimeAdapter
    장기적으로:
    ConductorRuntimeAdapter

Agent-Orchestrator RuntimeAdapter

other RuntimeAdapter
등을 구현할 수 있다.
이들은 Platform Core 변경 없이 교체 가능해야 한다.
모든 Adapter를 초기 MVP에서 구현할 필요는 없다.

30. WorkflowAdapter
    최소 interface:
    start(workflow_spec)
    -> WorkflowHandle

status(handle)

resume(handle)

cancel(handle)

audit_decide(
handle,
verdict,
evidence
)

recover(handle)
초기 Backend:
durable-jobs
이다.

31. Platform과 Workflow Backend의 책임 차이
    Workflow Backend:
    개별 workflow durability
    activity execution
    retry/resume primitive
    workflow-local checkpoint
    audit gate primitive
    Platform Core:
    task selection
    batch state
    cross-task dependency
    hold-and-continue
    human decisions
    project policy
    repository merge policy
    이다.

32. Supervisor Auto-Continuation은 Core Requirement가 아니다
    Platform은 다음 구조를 요구하지 않는다.
    Worker terminal
    → 같은 Supervisor ACP session 자동 resume
    그것은 특정 Runtime/Workflow integration 방식일 수 있다.
    Common Platform은:
    Workflow status/event 관측
    → Platform durable state transition
    → 필요 시 Supervisor turn 요청
    → Actor/Auditor lifecycle 조정
    으로 동작할 수 있다.
    따라서 특정 Backend의 “same-Supervisor automatic continuation” 기능은 Platform MVP의 필수 architecture primitive가 아니다.

33. Actor Contract
    Actor는 구현 담당이다.
    Actor 입력의 authoritative basis:
    Immutable Task Contract Snapshot
    Actor 금지:
    canonical direct mutation

self merge

unauthorized push

tag mutation

git clean

reset --hard

contract 변경

scope 밖 변경
Actor가 테스트를 실행할 수는 있지만 결과는 기본적으로 evidence candidate다.

34. Independent Auditor
    Auditor는 Actor와 독립된 RuntimeSession을 사용한다.
    가능한 경우 CapabilityGrant로:
    repository read = yes

feature write = no

canonical write = no

merge = no
를 강제한다.
Auditor 입력:
Task Contract Snapshot

base commit

candidate commit

actual diff

contract snapshot

Verification Evidence

repository lineage
결과:
AUDIT_PASS

FIX_REQUIRED

HUMAN_REQUIRED

35. Auditor 권위 경계
    Auditor는 semantic review를 담당한다.
    하지만 Auditor 역시 다음을 직접 확정할 수 없다.
    Git HEAD

Verification PASS

Capability eligibility

Merge eligibility
이 값들은 Platform-controlled authoritative source에서 읽는다.

36. Platform-owned Verification
    Actor 자기보고는 authoritative verification이 아니다.
    Actor:
    "tests passed"

→ WORKER_REPORTED
고신뢰 gate에는 Platform-controlled VerificationRunner 또는 신뢰 가능한 외부 backend를 사용한다.

37. VerificationRunner Contract
    run_verification(
    verification_profile,
    repository_snapshot,
    task_contract_snapshot
    ) -> VerificationEvidence[]
    가능 backend:
    LocalVerificationAdapter

CIValidationAdapter

RemoteSandboxVerificationAdapter

38. Verification Profile
    Project Profile은 verification 실행 요구사항을 선언한다.
    예:
    unit

regression

schema

registry

mutation

ShellCheck

Builder

Docker smoke

Git lineage

Git clean
Platform Core가 project-specific shell command를 하드코딩하지 않는다.

39. Verification Evidence
    예:
    verification_evidence:
    check: full_builder

result: PASS

assurance_level: REEXECUTED

target_commit: ...

task_contract_hash: ...

executor_identity: ...

run_reference: ...

artifact_digest: ...

timestamp: ...
Evidence는 반드시 검사 대상 commit과 Task Contract에 bind 가능해야 한다.

40. Assurance Levels
    유지:
    REEXECUTED

ARTIFACT_VERIFIED

LOG_VERIFIED

WORKER_REPORTED

INFERRED
의미:
REEXECUTED
Platform-controlled verifier가 실제 대상 commit에서 재실행

ARTIFACT_VERIFIED
신뢰 가능한 외부 실행 artifact의 provenance/integrity 검증

LOG_VERIFIED
실행 로그의 출처·commit·완결성 검증

WORKER_REPORTED
Actor/Model의 주장

INFERRED
주변 상태로부터 추론
ARTIFACT_VERIFIED와 LOG_VERIFIED를 반드시 일렬의 숫자 등급으로 비교할 필요는 없다.
Policy는 check별 accepted assurance set을 선언할 수 있다.

41. Merge Verification Policy
    예:
    merge_policy:
    required_verification:

        full_builder:
          accepted_assurance:
            - REEXECUTED

        ci:
          accepted_assurance:
            - ARTIFACT_VERIFIED
            - REEXECUTED

    WORKER_REPORTED만으로 자동 merge할 수 없다.

42. RepositoryAdapter
    최소 interface:
    snapshot_canonical()

create_feature_workspace(base_head)

inspect_candidate()

get_diff()

verify_tracked_clean()

verify_expected_files()

verify_lineage()

verify_canonical_head()

prepare_merge()

commit_merge()
구체 merge 방식은 Adapter 구현에 따라 달라질 수 있다.

43. Repository Gate
    Model은 merge를 직접 수행하지 않는다.
    Supervisor
    ↓
    MERGE PROPOSAL

Platform
↓
Policy validation
Verification validation
Audit validation
Capability validation

Repository Gate
↓
Authoritative merge

44. Repository Gate — Local 전략
    Local Git backend는 다음과 같은 guarded ff-only 전략을 사용할 수 있다.
    canonical clean

current HEAD == expected HEAD

candidate parent == expected HEAD

candidate clean

verification PASS

required assurance 충족

audit PASS

expected-file scope PASS

conflicting writer 없음

→ git merge --ff-only
자동 rebase와 merge commit은 기본 금지한다.

45. Repository Gate — Protected Remote 전략
    Repository Gate는 원격 서버의 보호 기능을 사용할 수도 있다.
    예:
    feature branch push

PR

required CI

required review

protected canonical branch

merge queue / server-side merge
이 경우에도 Platform은 다음을 검증해야 한다.
Actor credential이 canonical protection을 bypass하지 못함

# PR head SHA

Verification Evidence target SHA

required check producer가 허용된 verifier임

merge 이후 canonical SHA reconcile
따라서 remote RepositoryGate는 RepositoryGate를 제거하는 것이 아니라 다른 구현이다.

46. Rework
    Execution Policy 예:
    max_rework = 2
    일반:
    FIX_REQUIRED
    → Actor rework
    → Verification
    → Auditor
    다음은 HOLD 후보:
    rework limit 초과

동일 finding 반복

계약 범위 초과

새 subflow 필요

지속적인 Actor/Auditor disagreement

47. Generic Subflow
    Platform은 THIN_FOUNDATION이라는 이름을 이해하지 않는다.
    Project Profile에서:
    classification
    → AUTO_SUBFLOW
    로 compile될 수 있다.
    Generic flow:
    whole intent / active Parent
    → Supervisor bounded child Proposal
    → Platform validate + materialise
    → TaskSource re-observe

    Parent Task
    → SUSPENDED

Child Task
→ Actor
→ Verify
→ Audit

Child PASS
→ Parent RESUME

48. Hold and Continue
    한 Task의 Human Decision 필요가 전체 Batch 정지를 의미하지 않는다.
    Task A
    → HELD

Task B
→ independent
→ safe
→ continue
판단에 사용:
TaskSource dependency

Platform state

Repository conflict

Execution Policy

49. PendingHumanDecision
    Human Gate는 synchronous 질문만 의미하지 않는다.
    pending_decision:
    decision_id: ...

task_id: ...

status: OPEN

category: CONTRACT_DECISION

question: ...

options: [...]

recommendation: ...

blocking_scope: TASK_ONLY

evidence_refs: [...]
Blocking Scope:
TASK_ONLY

DEPENDENCY_SUBTREE

BATCH

PROJECT

50. 비동기 Human Operation
    사람은 즉시 응답하지 않아도 된다.
    Platform은 여러 Pending Decision을 durable하게 보관하고 독립 작업을 계속할 수 있어야 한다.
    이는 근무시간 외 무인 운영의 핵심 요구사항이다.

51. Batch Coordinator
    초기 기본 정책:
    max_tasks = 3

concurrency = 1

max_rework = 2
동일 canonical repository에서 병렬 writable candidate를 기본 허용하지 않는다.

52. Circuit Breaker
    다음은 task-level HOLD가 아니라 safety stop 후보이다.
    canonical unexpected dirty

canonical HEAD mismatch

lineage corruption

production regression

verification infrastructure 반복 failure

unexpected mass file change

Platform durable state corruption

conflicting writers

test/operation 수의 설명 불가능한 감소

last safe checkpoint 불명

capability boundary violation
전환:
PAUSED_SAFELY

53. Durable Platform State
    상위 Source of Truth는 Platform durable state다.
    Model conversation은 Source of Truth가 아니다.
    Workflow Backend의 per-workflow state도 상위 batch state를 대체하지 않는다.
    최소 reference:
    platform_run:
    id: ...

project:
id: ...

compiled_profile:
hash: ...

batch:
id: ...
status: ...

task_source:
adapter_type: ...
external_ref: ...

current_task:
...

task_contract_snapshot:
id: ...
hash: ...

capability_grants:
supervisor: ...
actor: ...
auditor: ...

runtime:
supervisor_session: ...
actor_session: ...
auditor_session: ...

workflow:
handle: ...

repository:
base_head: ...
candidate_commit: ...

verification:
evidence: [...]

audit:
verdict: ...

pending_human_decisions: [...]

completed_tasks: []

held_tasks: []
Backend raw identifiers은 Adapter-owned metadata로 격리한다.

54. Recovery
    restart 시 Platform durable state만 맹신하지 않는다.
    reconcile 대상:
    Compiled Profile hash

Task Contract hash

Child materialisation intent / receipt / TaskSource round-trip

CapabilityGrant version

TaskSource external state

canonical HEAD

candidate branch/worktree

candidate commit lineage

Runtime session state

Workflow state

Verification target commit

PendingHumanDecision state
설명할 수 없는 불일치:
→ PAUSED_SAFELY

55. Recovery Source Authority
    각 사실은 authoritative owner가 다르다.
    Project/Profile
    → Profile Registry

Task external definition
→ TaskSource

Child decomposition semantics
→ validated Supervisor Proposal을 동결한 Platform materialisation record

Child external identity / published representation
→ configured Child Task Materialisation Adapter, 이후 definition authority는 TaskSource fresh observation

Parent-child materialisation intent
→ Platform materialisation record

Parent suspension / executable relation
→ Platform durable state의 validated START_SUBFLOW transition

Platform transition
→ Platform durable state

Runtime session
→ RuntimeAdapter

Workflow execution
→ WorkflowAdapter

Repository fact
→ RepositoryAdapter

Verification fact
→ Verification backend

Human resolution
→ Platform Human Decision record
Recovery는 이 authority map에 따라 reconcile한다.

56. Runtime Session Loss
    Runtime session 손실은 Platform execution identity 손실과 같지 않다.
    다음으로 새 session을 만들 수 있어야 한다.
    Compiled Profile Snapshot

Task Contract Snapshot

CapabilityGrant

Platform durable state

Repository state
Model conversation memory는 recovery prerequisite가 아니다.

57. Idempotency
    side effect는 stable idempotency identity를 가져야 한다.
    Batch create

Task begin

Runtime session spawn

Workflow start

Verification request

Auditor spawn

Audit decision

PendingHumanDecision create

Merge request

Report emission
restart/retry로 동일 side effect가 중복 수행되어서는 안 된다.

58. Idempotent Reporting
    예:
    report:
    <project>
    :<batch>
    :<event-type>
    :<event-id>
    동일:
    PAUSED_SAFELY

HUMAN_REQUIRED

BATCH_COMPLETE
이벤트의 중복 알림을 방지한다.

59. Reporting
    정상 progress는 기본 silent.
    normal transition
    → silent

TASK_ONLY pending decision
→ 필요 시 1회

PAUSED_SAFELY
→ 즉시 1회

Batch complete
→ summary 1회
Transport는 Adapter다.

60. 초기 Backend 구성
    초기 구현 후보:
    Runtime
    → OpenClawRuntimeAdapter

Workflow
→ durable-jobs WorkflowAdapter

Repository
→ LocalGitRepositoryAdapter
또는
GitHubProtectedRepositoryAdapter

Verification
→ LocalVerificationAdapter

- 선택적 CIValidationAdapter

Reporting
→ SlackReportAdapter

TaskSource
→ ProjectDocumentTaskSource

61. Backend v1의 의미
    현재 OpenClaw + durable-jobs는:
    Common Platform
    자체가 아니다.
    다음으로 분류한다.
    Runtime Backend v1

- Workflow Backend v1
  미래에는:
  OpenClaw native

Conductor

Agent Orchestrator

other Runtime
으로 Runtime 부분을 교체할 수 있다.

62. 외부 프로젝트 활용 원칙
    외부 Agent Orchestration 제품/프로젝트는 다음 중 하나로 사용한다.
    Adapter Backend

implementation reference

UX reference
해당 제품의 project semantics 또는 trust model을 Platform Core에 복사하지 않는다.
특히 Platform은 자체적으로 다시 만들지 않는 것을 우선한다.
worktree manager

agent launcher

PR UI

CI engine

63. 최소 Test Double 원칙
    Backend replaceability는 유지하지만 초기 MVP에서 production-quality Fake Backend matrix를 만들 필요는 없다.
    Core 테스트를 위한 최소 deterministic test double만 요구한다.
    예:
    FakeRuntimeAdapter

FakeWorkflowAdapter

FakeRepositoryAdapter

FakeVerificationAdapter
목적은:
Core가 특정 Backend implementation 없이
state transition / policy validation 가능함을 증명
하는 것이다.
Fake Backend 자체는 제품 수준 기능을 구현하지 않는다.

64. MVP 0 — Architecture Core
    구현 대상:
    Project Profile schema

Execution Policy schema

Compiled Profile schema

Profile Compiler

Backend Capability Manifest

TaskSource interface

Supervisor Decision schema

Decision Validator

Task Contract Snapshot schema

CapabilityGrant schema

Capability Broker

Platform durable state schema

RuntimeAdapter interface

WorkflowAdapter interface

RepositoryAdapter interface

VerificationRunner interface

ReportAdapter interface

minimal deterministic test doubles
Acceptance:
OpenClaw 없이 Core policy/state tests 가능

infra-scanner 없이 Core tests 가능

ACP identifier 없이 Core state 표현 가능

READY_ITEM 없이 generic Task lifecycle test 가능

Backend capability mismatch를 실행 전에 차단 가능

65. MVP 1 — Single Task / Human Merge
    Project Profile

- Execution Policy
  ↓
  Compiled Profile
  ↓
  TaskSource discover
  ↓
  Supervisor Proposal
  ↓
  Decision validation
  ↓
  Immutable Task Contract
  ↓
  Actor CapabilityGrant
  ↓
  Actor RuntimeSession
  ↓
  candidate commit
  ↓
  Platform-owned Verification
  ↓
  Auditor readonly CapabilityGrant
  ↓
  Independent Audit
  ↓
  FIX_REQUIRED <= policy limit
  ↓
  AUDIT_PASS
  ↓
  Pending Human Merge Decision
  자동 merge는 없다.

66. MVP 1과 Backend Continuation
    MVP 1은 OpenClaw의 기존 P3-H same Supervisor auto-continuation 기능을 필수 전제로 하지 않는다.
    Platform Coordinator가 Workflow 상태를 관측하고 Actor/Auditor lifecycle을 조정할 수 있다.
    P3-H deferred continuation smoke는 Backend 품질 검증으로 유지할 수 있으나 Platform MVP 1의 Architecture Gate는 아니다.

67. MVP 2 — Safe Automatic Merge
    MVP 1 +
    Repository Gate

required capability assurance

required verification assurance

authoritative repository lineage

automatic merge
Repository strategy는:
Local guarded ff-only

또는

Protected remote merge
중 하나일 수 있다.
자동 merge는 선택된 Backend가 Execution Policy의 capability requirements를 충족할 때만 활성화한다.

68. MVP 3 — Subflow / Hold-next / Batch
    MVP 2 +
    AUTO_SUBFLOW

bounded Supervisor child TaskDefinition Proposal

Platform-owned idempotent child materialisation

fresh TaskSource re-observation before admission

Parent suspend/resume

Task dependency graph

PendingHumanDecision queue

HELD → independent next task

batch <= configured maximum

69. MVP 4 — Long-running Unattended
    MVP 3 +
    full circuit breaker

Platform ↔ Backend reconciliation

Runtime recovery

Workflow recovery

Repository recovery

Verification evidence reconciliation

TaskSource projection reconciliation

idempotent notification

long-running batch operation

70. MVP Scope Discipline
    MVP 과정에서 다음을 만들지 않는다.
    새 worktree framework

새 generic workflow engine

새 CI framework

새 PR UI

multi-runtime support를 위한 불필요한 production adapters

generic plugin marketplace

workflow DSL beyond Project Profile needs
처음에는:
1 Project Profile
1 Execution Policy family
1 Runtime Backend
1 Workflow Backend
1 TaskSource
로 실제 동작을 증명한다.
Generic contract는 유지하되 구현체 수는 최소화한다.

71. Architecture Acceptance Criteria
    최소 다음을 만족해야 한다.
1. infra-scanner-specific vocabulary 없이 Core가 존재한다.

1. Core state가 OpenClaw ACP identifier에 의존하지 않는다.

1. Supervisor Decision은 실행 authority가 아니라 Proposal이다.

1. Supervisor-authored child semantics는 structured validation과 Platform-owned materialisation을 거치며,
   Supervisor가 TaskSource/backend를 직접 mutate하지 않는다.

1. materialised child는 fresh TaskSource observation 전에는 admission/Task Contract authority가 아니다.

1. child materialisation은 Profile 밖 pipeline/workflow/model topology를 생성하지 않는다.

1. Profile 범위 밖 Proposal은 deterministic하게 거부된다.

1. 같은 Project Profile에 다른 Execution Policy 적용이 가능하다.

1. Platform은 maturity/operating mode abstraction을 요구하지 않는다.

1. Actor와 Auditor는 동일 Task Contract Snapshot을 기준으로 동작한다.

1. 진행 중 Task Contract는 Profile/Policy 변경으로 silent migration되지 않는다.

1. Runtime identity는 Backend-authoritative하다.

1. CapabilityGrant를 Model이 확대할 수 없다.

1. Prompt-only restriction을 ENFORCED capability로 간주하지 않는다.

1. Auditor write capability는 요구되는 Backend에서 실제 boundary로 차단 가능해야 한다.

1. Actor에게 canonical merge authority를 직접 지급하지 않는다.

1. WORKER_REPORTED만으로 automatic merge하지 않는다.

1. Verification Evidence가 실제 target commit과 Task Contract에 bind된다.

1. TaskSource 교체가 Core business logic 변경을 요구하지 않는다.

1. Workflow Backend 교체가 Project Profile semantics 변경을 요구하지 않는다.

1. Runtime Backend 교체가 Platform durable state schema의 의미를 변경하지 않는다.

1. Repository Gate를 local/remote implementation으로 교체할 수 있다.

1. TASK_ONLY PendingHumanDecision은 독립 Task 진행을 막지 않는다.

1. restart 후 동일 Human Decision 또는 Report가 중복 생성되지 않는다.

1. Runtime session loss 후 immutable state에서 execution context 재구성이 가능하다.

1. Backend capability가 Policy 요구보다 낮으면 실행 전에 거부된다.

1. Core tests는 최소 Fake Backend로 Backend implementation 없이 실행 가능하다.

1. 자동 merge의 authoritative side effect는 Repository Gate만 수행한다.

1. Non-goals
   다음은 Platform Core의 목표가 아니다.
   OpenClaw 자체 개발

durable-jobs 자체 재설계

Conductor/AO 대체품 제작

프로젝트 의미 하드코딩

infra-scanner-specific logic

OperatingMode Core abstraction

Maturity Engine

Project-specific Foundation Engine

ACP-specific business identity

별도 AI Planner 계층

별도 Approval Workflow Engine

Actor 자기보고 승격

prompt-only security

silent Task Contract migration

TaskSource를 durable execution state로 사용

Policy 변경 소급 적용

Model 직접 merge

무제한 parallel writable development

새 generic Git workspace system

새 CI framework

새 agent UI

73. TD 이전 확정해야 할 핵심 질문
    모든 세부사항을 장기간 연구하지 않는다.
    TD 전에 실제 Architecture에 영향을 주는 질문만 해결한다.
    Q1. Snapshot hashing
    Compiled Profile
    Task Contract
    Contract Sources
    의 canonical serialization 및 hash 방식.

Q2. Durable Store / Transaction
Platform state transition의 atomicity와 persistence 방식.

Q3. RuntimeTurnResult
다른 Runtime에도 공통으로 적용할 최소 structured result envelope.

Q4. Capability Vocabulary
Platform 공통 CapabilityGrant vocabulary와 Backend enforcement mapping.

Q5. Recovery Precedence
Platform state와:
Runtime
Workflow
Repository
TaskSource
Verification
사이 불일치 시 authority/reconciliation 규칙.

Q6. Repository Gate
초기 MVP 2가:
Local guarded ff-only
인지,
Protected remote branch
인지.

Q7. Contract Invalidation
어떤 drift가 현재 Attempt의 invalidation을 강제하는가.

Q8. Workflow Observation
Platform이 Workflow 완료를:
poll

event

callback
중 어떤 추상 contract로 관측할 것인지.
특정 OpenClaw automatic continuation을 Core contract로 만들지 않는다.

74. Architecture Risks
    남아 있는 핵심 위험:
1. Profile이 과도하게 expressive해져
   또 하나의 workflow programming language가 되는 것.

1. Supervisor Proposal과 Platform deterministic transition의
   책임이 다시 섞이는 것.

1. Runtime capability enforcement가 약해
   CapabilityGrant가 문서상 권한에 그치는 것.

1. Platform durable state와 Workflow durable state의
   이중-state reconciliation 복잡성.

1. TaskSource external state와 Platform state divergence.

1. CI/remote verification provenance의 불충분함.

1. Contract drift가 장시간 Task에 미치는 영향.

1. Generic성 때문에 1인 프로젝트 범위를 초과하는 것.
   마지막 위험에 대한 대응은:
   Contract는 generic하게 유지한다.

초기 implementation은 하나씩만 만든다.

이미 존재하는 execution infrastructure를 재사용한다.
이다.

75. 최초 구현 경계
    현재 예상되는 직접 Build 대상:
    Profile Compiler

Execution Policy Compiler

Compiled Profile Snapshot

Decision Validator

ProjectDocumentTaskSource

Immutable Task Contract

Capability Broker

Platform Durable State

PendingHumanDecision

Platform Coordinator

Verification Policy / Evidence binding

Repository Gate policy
현재 예상되는 Reuse 대상:
OpenClaw
→ Runtime/session/worktree primitives

durable-jobs
→ Workflow durability/audit/evidence primitives

Git
→ repository primitive

optional GitHub
→ protected branch / CI / merge primitive

Slack
→ report/control surface

76. 최종 정의
    Common Autonomous Development Platform은:
    프로젝트의 의미를 Project Profile로 정의하고,

자동화 권한을 Execution Policy로 별도 정의하고,

두 계약을 immutable Compiled Profile로 합성하며,

TaskSource에서 작업을 발견하고,

Supervisor Model의 판단을 Proposal로만 받아,

deterministic policy로 검증하고,

Task Attempt의 계약을 immutable snapshot으로 고정하고,

Role별 CapabilityGrant를 발급하고,

교체 가능한 Runtime / Workflow /
Repository / Verification Backend를 사용하여 실행하고,

Platform-controlled evidence로 결과를 검증하고,

독립 Auditor가 semantic correctness를 검토하며,

정책상 허용된 경우에만 Repository Gate가
canonical side effect를 수행하고,

사람의 판단이 필요한 사항은
durable PendingHumanDecision으로 남기며,

Runtime/Model/Backend가 재시작되더라도
계약·상태·권한·증거를 재구성할 수 있는

deterministic autonomous-development control plane.
장기 경계:
Model proposes.

Platform validates.

Capability boundary authorizes.

Runtime executes.

Verification proves.

Auditor reviews.

Repository Gate merges.

Human decides only where policy requires.
이 경계를 Common Platform의 최상위 Architecture Contract로 유지한다.

Appendix A — v0.2 → v0.3 핵심 변경
Added
Backend Capability Manifest

Backend Compatibility Gate

Generic authoritative Runtime identity contract

RuntimeTurnResult requirements

Local / Protected-Remote RepositoryGate strategies

Explicit Build-vs-Reuse boundary

Minimal Test Double principle

Supervisor auto-continuation non-requirement

MVP scope discipline
Modified
Runtime trust
→ OpenClaw sessionKey 방식이 아닌 generic backend-authoritative identity

Repository policy
→ remote push를 전역 Non-goal에서 Execution Policy 항목으로 이동

RepositoryGate
→ local ff-only뿐 아니라 protected remote implementation 허용

Fake adapters
→ full substitute 구현이 아닌 최소 deterministic test doubles

MVP 1
→ old P3-H automatic continuation에 종속되지 않음

MVP 2
→ capability compatibility를 명시적 precondition으로 추가
Clarified
Generic Architecture를 유지하는 것과
여러 Backend를 실제로 구현하는 것은 별개다.

Backend replaceability는 Architecture requirement다.

초기 구현체 수는 최소화한다.

외부 제품은 Platform 자체가 아니라
Runtime / Repository / UX / implementation reference가 될 수 있다.

durable-jobs의 기존 Workflow/Evidence 자산은 재사용한다.
Intentionally unchanged
Runtime ≠ Platform

MCP ≠ Platform Core

Supervisor decision = Proposal

Project Profile / Execution Policy 분리

Immutable Task Contract

CapabilityGrant

Platform-owned Verification

Assurance Levels

Independent Auditor

PendingHumanDecision

Generic Subflow

Hold-and-Continue

Circuit Breaker

Durable Platform State

Replaceable Backend philosophy
