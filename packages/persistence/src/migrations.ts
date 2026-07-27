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
CREATE TABLE routing_decisions (id TEXT PRIMARY KEY, conversation_id TEXT, workflow_run_id TEXT, kind TEXT NOT NULL,
  decision_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE routing_rules (id TEXT PRIMARY KEY, rule_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE workflow_role_profiles (scope TEXT NOT NULL, scope_id TEXT NOT NULL, role TEXT NOT NULL, profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (scope, scope_id, role));
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL, status TEXT NOT NULL,
  summary TEXT, context_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_step_runs (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), node_id TEXT NOT NULL,
  role TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE workflow_edges_taken (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), edge_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workflow_artifacts (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), kind TEXT NOT NULL,
  path TEXT NOT NULL, artifact_json TEXT NOT NULL);
CREATE TABLE workflow_loop_state (workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), loop_id TEXT NOT NULL,
  iteration INTEGER NOT NULL, max_iterations INTEGER NOT NULL, PRIMARY KEY (workflow_run_id, loop_id));
CREATE TABLE workflow_reviews (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  verdict TEXT NOT NULL, summary TEXT NOT NULL, review_json TEXT NOT NULL);
CREATE TABLE workflow_findings (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id), step_run_id TEXT NOT NULL,
  severity TEXT NOT NULL, finding_json TEXT NOT NULL);
CREATE TABLE workflow_announcements (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  announcement_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE provider_installations (provider_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE provider_health (provider_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE INDEX idx_conversations_project ON conversations(project_id);
CREATE INDEX idx_events_conversation ON agent_events(conversation_id, created_at);
CREATE INDEX idx_steps_workflow_run ON workflow_step_runs(workflow_run_id);
CREATE INDEX idx_routes_workflow_run ON routing_decisions(workflow_run_id, created_at);
`,
}];
