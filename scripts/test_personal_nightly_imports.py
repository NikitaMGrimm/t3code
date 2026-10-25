import importlib.util
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
        conflicts = nightly.merge_delta(self.repo, original, incoming)
        return conflicts, (self.repo / path).read_text()

    def test_combines_adjacent_import_additions_and_keeps_clean_code_changes(self):
        base = 'import "./styles.css";\nimport * as namespace from "namespace";\nimport { common } from "shared";\n\nconst upstream = 0;\n' + '\n' * 10 + 'const feature = 0;\n'
        ours = base.replace('\n\nconst upstream = 0;', '\nimport { left } from "upstream";\n\nconst upstream = 1;')
        theirs = base.replace('\n\n', '\nimport type { Right } from "feature";\n\n', 1).replace('const feature = 0;', 'const feature = 1;')
        conflicts, text = self.merge(base, ours, theirs)
        self.assertEqual(conflicts, [])
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


if __name__ == "__main__":
    unittest.main()
