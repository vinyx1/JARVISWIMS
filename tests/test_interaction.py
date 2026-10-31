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
    asyncio.run(main.ask(main.Ask(question='Where are my keys?')))
    assert main.interaction()['speak_on'] == 'phone'      # default: the phone speaks, the HUD stays silent
    main.reset()
