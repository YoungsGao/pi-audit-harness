import hashlib

import pytest

from pi_audit.core import EvidenceService, MAX_BYTES


@pytest.fixture
def sample(tmp_path):
    root = tmp_path / "target"
    root.mkdir()
    raw = "".join(f"line {i}\n" for i in range(1, 101)).encode("utf-8")
    (root / "app.js").write_bytes(raw)
    service = EvidenceService(root, "run_test", tmp_path / "run")
    return root, raw, service


def request(start=1, end=3, path="app.js"):
    return {"relative_path": path, "start_line": start, "end_line": end}


def test_exact_slice_and_hash(sample):
    _, raw, service = sample
    result = service.read(request(2, 3))
    assert result.status == "ok"
    assert result.data.code == "2: line 2\n3: line 3"
    assert result.data.file_sha256 == hashlib.sha256(raw).hexdigest()
    assert service.check(result.data.evidence_id).data == result.data


@pytest.mark.parametrize("payload", [
    request(0, 1),
    request(3, 2),
    request("1", 3),
    request(True, 3),
    {**request(), "project_root": "E:/"},
])
def test_reject_invalid_arguments(sample, payload):
    result = sample[2].read(payload)
    assert result.status == "error"
    assert result.error.code == "INVALID_ARGUMENT"
    assert result.data is None


@pytest.mark.parametrize("path", ["../outside.js", "../../README.md"])
def test_reject_parent_path(sample, path):
    result = sample[2].read(request(path=path))
    assert result.error.code == "PATH_OUTSIDE"


def test_reject_absolute_path(sample):
    root, _, service = sample
    assert service.read(request(path=str(root / "app.js"))).error.code == "PATH_OUTSIDE"


def test_reject_non_source(sample):
    root, _, service = sample
    (root / "note.txt").write_text("hello", encoding="utf-8")
    assert service.read(request(1, 1, "note.txt")).error.code == "FILE_TYPE"


def test_missing_file(sample):
    assert sample[2].read(request(path="missing.js")).error.code == "NOT_FOUND"


def test_reject_line_beyond_file(sample):
    assert sample[2].read(request(99, 101)).error.code == "LINE_RANGE"


def test_truncation_and_continuation(sample):
    service = sample[2]
    first = service.read(request(1, 100))
    assert first.status == "partial"
    assert first.data.end_line == 80
    assert first.data.next_line == 81
    second = service.read(request(first.data.next_line, 100))
    assert second.status == "ok"
    assert second.data.start_line == 81
    assert second.data.end_line == 100
    assert second.data.file_sha256 == first.data.file_sha256


def test_character_limit(sample):
    root, _, service = sample
    (root / "wide.js").write_text(("x" * 7000 + "\n") * 2, encoding="utf-8")
    result = service.read(request(1, 2, "wide.js"))
    assert result.status == "partial"
    assert result.data.end_line == 1
    assert result.data.next_line == 2


def test_single_line_too_long(sample):
    root, _, service = sample
    (root / "wide.js").write_text("x" * 12000, encoding="utf-8")
    assert service.read(request(1, 1, "wide.js")).error.code == "OUTPUT_LIMIT"


def test_large_file(sample):
    root, _, service = sample
    (root / "large.js").write_bytes(b"x" * (MAX_BYTES + 1))
    assert service.read(request(1, 1, "large.js")).error.code == "FILE_TOO_LARGE"


def test_non_utf8(sample):
    root, _, service = sample
    (root / "bad.js").write_bytes(b"\xff\xfe")
    assert service.read(request(1, 1, "bad.js")).error.code == "ENCODING_ERROR"


def test_source_change_invalidates_old_evidence(sample):
    root, _, service = sample
    evidence = service.read(request()).data
    with (root / "app.js").open("a", encoding="utf-8") as stream:
        stream.write("// changed\n")
    assert service.check(evidence.evidence_id).error.code == "SOURCE_CHANGED"
    assert service.read(request()).error.code == "SOURCE_CHANGED"


def test_other_run_does_not_accept_evidence(sample, tmp_path):
    root, _, first = sample
    evidence = first.read(request()).data
    second = EvidenceService(root, "run_other", tmp_path / "other")
    assert second.check(evidence.evidence_id).error.code == "UNKNOWN_EVIDENCE"


def test_unknown_evidence(sample):
    assert sample[2].check("ev_fake").error.code == "UNKNOWN_EVIDENCE"


def test_external_symlink_rejected(sample, tmp_path):
    root, _, service = sample
    outside = tmp_path / "outside.js"
    outside.write_text("outside\n", encoding="utf-8")
    try:
        (root / "link.js").symlink_to(outside)
    except OSError:
        pytest.skip("当前 Windows 环境没有创建符号链接的权限")
    assert service.read(request(1, 1, "link.js")).error.code == "PATH_OUTSIDE"
