export const mcpMigration = `
CREATE TABLE recovery_mcp_tools (
 journey_id TEXT NOT NULL, request_key TEXT NOT NULL,
 path_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 binding_hash TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 sha256 TEXT NOT NULL, saved_at TEXT NOT NULL,
 PRIMARY KEY(journey_id,request_key),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TRIGGER immutable_mcp_receipts_update BEFORE UPDATE ON recovery_mcp_tools BEGIN SELECT RAISE(ABORT,'MCP receipts are immutable'); END;
CREATE TRIGGER immutable_mcp_receipts_delete BEFORE DELETE ON recovery_mcp_tools BEGIN SELECT RAISE(ABORT,'MCP receipts are immutable'); END;
`
