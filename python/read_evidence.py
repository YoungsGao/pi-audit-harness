from pathlib import Path
import hashlib
import json
import uuid


def read_evidence(
    project_root: Path,
    relative_path: str,
    start_line: int,
    end_line: int,
) -> dict:
    # 1. 检查行号
    if start_line < 1 or end_line < start_line:
        raise ValueError("行号必须满足：1 <= start_line <= end_line")

    if end_line - start_line + 1 > 80:
        raise ValueError("一次最多读取 80 行")

    # 2. 检查文件路径
    root = project_root.resolve(strict=True)
    requested_path = Path(relative_path)

    if requested_path.is_absolute():
        raise ValueError("请使用项目内的相对路径")

    file_path = (root / requested_path).resolve(strict=True)

    if not file_path.is_relative_to(root):
        raise ValueError("文件不在允许的项目目录内")

    if not file_path.is_file():
        raise ValueError("目标必须是文件")

    # 3. 读取文件，并计算整个文件的哈希
    file_bytes = file_path.read_bytes()
    file_hash = hashlib.sha256(file_bytes).hexdigest()

    text = file_bytes.decode("utf-8")
    lines = text.splitlines()

    if end_line > len(lines):
        raise ValueError(f"文件只有 {len(lines)} 行")

    # 4. 选出指定行，并保留原始行号
    selected_lines = lines[start_line - 1:end_line]

    numbered_code = "\n".join(
        f"{line_number}: {line}"
        for line_number, line in enumerate(
            selected_lines,
            start=start_line,
        )
    )

    # 5. 返回结构化证据
    return {
        "evidence_id": f"ev_{uuid.uuid4().hex}",
        "path": file_path.relative_to(root).as_posix(),
        "start_line": start_line,
        "end_line": end_line,
        "file_sha256": file_hash,
        "code": numbered_code,
    }


if __name__ == "__main__":
    repository_root = Path(__file__).resolve().parents[1]
    project_root = repository_root / "fixtures" / "express"

    evidence = read_evidence(
        project_root=project_root,
        relative_path="app.js",
        start_line=6,
        end_line=8,
    )

    print(json.dumps(evidence, ensure_ascii=False, indent=2))