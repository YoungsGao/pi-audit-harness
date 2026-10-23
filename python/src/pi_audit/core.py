import hashlib
import json
import time
import uuid
from pathlib import Path

from pydantic import ValidationError

from pi_audit.models import Evidence, ReadRequest, ToolError, ToolReply


MAX_BYTES = 1024 * 1024
MAX_LINES = 80
MAX_CHARS = 12000
EXTENSIONS = {".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"}


class AuditError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class EvidenceService:
    def __init__(self, root: Path, run_id: str, run_dir: Path):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("root 必须是目录")
        self.run_id = run_id
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._evidence: dict[str, Evidence] = {}
        self._hashes: dict[str, str] = {}

    def _load(self, relative_path: str) -> tuple[str, bytes]:
        requested = Path(relative_path)
        if requested.is_absolute() or requested.drive or requested.root:
            raise AuditError("PATH_OUTSIDE", "必须使用允许目录内的相对路径")
        if ".." in requested.parts:
            raise AuditError("PATH_OUTSIDE", "不允许使用上级目录路径")
        try:
            path = (self.root / requested).resolve(strict=True)
            if not path.is_relative_to(self.root):
                raise AuditError("PATH_OUTSIDE", "文件不在允许的项目目录内")
            if not path.is_file():
                raise AuditError("NOT_FILE", "目标必须是文件")
            if path.suffix.lower() not in EXTENSIONS:
                raise AuditError("FILE_TYPE", "当前只允许 JavaScript / TypeScript 源码")
            with path.open("rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
        except FileNotFoundError:
            raise AuditError("NOT_FOUND", "文件不存在") from None
        except (OSError, ValueError, RuntimeError):
            raise AuditError("IO_ERROR", "文件路径解析或读取失败") from None
        if len(raw) > MAX_BYTES:
            raise AuditError("FILE_TOO_LARGE", "文件超过 1 MiB 上限")
        return path.relative_to(self.root).as_posix(), raw

    def _read(self, payload: dict) -> Evidence:
        request = ReadRequest.model_validate(payload)
        path, raw = self._load(request.relative_path)
        file_hash = hashlib.sha256(raw).hexdigest()
        if path in self._hashes and self._hashes[path] != file_hash:
            raise AuditError("SOURCE_CHANGED", "本次运行中源码发生变化，请新建运行")
        try:
            lines = raw.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            raise AuditError("ENCODING_ERROR", "文件不是有效的 UTF-8 文本") from None
        if request.end_line > len(lines):
            raise AuditError("LINE_RANGE", f"文件只有 {len(lines)} 行")

        stop = min(request.end_line, request.start_line + MAX_LINES - 1)
        selected: list[str] = []
        used = 0
        for number in range(request.start_line, stop + 1):
            line = f"{number}: {lines[number - 1]}"
            needed = len(line) + (1 if selected else 0)
            if used + needed > MAX_CHARS:
                break
            selected.append(line)
            used += needed
        if not selected:
            raise AuditError("OUTPUT_LIMIT", "首行超过输出上限，当前不能按行返回")

        actual_end = request.start_line + len(selected) - 1
        truncated = actual_end < request.end_line
        evidence = Evidence(
            evidence_id=f"ev_{uuid.uuid4().hex}",
            run_id=self.run_id,
            path=path,
            start_line=request.start_line,
            end_line=actual_end,
            total_lines=len(lines),
            file_sha256=file_hash,
            code="\n".join(selected),
            truncated=truncated,
            next_line=actual_end + 1 if truncated else None,
        )
        with (self.run_dir / "evidence.jsonl").open("a", encoding="utf-8") as log:
            log.write(evidence.model_dump_json() + "\n")
        self._evidence[evidence.evidence_id] = evidence
        self._hashes[path] = file_hash
        return evidence

    def _check(self, evidence_id: str) -> Evidence:
        evidence = self._evidence.get(evidence_id)
        if evidence is None:
            raise AuditError("UNKNOWN_EVIDENCE", "此编号不属于当前服务运行")
        path, raw = self._load(evidence.path)
        if path != evidence.path or hashlib.sha256(raw).hexdigest() != evidence.file_sha256:
            raise AuditError("SOURCE_CHANGED", "证据对应的源码已改变")
        return evidence

    def _invoke(self, operation, argument) -> ToolReply:
        started = time.perf_counter()
        call_id = f"call_{uuid.uuid4().hex}"
        evidence = None
        error = None
        try:
            evidence = operation(argument)
        except ValidationError:
            error = ToolError(code="INVALID_ARGUMENT", message="参数不符合读取契约")
        except AuditError as exc:
            error = ToolError(code=exc.code, message=str(exc))
        except OSError:
            error = ToolError(code="IO_ERROR", message="证据日志写入失败")
        truncated = evidence.truncated if evidence else False
        reply = ToolReply(
            run_id=self.run_id,
            call_id=call_id,
            status="error" if error else ("partial" if truncated else "ok"),
            data=evidence,
            evidence_ids=[evidence.evidence_id] if evidence else [],
            error=error,
            duration_ms=(time.perf_counter() - started) * 1000,
            truncated=truncated,
            limitations=["返回范围未覆盖全部请求行"] if truncated else [],
        )
        with (self.run_dir / "calls.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({
                "call_id": call_id,
                "operation": operation.__name__,
                "status": reply.status,
                "error_code": error.code if error else None,
                "duration_ms": reply.duration_ms,
                "evidence_ids": reply.evidence_ids,
            }, ensure_ascii=False) + "\n")
        return reply

    def read(self, payload: dict) -> ToolReply:
        return self._invoke(self._read, payload)

    def check(self, evidence_id: str) -> ToolReply:
        return self._invoke(self._check, evidence_id)
