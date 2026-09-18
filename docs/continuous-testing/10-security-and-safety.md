# Security and Safety

This document defines the security boundary for an always-on system that runs
an AI coding agent, synthetic prompts, tools, terminals, provider clients, and
fault experiments.

The verification environment is test infrastructure, but it still executes
code and handles credentials. Treat it as a potentially hostile workload, not
as a trusted shell script that happens to run continuously.

## Security Objectives

- deterministic lanes cannot reach undeclared external networks;
- OpenCode and test tools cannot read or modify user or host data outside their
  assigned workspace;
- real-provider credentials are available only to the narrow lanes that need
  them;
- generated prompts, model output, tool input, fixtures, and cassettes cannot
  inject control-plane commands;
- secrets and sensitive content do not enter ordinary telemetry or artifacts;
- a compromised lane cannot control the supervisor or other lanes;
- resource and cost abuse is bounded;
- destructive chaos actions target only explicit disposable resources;
- dependencies, target revisions, and test artifacts are attributable and
  reviewable;
- operational mutations require authorization and produce audit records.

## Threat Model

Potentially untrusted inputs include:

- the OpenCode target revision under test;
- provider package code and transitive dependencies;
- real model output;
- generated or recorded provider payloads;
- repository fixture content;
- plugin and MCP output;
- tool arguments selected by a model;
- cassettes and artifacts loaded from storage;
- scenario/config changes;
- malformed protocol frames;
- a compromised lane process.

Protected assets include:

- host filesystem and user data;
- source repositories outside the fixture;
- Git and package-registry credentials;
- provider API keys and cloud credentials;
- control-plane database and artifact credentials;
- other lanes and their state;
- production networks and services;
- review users who open logs, frames, or HTML-like artifacts;
- provider and infrastructure budgets.

## Trust Boundaries

```text
operator / CI identity
        |
        v
control plane ------ run/artifact stores
        |
  authenticated lease
        |
        v
lane supervisor boundary
        |
        v
OpenCode + TUI + Drive controllers + fixture tools
        |
   deny-by-default egress
        |
        +--> no network in deterministic lanes
        +--> allowlisted provider endpoints in live lanes
```

The control plane never treats a lane-supplied path, PID, URL, artifact, or
classification as trusted without validation.

## Lane Isolation

The first single-host deployment should use containers or a comparably strong
OS sandbox per lane when practical.

Each lane receives:

- a dedicated unprivileged user/identity;
- a private writable workspace and OpenCode data directory;
- read-only target artifact where possible;
- no mount of the user's home, SSH directory, cloud config, Docker socket, or
  control-plane state;
- explicit CPU, memory, process, descriptor, and disk quotas;
- loopback-only simulation endpoints;
- declared egress policy;
- a minimal environment allowlist;
- no host PID namespace or privileged capabilities;
- a separate temporary directory.

Avoid sharing writable package caches between untrusted target executions. A
read-only verified cache or per-generation cache is safer.

## Filesystem Safety

All scenario and tool paths are resolved relative to an explicit fixture root.

Before any write, restore, move, or delete:

1. parse and normalize the requested relative path;
2. reject absolute paths and parent traversal;
3. resolve symlinks according to policy;
4. verify the final target remains inside the lane-owned root;
5. reject mount points and protected control directories;
6. operate on an explicit path, not a broad glob;
7. record the action and result.

Never use the user's home directory, workspace root, `/`, or an unresolved
environment variable as a recursive cleanup target.

Fixture reset owns a declared path set. It does not recursively replace the
entire lane directory, which also contains OpenCode state, logs, and runtime
metadata.

## Process Safety

Process termination uses explicit generation metadata:

- lane ID;
- process role;
- PID;
- observed start time or process handle;
- executable/command digest where available;
- parent-child relationship.

Before a destructive signal, revalidate that identity. If it no longer matches,
stop and mark the lane unsafe. Do not kill by fuzzy command substring or by
assuming a port owner belongs to the lane.

Graceful termination precedes force kill. Force kill remains scoped to the
verified child process tree.

## Network Policy

### Deterministic lanes

- deny external egress at the container/host firewall layer;
- allow loopback simulation endpoints and explicitly required local fixture
  services;
- V2's simulated Effect HTTP client also denies unregistered destinations;
- DNS need not be available;
- fail and alert on any attempted undeclared destination.

Application-level route denial is defense in depth, not a substitute for
network policy.

### Provider contract lanes

Deterministic programmable-transport and cassette replay tests deny all real
egress. Recording mode is an explicit, separately authorized operation with a
provider endpoint allowlist.

### Live-provider lanes

- separate identity and node/lane profile;
- allow only required provider/auth endpoints;
- block metadata-service access unless a tested cloud auth flow explicitly
  needs it in an isolated environment;
- enforce model/provider allowlist;
- cap request count, tokens, time, and spend;
- no fallback to arbitrary endpoint from model or prompt content;
- record safe destination identity.

## Credentials

Use a secret manager or deployment-native secret provider. Credentials are:

- injected only into the process/layer that needs them;
- never written to scenario config, attempt records, traces, or fixture files;
- scoped to test accounts/projects with minimal permissions;
- rotated independently;
- omitted from deterministic lanes;
- unavailable to generated tool commands;
- revoked when a lane image or dependency is suspected compromised.

Prefer short-lived credentials. For cloud providers, isolate project/account and
apply hard service quotas.

The control plane stores secret references and credential-profile names, not
secret values.

## Environment Variables

Build subprocess environments from an allowlist. Do not inherit the full
operator shell environment.

Commonly sensitive variables to exclude include:

- Git/SSH credentials;
- package registry tokens;
- cloud/provider credentials not selected for the lane;
- database and artifact-store credentials belonging to the control plane;
- desktop/session tokens;
- unrelated application secrets;
- proxy variables that bypass egress policy.

Record variable names supplied to the lane, never sensitive values.

## Tool Safety

Drive-controlled tools should be the default in deterministic scenarios.

Every tool registration declares:

- stable name and schema;
- capability class;
- read/write/network/process effects;
- path or destination allowlist;
- timeout and output limit;
- whether user permission is expected;
- whether it is valid in generated campaigns.

Generated models choose only from currently offered controlled tools. Tool
arguments are schema-decoded and then independently policy-validated.

Shell-like testing uses a dedicated fixture command surface or sandbox. Do not
turn arbitrary model text into a host shell command.

Tool output is bounded. Binary or huge output becomes a safe digest/summary and
restricted artifact when needed.

## Prompt and Model-Output Safety

Synthetic prompt strings are data. They do not interpolate into shell commands,
file paths, SQL, metric names, or artifact keys without escaping and validation.

Real model output is untrusted even when the prompt is synthetic:

- it cannot alter scheduler policy;
- it cannot select provider credentials or endpoints;
- it cannot widen tool permissions;
- it cannot choose host paths;
- it cannot emit HTML/terminal control that review tools execute;
- it cannot mark its own attempt passed.

Pass/fail derives from registered assertions and run policy.

## Terminal and Rendering Safety

Frames and logs may contain control sequences or crafted Unicode.

- store canonical frame data as structured pixels/cells, not executable
  terminal replay when possible;
- escape terminal output in web review UI;
- serve downloaded artifacts with safe content type and disposition;
- sanitize filenames and never use prompt text as a path;
- render PNGs in an isolated process with resource limits;
- bound terminal dimensions and frame count;
- do not allow links in model output to become privileged control-plane
  navigation without safe URL handling.

## Artifact Security

Artifacts have sensitivity classes:

- `public-synthetic`: reviewed deterministic fixture content;
- `internal`: normal logs/frames with safe synthetic data;
- `restricted`: real provider content, HTTP context, environment or repository
  detail;
- `quarantined`: redaction failed or content type is unsafe/unknown.

Artifact storage keys are generated from IDs, not caller paths. Upload verifies
size, digest, type, redaction status, and quota.

Review/download access follows sensitivity. Object-store URLs are short-lived
and audited for restricted content.

## Redaction

Redact:

- authorization, cookies, API keys, signed URLs, and credential-like values;
- query parameters and JSON fields configured by provider;
- environment values;
- provider/account/project/deployment/request IDs according to policy;
- user paths and repository remotes;
- prompt, response, and tool content outside safe synthetic fixtures;
- error bodies that echo a request.

Use multiple layers:

1. avoid collecting content;
2. redact at source adapter;
3. redact artifact before publication;
4. scan complete artifact for credential patterns and known secret values;
5. quarantine on scan failure.

Never log a secret merely to prove the redactor catches it in a live lane. Use
synthetic sentinel secrets in tests.

## HTTP Recorder Safety

The target recorder has secure defaults and scans cassettes. Operational policy
adds:

- record only from dedicated test credentials/accounts;
- review cassette diffs before commit;
- allowlist necessary non-sensitive matching headers;
- stabilize account-specific paths with redaction functions;
- reject recordings containing unrecognized credential formats;
- never automatically overwrite an existing cassette;
- version cassette schema and recorder version;
- run replay with egress denied to prove it is self-contained;
- remove stale cassettes through explicit reviewed targets.

Record/replay is not a license to preserve full production conversations.

## Package and Supply-Chain Safety

Target and harness builds should record:

- Git commit and clean/dirty status;
- lockfile digest;
- resolved package versions;
- build artifact/image digest;
- base image/runtime version;
- dependency provenance available from the build system;
- source of dynamically loaded provider packages.

Controls:

- use lockfile-frozen installation;
- avoid runtime installation in persistent lanes where possible;
- isolate package caches;
- scan dependencies/images according to organizational policy;
- require review for new postinstall/native code;
- do not load a package specifier derived from model output;
- test loader failures and unexpected package exports;
- rotate credentials after confirmed dependency compromise.

Provider packages run with the same suspicion as the OpenCode target.

## Control-Plane Authorization

Read-only status and broad synthetic artifacts may have wider access than
mutations.

Require authenticated authorization for:

- enabling/disabling schedules;
- launching live-provider or chaos work;
- draining/freezing/recycling lanes;
- changing network/credential profiles;
- replaying restricted attempts;
- accessing restricted artifacts;
- changing retention/quota policy;
- acknowledging or reclassifying failures.

Every mutation records actor, request, resolved targets, before/after policy,
and outcome.

## Configuration Safety

Schema validation rejects:

- unknown lane/network/credential profile names;
- paths outside approved roots;
- overlapping lane ports or writable roots;
- real-provider configuration in deterministic lanes;
- unbounded time, output, step, retry, or cost settings;
- destructive chaos without disposable resource declaration;
- artifact retention beyond policy;
- scenario IDs absent from the registry;
- unsupported protocol commands or aliases.

Policy validation runs both at config load and immediately before the sensitive
operation, because external state may have changed.

## Resource Limits

Per lane and attempt, bound:

- CPU and memory;
- process/thread/descriptor count;
- writable disk and database size;
- log and artifact bytes;
- terminal dimensions and frame count;
- request/output/tool payload bytes;
- model steps and tool invocations;
- wall-clock duration;
- concurrent sessions/clients;
- provider tokens, requests, and cost.

Cross hard thresholds by stopping admission and safely terminating the narrowest
owner. Preserve an essential failure manifest before large artifacts.

## Cost Abuse and Provider Safety

Real-provider probes have:

- daily and monthly hard budgets enforced outside the model call;
- per-provider/model maximum output;
- concurrency one initially;
- simple non-sensitive prompts;
- no user-supplied prompt endpoint;
- no arbitrary hosted tools;
- circuit breaker after authentication/quota/repeated transient errors;
- independent kill switch;
- usage reconciliation against provider billing where feasible.

A compromised scenario cannot increase budgets or choose a premium model.

## Chaos Safety

Every destructive experiment validates:

- dedicated disposable target;
- exact lane generation and resource identity;
- exclusive lease;
- steady state;
- blast-radius limit;
- abort thresholds;
- supervisor/control plane outside the target where required;
- cleanup mechanism tested without the fault;
- no real credentials or shared state unless explicitly necessary;
- evidence capacity.

Disk corruption, disk-full, cgroup pressure, and broad network failure remain
disabled until run inside disposable isolated resources.

## Data Retention and Deletion

Minimize collection and expire data by class. Deletion jobs:

- select objects from database IDs/prefixes generated by the system;
- validate store/root boundaries;
- delete in bounded batches;
- record counts and failures;
- preserve legal/security holds explicitly;
- never follow symlinks or artifact-supplied filesystem paths;
- retry idempotently;
- verify orphan staging data separately.

Persistent lane state is not retained indefinitely merely because a test once
failed. Snapshot the minimum required evidence and apply the failure retention
policy.

## Incident Response

### Suspected secret exposure

1. Stop affected lane and artifact publication.
2. Quarantine relevant artifacts/logs/cassettes.
3. Revoke and rotate the credential.
4. identify target/harness revision and access history;
5. scan storage for the exposed value and related formats;
6. remove through approved incident process;
7. add synthetic regression sentinel;
8. restore only after redaction and isolation are verified.

### Unexpected network egress

1. Block the lane profile at network policy.
2. Freeze attempt and capture safe destination/process evidence.
3. Revoke potentially exposed credentials.
4. determine whether application-level simulated network was bypassed;
5. audit other lanes with the same artifact;
6. require an explicit regression test before re-enable.

### Filesystem escape attempt

1. Stop the lane without following the requested target.
2. preserve normalized path, symlink, process, and policy evidence;
3. verify host/shared paths were not changed;
4. rotate sensitive credentials if readable data may have been exposed;
5. fix both application validation and container mount policy.

### Runaway resource or cost

1. Activate the narrow kill switch;
2. stop admission;
3. terminate explicit lane/provider work;
4. retain bounded manifests and counters;
5. reconcile provider usage and host resource impact;
6. lower limits or fix loop before restoring.

## Security Tests

Automate:

- path traversal, absolute path, symlink escape, and mount-boundary tests;
- cleanup target validation with unset/hostile configuration;
- process PID reuse/identity mismatch;
- unknown port ownership behavior;
- egress denial and route miss;
- environment allowlist verification;
- fake credential sentinel scanning in every artifact format;
- malicious error body echoing request credentials;
- terminal escape and review UI encoding;
- oversized frame/log/body/tool output;
- untrusted artifact filename/content type;
- unauthorized control-plane mutation;
- expired artifact access;
- cost/step/time budget enforcement;
- chaos target mismatch abort;
- package loader with unexpected export and malicious specifier input;
- replay proving no real network use.

Run security-policy smoke before declaring a new deployment profile ready.

## Acceptance Criteria

The system is safe for unattended operation when:

- each lane runs with isolated identity, storage, processes, resources, and
  network policy;
- deterministic and replay lanes have external egress denied;
- live credentials exist only in allowlisted live profiles with hard budgets;
- target and tool paths are normalized and proven inside explicit roots;
- process signals target revalidated generation identities;
- arbitrary model output cannot become a shell command, path, endpoint,
  permission, scheduler policy, or pass verdict;
- default telemetry contains no prompt/model/tool content or secrets;
- every artifact is typed, size-bounded, redaction-verified, and access-classed;
- redaction failure quarantines rather than publishes;
- destructive chaos requires a disposable isolated target and exclusive lease;
- control-plane mutations are authorized and audited;
- lockfile, package versions, target commit, and build digest are recorded;
- incident kill switches work independently of the workload;
- restore and security regression tests are exercised regularly.

