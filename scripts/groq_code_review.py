import json
import os
import re
import subprocess
from pathlib import Path

import requests

GROQ_API_KEY = os.environ["GROQ_API_KEY"]
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Directories/extensions to skip entirely
SKIP_DIRS = {".git", "node_modules", "dist", "build", "vendor", ".venv",
             "__pycache__", ".next", "target"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2",
            ".ttf", ".lock", ".min.js", ".map", ".zip", ".pdf", ".mp4", ".mp3"}

MAX_TOTAL_CHARS = 150_000   # budget for source content sent to the model
MAX_FILE_CHARS = 20_000     # skip abnormally large single files

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

Respond with ONLY a JSON array (no markdown fences, no commentary).
Each element must have this exact shape:
{
  "category": "security" | "performance" | "bug" | "maintainability",
  "title": "short specific title",
  "files": "file path(s) and approximate line numbers",
  "description": "what the problem is and why it matters",
  "suggested_fix": "a concrete suggested direction"
}

If nothing significant is found, return an empty JSON array: []
Group minor style nitpicks into a single "maintainability" entry rather
than one entry per nitpick. Prioritize security and correctness over
style.
"""


def collect_source(root="."):
    chunks = []
    total = 0
    for path in sorted(Path(root).rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_EXT:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if not text.strip() or len(text) > MAX_FILE_CHARS:
            continue
        entry = f"\n--- FILE: {path} ---\n{text}"
        if total + len(entry) > MAX_TOTAL_CHARS:
            break
        chunks.append(entry)
        total += len(entry)
    return "".join(chunks)


def call_groq(source_blob):
    messages = [
        {"role": "system", "content": "You are a meticulous senior software engineer performing a code review."},
        {"role": "user", "content": CATEGORIES_PROMPT + "\n\nCODEBASE:\n" + source_blob},
    ]
    resp = requests.post(
        GROQ_URL,
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={"model": GROQ_MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 4000},
        timeout=120,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    content = re.sub(r"^```(json)?|```$", "", content.strip(), flags=re.MULTILINE).strip()
    return json.loads(content)


def existing_titles():
    result = subprocess.run(
        ["gh", "issue", "list", "--state", "open", "--limit", "200", "--json", "title"],
        capture_output=True, text=True, check=True,
    )
    return {item["title"] for item in json.loads(result.stdout)}


def create_issue(finding, known_titles):
    category = finding.get("category", "maintainability").lower()
    title = f"[{category.capitalize()}] {finding['title']}"
    if title in known_titles:
        print(f"Skipping duplicate: {title}")
        return
    body = (
        f"**Files:** {finding.get('files', 'n/a')}\n\n"
        f"**Problem:**\n{finding.get('description', '')}\n\n"
        f"**Suggested fix:**\n{finding.get('suggested_fix', '')}\n\n"
        f"_Filed automatically by scheduled Groq code review._"
    )
    args = ["gh", "issue", "create", "--title", title, "--body", body]
    label = {"security": "security", "performance": "performance", "bug": "bug"}.get(category)
    if label:
        args += ["--label", label]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0 and label:
        # Label probably doesn't exist in this repo -- retry without it
        result = subprocess.run(args[:-2], capture_output=True, text=True)
    print(result.stdout or result.stderr)


def main():
    source_blob = collect_source()
    if not source_blob.strip():
        print("No source files found to review.")
        return
    findings = call_groq(source_blob)
    if not findings:
        print("No significant findings.")
        return
    known_titles = existing_titles()
    for finding in findings:
        create_issue(finding, known_titles)


if __name__ == "__main__":
    main()