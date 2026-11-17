import asyncio
import hashlib
import json
import os
import re
import tempfile
import subprocess
from pathlib import Path

PROFILE = "audit-mcp/1;codegraph/1;static/1"
SEMGREP_VERSION = "1.185.0"


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(compact(value).encode("utf-8")).hexdigest()


def cards(scope, step, ranges):
    result = []
    for index, row in enumerate(ranges):
        key = digest([scope["projectId"], scope["runId"], scope["pathId"], step, row])[:16]
        for offset, text in enumerate(re.split(r"\r?\n", row["text"])):
            if text.strip() and len(text.encode("utf-16-le")) // 2 <= 1000:
                line = row["startLine"] + offset
                result.append(dict(id=f"ev-{step}-{index}-{line}-{key}", filePath=row["filePath"], startLine=line, endLine=line, text=text))
    return result


async def process(command, args, cwd, env, timeout):
    child = await asyncio.create_subprocess_exec(command, *args, cwd=cwd, env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        out, _ = await asyncio.wait_for(child.communicate(), timeout)
        if child.returncode:
            raise RuntimeError("STATIC_EXECUTION_FAILED")
        if len(out) > 4 * 1024 * 1024:
            raise RuntimeError("STATIC_OUTPUT_LIMIT")
        return out.decode("utf-8").strip()
    finally:
        if child.returncode is None:
            child.kill()
            await child.communicate()


async def scan(files, executable, rules):
    empty = lambda status, gap: dict(status=status, engine="semgrep/" + SEMGREP_VERSION, gaps=[gap], truncated=False, items=[])
    if not executable:
        return empty("unavailable", "SEMGREP_NOT_CONFIGURED")
    if not Path(executable).is_absolute() or not Path(executable).is_file():
        return empty("unavailable", "SEMGREP_PATH_INVALID")
    if not files or len(files) > 2 or any(len(f["source"].encode("utf-8")) > 262144 for f in files):
        return empty("partial", "STATIC_INPUT_LIMIT")
    with tempfile.TemporaryDirectory(prefix="pi-static-python-") as folder:
        env = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "LD_LIBRARY_PATH"}}
        env.update({key: folder for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TEMP", "TMP"]})
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", SEMGREP_SEND_METRICS="off", SEMGREP_ENABLE_VERSION_CHECK="0")
        try:
            version = await process(executable, ["--version"], folder, env, 10)
            if version != SEMGREP_VERSION:
                return empty("unavailable", "SEMGREP_VERSION_MISMATCH")
            source_dir = Path(folder) / "sources"
            source_dir.mkdir()
            rule_file = Path(folder) / "rules.json"
            rule_file.write_text(compact(rules), "utf-8")
            for i, file in enumerate(files):
                (source_dir / f"Input{i}.java").write_text(file["source"], "utf-8", newline="")
            data = json.loads(await process(executable, ["scan", "--json", "--metrics=off", "--disable-version-check", "--no-git-ignore", "--no-rewrite-rule-ids", "--jobs=1", "--timeout=5", "--max-memory=256", "--max-target-bytes=262144", "--config", str(rule_file), "sources"], folder, env, 20))
            items = []
            for hit in data["results"]:
                match = re.fullmatch(r"sources[/\\]Input([01])\.java", hit["path"])
                rule = next((r for r in rules["rules"] if r["id"] == hit["check_id"]), None)
                if not match or not rule:
                    raise RuntimeError("STATIC_LOCATION_INVALID")
                file = files[int(match[1])]
                first, last = hit["start"]["line"], hit["end"]["line"]
                if not 1 <= first <= last <= len(file["source"].split("\n")):
                    raise RuntimeError("STATIC_LOCATION_INVALID")
                if len(items) < 12:
                    items.append(dict(findingId="finding-" + digest([digest(rules), file, hit["check_id"], first, last])[:24],
                        ruleId=rule["id"], filePath=file["filePath"], startLine=first, endLine=last,
                        message=rule["message"], classification="static-finding", confirmedVulnerability=False))
            return dict(status="partial" if data["errors"] or len(data["results"]) > 12 else "ok", engine="semgrep/" + version,
                gaps=["STATIC_PARSE_OR_TIMEOUT_GAPS"] if data["errors"] else [], truncated=len(data["results"]) > 12, items=items)
        except asyncio.TimeoutError:
            return empty("failed", "STATIC_TIMEOUT")
        except (OSError, ValueError, KeyError, RuntimeError):
            return empty("failed", "STATIC_EXECUTION_FAILED")


class EvidenceTools:
    def __init__(self, bundle, rules):
        self.bundle, self.rules = bundle, rules
        self.targets = {}
        self.files = {f["filePath"]: f["source"] for f in bundle["files"]}
        for receipt in bundle.get("receipts", []):
            if receipt["name"] == "audit_find_related":
                for row in receipt["output"]["items"]:
                    self.targets[row["targetId"]] = (receipt["args"]["stepIndex"], row["item"])

    async def call(self, name, args, config):
        scope = self.bundle
        step = args["stepIndex"]
        if type(step) is not int or not 0 <= step < len(scope["steps"]):
            raise ValueError("AGENT_TOOL_SCOPE")
        edge = scope["steps"][step]["edge"]
        output = dict(contractVersion=1, tool=name, profile=PROFILE,
            server="audit-static/1" if name == "audit_static_scan" else "audit-codegraph/1",
            snapshotId=scope["snapshotId"], sourceStamp=scope["sourceStamp"], stepIndex=step,
            status="ok", truncated=False, gaps=[], items=[], ranges=[], citations=[], engine="codegraph", rulesDigest=None)
        if name == "audit_find_related":
            graph = scope["graph"]
            methods = {row["key"]: row["item"] for row in graph["methods"]}
            call = next((c for c in graph["calls"] if c["filePath"] == edge["filePath"] and c["line"] == edge["callLine"] and c["column"] == edge["callColumn"]), None)
            gaps = list(graph["gaps"])
            items = []
            if call:
                direction = args["direction"]
                if direction == "definition":
                    gaps.extend(call["gaps"])
                    items = [methods[key] for key in call["targets"] if key in methods]
                else:
                    own = call["caller"] if direction == "outgoing" else (call["targets"][0] if len(call["targets"]) == 1 else None)
                    if direction == "incoming":
                        gaps.extend(call["gaps"])
                    for c in graph["calls"]:
                        if direction == "outgoing" and c["caller"] == own:
                            keys = c["targets"]
                        elif direction == "incoming" and own in c["targets"]:
                            keys = [c["caller"]]
                        else:
                            continue
                        gaps.extend(c["gaps"])
                        site = dict(filePath=c["filePath"], start=dict(line=c["line"], column=c["column"]), end=dict(line=c["line"], column=c["column"] + len(c["name"].encode("utf-16-le")) // 2))
                        items.extend({**methods[key], "callSite": site} for key in keys if key in methods)
            output["engine"] = graph["engine"]
            output["truncated"] = len(items) > 8
            if len(items) > 8:
                gaps.append("QUERY_RESULT_LIMIT")
            output["gaps"] = list(dict.fromkeys(gaps))[:24]
            output["status"] = "unavailable" if "CODEGRAPH_NOT_AVAILABLE" in gaps else "partial" if gaps else "ok"
            for item in items[:8]:
                target = "rel-" + digest([PROFILE, scope["projectId"], scope["runId"], scope["pathId"], scope["snapshotId"], args, item])[:32]
                self.targets[target] = (step, item)
                output["items"].append(dict(targetId=target, item=item, classification="graph-candidate"))
        elif name == "audit_read_related":
            target = self.targets.get(args["targetId"])
            if not target or target[0] != step:
                raise ValueError("AGENT_TOOL_SCOPE")
            item = target[1]
            location = item["symbol"]["location"] if item.get("symbol") else item["location"]
            lines = self.files[location["filePath"]].split("\n")
            first, last = location["start"]["line"], min(len(lines), location["end"]["line"], location["start"]["line"] + 79)
            text = "\n".join(lines[first - 1:last])
            if len(text.encode("utf-8")) > 12000:
                output.update(status="partial", truncated=True, gaps=["RELATED_SOURCE_BYTES_LIMIT"])
            else:
                output["ranges"] = [dict(filePath=location["filePath"], startLine=first, endLine=last, text=text)]
                output["citations"] = cards(scope, step, output["ranges"])
                if last < location["end"]["line"]:
                    output.update(status="partial", truncated=True, gaps=["RELATED_SOURCE_LINES_LIMIT"])
        elif name == "audit_static_scan":
            paths = list(dict.fromkeys([edge["filePath"]] + ([edge["calledFilePath"]] if edge.get("calledFilePath") else [])))
            output.update(await scan([dict(filePath=p, source=self.files[p]) for p in paths], config.semgrepPath, self.rules))
            output["rulesDigest"] = digest(self.rules)
        else:
            raise ValueError("AGENT_TOOL_SCOPE")
        return output
