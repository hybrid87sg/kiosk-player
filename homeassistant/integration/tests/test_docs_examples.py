"""The automations and scripts in docs/ha-examples.md load in Home Assistant as written."""

from pathlib import Path
import re

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import yaml

EXAMPLES = Path(__file__).resolve().parents[3] / "docs" / "ha-examples.md"


async def test_examples_load(hass: HomeAssistant) -> None:
    blocks = [yaml.safe_load(b) for b in re.findall(r"```yaml\n(.*?)```", EXAMPLES.read_text(), re.S)]
    automations = [b for b in blocks if "triggers" in b]
    scripts = {f"example_{i}": b for i, b in enumerate(b for b in blocks if "sequence" in b)}
    assert automations and scripts
    assert await async_setup_component(hass, "automation", {"automation": automations})
    assert await async_setup_component(hass, "script", {"script": scripts})
    await hass.async_block_till_done()
    loaded = [s for s in hass.states.async_all() if s.domain in ("automation", "script")]
    # An example with a mistake would be missing or "unavailable".
    assert len(loaded) == len(automations) + len(scripts)
    assert all(s.state != "unavailable" for s in loaded)
