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


def test_phone_choice_of_speaker_is_relayed_to_the_hud(monkeypatch):
    import asyncio
    result = {'answer': 'On the chair, sir.', 'kind': 'find', 'frames': []}
    monkeypatch.setattr(main, '_answer_request', AsyncMock(return_value=result), raising=False)
    monkeypatch.setattr(main.store, 'reset', lambda: None)
    main.reset()
    asyncio.run(main.ask(main.Ask(question='Where is my helmet?', speak_on='laptop')))
    assert main.interaction()['speak_on'] == 'laptop'
    asyncio.run(main.ask(main.Ask(question='Where is my wallet?', speak_on='both')))
    assert main.interaction()['speak_on'] == 'both'
    asyncio.run(main.ask(main.Ask(question='Where are my keys?')))
    assert main.interaction()['speak_on'] == 'phone'      # default: the phone speaks, the HUD stays silent
    main.reset()


def test_answer_returns_before_the_box_and_the_box_arrives_on_the_hud_later(monkeypatch):
    """The voice must not wait ~1-2s for locate_object: /ask answers at once, the gold box follows."""
    import asyncio, time
    frame = {'id': 'f_000001', 'url': '/frames/f_000001.jpg', 'ts': 1, 'note': 'helmet on chair'}
    result = {'answer': 'On the chair, sir.', 'kind': 'find', 'frames': [frame]}
    monkeypatch.setattr(main, '_answer_request', AsyncMock(return_value=result), raising=False)
    monkeypatch.setattr(main.store, 'reset', lambda: None)

    async def slow_boxes(r):
        await asyncio.sleep(0.3)
        r['frames'][0]['box'] = [0.1, 0.1, 0.5, 0.5]
        return r
    monkeypatch.setattr(main, '_add_boxes', slow_boxes)
    main.reset()

    async def scenario():
        t = time.monotonic()
        reply = await main.ask(main.Ask(question='Where is my helmet?'))
        assert time.monotonic() - t < 0.2                     # answered without waiting for the box
        assert 'box' not in reply['frames'][0]
        assert not main.interaction().get('boxed')
        await asyncio.sleep(0.45)
        later = main.interaction()
        assert later['boxed'] is True
        assert later['result']['frames'][0]['box'] == [0.1, 0.1, 0.5, 0.5]
    asyncio.run(scenario())
    main.reset()


def test_late_box_is_dropped_after_reset(monkeypatch):
    import asyncio
    frame = {'id': 'f_000001', 'url': '/frames/f_000001.jpg', 'ts': 1, 'note': 'helmet'}
    monkeypatch.setattr(main, '_answer_request', AsyncMock(return_value={'answer': 'x', 'kind': 'find', 'frames': [frame]}), raising=False)
    monkeypatch.setattr(main.store, 'reset', lambda: None)

    async def slow_boxes(r):
        await asyncio.sleep(0.2)
        r['frames'][0]['box'] = [0.1, 0.1, 0.5, 0.5]
        return r
    monkeypatch.setattr(main, '_add_boxes', slow_boxes)
    main.reset()

    async def scenario():
        await main.ask(main.Ask(question='Where is my helmet?'))
        main.reset()
        await asyncio.sleep(0.35)
        assert main.interaction() is None                      # the late box must not resurrect it
    asyncio.run(scenario())
