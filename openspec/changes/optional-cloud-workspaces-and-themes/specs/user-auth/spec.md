# Spec Delta

## Purpose

Provides optional account authentication and private sessions while keeping the editor usable without an account and excluding public registration.

## ADDED Requirements

### Requirement: Optional login without registration
The system SHALL offer username/password login and logout without requiring login for local editing, import or export. It SHALL NOT expose public registration UI or a public registration API.

#### Scenario: Guest editor
- **WHEN** a visitor opens the site without a session
- **THEN** local boards remain usable and login is optional

#### Scenario: No public registration
- **WHEN** a visitor inspects account actions or attempts public account creation
- **THEN** no registration action is offered and no account is created

### Requirement: Protected sessions
The system SHALL hash passwords with a password-specific adaptive algorithm, use revocable expiring server sessions with HttpOnly cookies, protect authenticated mutations against CSRF, throttle failed logins, and avoid exposing passwords or session secrets in client storage, logs or responses. Production session cookies SHALL require HTTPS.

#### Scenario: Invalid login
- **WHEN** an invalid username or password is submitted
- **THEN** a generic authentication error is shown without revealing account existence, and repeated attempts are throttled

#### Scenario: Session expiration
- **WHEN** an authenticated request has an expired or revoked session
- **THEN** the request is rejected and pending local work is preserved without reporting cloud success

#### Scenario: Forged mutation
- **WHEN** an authenticated state-changing request lacks valid CSRF protection
- **THEN** the server rejects it without changing data

### Requirement: Roles and ownership
Accounts SHALL have a server-authoritative basic or admin role. Every board, history, attachment and configuration request SHALL enforce account ownership; the admin role grants attachment/history entitlements, not access to other users' private data.

#### Scenario: Cross-account object access
- **WHEN** one account requests another account's board, history or attachment using a known identifier
- **THEN** the request is denied without returning private content or changing it

#### Scenario: Client role tampering
- **WHEN** a basic user submits an admin role in a request
- **THEN** the server applies the stored basic role and its limits

### Requirement: Explicit development admin provisioning
The development deployment SHALL support explicit, repeatable provisioning of the requested admin using an externally supplied initial password. It SHALL NOT commit the password, enable known credentials in production, or reset an existing password during ordinary restarts.

#### Scenario: Development full-loop account
- **WHEN** the operator explicitly bootstraps the requested development admin with a supplied password
- **THEN** that account can log in and exercise admin attachment and history behavior

#### Scenario: Restart preserves credentials
- **WHEN** containers restart after the admin password has changed
- **THEN** bootstrap does not overwrite that password

### Requirement: Account lifecycle isolation
Logout SHALL revoke the current session, stop account synchronization, and return to the guest workspace. Account switching SHALL never expose or synchronize the previous account's cached data under the next account.

#### Scenario: Switch accounts with queued edits
- **WHEN** account A logs out with unsynchronized edits and account B logs in
- **THEN** A's cached content and queued mutations remain inaccessible to B and are not submitted using B's session
