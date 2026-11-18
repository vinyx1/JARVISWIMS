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
    assert {"answer", "kind", "frames"} <= set(result) <= {"answer", "kind", "frames", "item"}
    assert isinstance(result["answer"], str) and result["answer"].strip()
    assert result["kind"] in {"find", "retrace", "other"}
    known = {e["id"]: e for e in log}
    for f in result["frames"]:
        assert {"id", "url", "ts", "note"} <= set(f) <= {"id", "url", "ts", "note", "where", "sure"}
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


# --- registered items ("this is my laptop") ----------------------------------

def test_registered_items_reach_the_model(use_client):
    client = use_client(FakeClient(model_reply({"answer": "On the table, sir.", "kind": "find",
                                                "frames": [{"id": HELMET_ID, "note": "helmet"}]})))
    mine = [{"item": "laptop", "description": "silver MacBook with a pumpkin sticker"}]
    result = answer.answer("where's my laptop?", FAKE_LOG, mine)
    prompt = client.kwargs["messages"][0]["content"]
    assert "MY laptop: silver MacBook with a pumpkin sticker" in prompt
    assert_contract(result, FAKE_LOG)


def test_no_registered_items_adds_nothing(use_client):
    client = use_client(FakeClient(model_reply({"answer": "Not seen, sir.", "kind": "other", "frames": []})))
    answer.answer("where's my laptop?", FAKE_LOG)
    assert "registered" not in client.kwargs["messages"][0]["content"]


def test_last_seen_record_reaches_the_model_and_its_frame_is_allowed(use_client):
    old = {"frame_id": "f_000999", "url": "/frames/f_000999.jpg", "ts": NOW_MS - 30 * 60_000,
           "where": "on desk by the window", "room": "workspace tables", "landmarks": ["window"]}
    mine = [{"item": "airpods", "description": "white AirPods Pro case", "last_seen": old}]
    client = use_client(FakeClient(model_reply({"answer": "On the desk by the window, sir.", "kind": "find",
                                                "frames": [{"id": "f_000999", "note": "AirPods on desk"}]})))
    result = answer.answer("where are my airpods?", FAKE_LOG, mine)
    prompt = client.kwargs["messages"][0]["content"]
    assert "Last seen: on desk by the window (workspace tables), near window" in prompt
    assert "frame f_000999" in prompt
    assert result["frames"] == [{"id": "f_000999", "url": "/frames/f_000999.jpg", "ts": old["ts"], "note": "AirPods on desk"}]


def test_empty_log_still_answers_from_a_last_seen_record(use_client):
    seen = {"frame_id": "f_000001", "url": "/frames/f_000001.jpg", "ts": 1.0, "where": "on desk"}
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": []})))
    assert answer.answer("where are my airpods?", [], [{"item": "airpods", "description": "x", "last_seen": seen}])["answer"] == "On the desk, sir."


# ---------- the second look at photos for a moved registered item ----------
BOTTLE = {"item": "water bottle", "description": "black ThermoFlask", "frame_id": "f_1", "url": "/frames/f_1.jpg", "ts": 1000,
          "last_seen": {"frame_id": "f_2", "url": "/frames/f_2.jpg", "ts": 2000, "where": "on desk"}}


def _entry(i, ts, objects=("blue power bank on desk",), scene="desk"):
    return {"id": f"f_{i}", "ts": ts, "url": f"/frames/f_{i}.jpg",
            "caption": {"scene": scene, "room_guess": "unknown", "objects": list(objects), "landmarks": []}}


def test_asked_item_matches_full_name_or_its_noun():
    assert answer.asked_item("where's my water bottle?", [BOTTLE]) is BOTTLE
    assert answer.asked_item("where did I leave my bottles", [BOTTLE]) is BOTTLE
    assert answer.asked_item("where's my helmet?", [BOTTLE]) is None


def test_frames_since_sighting_skips_older_and_blank_frames():
    log = [_entry(2, 2000), _entry(3, 3000, ["MY water bottle (black ThermoFlask) on desk"]),
           _entry(4, 4000), _entry(5, 5000, [], "dark frame, nearly all black"), _entry(6, 6000)]
    assert [e["id"] for e in answer.frames_since_sighting(BOTTLE, log)] == ["f_6", "f_4"]


def test_a_sure_sighting_wins_over_the_stale_caption_answer(use_client):
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]), _entry(3, 3000), _entry(4, 4000)]
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": [{"id": "f_2", "note": "on desk"}]})))
    seen = {}

    def look(item, entries):
        seen["ids"] = [e["id"] for e in entries]
        return [{"id": "f_3", "where": "on the carpet by the bed", "confidence": 85}, {"id": "f_99", "where": "x", "confidence": 99}]

    r = answer.answer("where's my water bottle", log, [BOTTLE], look)
    assert seen["ids"] == ["f_4", "f_3"]
    assert r["answer"].startswith("Aha, found it") and "on the carpet by the bed" in r["answer"]
    assert [(f["id"], f["sure"]) for f in r["frames"]] == [("f_3", True)], "sure: no stale spots, no invented ids"
    assert r["item"] == "water bottle"
    assert_contract(r, log)


def test_below_the_sure_threshold_it_only_might_be_there(use_client):
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]), _entry(3, 3000), _entry(4, 4000)]
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": [{"id": "f_2", "note": "on desk"}]})))
    r = answer.answer("where's my bottle", log, [BOTTLE], lambda i, e: [
        {"id": "f_3", "where": "on the floor", "confidence": 60}, {"id": "f_4", "where": "on the bed", "confidence": 70}])
    assert r["answer"].startswith("I can't be certain") and "might be on the bed" in r["answer"] and "Or possibly on the floor" in r["answer"]
    assert [(f["id"], f["sure"]) for f in r["frames"]] == [("f_4", False), ("f_3", False), ("f_2", False)]
    assert_contract(r, log)


def test_sure_spot_plus_a_newer_possible_one(use_client):
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]), _entry(3, 3000), _entry(4, 4000), _entry(5, 5000)]
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": []})))
    r = answer.answer("where's my bottle", log, [BOTTLE], lambda i, e: [
        {"id": "f_3", "where": "in your hand", "confidence": 60},          # older and unsure: dropped
        {"id": "f_4", "where": "on the carpet", "confidence": 90},
        {"id": "f_5", "where": "by the laundry basket", "confidence": 62},  # newer, possible
        {"id": "f_5", "where": "a shadow", "confidence": 30}])             # below MAYBE: ignored
    assert "Aha, found it, sir. Your water bottle was on the carpet" in r["answer"]
    assert "It might also be by the laundry basket" in r["answer"]
    assert [(f["id"], f["sure"]) for f in r["frames"]] == [("f_4", True), ("f_5", False)]


def test_nothing_confident_enough_keeps_the_caption_answer(use_client):
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]), _entry(3, 3000)]
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": [{"id": "f_2", "note": "on desk"}]})))
    r = answer.answer("where's my bottle", log, [BOTTLE], lambda i, e: [{"id": "f_3", "where": "a shadow", "confidence": 40}])
    assert r["answer"] == "On the desk, sir." and r["item"] == "water bottle"


def test_nothing_found_or_look_failing_keeps_the_caption_answer(use_client):
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]), _entry(3, 3000)]
    use_client(FakeClient(model_reply({"answer": "On the desk, sir.", "kind": "find", "frames": [{"id": "f_2", "note": "on desk"}]})))
    assert answer.answer("where's my bottle", log, [BOTTLE], lambda i, e: [])["answer"] == "On the desk, sir."

    def broken(i, e):
        raise RuntimeError("boom")
    assert answer.answer("where's my bottle", log, [BOTTLE], broken)["answer"] == "On the desk, sir."


def test_a_glimpse_mentioned_in_a_caption_is_not_pushed_out_by_newer_frames():
    log = [_entry(2, 2000, ["MY water bottle (black ThermoFlask) on desk"]),
           _entry(3, 3000, ["possibly sir's black water bottle in hand"])] + [_entry(i, i * 1000) for i in range(4, 20)]
    ids = [e["id"] for e in answer.frames_since_sighting(BOTTLE, log, limit=4)]
    assert ids == ["f_19", "f_18", "f_17", "f_3"]
