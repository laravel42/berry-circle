#!/usr/bin/env python3
"""Fail when the Berry server process could reach a model provider.

Bedrock is reached only from inside AgentCore Runtime (ADR-0014). The loop and
its tools live under server-ts/src/agents/runtime/, which is what the runtime
image ships; nothing else in server-ts/src may import a model SDK, and no
package.json in the repository may depend on a provider SDK at all.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = "server-ts/src/agents/runtime/"
FORBIDDEN_IMPORTS = (
    "@strands-agents/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-bedrock",
    "@anthropic-ai/",
    "openai",
    "@ai-sdk/",
    "@google/genai",
    "@google/generative-ai",
    "@mistralai/",
    "cohere-ai",
    "groq-sdk",
    "ollama",
)
# The model catalogue lists foundation models (a control-plane read); it never
# invokes one. Anything else under the bedrock control plane is refused.
CONTROL_PLANE_ALLOWED = {"server-ts/src/agents/catalog.ts": ("@aws-sdk/client-bedrock",)}
PROVIDER_PACKAGES = re.compile(
    r"^(openai|ai|@anthropic-ai/.*|@ai-sdk/.*|@google/genai|@google/generative-ai|"
    r"@mistralai/.*|cohere-ai|groq-sdk|ollama|@langchain/.*|langchain)$"
)
SKIP_DIRS = {"node_modules", ".next", ".next-verify", ".git"}
STATIC_IMPORT = re.compile(
    r"^\s*(?:import|export)\s+(type\s+)?(?:[^;'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]",
    re.MULTILINE | re.DOTALL,
)
DYNAMIC_IMPORT = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")


def forbidden(specifier: str) -> bool:
    return any(
        specifier == name or (name.endswith("/") and specifier.startswith(name)) or specifier.startswith(name + "/")
        for name in FORBIDDEN_IMPORTS
    )


def skipped(path: Path, root: Path) -> bool:
    parts = path.relative_to(root).parts
    return any(part in SKIP_DIRS or part.startswith(".tmp") for part in parts)


def source_offences(root: Path) -> list[str]:
    offences: list[str] = []
    src = root / "server-ts" / "src"
    if not src.is_dir():
        return offences
    for path in sorted(src.rglob("*.ts")):
        rel = path.relative_to(root).as_posix()
        if rel.startswith(RUNTIME_DIR) or skipped(path, root):
            continue
        text = path.read_text(encoding="utf-8")
        found: list[tuple[int, str]] = []
        for match in STATIC_IMPORT.finditer(text):
            if match.group(1):  # `import type` emits nothing
                continue
            found.append((match.start(), match.group(2)))
        for match in DYNAMIC_IMPORT.finditer(text):
            found.append((match.start(), match.group(1)))
        for offset, specifier in found:
            if not forbidden(specifier):
                continue
            if specifier in CONTROL_PLANE_ALLOWED.get(rel, ()):
                continue
            line = text.count("\n", 0, offset) + 1
            offences.append(f"{rel}:{line}: forbidden import '{specifier}'")
    return offences


def package_offences(root: Path) -> list[str]:
    offences: list[str] = []
    for path in sorted(root.rglob("package.json")):
        if skipped(path, root):
            continue
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            for name in sorted((manifest.get(field) or {}).keys()):
                if PROVIDER_PACKAGES.match(name):
                    rel = path.relative_to(root).as_posix()
                    offences.append(f"{rel}: provider SDK '{name}' in {field}")
    return offences


def value_imports(text: str) -> list[tuple[int, str]]:
    found = [(m.start(), m.group(2)) for m in STATIC_IMPORT.finditer(text) if not m.group(1)]
    found += [(m.start(), m.group(1)) for m in DYNAMIC_IMPORT.finditer(text)]
    return found


def transitive_offences(root: Path) -> list[str]:
    """Server modules that load a model SDK through a runtime module.

    The direct rule alone passes `import { toAgentName } from
    '../agents/runtime/agent.ts'`, yet that line loads @strands-agents/sdk into
    the server process. So every non-test module outside the runtime tree is
    followed through its relative value imports, and reaching a runtime module
    that imports a model SDK is an offence. Tests never run in the server
    process and are exempt.
    """
    offences: list[str] = []
    src = root / "server-ts" / "src"
    if not src.is_dir():
        return offences
    for entry in sorted(src.rglob("*.ts")):
        rel = entry.relative_to(root).as_posix()
        if rel.startswith(RUNTIME_DIR) or rel.endswith(".test.ts") or skipped(entry, root):
            continue
        seen: set[Path] = set()
        stack = [entry]
        hit: tuple[str, str] | None = None
        while stack and hit is None:
            current = stack.pop()
            if current in seen or not current.is_file():
                continue
            seen.add(current)
            try:
                current_rel = current.relative_to(root).as_posix()
            except ValueError:
                continue
            for _, specifier in value_imports(current.read_text(encoding="utf-8")):
                if specifier.startswith("."):
                    # normpath, not resolve(): a symlinked root (macOS /var) must stay comparable.
                    stack.append(Path(os.path.normpath(current.parent / specifier)))
                elif current != entry and current_rel.startswith(RUNTIME_DIR) and forbidden(specifier):
                    hit = (specifier, current_rel)
                    break
        if hit:
            offences.append(f"{rel}: reaches forbidden import '{hit[0]}' through {hit[1]}")
    return offences


def find_offences(root: Path) -> list[str]:
    return source_offences(root) + transitive_offences(root) + package_offences(root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    offences = find_offences(args.root.resolve())
    for offence in offences:
        print(offence)
    if offences:
        print(f"{len(offences)} model-SDK offence(s); see ADR-0014", file=sys.stderr)
        return 1
    print("no model SDK outside server-ts/src/agents/runtime/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
