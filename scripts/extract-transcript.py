#!/usr/bin/env python3
"""
extract-transcript.py — Extract visible conversation from a Claude Code JSONL transcript.

Usage:
    extract-transcript.py <session-id> [project-dir]

Environment:
    TRANSCRIPT_BUDGET  Max characters to include (default: 50000)

The transcript path is computed as:
    ~/.claude/projects/{sanitized-project-path}/{session-id}.jsonl

where sanitized-project-path replaces '/' with '-' in the realpath of project-dir.
If no project-dir is given, the current working directory is used.

If the file doesn't exist, the script exits silently (exit 0, no output).
"""

import json
import os
import sys
from datetime import datetime, timezone


TRANSCRIPT_BUDGET = int(os.environ.get("TRANSCRIPT_BUDGET", "50000"))
TRUNCATE_AT = 2000
TRUNCATE_KEEP = 800


def sanitize_path(path: str) -> str:
    """Convert an absolute path to the Claude projects directory component."""
    real = os.path.realpath(path)
    # Replace every '/' with '-' (leading '/' becomes leading '-')
    return real.replace("/", "-")


def transcript_path(session_id: str, project_dir: str) -> str:
    sanitized = sanitize_path(project_dir)
    base = os.path.expanduser("~/.claude/projects")
    return os.path.join(base, sanitized, f"{session_id}.jsonl")


def parse_message_field(raw_message):
    """Return the message dict, handling both dict and JSON-string forms."""
    if isinstance(raw_message, dict):
        return raw_message
    if isinstance(raw_message, str):
        try:
            parsed = json.loads(raw_message)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def extract_text_from_content(content):
    """Extract visible text from a content list (assistant messages).

    Keeps only type='text' blocks; skips 'thinking' and 'tool_use'.
    Returns None if no text blocks found.
    """
    if not isinstance(content, list):
        return None
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            if text:
                parts.append(text)
    return "\n\n".join(parts) if parts else None


def truncate_message(text: str) -> str:
    """Truncate a message that exceeds TRUNCATE_AT chars."""
    if len(text) <= TRUNCATE_AT:
        return text
    omitted = len(text) - TRUNCATE_KEEP * 2
    return (
        text[:TRUNCATE_KEEP]
        + f"\n[...truncated ~{omitted} chars...]\n"
        + text[-TRUNCATE_KEEP:]
    )


def format_ts(iso_str: str) -> str:
    """Format an ISO timestamp to a readable date-time string."""
    try:
        # Handle both Z suffix and +00:00
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        dt_local = dt.astimezone()
        return dt_local.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso_str


def load_entries(path: str):
    """Read and parse JSONL entries, skipping malformed lines."""
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return entries


def build_turns(entries):
    """
    Convert raw JSONL entries into a list of turn dicts.

    Each turn dict is one of:
      {"type": "turn", "ts": ..., "user": ..., "assistant": ...}
      {"type": "boundary", "ts": ...}
    """
    turns = []
    pending_user = None

    for entry in entries:
        # Skip sidechain entries
        if entry.get("isSidechain"):
            continue

        role = entry.get("type")
        ts = entry.get("timestamp", "")

        # Compact boundary marker
        if role == "system":
            subtype = entry.get("subtype", "")
            if subtype == "compact_boundary":
                # Flush any incomplete user turn
                if pending_user is not None:
                    turns.append({
                        "type": "turn",
                        "ts": pending_user["ts"],
                        "user": pending_user["text"],
                        "assistant": None,
                    })
                    pending_user = None
                turns.append({"type": "boundary", "ts": ts})
            continue

        if role == "user":
            msg = parse_message_field(entry.get("message"))
            if msg is None:
                continue
            content = msg.get("content")
            # Only plain-string content (skip tool_result lists)
            if not isinstance(content, str):
                continue
            if not content.strip():
                continue
            # Flush any pending user without a response
            if pending_user is not None:
                turns.append({
                    "type": "turn",
                    "ts": pending_user["ts"],
                    "user": pending_user["text"],
                    "assistant": None,
                })
            pending_user = {"ts": ts, "text": content}

        elif role == "assistant":
            msg = parse_message_field(entry.get("message"))
            if msg is None:
                continue
            content = msg.get("content")
            text = extract_text_from_content(content)
            if text is None:
                continue
            if pending_user is not None:
                turns.append({
                    "type": "turn",
                    "ts": pending_user["ts"],
                    "user": pending_user["text"],
                    "assistant_ts": ts,
                    "assistant": text,
                })
                pending_user = None
            # else: assistant message without preceding user — skip

    # Flush any trailing incomplete user turn
    if pending_user is not None:
        turns.append({
            "type": "turn",
            "ts": pending_user["ts"],
            "user": pending_user["text"],
            "assistant": None,
        })

    return turns


def apply_budget(turns, budget: int):
    """
    Walk backwards through turns, truncating messages to fit within budget.

    Returns (selected_turns_in_order, total_chars).
    """
    selected = []
    used = 0

    for turn in reversed(turns):
        if turn["type"] == "boundary":
            # Boundaries are cheap — always include them
            selected.append(turn)
            continue

        user_text = truncate_message(turn.get("user") or "")
        assistant_text = turn.get("assistant")
        if assistant_text:
            assistant_text = truncate_message(assistant_text)

        chunk_size = len(user_text) + (len(assistant_text) if assistant_text else 0)

        if used + chunk_size > budget and selected:
            # Budget exceeded — stop adding more turns
            break

        used += chunk_size
        selected.append({**turn, "user": user_text, "assistant": assistant_text})

    selected.reverse()
    return selected, used


def format_output(turns, total_chars: int) -> str:
    """Render the selected turns as a markdown string."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    visible_turns = [t for t in turns if t["type"] == "turn"]
    n = len(visible_turns)

    lines = [
        f"# Recent Conversation (before compaction)",
        "",
        f"_Extracted at {now}. Last {n} visible turns, ~{total_chars} chars._",
        "",
    ]

    turn_num = 0
    for turn in turns:
        if turn["type"] == "boundary":
            ts_str = format_ts(turn.get("ts", ""))
            lines += [
                "---",
                f"_[Compaction boundary at {ts_str} — earlier conversation was compressed]_",
                "---",
                "",
            ]
            continue

        turn_num += 1
        ts_str = format_ts(turn.get("ts", ""))
        lines.append(f"## Turn {turn_num} ({ts_str})")
        lines.append(f"**User**: {turn['user']}")
        if turn.get("assistant"):
            lines.append(f"**Claude**: {turn['assistant']}")
        lines.append("")

    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    session_id = args[0]
    project_dir = args[1] if len(args) > 1 else os.getcwd()

    path = transcript_path(session_id, project_dir)

    if not os.path.exists(path):
        sys.exit(0)

    entries = load_entries(path)
    if not entries:
        sys.exit(0)

    turns = build_turns(entries)
    if not turns:
        sys.exit(0)

    selected, total_chars = apply_budget(turns, TRANSCRIPT_BUDGET)
    if not selected:
        sys.exit(0)

    print(format_output(selected, total_chars))


if __name__ == "__main__":
    main()
