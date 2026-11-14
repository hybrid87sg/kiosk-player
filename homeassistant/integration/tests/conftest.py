"""Test fixtures: a real Kiosk server (Node) and helpers to drive it as an admin would."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

import aiohttp
import pytest

SERVER_SCRIPT = Path(__file__).with_name("kiosk_server.js")


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Lets Home Assistant load custom_components/kiosk_player."""
    return


class KioskServer:
    """A running Kiosk server, and what an admin and a TV do on it."""

    def __init__(self, port: int) -> None:
        self.url = f"http://127.0.0.1:{port}"
        self.token: str | None = None

    async def call(
        self, method: str, path: str, json_body: Any = None, token: str | None = None, headers=None
    ) -> tuple[int, Any]:
        h = dict(headers or {})
        if token or self.token:
            h.setdefault("authorization", f"Bearer {token or self.token}")
        async with (
            aiohttp.ClientSession() as session,
            session.request(method, self.url + path, json=json_body, headers=h) as r,
        ):
            try:
                body = await r.json(content_type=None)
            except ValueError:
                body = None
            return r.status, body

    async def sign_in(self) -> None:
        _, body = await self.call("POST", "/api/auth/login", {"username": "boss", "password": "correct-horse-9"})
        self.token = body["token"]

    async def make_relay(self, name: str) -> dict[str, Any]:
        status, body = await self.call("POST", "/api/relays", {"name": name})
        assert status == 201, body
        return body

    async def new_code(self, relay_id: str) -> str:
        return (await self.call("POST", f"/api/relays/{relay_id}/pairing-code"))[1]["pairing_code"]

    async def pair_proxy(self, code: str) -> str:
        status, body = await self.call("POST", "/api/relay/v1/pair", {"code": code, "kind": "proxy"}, token="-")
        assert status == 201, body
        return body["credential"]

    async def add_tv(self, proxy: str, name: str, location: str) -> dict[str, Any]:
        _, tv = await self.call(
            "POST", "/api/player/register", {"app_version": "0.6.0"}, token="-", headers={"x-kiosk-relay-auth": proxy}
        )
        status, claimed = await self.call(
            "POST", "/api/devices/claim", {"code": tv["pairing_code"], "name": name, "location": location}
        )
        assert status == 200, claimed
        return {**claimed, "token": tv["token"], "proxy": proxy}

    async def tv_heartbeat(self, tv: dict[str, Any]) -> None:
        await self.call(
            "POST",
            "/api/player/heartbeat",
            {"app_version": "0.6.0"},
            token=tv["token"],
            headers={"x-kiosk-relay-auth": tv["proxy"]},
        )

    async def tv_fetch_playlist(self, tv: dict[str, Any]) -> dict[str, Any]:
        return (
            await self.call(
                "GET", "/api/player/playlist", token=tv["token"], headers={"x-kiosk-relay-auth": tv["proxy"]}
            )
        )[1]

    async def location_id(self, name: str) -> int:
        _, body = await self.call("GET", "/api/locations")
        return next(loc["id"] for loc in body["locations"] if loc["name"] == name)

    async def add_playlist(self, name: str, location: str) -> dict[str, Any]:
        status, body = await self.call(
            "POST",
            "/api/playlists",
            {"name": name, "orientation": "landscape", "location_id": await self.location_id(location)},
        )
        assert status == 201, body
        return body


@pytest.fixture
def socket_enabled_localhost(socket_enabled):
    """The real Kiosk server runs on this machine; the test may talk to it."""
    return


def _start(node: str, port: int, data_dir: str) -> tuple[subprocess.Popen, int]:
    env = {**os.environ, "KIOSK_TEST_PORT": str(port), "KIOSK_TEST_DATA": data_dir}
    process = subprocess.Popen(
        [node, str(SERVER_SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env
    )
    line = process.stdout.readline()
    process.stdout.close()
    return process, json.loads(line)["port"]


def _stop(process: subprocess.Popen) -> None:
    process.stdin.close()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


@pytest.fixture
async def kiosk_server(socket_enabled_localhost, tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed to run the real Kiosk server")
    loop = asyncio.get_running_loop()
    data_dir = str(tmp_path / "kiosk-data")
    os.makedirs(data_dir)
    process, port = await loop.run_in_executor(None, _start, node, 0, data_dir)
    server = KioskServer(port)

    async def stop() -> None:
        await loop.run_in_executor(None, _stop, server.process)

    async def start() -> None:
        server.process, _ = await loop.run_in_executor(None, _start, node, port, data_dir)

    server.process, server.stop, server.start = process, stop, start
    await server.sign_in()
    yield server
    await stop()
