import json
import os
import re
import subprocess
from pathlib import Path

import requests

GROQ_API_KEY = os.environ["GROQ_API_KEY"]
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "vendor",
    ".venv",
    "__pycache__",
    ".next",
    "target",
}

SKIP_EXT = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".lock",
    ".min.js",
    ".map",
    ".zip",
    ".pdf",
    ".mp4",
    ".mp3",
}

# Safe limits
MAX_BATCH_CHARS = 25000
MAX_FILE_CHARS = 12000

CATEGORIES_PROMPT = """
Review this codebase across four categories:

1. Security - injection risks, auth/access-control flaws, secrets or
credentials in code, unsafe deserialization, vulnerable/outdated
dependencies, insecure defaults.

2. Performance - inefficient algorithms or queries, N+1 queries,
unnecessary re-renders/recomputation, memory leaks, blocking calls
on hot paths.

3. Bugs - logic errors, incorrect edge-case handling, race conditions,
null/undefined handling issues.

4. Maintainability / best practices - significant code smells,
duplicated logic, missing error handling, poor test coverage in
critical paths.

Respond with ONLY a JSON array.

Each element:

{
  "category":"security|performance|bug|maintainability",
  "title":"",
  "files":"",
  "description":"",
  "suggested_fix":""
}

Return [] if nothing significant is found.
"""


def collect_batches(root="."):
    batches = []

    current = []
    current_size = 0

    for path in sorted(Path(root).rglob("*")):

        if not path.is_file():
            continue

        if any(part in SKIP_DIRS for part in path.parts):
            continue

        if path.suffix.lower() in SKIP_EXT:
            continue

        try:
            text = path.read_text(
                encoding="utf-8",
                errors="ignore",
            )
        except Exception:
            continue

        if not text.strip():
            continue

        if len(text) > MAX_FILE_CHARS:
            text = text[:MAX_FILE_CHARS]

        entry = f"\n--- FILE: {path} ---\n{text}\n"

        if current_size + len(entry) > MAX_BATCH_CHARS:
            batches.append("".join(current))
            current = []
            current_size = 0

        current.append(entry)
        current_size += len(entry)

    if current:
        batches.append("".join(current))

    return batches


def call_groq(source_blob):
    messages = [
        {
            "role": "system",
            "content": "You are a meticulous senior software engineer performing a code review.",
        },
        {
            "role": "user",
            "content": CATEGORIES_PROMPT + "\n\nCODEBASE:\n" + source_blob,
        },
    ]

    resp = requests.post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 1500,
        },
        timeout=120,
    )

    if resp.status_code == 413:
        print("Skipped batch because payload exceeded Groq limit.")
        return []

    resp.raise_for_status()

    content = resp.json()["choices"][0]["message"]["content"]

    content = re.sub(
        r"^```(?:json)?|```$",
        "",
        content.strip(),
        flags=re.MULTILINE,
    ).strip()

    try:
        return json.loads(content)
    except Exception:
        print("Failed to parse model output.")
        print(content)
        return []


def existing_titles():
    result = subprocess.run(
        [
            "gh",
            "issue",
            "list",
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "title",
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    return {x["title"] for x in json.loads(result.stdout)}


def create_issue(finding, known_titles):
    category = finding.get("category", "maintainability").lower()

    title = f"[{category.capitalize()}] {finding['title']}"

    if title in known_titles:
        print(f"Skipping duplicate: {title}")
        return

    body = (
        f"**Files:** {finding.get('files','n/a')}\n\n"
        f"**Problem:**\n{finding.get('description','')}\n\n"
        f"**Suggested fix:**\n{finding.get('suggested_fix','')}\n\n"
        "_Filed automatically by scheduled Groq review._"
    )

    args = [
        "gh",
        "issue",
        "create",
        "--title",
        title,
        "--body",
        body,
    ]

    label = {
        "security": "security",
        "performance": "performance",
        "bug": "bug",
    }.get(category)

    if label:
        args += ["--label", label]

    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0 and label:
        result = subprocess.run(
            args[:-2],
            capture_output=True,
            text=True,
        )

    print(result.stdout or result.stderr)


def main():
    batches = collect_batches()

    if not batches:
        print("No source files found.")
        return

    print(f"Reviewing {len(batches)} batch(es)...")

    findings = []

    for index, batch in enumerate(batches, start=1):
        print(f"Batch {index}/{len(batches)}")

        try:
            findings.extend(call_groq(batch))
        except Exception as e:
            print(e)

    if not findings:
        print("No significant findings.")
        return

    known_titles = existing_titles()

    for finding in findings:
        create_issue(finding, known_titles)


if __name__ == "__main__":
    main()