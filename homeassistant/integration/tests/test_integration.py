"""Kiosk Player integration tests, against a real Kiosk server (see conftest.py)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import device_registry as dr, entity_registry as er
import pytest

from custom_components.kiosk_player.const import DOMAIN
from custom_components.kiosk_player.diagnostics import async_get_config_entry_diagnostics

from .conftest import KioskServer


async def wait_for(hass: HomeAssistant, check: Callable[[], bool], timeout: float = 12.0) -> None:  # noqa: ASYNC109 (a plain wait limit)
    """Lets Home Assistant run until check() is true (the server pushes changes within ~5 s)."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not check():
        if loop.time() > end:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.1)
        await hass.async_block_till_done()


async def pair(hass: HomeAssistant, url: str, code: str):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    return await hass.config_entries.flow.async_configure(result["flow_id"], {"url": url, "pairing_code": code})


async def setup_relay(hass: HomeAssistant, server: KioskServer, name: str = "Qoltured"):
    """A relay on the server with one TV, and this Home Assistant paired as it."""
    made = await server.make_relay(name)
    proxy = await server.pair_proxy(made["pairing_code"])
    tv = await server.add_tv(proxy, "Cafe wall", name)
    result = await pair(hass, server.url.replace("http://", ""), made["pairing_code"].lower())
    assert result["type"] is FlowResultType.CREATE_ENTRY, result
    await hass.async_block_till_done()
    entry = hass.config_entries.async_get_entry(result["result"].entry_id)
    await wait_for(hass, lambda: entry.runtime_data.socket.connected)
    return made, proxy, tv, entry


def state(hass: HomeAssistant, entity_id: str) -> str | None:
    s = hass.states.get(entity_id)
    return s.state if s else None


async def unload(hass: HomeAssistant, entry) -> None:
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_pairing_creates_relay_and_screens(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    made, _, tv, entry = await setup_relay(hass, kiosk_server)
    assert entry.title == "Qoltured"
    assert entry.unique_id == made["relay"]["id"]
    assert entry.data["url"] == kiosk_server.url  # http:// and the port were filled in
    assert entry.data["credential"].startswith("rk_")
    assert entry.state is ConfigEntryState.LOADED

    # One device for the relay, one for its TV, linked.
    devices = dr.async_get(hass)
    relay_device = devices.async_get_device({(DOMAIN, entry.unique_id)})
    tv_device = devices.async_get_device({(DOMAIN, f"{entry.unique_id}_{tv['id']}")})
    assert relay_device and tv_device
    assert tv_device.name == "Cafe wall"
    assert tv_device.via_device_id == relay_device.id

    entities = er.async_get(hass)
    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(entities, entry.entry_id)}
    assert state(hass, ids[f"{entry.unique_id}_server_connected"]) == "on"
    assert state(hass, ids[f"{entry.unique_id}_{tv['id']}_online"]) == "on"
    assert state(hass, ids[f"{entry.unique_id}_{tv['id']}_playlist"]) == "Landscape"
    assert state(hass, ids[f"{entry.unique_id}_{tv['id']}_playlist_select"]) == "Automatic"
    assert state(hass, ids[f"{entry.unique_id}_players_online"]) == "1"

    # The server shows the integration as paired and connected.
    _, view = await kiosk_server.call("GET", f"/api/relays/{entry.unique_id}")
    assert view["paired"] == {"control": True, "proxy": True}
    assert view["connected"] is True

    # The same relay can't be added twice (its code is used up anyway; a new one is needed).
    again = await pair(hass, kiosk_server.url, await kiosk_server.new_code(entry.unique_id))
    assert again["type"] is FlowResultType.ABORT
    assert again["reason"] == "already_configured"
    await unload(hass, entry)


async def test_pairing_errors(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    made = await kiosk_server.make_relay("Linsy")
    # Mistyped.
    result = await pair(hass, kiosk_server.url, "AAAAA-BBBBB")
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_code"}
    # Replaced by a newer code (as an expired one is refused the same way).
    newer = await kiosk_server.new_code(made["relay"]["id"])
    result = await pair(hass, kiosk_server.url, made["pairing_code"])
    assert result["errors"] == {"base": "invalid_code"}
    # Nothing listening there.
    result = await pair(hass, "127.0.0.1:1", newer)
    assert result["errors"] == {"url": "cannot_connect"}
    # Disabled relay.
    await kiosk_server.call("PATCH", f"/api/relays/{made['relay']['id']}", {"status": "disabled"})
    result = await pair(hass, kiosk_server.url, newer)
    assert result["errors"] == {"base": "relay_disabled"}


async def test_live_updates_and_commands(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    made, proxy, tv, entry = await setup_relay(hass, kiosk_server)
    coordinator = entry.runtime_data
    promo = await kiosk_server.add_playlist("Promo", "Qoltured")
    events: list = []
    hass.bus.async_listen(f"{DOMAIN}_command_updated", lambda e: events.append(e.data))

    # A rename on the main server shows up through the live connection, without waiting for the poll.
    await kiosk_server.call("PATCH", f"/api/devices/{tv['id']}", {"name": "Cafe wall 2"})
    await wait_for(hass, lambda: coordinator.data[tv["id"]]["name"] == "Cafe wall 2")

    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}
    select = ids[f"{entry.unique_id}_{tv['id']}_playlist_select"]
    await wait_for(hass, lambda: "Promo" in hass.states.get(select).attributes["options"])

    # Choosing a playlist sends play_playlist; the server applies it.
    await hass.services.async_call("select", "select_option", {"entity_id": select, "option": "Promo"}, blocking=True)
    await wait_for(hass, lambda: state(hass, select) == "Promo")
    _, player = await kiosk_server.call("GET", f"/api/relay/v1/players/{tv['id']}", token=entry.data["credential"])
    assert player["playlist_id"] == promo["id"]
    await wait_for(hass, lambda: any(e["status"] == "applied" for e in events))
    # When the TV fetches it, the command is acknowledged, and an event says so.
    await kiosk_server.tv_fetch_playlist(tv)
    await wait_for(hass, lambda: any(e["status"] == "acknowledged" for e in events))

    # The action, by playlist name, back to Automatic.
    device = dr.async_get(hass).async_get_device({(DOMAIN, f"{entry.unique_id}_{tv['id']}")})
    await hass.services.async_call(
        DOMAIN, "play_playlist", {"device_id": device.id, "playlist": "automatic"}, blocking=True
    )
    await wait_for(hass, lambda: state(hass, select) == "Automatic")
    # An unknown playlist is a clear error and changes nothing.
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN, "play_playlist", {"device_id": device.id, "playlist": "Nope"}, blocking=True
        )

    # Refresh, by button and by action.
    refresh = ids[f"{entry.unique_id}_{tv['id']}_refresh"]
    await hass.services.async_call("button", "press", {"entity_id": refresh}, blocking=True)
    await hass.services.async_call(DOMAIN, "refresh_player", {"device_id": device.id}, blocking=True)
    await wait_for(hass, lambda: sum(1 for e in events if e["kind"] == "refresh") >= 2)

    # A screen moved to another relay on the main server: commands for it are refused clearly.
    other = await kiosk_server.make_relay("Linsy")
    await kiosk_server.call("PUT", f"/api/devices/{tv['id']}/relay", {"relay_id": other["relay"]["id"]})
    with pytest.raises(HomeAssistantError, match="isn't one of this relay's screens"):
        await hass.services.async_call(DOMAIN, "refresh_player", {"device_id": device.id}, blocking=True)
    # ...and it disappears from this relay (unavailable), which then lets it be deleted.
    await wait_for(hass, lambda: tv["id"] not in coordinator.data)
    await wait_for(hass, lambda: state(hass, select) == "unavailable")

    # A new TV at this relay turns up by itself.
    tv2 = await kiosk_server.add_tv(proxy, "Counter", "Qoltured")
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert dr.async_get(hass).async_get_device({(DOMAIN, f"{entry.unique_id}_{tv2['id']}")}) is not None
    await unload(hass, entry)


async def test_offline_screen_fires_event(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    _, _, tv, entry = await setup_relay(hass, kiosk_server)
    events: list = []
    hass.bus.async_listen(f"{DOMAIN}_player_offline", lambda e: events.append(e.data))
    # The server's offline check runs every 30 s and can't be hurried from here, so its message
    # (as tested on the server side in relay-live.test.js) is handed straight to the coordinator.
    await entry.runtime_data._handle_message({"type": "player.offline", "player_id": tv["id"], "at": 0})
    await hass.async_block_till_done()
    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}
    assert state(hass, ids[f"{entry.unique_id}_{tv['id']}_online"]) == "off"
    assert state(hass, ids[f"{entry.unique_id}_players_offline"]) == "1"
    assert events and events[0]["player_id"] == tv["id"] and events[0]["name"] == "Cafe wall"
    await unload(hass, entry)


async def test_revoked_credential_asks_to_pair_again(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    made, _, _, entry = await setup_relay(hass, kiosk_server)
    _, view = await kiosk_server.call("GET", f"/api/relays/{entry.unique_id}")
    control = next(c for c in view["credentials"] if c["kind"] == "control")
    await kiosk_server.call("POST", f"/api/relays/{entry.unique_id}/credentials/{control['id']}/revoke")

    # The live connection is closed, the reconnect is refused, and Home Assistant asks to re-pair.
    await wait_for(
        hass, lambda: any(f["context"]["source"] == "reauth" for f in hass.config_entries.flow.async_progress())
    )
    flow = next(f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == "reauth")
    assert flow["step_id"] == "reauth_confirm"

    # A code for a different relay is refused.
    other = await kiosk_server.make_relay("Linsy")
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], {"pairing_code": other["pairing_code"]})
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "wrong_relay"

    await wait_for(
        hass, lambda: any(f["context"]["source"] == "reauth" for f in hass.config_entries.flow.async_progress()), 70
    )
    flow = next(f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == "reauth")
    old = entry.data["credential"]
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {"pairing_code": await kiosk_server.new_code(entry.unique_id)}
    )
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "reauth_successful"
    await hass.async_block_till_done()
    assert entry.data["credential"] != old
    await wait_for(hass, lambda: entry.state is ConfigEntryState.LOADED and entry.runtime_data.socket.connected)
    await unload(hass, entry)


async def test_new_credential_handed_over_live(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    _, _, _, entry = await setup_relay(hass, kiosk_server)
    old = entry.data["credential"]
    status, _ = await kiosk_server.call("POST", f"/api/relays/{entry.unique_id}/rotate", {"kind": "control"})
    assert status == 201
    await wait_for(hass, lambda: entry.data["credential"] != old)
    # It reconnects with the new one, and the old one stops working.
    await wait_for(hass, lambda: entry.runtime_data.socket.connected)
    status, _ = await kiosk_server.call("GET", "/api/relay/v1/me", token=old)
    assert status == 401
    status, _ = await kiosk_server.call("GET", "/api/relay/v1/me", token=entry.data["credential"])
    assert status == 200
    await unload(hass, entry)


async def test_reconnects_after_the_main_server_restarts(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    _, _, _, entry = await setup_relay(hass, kiosk_server)
    changes: list = []
    hass.bus.async_listen(f"{DOMAIN}_connection_changed", lambda e: changes.append(e.data["connected"]))
    ids = {e.unique_id: e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}
    connected = ids[f"{entry.unique_id}_server_connected"]

    await kiosk_server.stop()
    await wait_for(hass, lambda: state(hass, connected) == "off")
    assert entry.state is ConfigEntryState.LOADED  # nothing to re-pair: the server is just away
    assert not any(f["context"]["source"] == "reauth" for f in hass.config_entries.flow.async_progress())

    await kiosk_server.start()
    await wait_for(hass, lambda: state(hass, connected) == "on", timeout=20)
    assert changes[:2] == [False, True]
    await unload(hass, entry)


async def test_diagnostics_never_show_the_credential(hass: HomeAssistant, kiosk_server: KioskServer) -> None:
    _, _, _, entry = await setup_relay(hass, kiosk_server)
    diag = await async_get_config_entry_diagnostics(hass, entry)
    text = json.dumps(diag, default=str)
    assert "rk_" not in text
    assert entry.data["credential_id"] not in text
    assert "127.0.0.1" not in text
    assert diag["connected"] is True
    assert len(diag["players"]) == 1
    await unload(hass, entry)
