"""Unit tests for backend/answer.py. Owner: Paul (D). No API calls: the client is faked.

Run from the repo root:
    backend/.venv/bin/python -m pytest tests/ -q
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import answer  # noqa: E402

FAKE_LOG = json.loads((ROOT / "tests" / "fake_log.json").read_text())
HELMET_ID = "f_000006"
NOW_MS = FAKE_LOG[-1]["ts"] + 3000


class FakeClient:
    """Stands in for anthropic.Anthropic: returns `response`, or raises `error`."""

    def __init__(self, response=None, error=None):
        self.calls = 0
        self._response, self._error = response, error
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls += 1
        self.kwargs = kwargs
        if self._error:
            raise self._error
        return self._response


def model_reply(payload: dict, stop_reason="end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="text", text=json.dumps(payload))],
    )


@pytest.fixture
def use_client(monkeypatch):
    def install(client):
        monkeypatch.setattr(answer, "_get_client", lambda: client)
        return client
    return install


def assert_contract(result: dict, log: list[dict]):
    assert set(result) == {"answer", "kind", "frames"}
    assert isinstance(result["answer"], str) and result["answer"].strip()
    assert result["kind"] in {"find", "retrace", "other"}
    known = {e["id"]: e for e in log}
    for f in result["frames"]:
        assert set(f) == {"id", "url", "ts", "note"}
        assert f["id"] in known
        assert f["url"] == known[f["id"]]["url"]
        assert f["ts"] == known[f["id"]]["ts"]


# --- _ago -------------------------------------------------------------------

@pytest.mark.parametrize("ms, expected", [
    (4_000, "just now"),
    (24_000, "24 seconds ago"),
    (60_000, "about 1 minute ago"),
    (190_000, "about 3 minutes ago"),
])
def test_ago_is_speakable(ms, expected):
    assert answer._ago(ms) == expected


# --- _format_log ------------------------------------------------------------

def test_format_log_has_one_line_per_frame_with_all_fields():
    text = answer._format_log(FAKE_LOG, NOW_MS)
    lines = text.splitlines()
    assert len(lines) == len(FAKE_LOG)
    helmet = next(line for line in lines if line.startswith(HELMET_ID))
    assert "hallway" in helmet
    assert "red Iron Man helmet on grey chair" in helmet
    assert "red exit sign" in helmet
    assert "seconds ago" in helmet


# --- _resolve_frames --------------------------------------------------------

def test_resolve_frames_drops_invented_ids_and_fills_url_ts_in_model_order():
    refs = [
        answer.FrameRef(id="f_000013", note="stage"),
        answer.FrameRef(id="f_999999", note="invented"),
        answer.FrameRef(id=HELMET_ID, note="helmet on chair"),
    ]
    frames = answer._resolve_frames(refs, FAKE_LOG)
    assert [f["id"] for f in frames] == ["f_000013", HELMET_ID]
    assert frames[1] == {"id": HELMET_ID, "url": FAKE_LOG[6]["url"], "ts": FAKE_LOG[6]["ts"],
                         "note": "helmet on chair"}


def test_resolve_frames_does_not_mutate_log():
    before = json.dumps(FAKE_LOG)
    answer._resolve_frames([answer.FrameRef(id=HELMET_ID, note="x")], FAKE_LOG)
    assert json.dumps(FAKE_LOG) == before


# --- answer(): happy path ---------------------------------------------------

def test_answer_returns_model_reply_with_validated_frames(use_client):
    client = use_client(FakeClient(model_reply({
        "answer": "Your helmet is on the grey chair by the exit sign, sir.",
        "kind": "find",
        "frames": [{"id": HELMET_ID, "note": "helmet on chair"}, {"id": "f_bogus", "note": "?"}],
    })))
    result = answer.answer("where did I leave my helmet?", FAKE_LOG)
    assert client.calls == 1
    assert result["kind"] == "find"
    assert [f["id"] for f in result["frames"]] == [HELMET_ID]
    assert_contract(result, FAKE_LOG)


def test_answer_sends_question_and_log_to_the_model(use_client):
    client = use_client(FakeClient(model_reply({"answer": "Very good, sir.", "kind": "other", "frames": []})))
    answer.answer("where did I leave my helmet?", FAKE_LOG)
    user_text = client.kwargs["messages"][0]["content"]
    assert "where did I leave my helmet?" in user_text
    assert HELMET_ID in user_text
    assert client.kwargs["model"] == answer.ANSWER_MODEL
    assert client.kwargs["system"] == answer.SYSTEM


# --- answer(): defensive paths (live demo insurance) ------------------------

def test_empty_log_does_not_call_the_model(use_client):
    client = use_client(FakeClient(error=AssertionError("should not be called")))
    result = answer.answer("where is my helmet?", [])
    assert client.calls == 0
    assert result["frames"] == [] and result["kind"] == "other"
    assert_contract(result, [])


def test_api_error_falls_back_to_keyword_search(use_client):
    use_client(FakeClient(error=RuntimeError("network down")))
    result = answer.answer("Where did I leave my helmet?", FAKE_LOG)
    assert result["kind"] == "find"
    assert [f["id"] for f in result["frames"]] == [HELMET_ID]  # most recent sighting, not "in hand"
    assert "grey chair" in result["answer"]
    assert_contract(result, FAKE_LOG)


def test_refusal_falls_back_to_keyword_search(use_client):
    use_client(FakeClient(model_reply({}, stop_reason="refusal")))
    result = answer.answer("where's my jacket?", FAKE_LOG)
    assert [f["id"] for f in result["frames"]] == ["f_000010"]
    assert_contract(result, FAKE_LOG)


def test_malformed_json_falls_back(use_client):
    bad = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text="not json")])
    use_client(FakeClient(bad))
    result = answer.answer("where's my phone?", FAKE_LOG)
    assert [f["id"] for f in result["frames"]] == ["f_000011"]
    assert_contract(result, FAKE_LOG)


def test_error_with_no_keyword_match_returns_team_error_reply(use_client):
    use_client(FakeClient(error=RuntimeError("boom")))
    result = answer.answer("where are my car keys?", FAKE_LOG)
    assert result == answer.ERROR_REPLY


def test_missing_client_falls_back(monkeypatch):
    def no_key():
        raise RuntimeError("no ANTHROPIC_API_KEY")
    monkeypatch.setattr(answer, "_get_client", no_key)
    result = answer.answer("where did I leave my helmet?", FAKE_LOG)
    assert [f["id"] for f in result["frames"]] == [HELMET_ID]
