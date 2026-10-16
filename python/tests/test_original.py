import hashlib

import pytest

from read_evidence import read_evidence


def test_read_selected_lines(tmp_path):
    raw = b"first\nsecond\nthird\n"
    (tmp_path / "app.js").write_bytes(raw)

    result = read_evidence(tmp_path, "app.js", 2, 3)

    assert result["path"] == "app.js"
    assert result["code"] == "2: second\n3: third"
    assert result["file_sha256"] == hashlib.sha256(raw).hexdigest()


def test_reject_path_outside(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (tmp_path / "outside.js").write_text("secret", encoding="utf-8")

    with pytest.raises(ValueError, match="文件不在允许的项目目录内"):
        read_evidence(project, "../outside.js", 1, 1)


@pytest.mark.parametrize("start,end", [(0, 1), (3, 2)])
def test_reject_invalid_range(tmp_path, start, end):
    (tmp_path / "app.js").write_text("one\ntwo\n", encoding="utf-8")

    with pytest.raises(ValueError, match="行号必须满足"):
        read_evidence(tmp_path, "app.js", start, end)


def test_reject_range_beyond_file(tmp_path):
    (tmp_path / "app.js").write_text("one\ntwo\n", encoding="utf-8")

    with pytest.raises(ValueError, match="文件只有 2 行"):
        read_evidence(tmp_path, "app.js", 1, 3)
