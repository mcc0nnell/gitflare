#!/usr/bin/env python3
"""Drive Gitflare CI MCP tools through a TalkPipe ChatterLang segment."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
import urllib.response
from collections.abc import Iterable, Iterator
from typing import Any

from talkpipe.chatterlang import compiler, registry
from talkpipe.pipe import core

MCP_VERSION = "2026-07-28"
TOOLS = ("ci_run_start", "ci_run_status", "ci_run_retry", "ci_run_cancel")


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _parse_response(response: urllib.response.addinfourl) -> dict[str, Any]:
    body = response.read().decode("utf-8")
    content_type = response.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:") :].strip())
        raise RuntimeError("MCP SSE response did not contain a data frame")
    return json.loads(body)


@registry.register_segment(name="gitflareMcpCall")
@core.segment()
def gitflare_mcp_call(items: Iterable[Any], tool: str) -> Iterator[dict[str, Any]]:
    """Call one Gitflare CI MCP tool for each input item."""

    if tool not in TOOLS:
        raise ValueError(f"unsupported tool: {tool}")

    endpoint = _required_env("GITFLARE_CI_MCP_URL")
    token = _required_env("GITFLARE_CI_MCP_TOKEN")

    for sequence, item in enumerate(items, start=1):
        arguments = json.loads(item) if isinstance(item, str) else item
        if not isinstance(arguments, dict):
            raise TypeError("TalkPipe input must decode to a JSON object")

        payload = {
            "jsonrpc": "2.0",
            "id": sequence,
            "method": "tools/call",
            "params": {
                "name": tool,
                "arguments": arguments,
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
                    "io.modelcontextprotocol/clientInfo": {
                        "name": "gitflare-talkpipe",
                        "version": "0.1.0",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
            },
        }
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": MCP_VERSION,
                "Mcp-Method": "tools/call",
                "Mcp-Name": tool,
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                yield _parse_response(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"MCP HTTP {error.code}: {detail}") from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", choices=TOOLS)
    parser.add_argument(
        "arguments",
        help='JSON object passed to the MCP tool, for example {"id":"ci-..."}',
    )
    args = parser.parse_args()

    # ChatterLang remains the orchestration spine: the custom segment is only
    # the transport adapter between a TalkPipe stream and the MCP endpoint.
    script = f'| gitflareMcpCall[tool="{args.tool}"] | print'
    pipeline = compiler.compile(script).as_function(single_in=True, single_out=False)
    list(pipeline(args.arguments))


if __name__ == "__main__":
    main()
