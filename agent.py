"""
Minimal code-editing agent, Python port of Thorsten Ball's "How to build an agent".

Run:
    export ANTHROPIC_API_KEY=...
    python agent.py

Type messages. Ctrl-D or empty line to exit.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

from anthropic import Anthropic

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 4096
MAX_TOOL_ITERS = 25

Tool = dict[str, Any]


# ---------- tools ----------

def _safe_path(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    cwd = Path.cwd().resolve()
    if cwd not in p.parents and p != cwd:
        raise ValueError(f"path escapes working directory: {path}")
    return p


def read_file(path: str) -> str:
    return _safe_path(path).read_text()


def list_files(path: str = ".") -> str:
    root = _safe_path(path)
    if root.is_file():
        return root.name
    entries = []
    for entry in sorted(root.iterdir()):
        if entry.name.startswith("."):
            continue
        entries.append(entry.name + ("/" if entry.is_dir() else ""))
    return "\n".join(entries)


def edit_file(path: str, old_str: str, new_str: str) -> str:
    p = _safe_path(path)
    if not p.exists():
        if old_str:
            raise FileNotFoundError(f"{path} does not exist")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(new_str)
        return f"created {path}"
    text = p.read_text()
    count = text.count(old_str)
    if count == 0:
        raise ValueError("old_str not found")
    if count > 1:
        raise ValueError(f"old_str matches {count} times; make it unique")
    p.write_text(text.replace(old_str, new_str, 1))
    return f"edited {path}"


TOOLS: list[Tool] = [
    {
        "schema": {
            "name": "read_file",
            "description": "Read a UTF-8 text file. Returns its full contents.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
        "fn": read_file,
    },
    {
        "schema": {
            "name": "list_files",
            "description": "List files and directories at the given path. Defaults to cwd.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        },
        "fn": list_files,
    },
    {
        "schema": {
            "name": "edit_file",
            "description": (
                "Replace old_str with new_str in path. old_str must match exactly once. "
                "If path does not exist and old_str is empty, creates the file with new_str."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_str": {"type": "string"},
                    "new_str": {"type": "string"},
                },
                "required": ["path", "old_str", "new_str"],
            },
        },
        "fn": edit_file,
    },
]


# ---------- loop ----------

def run_agent(tools: list[Tool] = TOOLS, system: str = "") -> None:
    client = Anthropic()
    tool_by_name: dict[str, Callable[..., Any]] = {t["schema"]["name"]: t["fn"] for t in tools}
    schemas = [t["schema"] for t in tools]
    convo: list[dict[str, Any]] = []

    print("Agent ready. Ctrl-D or empty line to exit.")
    while True:
        try:
            user = input("\nYou: ").strip()
        except EOFError:
            return
        if not user:
            return
        convo.append({"role": "user", "content": user})

        for _ in range(MAX_TOOL_ITERS):
            resp = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=system,
                tools=schemas,
                messages=convo,
            )
            convo.append({"role": "assistant", "content": resp.content})

            tool_results = []
            for block in resp.content:
                if block.type == "text" and block.text:
                    print(f"\nClaude: {block.text}")
                elif block.type == "tool_use":
                    fn = tool_by_name.get(block.name)
                    args_preview = json.dumps(block.input)[:200]
                    print(f"  -> {block.name}({args_preview})")
                    if fn is None:
                        out = f"ERROR: unknown tool {block.name}"
                        is_error = True
                    else:
                        try:
                            out = fn(**block.input)
                            is_error = False
                        except Exception as e:
                            out = f"ERROR: {type(e).__name__}: {e}"
                            is_error = True
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(out),
                        "is_error": is_error,
                    })

            if resp.stop_reason != "tool_use" or not tool_results:
                break
            convo.append({"role": "user", "content": tool_results})
        else:
            print(f"  (stopped: hit MAX_TOOL_ITERS={MAX_TOOL_ITERS})")


if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set")
    run_agent()
