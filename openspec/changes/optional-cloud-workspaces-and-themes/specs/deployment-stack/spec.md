# Spec Delta

## Purpose

Provides a reproducible container deployment for the frontend, authenticated API, relational data and private attachment storage, with explicit provisioning and recovery procedures.

## ADDED Requirements

### Requirement: Complete persistent stack
The documented container startup SHALL serve the application and same-origin API on port 6610, with PostgreSQL and private object storage backed by persistent volumes. Database and storage services SHALL NOT be exposed publicly by default.

#### Scenario: Fresh deployment
- **WHEN** an operator supplies required configuration and starts the documented stack
- **THEN** the frontend and API become reachable on the application origin after dependencies and schema are ready

#### Scenario: Restart retains cloud state
- **WHEN** services restart without deleting volumes
- **THEN** accounts, sessions not yet expired, boards, retained history and attachments remain available

### Requirement: Explicit secrets and bootstrap
Runtime secrets SHALL be supplied outside tracked source. Ordinary startup SHALL NOT provision a known password. A separate development-only bootstrap operation SHALL provision the requested admin without resetting existing credentials.

#### Scenario: Missing configuration
- **WHEN** required database or object-storage credentials are missing
- **THEN** affected services fail with an actionable diagnostic without printing secrets

### Requirement: Schema and readiness lifecycle
Database migrations SHALL be versioned and repeatable, and readiness SHALL fail while required schema or backing services are unavailable. Unhealthy dependencies SHALL produce explicit API errors rather than successful empty data.

#### Scenario: Database unavailable
- **WHEN** PostgreSQL becomes unavailable
- **THEN** API readiness fails and cloud requests report unavailability while guest local editing remains usable

### Requirement: Large-transfer deployment path
The complete proxy, API and object-storage transfer path SHALL support streaming and resumable multipart transfers without an artificial admin application quota or full-file memory buffering. Physical/provider limits SHALL be documented and surfaced explicitly.

#### Scenario: Admin large upload
- **WHEN** an admin uploads a file exceeding the basic limit through the deployed application origin
- **THEN** the proxy and API do not impose the basic-user limit and transfer progress or a specific physical-limit error is shown

### Requirement: Backup and recovery
Deployment documentation SHALL describe coherent backup and restore of PostgreSQL and attachment objects, secret handling, migration execution, development provisioning and safe shutdown without deleting persistent volumes.

#### Scenario: Restore verification
- **WHEN** an operator restores a documented backup into an isolated stack
- **THEN** a previously saved board, retained historical revision and referenced attachment can be loaded successfully
