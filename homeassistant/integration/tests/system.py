"""Pieces for the full-system tests: relay add-ons, TVs, and a link that can be cut.

Everything is real except Google Drive and the TVs' screens:
- the main Kiosk server (kiosk_server.js, see conftest.py),
- each site's relay add-on: `node server/src/index.js` in relay mode, its own process,
- each site's Home Assistant integration (in the test's Home Assistant),
- each site's "Tailscale": a small TCP link (CutLink) between that site and the main server,
  which the test can cut and restore, as when a site's internet or Tailscale drops,
- TVs: HTTP clients doing what the Kiosk Player app does, through their site's relay.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

import aiohttp

SERVER_DIR = Path(__file__).resolve().parents[3] / "server"


class CutLink:
    """A TCP pass-through to the main server that can be cut (closing every connection) and restored."""

    def __init__(self, target_port: int) -> None:
        self.target_port = target_port
        self.port = 0
        self._server: asyncio.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()
        self._tasks: set[asyncio.Task] = set()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", self.port)
        self.port = self._server.sockets[0].getsockname()[1]

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target_port)
        except OSError:
            writer.close()
            return
        self._writers |= {writer, up_writer}

        async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
            with contextlib.suppress(OSError, asyncio.CancelledError):
                while data := await src.read(65536):
                    dst.write(data)
                    await dst.drain()
            dst.close()

        for task in (asyncio.create_task(pipe(reader, up_writer)), asyncio.create_task(pipe(up_reader, writer))):
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def cut(self) -> None:
        """No new connections, and the open ones (e.g. the live connection) are dropped."""
        if self._server is not None:
            self._server.close()
            self._server = None
        for writer in list(self._writers):
            writer.close()
        self._writers.clear()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.sleep(0.1)

    async def restore(self) -> None:
        await self.start()

    async def close(self) -> None:
        await self.cut()


class RelayAddon:
    """The Kiosk add-on in relay mode, as its own process, like on a site's Home Assistant."""

    def __init__(self, site: str, main_url: str, data_dir: str) -> None:
        self.site = site
        self.main_url = main_url
        self.data_dir = data_dir
        self.process: subprocess.Popen | None = None
        self.port = 0

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self, pairing_code: str = "") -> None:
        node = shutil.which("node")
        if self.port == 0:
            with contextlib.closing(__import__("socket").socket()) as s:
                s.bind(("127.0.0.1", 0))
                self.port = s.getsockname()[1]
        env = {
            **os.environ,
            "MODE": "relay",
            "SITE_NAME": self.site,
            "MAIN_SERVER_URL": self.main_url,
            "PAIRING_CODE": pairing_code,
            "PORT": str(self.port),
            "DATA_DIR": self.data_dir,
            "HA_OPTIONS_FILE": os.path.join(self.data_dir, "no-options.json"),
        }
        env.pop("INGRESS_PORT", None)
        self.process = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: subprocess.Popen(  # noqa: ASYNC220 (runs in a worker thread)
                [node, str(SERVER_DIR / "src" / "index.js")],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ),
        )
        for _ in range(100):
            with contextlib.suppress(aiohttp.ClientError):
                async with aiohttp.ClientSession() as session, session.get(f"{self.url}/api/health") as r:
                    if r.status == 200:
                        return
            await asyncio.sleep(0.1)
        raise AssertionError(f"relay add-on for {self.site} didn't start")

    async def stop(self) -> None:
        if self.process is not None:
            self.process.terminate()
            await asyncio.get_running_loop().run_in_executor(None, self.process.wait)
            self.process = None

    async def pairing(self) -> dict[str, Any]:
        async with aiohttp.ClientSession() as session, session.get(f"{self.url}/api/relay/status") as r:
            return (await r.json())["pairing"]


class Tv:
    """A TV running Kiosk Player, talking to its site's relay (or straight to the main server)."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.token: str | None = None
        self.pairing_code: str | None = None
        self.id: int | None = None

    async def call(self, method: str, path: str, json_body: Any = None) -> tuple[int, Any]:
        headers = {"authorization": f"Bearer {self.token}"} if self.token else {}
        async with (
            aiohttp.ClientSession() as session,
            session.request(method, self.base_url + path, json=json_body, headers=headers) as r,
        ):
            body = await r.read()
            try:
                import json

                return r.status, json.loads(body)
            except ValueError:
                return r.status, body

    async def register(self) -> None:
        status, body = await self.call("POST", "/api/player/register", {"app_version": "0.6.0", "model": "Test TV"})
        assert status == 201, body
        self.token, self.pairing_code = body["token"], body["pairing_code"]

    async def heartbeat(self) -> tuple[int, Any]:
        return await self.call("POST", "/api/player/heartbeat", {"app_version": "0.6.0"})

    async def playlist(self) -> tuple[int, Any]:
        return await self.call("GET", "/api/player/playlist")

    async def download(self, media_id: int) -> tuple[int, Any]:
        return await self.call("GET", f"/media/{media_id}")
