import importlib.util
import json
import os
import subprocess
import sys
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("personal_nightly_imports", Path(__file__).with_name("personal-nightly.py"))
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)


class ImportConflictTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        nightly.git("init", "-b", "main", cwd=self.repo)
        nightly.git("config", "user.name", "test", cwd=self.repo)
        nightly.git("config", "user.email", "test@example.invalid", cwd=self.repo)

    def commit(self, text, path):
        file = self.repo / path
        file.write_text(text)
        nightly.git("add", path, cwd=self.repo)
        nightly.git("commit", "-m", "fixture", cwd=self.repo)
        return nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()

    def merge(self, base, ours, theirs, path="example.test.ts"):
        original = self.commit(base, path)
        incoming = self.commit(theirs, path)
        nightly.git("checkout", "--detach", original, cwd=self.repo)
        self.commit(ours, path)
        self.resolved_imports = []
        conflicts = nightly.merge_delta(self.repo, original, incoming, import_tests=self.resolved_imports)
        return conflicts, (self.repo / path).read_text()

    def test_combines_adjacent_import_additions_and_keeps_clean_code_changes(self):
        base = 'import "./styles.css";\nimport * as namespace from "namespace";\nimport { common } from "shared";\n\nconst upstream = 0;\n' + '\n' * 10 + 'const feature = 0;\n'
        ours = base.replace('\n\nconst upstream = 0;', '\nimport { left } from "upstream";\n\nconst upstream = 1;')
        theirs = base.replace('\n\n', '\nimport type { Right } from "feature";\n\n', 1).replace('const feature = 0;', 'const feature = 1;')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertEqual(self.resolved_imports, ['example.test.ts'])
        self.assertIn('import { left } from "upstream";', text)
        self.assertIn('import type { Right } from "feature";', text)
        self.assertIn('const upstream = 1;', text)
        self.assertIn('const feature = 1;', text)
        self.assertEqual(nightly.git("diff", "--name-only", "--diff-filter=U", cwd=self.repo).stdout, "")

    def test_combines_named_additions_to_the_same_declaration_once(self):
        base = 'import { common } from "shared";\n\nrun();\n'
        ours = base.replace('{ common }', '{ common, left }')
        theirs = base.replace('{ common }', '{ common, right }')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertIn('import { common, left, right } from "shared";', text)
        self.assertEqual(text.count('common'), 1)

    def test_preserves_inline_type_import_module_evaluation(self):
        base = 'import { type Common } from "shared";\n\nrun();\n'
        ours = base.replace('type Common', 'type Common, type Left')
        theirs = base.replace('type Common', 'type Common, type Right')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertIn('import { type Common, type Left, type Right } from "shared";', text)
        self.assertNotIn('import type', text)

    def test_refuses_removals_aliases_side_effects_and_competing_bindings(self):
        for base, ours, theirs in [
            ('import { common } from "x";\n', 'import { left } from "x";\n', 'import { common, right } from "x";\n'),
            ('', 'import { left as local } from "x";\n', 'import { right } from "y";\n'),
            ('', 'import "side-effect";\n', 'import { right } from "y";\n'),
            ('', 'import { same } from "x";\n', 'import { same } from "y";\n'),
            ('', 'import type { same } from "x";\n', 'import { same } from "x";\n'),
            ('', '// why this import matters\nimport { left } from "x";\n', 'import { right } from "y";\n'),
            ('import { first } from "x";\nimport { second } from "y";\n',
             'import { second } from "y";\nimport { first, left } from "x";\n',
             'import { first } from "x";\nimport { second, right } from "y";\n'),
        ]:
            with self.subTest(ours=ours, theirs=theirs):
                self.assertIsNone(nightly.additive_imports(base, ours, theirs))

    def test_refuses_a_binding_collision_with_an_unchanged_default_import(self):
        base = 'import local from "existing";\n\nrun();\n'
        ours = base.replace('\n\n', '\nimport { local } from "new";\n\n')
        theirs = base.replace('\n\n', '\nimport { other } from "feature";\n\n')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, ['example.test.ts'])
        self.assertIn('<<<<<<<', text)

    def test_refuses_to_move_setup_after_an_existing_module(self):
        base = 'import { a } from "a";\nimport { b } from "b";\n\nrun();\n'
        ours = base.replace('{ a }', '{ a, left }')
        theirs = base.replace('import { b }', 'import { setup } from "setup";\nimport { b, right }')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, ['example.test.ts'])
        self.assertIn('<<<<<<<', text)

    def test_escaped_module_specifiers_are_left_for_manual_resolution(self):
        base = 'import { a } from "./fo\\u006f";\n\nrun();\n'
        conflicts, text = self.merge(base, base.replace('{ a }', '{ a, left }'), base.replace('{ a }', '{ a, right }'))
        self.assertEqual(conflicts, ['example.test.ts'])
        self.assertIn('<<<<<<<', text)

    def test_runtime_files_still_require_manual_resolution(self):
        base = 'import { common } from "x";\n\nrun();\n'
        conflicts, _ = self.merge(base, base.replace('common', 'common, left'), base.replace('common', 'common, right'), 'example.ts')
        self.assertEqual(conflicts, ['example.ts'])

    def test_a_code_conflict_leaves_the_whole_file_unresolved(self):
        base = 'import { common } from "x";\n\nrun("base");\n'
        ours = base.replace('common', 'common, left').replace('"base"', '"ours"')
        theirs = base.replace('common', 'common, right').replace('"base"', '"theirs"')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, ['example.test.ts'])
        self.assertIn('<<<<<<<', text)

    def test_import_text_inside_a_template_literal_is_not_treated_as_imports(self):
        base = 'const template = `\nimport { common } from "x";\n`;\n'
        conflicts, _ = self.merge(base, base.replace('common', 'common, left'), base.replace('common', 'common, right'))
        self.assertEqual(conflicts, ['example.test.ts'])


class ReconciledTestVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        nightly.git("init", cwd=self.repo)
        for package in ("packages/contracts", "apps/web"):
            directory = self.repo / package
            directory.mkdir(parents=True)
            (directory / "package.json").write_text('{}')
        self.unit = "packages/contracts/preview.test.ts"
        self.browser = "apps/web/preview.browser.test.tsx"
        for path in (self.unit, self.browser):
            (self.repo / path).write_text('// test fixture\n')
        nightly.git("add", ".", cwd=self.repo)
        binaries = self.repo / "bin"
        binaries.mkdir()
        vp = binaries / "vp"
        vp.write_text('#!' + sys.executable + '\n' +
                      "import json, os, sys\n"
                      "with open(os.environ['VP_CALLS'], 'a') as log:\n"
                      "    log.write(json.dumps({'cwd': os.getcwd(), 'args': sys.argv[1:]}) + '\\n')\n"
                      "if sys.argv[1] == os.environ.get('VP_FAIL'):\n"
                      "    sys.exit(7)\n"
                      "files = [arg for arg in sys.argv[1:] if arg.endswith(('.ts', '.tsx'))]\n"
                      "if sys.argv[1] == 'test' and files and all('.spec.' in arg for arg in files):\n"
                      "    sys.exit(5)\n")
        vp.chmod(0o755)
        self.log = self.repo / "calls.jsonl"
        self.env = {"PATH": str(binaries) + os.pathsep + os.environ.get("PATH", ""), "VP_CALLS": str(self.log)}

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_runs_scoped_types_and_each_affected_test_with_the_correct_runner(self):
        with patch.dict(os.environ, self.env):
            nightly.verify_import_tests(self.repo, {"resolvedTestImports": [self.browser, self.unit, self.unit]})
        calls = self.calls()
        self.assertEqual(len(calls), 4)
        self.assertEqual({tuple(call["args"]) for call in calls[:2]}, {
            ("run", "--filter", "./apps/web", "typecheck"),
            ("run", "--filter", "./packages/contracts", "typecheck"),
        })
        self.assertEqual(calls[2], {"cwd": str(self.repo), "args": ["test", "run", "./" + self.unit]})
        self.assertEqual(calls[3], {"cwd": str(self.repo / "apps/web"),
                                    "args": ["test", "run", "--project", "browser", "./preview.browser.test.tsx"]})

    def test_a_typecheck_or_test_failure_stops_verification(self):
        for command, expected_calls in (("run", 1), ("test", 3)):
            with self.subTest(command=command):
                self.log.unlink(missing_ok=True)
                with patch.dict(os.environ, {**self.env, "VP_FAIL": command}), self.assertRaises(subprocess.CalledProcessError) as error:
                    nightly.verify_import_tests(self.repo, {"resolvedTestImports": [self.unit, self.browser]})
                self.assertEqual(error.exception.returncode, 7)
                self.assertEqual(len(self.calls()), expected_calls)

    def test_a_passing_file_cannot_hide_an_undiscovered_unit_or_browser_file(self):
        for ignored, passing in (("packages/contracts/ignored.spec.ts", self.unit),
                                 ("apps/web/ignored.browser.spec.tsx", self.browser)):
            with self.subTest(ignored=ignored):
                (self.repo / ignored).write_text("// excluded by discovery\n")
                nightly.git("add", ignored, cwd=self.repo)
                self.log.unlink(missing_ok=True)
                with patch.dict(os.environ, self.env), self.assertRaises(subprocess.CalledProcessError) as error:
                    nightly.verify_import_tests(self.repo, {"resolvedTestImports": [passing, ignored]})
                self.assertEqual(error.exception.returncode, 5)
                tests = [call for call in self.calls() if call["args"][0] == "test"]
                self.assertEqual(len(tests), 1)
                self.assertEqual(tests[0]["args"][-1], "./" + ignored.split("apps/web/", 1)[-1])

    def test_rejects_invalid_metadata_before_running_any_candidate_commands(self):
        for paths in ("not-a-list", [1], ["../outside.test.ts"], ["packages/contracts/package.json"], ["apps/web/missing.test.ts"]):
            with self.subTest(paths=paths), patch.dict(os.environ, self.env), self.assertRaises(ValueError):
                nightly.verify_import_tests(self.repo, {"resolvedTestImports": paths})
        self.assertEqual(self.calls(), [])
        with patch.dict(os.environ, self.env):
            nightly.verify_import_tests(self.repo, {})
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
