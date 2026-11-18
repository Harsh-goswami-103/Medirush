import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.groq_code_review import collect_batches, is_sensitive_path


class CodeReviewFileSelectionTests(unittest.TestCase):
    def test_sensitive_paths_are_rejected(self):
        for path in (
            ".env",
            ".env.example",
            ".envrc",
            "config/production.env",
            "secrets/production.json",
            "config/service-account.json",
            "certs/server.pem",
            ".aws/credentials",
            ".npmrc",
        ):
            with self.subTest(path=path):
                self.assertTrue(is_sensitive_path(path))

        self.assertFalse(is_sensitive_path("src/auth.ts"))

    def test_batches_include_only_tracked_safe_regular_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)

            files = {
                "src/app.ts": "export const safe = true;",
                ".env.production": "API_KEY=DO_NOT_SEND",
                ".env.example": "DATABASE_URL=DO_NOT_SEND",
                ".envrc": "export TOKEN=DO_NOT_SEND",
                "config/production.env": "TOKEN=DO_NOT_SEND",
                "secrets/production.json": '{"token":"DO_NOT_SEND"}',
                "certs/server.pem": "PRIVATE KEY DO_NOT_SEND",
                ".npmrc": "//registry.npmjs.org/:_authToken=DO_NOT_SEND",
            }
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")

            outside_secret = Path(temporary) / "outside-secret.txt"
            outside_secret.write_text("SYMLINK_SECRET_DO_NOT_SEND", encoding="utf-8")
            (root / "src" / "linked.ts").symlink_to(outside_secret)

            subprocess.run(["git", "add", "--all"], cwd=root, check=True)
            (root / "untracked.ts").write_text("UNTRACKED_DO_NOT_SEND", encoding="utf-8")

            content = "\n".join(collect_batches(root))

            self.assertIn("src/app.ts", content)
            for marker in (
                "DO_NOT_SEND",
                "PRIVATE KEY",
                "SYMLINK_SECRET_DO_NOT_SEND",
                "UNTRACKED_DO_NOT_SEND",
            ):
                self.assertNotIn(marker, content)


if __name__ == "__main__":
    unittest.main()
