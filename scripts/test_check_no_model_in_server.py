#!/usr/bin/env python3
"""Self-test for check-no-model-in-server.py against throwaway trees."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-no-model-in-server.py"
spec = importlib.util.spec_from_file_location("check_no_model", SCRIPT)
assert spec and spec.loader
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def tree(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


class CheckTest(unittest.TestCase):
    def test_runtime_modules_may_import_the_model_sdk(self) -> None:
        root = tree({
            "server-ts/src/agents/runtime/model.ts": "import { BedrockModel } from '@strands-agents/sdk';\n",
            "server-ts/package.json": json.dumps({"dependencies": {"zod": "^4"}}),
        })
        self.assertEqual(check.find_offences(root), [])

    def test_server_code_importing_the_model_sdk_is_refused(self) -> None:
        root = tree({
            "server-ts/src/plans/triage.ts": "import {\n   Agent,\n} from '@strands-agents/sdk';\n",
            "server-ts/src/x.ts": "const m = await import('@aws-sdk/client-bedrock-runtime');\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 2)
        self.assertIn("server-ts/src/plans/triage.ts", offences[0])

    def test_type_only_imports_are_allowed(self) -> None:
        root = tree({"server-ts/src/a.ts": "import type { Message } from '@strands-agents/sdk';\n"})
        self.assertEqual(check.find_offences(root), [])

    def test_catalog_may_use_the_bedrock_control_plane_only(self) -> None:
        root = tree({
            "server-ts/src/agents/catalog.ts": "import { BedrockClient } from '@aws-sdk/client-bedrock';\n",
            "server-ts/src/b.ts": "import { BedrockClient } from '@aws-sdk/client-bedrock';\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 1)
        self.assertIn("server-ts/src/b.ts", offences[0])

    def test_provider_sdk_in_any_package_json_is_refused(self) -> None:
        root = tree({
            "frontend/package.json": json.dumps({"dependencies": {"openai": "^4"}}),
            "server-ts/package.json": json.dumps({"devDependencies": {"@anthropic-ai/sdk": "^1"}}),
            "node_modules/x/package.json": json.dumps({"dependencies": {"openai": "^4"}}),
        })
        self.assertEqual(len(check.find_offences(root)), 2)

    def test_a_value_import_that_loads_the_sdk_through_the_runtime_tree_is_refused(self) -> None:
        root = tree({
            "server-ts/src/agents/runtime/agent.ts": (
                "import { Agent } from '@strands-agents/sdk';\nexport const toAgentName = (n: string) => n;\n"
            ),
            "server-ts/src/agents/runtime/utf8.ts": "export const truncateUtf8 = (s: string) => s;\n",
            "server-ts/src/conversations/responder.ts": "import { toAgentName } from '../agents/runtime/agent.ts';\n",
            "server-ts/src/agents/prompt.ts": "import { truncateUtf8 } from './runtime/utf8.ts';\n",
            "server-ts/src/runtime/x.test.ts": "import { toAgentName } from '../agents/runtime/agent.ts';\n",
        })
        offences = check.find_offences(root)
        self.assertEqual(len(offences), 1)
        self.assertIn("server-ts/src/conversations/responder.ts", offences[0])


if __name__ == "__main__":
    unittest.main()
