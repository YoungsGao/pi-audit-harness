import json
import os
import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from pi_audit.audit_mcp.registry import Registry
from pi_audit.audit_mcp.tools import cards
from pi_audit.audit_mcp.tools import scan


@pytest.mark.skipif(not os.environ.get('PI_AUDIT_SEMGREP_PATH'), reason='explicit local Semgrep required')
def test_real_python_framework_scanner_positive_and_bound_negative():
    contract = json.loads((Path(__file__).parents[1] / 'src/pi_audit/audit_mcp/contract.json').read_text('utf-8'))
    result = asyncio.run(scan([
        dict(filePath='Positive.java', source='class Positive { JdbcTemplate jdbc; Object find(String q) { String sql="SELECT id FROM users WHERE name="+q; return jdbc.queryForList(sql); } }'),
        dict(filePath='Bound.java', source='class Bound { JdbcTemplate jdbc; Object find(String q) { return jdbc.queryForList("SELECT id FROM users WHERE name=?", q); } }')
    ], os.environ['PI_AUDIT_SEMGREP_PATH'], contract['rules']))
    assert result['status'] == 'ok', result
    assert any(r['ruleId'] == 'audit-java-framework-sql' and r['filePath'] == 'Positive.java' for r in result['items'])
    assert not any(r['filePath'] == 'Bound.java' for r in result['items'])


def test_selection_revision_and_restart(tmp_path):
    registry = Registry(tmp_path)
    old = registry.get("static")
    added = registry.save(dict(name="second", kind="static", enabled=True))
    assert registry.get("static").enabled is False
    assert added.enabled
    assert registry.get("static").revision == old.revision + 1
    reopened = Registry(tmp_path)
    assert reopened.get(added.id).name == "second"
    with pytest.raises(ValueError, match="更新"):
        reopened.save({**added.model_dump(), "revision": 99})


def test_failed_replace_changes_neither_file_nor_memory(tmp_path):
    registry = Registry(tmp_path)
    before = registry.file.read_bytes()
    with patch("pi_audit.audit_mcp.registry.os.replace", side_effect=OSError("fixture disk failure")):
        with pytest.raises(OSError):
            registry.save(dict(name="not committed", kind="static", enabled=True))
    assert registry.file.read_bytes() == before
    assert len(registry.rows) == 2
    assert registry.get("static").enabled is True


def test_import_is_atomic_disabled_and_rejects_unsupported_credentials(tmp_path):
    registry = Registry(tmp_path)
    with pytest.raises(ValueError):
        registry.import_config({"mcpServers": {"ok": {"command": "python"}, "bad": {"command": "python", "env": {"API_KEY": "x"}}}})
    assert len(registry.rows) == 2
    imported = registry.import_config({"mcpServers": {"ok": {"command": "python", "args": ["-m", "example"]}}})
    assert imported[0].enabled is False
    assert json.loads(registry.file.read_text("utf-8"))["servers"][-1]["name"] == "ok"


def test_source_cards_respect_utf16_limits_and_crlf():
    scope = dict(projectId="p", runId="r", pathId="path")
    row = dict(filePath="A.java", startLine=3, endLine=5, text="return value;\r\n" + "😀" * 501 + "\r\n ")
    output = cards(scope, 0, [row])
    assert len(output) == 1
    assert output[0]["text"] == "return value;"
    assert output[0]["startLine"] == 3
    assert output[0]["id"].startswith("ev-0-0-3-")
