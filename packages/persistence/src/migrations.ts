export interface Migration { version: number; name: string; sql: string; destructive?: boolean }

export const migrations: readonly Migration[] = [{
  version: 1,
  name: "initial_application_schema",
  sql: `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, real_path TEXT NOT NULL,
  created_at TEXT NOT NULL, last_opened_at TEXT NOT NULL, preferred_agent_id TEXT, preferred_router_id TEXT, permission_profile_id TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE provider_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), agent_id TEXT NOT NULL,
  provider_session_id TEXT, status TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agent_events (id TEXT PRIMARY KEY, conversation_id TEXT, workflow_run_id TEXT, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE permission_decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL,
  request_id TEXT NOT NULL, decision TEXT NOT NULL, request_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workflow_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, position INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL, status TEXT NOT NULL,
  summary TEXT, context_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_step_runs (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), node_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL, agent_name TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE workflow_edges_taken (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), edge_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workflow_loop_state (workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), loop_id TEXT NOT NULL,
  iteration INTEGER NOT NULL, max_iterations INTEGER NOT NULL, PRIMARY KEY (workflow_run_id, loop_id));
CREATE TABLE workflow_announcements (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  announcement_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE provider_installations (provider_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE provider_health (provider_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE INDEX idx_conversations_project ON conversations(project_id);
CREATE INDEX idx_events_conversation ON agent_events(conversation_id, created_at);
CREATE INDEX idx_steps_workflow_run ON workflow_step_runs(workflow_run_id);
`,
}, {
  version: 2,
  name: "replace_fixed_roles_with_agent_profiles",
  destructive: true,
  sql: `
DROP TABLE IF EXISTS workflow_findings;
DROP TABLE IF EXISTS workflow_reviews;
DROP TABLE IF EXISTS workflow_artifacts;
DROP TABLE IF EXISTS workflow_announcements;
DROP TABLE IF EXISTS workflow_loop_state;
DROP TABLE IF EXISTS workflow_edges_taken;
DROP TABLE IF EXISTS workflow_step_runs;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflow_definitions;
DROP TABLE IF EXISTS workflow_role_profiles;
DROP TABLE IF EXISTS routing_rules;
DROP TABLE IF EXISTS routing_decisions;

CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, position INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL, status TEXT NOT NULL,
  summary TEXT, context_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_step_runs (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), node_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL, agent_name TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE workflow_edges_taken (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), edge_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workflow_loop_state (workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), loop_id TEXT NOT NULL,
  iteration INTEGER NOT NULL, max_iterations INTEGER NOT NULL, PRIMARY KEY (workflow_run_id, loop_id));
CREATE TABLE workflow_announcements (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  announcement_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_steps_workflow_run ON workflow_step_runs(workflow_run_id);
`,
}, {
  version: 3,
  name: "conversation_memory_session_lanes_and_usage",
  sql: `
CREATE TABLE conversation_memory (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  memory_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_session_lanes (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  lane_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  memory_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, lane_key)
);
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  workflow_run_id TEXT,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_id TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_lanes_conversation ON provider_session_lanes(conversation_id, updated_at);
CREATE INDEX idx_usage_conversation ON usage_records(conversation_id, created_at);
`,
}];
