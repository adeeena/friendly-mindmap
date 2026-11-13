CREATE TABLE users (
    id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE CHECK (username = lower(btrim(username)) AND length(username) BETWEEN 1 AND 100),
    password_hash text NOT NULL,
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    role text NOT NULL DEFAULT 'basic' CHECK (role IN ('basic', 'admin')),
    configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
    configuration_revision bigint NOT NULL DEFAULT 0 CHECK (configuration_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    csrf_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    idle_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at AND idle_expires_at <= expires_at)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
    key_hash text PRIMARY KEY,
    attempts integer NOT NULL CHECK (attempts > 0),
    window_started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_window_idx ON login_attempts(window_started_at);

CREATE TABLE boards (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    content jsonb,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    camera jsonb NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}' CHECK (jsonb_typeof(camera) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    content_revision bigint NOT NULL DEFAULT 1 CHECK (content_revision > 0),
    content_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (id, owner_id),
    CHECK (deleted_at IS NOT NULL OR (jsonb_typeof(content) = 'object' AND content IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE INDEX boards_owner_updated_idx ON boards(owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE board_history (
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    content_revision bigint NOT NULL CHECK (content_revision > 0),
    server_revision bigint NOT NULL CHECK (server_revision > 0),
    name text NOT NULL,
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    actor_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, content_revision)
);

CREATE TABLE board_attachments (
    id uuid PRIMARY KEY,
    board_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    uploader_id uuid NOT NULL REFERENCES users(id),
    storage_key text NOT NULL UNIQUE,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    mime text NOT NULL DEFAULT 'application/octet-stream',
    detected_mime text,
    size_bytes bigint CHECK (size_bytes >= 0),
    checksum text,
    state text NOT NULL CHECK (state IN ('staged', 'ready', 'deleting')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (board_id, owner_id) REFERENCES boards(id, owner_id),
    UNIQUE (id, board_id),
    CHECK (state <> 'ready' OR (size_bytes IS NOT NULL AND checksum IS NOT NULL))
);
CREATE INDEX board_attachments_board_idx ON board_attachments(board_id);
CREATE INDEX board_attachments_cleanup_idx ON board_attachments(state, updated_at);

CREATE TABLE board_attachment_refs (
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    node_id text NOT NULL,
    attachment_id uuid NOT NULL,
    PRIMARY KEY (board_id, node_id, attachment_id),
    FOREIGN KEY (attachment_id, board_id) REFERENCES board_attachments(id, board_id)
);
CREATE INDEX board_attachment_refs_attachment_idx ON board_attachment_refs(attachment_id);

CREATE TABLE board_history_attachments (
    board_id uuid NOT NULL,
    content_revision bigint NOT NULL,
    node_id text NOT NULL,
    attachment_id uuid NOT NULL,
    PRIMARY KEY (board_id, content_revision, node_id, attachment_id),
    FOREIGN KEY (board_id, content_revision) REFERENCES board_history(board_id, content_revision) ON DELETE CASCADE,
    FOREIGN KEY (attachment_id, board_id) REFERENCES board_attachments(id, board_id)
);
CREATE INDEX board_history_attachments_attachment_idx ON board_history_attachments(attachment_id);

CREATE TABLE attachment_uploads (
    id uuid PRIMARY KEY,
    attachment_id uuid NOT NULL UNIQUE,
    board_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    node_id text NOT NULL,
    multipart_id text,
    expected_size bigint NOT NULL CHECK (expected_size >= 0),
    state text NOT NULL CHECK (state IN ('pending', 'uploading', 'completed', 'aborted', 'expired')),
    basic_slot boolean NOT NULL DEFAULT false,
    completed_parts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(completed_parts) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (attachment_id, board_id) REFERENCES board_attachments(id, board_id),
    FOREIGN KEY (board_id, owner_id) REFERENCES boards(id, owner_id)
);
CREATE UNIQUE INDEX attachment_uploads_basic_slot_idx ON attachment_uploads(board_id, node_id)
    WHERE basic_slot AND state IN ('pending', 'uploading');
CREATE INDEX attachment_uploads_expiry_idx ON attachment_uploads(expires_at) WHERE state IN ('pending', 'uploading');

CREATE TABLE mutation_receipts (
    owner_id uuid NOT NULL REFERENCES users(id),
    mutation_id uuid NOT NULL,
    request_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, mutation_id)
);
