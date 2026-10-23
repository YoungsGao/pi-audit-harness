import argparse
import json
from pathlib import Path

from pi_audit.models import ToolReply


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    schema = ToolReply.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(args.output.resolve())


if __name__ == "__main__":
    main()
