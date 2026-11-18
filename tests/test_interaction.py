"""No-provider tests for the phone-to-HUD completed exchange relay."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import pytest
import main


def test_completed_answer_relay_and_reset(monkeypatch):
    import asyncio
    result = {'answer': 'On the chair, sir.', 'kind': 'find', 'frames': []}
    monkeypatch.setattr(main, '_answer_request', AsyncMock(return_value=result), raising=False)
    monkeypatch.setattr(main.store, 'reset', lambda: None)
    main.reset()
    assert main.interaction() is None
    assert asyncio.run(main.ask(main.Ask(question='Where is my helmet?'))) == result
    exchange = main.interaction()
    assert exchange['question'] == 'Where is my helmet?'
    assert exchange['result'] == result
    assert isinstance(exchange['id'], str) and exchange['id']
    asyncio.run(main.ask(main.Ask(question='Where are my keys?')))
    assert main.interaction()['id'] != exchange['id']
    main.reset()
    assert main.interaction() is None


def test_reset_waits_for_phone_answer_before_clearing_exchange(monkeypatch):
    import asyncio
    monkeypatch.setattr(main.store, 'reset', lambda: None)
    async def run():
        started, finish = asyncio.Event(), asyncio.Event()
        async def answer(body):
            started.set()
            await finish.wait()
            return {'answer': 'Old answer', 'kind': 'other', 'frames': []}
        monkeypatch.setattr(main, '_answer_request', answer, raising=False)
        task = asyncio.create_task(main.ask(main.Ask(question='Old question')))
        await started.wait()
        with pytest.raises(main.HTTPException) as error:
            main.reset()
        assert error.value.status_code == 409
        finish.set()
        await task
        assert main.interaction()["question"] == "Old question"
        main.reset()
        assert main.interaction() is None
    asyncio.run(run())


# ---------- the photo wheel: "that's it" and "keep looking" ----------
BOTTLE = {'item': 'water bottle', 'description': 'black ThermoFlask', 'frame_id': 'f_1', 'url': '/frames/f_1.jpg', 'ts': 1000}


def _fake_store(monkeypatch, log):
    seen = []
    monkeypatch.setattr(main.store, 'reset', lambda: None)
    monkeypatch.setattr(main.store, 'read_log', lambda: log)
    monkeypatch.setattr(main.store, 'mine', lambda: [dict(BOTTLE)])
    monkeypatch.setattr(main.store, 'session', lambda: 1)
    monkeypatch.setattr(main.store, 'mark_seen', lambda *a, **k: seen.append((a, k)) or True)
    main.reset()
    return seen


def test_confirm_records_the_tapped_photo_even_if_older(monkeypatch):
    log = [{'id': 'f_5', 'ts': 5000, 'url': '/frames/f_5.jpg', 'caption': {'scene': 'floor', 'room_guess': 'bedroom', 'objects': [], 'landmarks': ['bed']}}]
    seen = _fake_store(monkeypatch, log)
    r = main.confirm(main.Confirm(item='Water Bottle', frame_id='f_5', where='on the carpet by the bed.'))
    assert r['answer'] == 'Very good, sir. Noted: your water bottle, on the carpet by the bed.'
    assert seen == [(('water bottle', 'f_5', 'on the carpet by the bed', 'bedroom', ['bed']), {'force': True})]
    with pytest.raises(main.HTTPException):
        main.confirm(main.Confirm(item='helmet', frame_id='f_5'))


def test_watch_announces_when_a_later_frame_spots_it(monkeypatch):
    entry = {'id': 'f_9', 'ts': 9e15, 'url': '/frames/f_9.jpg', 'caption': None}
    seen = _fake_store(monkeypatch, [entry])
    assert main.watch(main.Watch(item='water bottle'))['answer'] == "Very well, sir. I'll keep looking for your water bottle."
    looks = []
    monkeypatch.setattr(main.ai, 'look_for', lambda item, entries: looks.append(entries) or [{'id': 'f_9', 'where': 'on the bed', 'confidence': 50}])
    hint = {'scene': 'bed', 'room_guess': 'bedroom', 'objects': ["possibly sir's water bottle on bed"], 'landmarks': []}
    main._check_watches('f_9', hint, 1)
    assert looks and main.interaction() is None, 'a 50% second look is not enough'
    monkeypatch.setattr(main.ai, 'look_for', lambda item, entries: [{'id': 'f_9', 'where': 'on the bed', 'confidence': 88}])
    main._check_watches('f_9', hint, 1)
    ex = main.interaction()
    assert ex['source'] is None
    assert ex['result']['answer'] == "Sir, I know where your water bottle is now. It's on the bed."
    assert ex['result']['frames'][0]['id'] == 'f_9' and ex['result']['frames'][0]['sure'] is True
    assert seen and main._watching == {}, 'announced once, then the watch ends'


def test_watch_takes_a_my_caption_at_once_and_ignores_unregistered_items(monkeypatch):
    entry = {'id': 'f_9', 'ts': 9e15, 'url': '/frames/f_9.jpg', 'caption': None}
    _fake_store(monkeypatch, [entry])
    assert main.watch(main.Watch(item='helmet'))['watching'] is False
    main.watch(main.Watch(item='water bottle'))
    monkeypatch.setattr(main.ai, 'look_for', lambda *a: pytest.fail('a MY caption needs no second look'))
    main._check_watches('f_9', {'objects': ['MY water bottle (black ThermoFlask) on the shelf'], 'landmarks': []}, 1)
    assert "on the shelf" in main.interaction()['result']['answer']
    main.reset()
