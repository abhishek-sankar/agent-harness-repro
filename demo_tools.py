"""
Sketch of the demo-capture tool layer.

Two backends behind a shared DemoSession interface:

  - PlaywrightSession   : web apps. Runnable today. `pip install playwright`
                          then `playwright install chromium`.
  - SimulatorSession    : iOS apps. Stubbed; real `xcrun simctl` / `xcodebuild`
                          invocations are inlined in comments so the gap to a
                          working macOS implementation is obvious.

Agent-facing tools are produced by `demo_tools(session)`, which returns a list
in the same {"schema","fn"} shape agent.py expects. So:

    from agent import TOOLS, run_agent
    from demo_tools import PlaywrightSession, demo_tools
    session = PlaywrightSession()
    run_agent(tools=TOOLS + demo_tools(session))

Vision-in-the-loop: `screenshot` returns base64 PNG alongside a path. The
harness is expected to attach the b64 as an `image` content block on the
*next* user turn (or inside tool_result once Anthropic's tool_result supports
images end-to-end), so the model can see what its last action produced and
self-correct. That closes the loop.
"""

from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol


# ---------- shared interface ----------

class DemoSession(Protocol):
    def start(self, target: str, **kwargs: Any) -> dict[str, Any]: ...
    def stop(self) -> dict[str, Any]: ...
    def act(self, action: str, **kwargs: Any) -> dict[str, Any]: ...
    def screenshot(self) -> dict[str, Any]: ...
    def start_recording(self, out_path: str | None = None) -> dict[str, Any]: ...
    def stop_recording(self) -> dict[str, Any]: ...
    def narrate(self, text: str) -> dict[str, Any]: ...


@dataclass
class Artifacts:
    """Single place every backend drops files. One task = one Artifacts dir."""
    root: Path
    screenshots: Path = field(init=False)
    recordings: Path = field(init=False)
    narration_path: Path = field(init=False)
    recording_started_at: float | None = None

    def __post_init__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.screenshots = self.root / "screenshots"
        self.recordings = self.root / "recordings"
        self.screenshots.mkdir(exist_ok=True)
        self.recordings.mkdir(exist_ok=True)
        self.narration_path = self.root / "narration.jsonl"


# ---------- Playwright backend (runnable) ----------

class PlaywrightSession:
    """
    Web demo backend. Records video via Playwright's built-in context recorder.

    Minimum set of `act` verbs chosen deliberately small — the model composes
    them. Extend on demand; resist the urge to wrap every Playwright method.
    """

    ACTIONS = {"click", "fill", "press", "goto", "wait_for", "assert_text"}

    def __init__(self, artifacts_dir: str = "./artifacts") -> None:
        self.artifacts = Artifacts(Path(artifacts_dir))
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None

    def start(self, target: str, headless: bool = True, viewport: dict | None = None) -> dict[str, Any]:
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=headless)
        self._context = self._browser.new_context(
            record_video_dir=str(self.artifacts.recordings),
            viewport=viewport or {"width": 1280, "height": 800},
        )
        self.artifacts.recording_started_at = time.time()
        self._page = self._context.new_page()
        self._page.goto(target)
        return {"url": self._page.url, "title": self._page.title()}

    def stop(self) -> dict[str, Any]:
        video_path = None
        if self._page and self._page.video:
            video_path = self._page.video.path()
        if self._context:
            self._context.close()
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()
        self._pw = self._browser = self._context = self._page = None
        return {"video": str(video_path) if video_path else None}

    def act(self, action: str, **kwargs: Any) -> dict[str, Any]:
        if action not in self.ACTIONS:
            raise ValueError(f"unknown action {action!r}; one of {sorted(self.ACTIONS)}")
        if self._page is None:
            raise RuntimeError("session not started")
        p = self._page
        if action == "click":
            p.click(kwargs["selector"], timeout=kwargs.get("timeout", 5000))
        elif action == "fill":
            p.fill(kwargs["selector"], kwargs["value"])
        elif action == "press":
            p.press(kwargs["selector"], kwargs["key"])
        elif action == "goto":
            p.goto(kwargs["url"])
        elif action == "wait_for":
            p.wait_for_selector(kwargs["selector"], timeout=kwargs.get("timeout", 5000))
        elif action == "assert_text":
            text = kwargs["text"]
            if text not in p.content():
                raise AssertionError(f"text {text!r} not on page")
        return {"ok": True, "url": p.url}

    def screenshot(self) -> dict[str, Any]:
        if self._page is None:
            raise RuntimeError("session not started")
        path = self.artifacts.screenshots / f"shot-{int(time.time() * 1000)}.png"
        png = self._page.screenshot(path=str(path), full_page=False)
        return {"path": str(path), "b64": base64.b64encode(png).decode()}

    def start_recording(self, out_path: str | None = None) -> dict[str, Any]:
        # Playwright records for the lifetime of a context. To "start" a new
        # recording mid-session, close the current context and open a new one.
        # This is fine — most demos are one context anyway. Left explicit so
        # the agent can't silently start a second recording.
        return {"note": "recording starts at context creation; use start() to begin"}

    def stop_recording(self) -> dict[str, Any]:
        return self.stop()

    def narrate(self, text: str) -> dict[str, Any]:
        ts = time.time() - (self.artifacts.recording_started_at or time.time())
        with self.artifacts.narration_path.open("a") as f:
            f.write(json.dumps({"ts": round(ts, 3), "text": text}) + "\n")
        return {"ts": round(ts, 3)}


# ---------- iOS Simulator backend (sketch) ----------

class SimulatorSession:
    """
    iOS demo backend. NOT runtime-verified — shapes the interface and names
    the exact shell commands to wire up on a macOS host.

    Typical lifecycle:
        xcrun simctl boot "iPhone 15"
        xcrun simctl launch booted <bundle_id>
        xcrun simctl io booted recordVideo <path.mov>   # background subprocess
        xcrun simctl io booted screenshot <path.png>
        # interactions: xcrun simctl io booted tap|swipe, or `idb`, or XCUITest
        SIGINT the recordVideo process to finalize the mp4/mov
        xcrun simctl shutdown booted
    """

    def __init__(self, artifacts_dir: str = "./artifacts") -> None:
        self.artifacts = Artifacts(Path(artifacts_dir))
        self.device: str | None = None
        self.bundle_id: str | None = None
        self._rec_proc: subprocess.Popen | None = None
        self._rec_path: Path | None = None

    def start(self, target: str, device: str = "iPhone 15") -> dict[str, Any]:
        # target == bundle_id for this backend
        self.device = device
        self.bundle_id = target
        subprocess.run(["xcrun", "simctl", "boot", device], check=False)
        subprocess.run(["xcrun", "simctl", "launch", "booted", target], check=True)
        return {"device": device, "bundle_id": target}

    def stop(self) -> dict[str, Any]:
        if self._rec_proc is not None:
            self.stop_recording()
        subprocess.run(["xcrun", "simctl", "shutdown", "booted"], check=False)
        return {"ok": True}

    def act(self, action: str, **kwargs: Any) -> dict[str, Any]:
        # `simctl io` supports tap / swipe / key events. Richer UI automation
        # (find-by-accessibility-id, typing into fields) wants `idb` or an
        # XCUITest runner host app. Sketching the minimal surface here.
        if action == "tap":
            x, y = kwargs["x"], kwargs["y"]
            subprocess.run(["xcrun", "simctl", "io", "booted", "tap", str(x), str(y)], check=True)
        elif action == "swipe":
            x1, y1, x2, y2 = kwargs["x1"], kwargs["y1"], kwargs["x2"], kwargs["y2"]
            subprocess.run(
                ["xcrun", "simctl", "io", "booted", "swipe",
                 str(x1), str(y1), str(x2), str(y2)],
                check=True,
            )
        elif action == "key":
            subprocess.run(["xcrun", "simctl", "io", "booted", "key", kwargs["key"]], check=True)
        else:
            raise ValueError(f"unknown simulator action {action!r}")
        return {"ok": True}

    def screenshot(self) -> dict[str, Any]:
        path = self.artifacts.screenshots / f"shot-{int(time.time() * 1000)}.png"
        subprocess.run(
            ["xcrun", "simctl", "io", "booted", "screenshot", str(path)],
            check=True,
        )
        b64 = base64.b64encode(path.read_bytes()).decode()
        return {"path": str(path), "b64": b64}

    def start_recording(self, out_path: str | None = None) -> dict[str, Any]:
        if self._rec_proc is not None:
            raise RuntimeError("recording already in progress")
        self._rec_path = Path(out_path) if out_path else (
            self.artifacts.recordings / f"demo-{int(time.time())}.mov"
        )
        self._rec_proc = subprocess.Popen(
            ["xcrun", "simctl", "io", "booted", "recordVideo", str(self._rec_path)],
        )
        self.artifacts.recording_started_at = time.time()
        return {"path": str(self._rec_path), "pid": self._rec_proc.pid}

    def stop_recording(self) -> dict[str, Any]:
        if self._rec_proc is None:
            return {"ok": True, "note": "no recording active"}
        self._rec_proc.send_signal(signal.SIGINT)
        try:
            self._rec_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._rec_proc.kill()
        path = self._rec_path
        self._rec_proc = None
        self._rec_path = None
        return {"path": str(path) if path else None}

    def narrate(self, text: str) -> dict[str, Any]:
        ts = time.time() - (self.artifacts.recording_started_at or time.time())
        with self.artifacts.narration_path.open("a") as f:
            f.write(json.dumps({"ts": round(ts, 3), "text": text}) + "\n")
        return {"ts": round(ts, 3)}


# ---------- agent-facing tool adapter ----------

def demo_tools(session: DemoSession) -> list[dict[str, Any]]:
    """
    Produce tool dicts in the shape agent.py expects. One session instance is
    closed over — start/stop it from the harness, not from inside a tool.
    """

    def _call(name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
        def wrapped(**kwargs: Any) -> str:
            out = fn(**kwargs)
            return json.dumps(out) if not isinstance(out, str) else out
        wrapped.__name__ = name
        return wrapped

    return [
        {
            "schema": {
                "name": "demo_start",
                "description": "Open the target (URL for web, bundle_id for iOS) and begin the session.",
                "input_schema": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                },
            },
            "fn": _call("demo_start", lambda target: session.start(target)),
        },
        {
            "schema": {
                "name": "demo_act",
                "description": (
                    "Perform a UI action. Web: click|fill|press|goto|wait_for|assert_text "
                    "with selector/value/text/url args. iOS: tap|swipe|key with x/y/key args."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "selector": {"type": "string"},
                        "value": {"type": "string"},
                        "text": {"type": "string"},
                        "url": {"type": "string"},
                        "key": {"type": "string"},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "x1": {"type": "number"},
                        "y1": {"type": "number"},
                        "x2": {"type": "number"},
                        "y2": {"type": "number"},
                        "timeout": {"type": "number"},
                    },
                    "required": ["action"],
                },
            },
            "fn": _call("demo_act", lambda **kw: session.act(**kw)),
        },
        {
            "schema": {
                "name": "demo_screenshot",
                "description": "Capture a screenshot. Returns path and base64 PNG for vision-in-the-loop.",
                "input_schema": {"type": "object", "properties": {}},
            },
            "fn": _call("demo_screenshot", lambda: session.screenshot()),
        },
        {
            "schema": {
                "name": "demo_narrate",
                "description": "Attach a timestamped caption to the recording timeline.",
                "input_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            },
            "fn": _call("demo_narrate", lambda text: session.narrate(text)),
        },
        {
            "schema": {
                "name": "demo_stop",
                "description": "End the session and finalize the recording.",
                "input_schema": {"type": "object", "properties": {}},
            },
            "fn": _call("demo_stop", lambda: session.stop()),
        },
    ]


# ---------- two-pass demo (stubs) ----------

def generate_demo_script(feature_spec: str, session_hint: str) -> str:
    """
    First pass. Ask the model to produce a sequence of demo_act calls from a
    feature spec, without running them. Returns a JSON array of action dicts.

    Intentionally a stub — implementation belongs in the harness that owns the
    Anthropic client, not in this file.
    """
    raise NotImplementedError


def verify_demo(script: list[dict[str, Any]], session: DemoSession) -> dict[str, Any]:
    """
    Second pass. Replay the script; on each step, screenshot and hand the
    frame back to the model with a "did this look right?" prompt. Collect
    per-step pass/fail and return a structured report.
    """
    raise NotImplementedError
