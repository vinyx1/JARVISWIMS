"""Public deployment (JARVIS_PUBLIC=1): private rooms, join links, rate limits, caps, budget."""
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import budget  # noqa: E402
import main  # noqa: E402
import store  # noqa: E402

BASE = "https://testserver"   # room cookies are Secure: only sent over https


def jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (200, 40, 40)).save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def public(tmp_path, monkeypatch):
    monkeypatch.setenv("ECHO_STUB_AI", "1")
    monkeypatch.setattr(main, "PUBLIC", True)
    monkeypatch.setattr(main, "RATE_LIMITS", True)
    monkeypatch.setattr(main, "ACCESS_KEY", "")
    monkeypatch.setattr(main, "limiter", main.Limiter())
    monkeypatch.setattr(store, "ROOMS", tmp_path / "rooms")
    monkeypatch.setattr(store, "_rooms", {})
    monkeypatch.setattr(store, "MAX_ROOMS", 5)
    monkeypatch.setattr(budget, "FILE", tmp_path / "budget.json")
    monkeypatch.setattr(budget, "_state", budget._fresh())
    monkeypatch.setattr(budget, "ROOM_USD", 0.25)


def visitor() -> TestClient:
    c = TestClient(main.app, base_url=BASE)
    assert c.get("/").status_code == 200          # opening the HUD hands out a room id
    assert main.ROOM_COOKIE in c.cookies
    return c


def send_frame(c: TestClient):
    return c.post("/frame", files={"image": ("f.jpg", jpeg(), "image/jpeg")}, data={"ts": "1000"})


def test_visitors_never_see_each_others_photos():
    a, b = visitor(), visitor()
    assert send_frame(a).status_code == 200
    assert len(a.get("/log").json()) == 1
    assert b.get("/log").json() == [] and b.get("/latest").json() is None
    assert a.get("/frames/f_000000.jpg").status_code == 200
    assert b.get("/frames/f_000000.jpg").status_code == 404     # same id, other room: not theirs
    assert a.get("/frames/..%2F..%2Fbudget.json").status_code == 404


def test_the_phone_joins_the_huds_room_through_the_qr_link():
    hud = visitor()
    send_frame(hud)
    url = hud.get("/phone").json()["url"]
    assert "/join?r=" in url
    phone = TestClient(main.app, base_url=BASE)
    landing = phone.get(url.replace("https://testserver", ""), follow_redirects=False)
    assert landing.status_code == 303 and landing.headers["location"] == "/capture.html"
    assert len(phone.get("/log").json()) == 1                    # same room as the HUD
    assert hud.get("/qr.svg").headers["content-type"].startswith("image/svg")


def test_a_made_up_join_link_is_refused():
    phone = TestClient(main.app, base_url=BASE)
    assert phone.get("/join?r=" + "x" * 32, headers={"accept": "text/html"}).status_code == 404
    assert phone.get("/join?r=../../etc").status_code == 404


def test_pages_static_files_and_bot_probes_create_no_rooms():
    c = TestClient(main.app, base_url=BASE)
    for path in ("/", "/capture.html", "/jarvis.js", "/wp-login.php", "/.env"):
        c.get(path)
    assert store.room_count() == 0
    c.get("/latest")                                             # first real API call
    assert store.room_count() == 1


def test_asking_too_fast_is_rate_limited():
    c = visitor()
    codes = [c.post("/ask", json={"question": "where is my helmet"}).status_code for _ in range(8)]
    assert codes[:4] == [200] * 4 and 429 in codes
    limited = c.post("/ask", json={"question": "again"})
    assert limited.status_code == 429 and "Retry-After" in limited.headers


def test_uploads_are_capped_and_must_be_photos():
    c = visitor()
    huge = b"\xff\xd8" + b"0" * (main.MAX_IMAGE_BYTES + 10)
    assert c.post("/frame", files={"image": ("f.jpg", huge, "image/jpeg")}).status_code == 413
    html = b"<script>alert(1)</script>"
    assert c.post("/frame", files={"image": ("f.jpg", html, "image/jpeg")}).status_code == 415
    assert c.post("/ask", json={"question": "x" * 5000}).status_code == 422
    big = c.post("/frame", content=b"0" * (main.MAX_BODY_BYTES + 1), headers={"content-type": "application/octet-stream"})
    assert big.status_code == 413


def test_other_websites_cannot_post_for_a_visitor():
    c = visitor()
    assert c.post("/reset", headers={"origin": "https://evil.example"}).status_code == 403
    assert c.post("/reset", headers={"origin": BASE}).status_code == 200


def test_room_frame_cap(monkeypatch):
    monkeypatch.setattr(store, "MAX_FRAMES", 2)
    c = visitor()
    assert [send_frame(c).status_code for _ in range(3)] == [200, 200, 429]


def test_too_many_rooms_means_busy_not_crash():
    for _ in range(store.MAX_ROOMS):
        visitor().get("/latest")
    late = visitor().get("/latest")
    assert late.status_code == 503 and "other guests" in late.json()["detail"]


def test_new_rooms_per_ip_are_limited(monkeypatch):
    monkeypatch.setattr(store, "MAX_ROOMS", 100)
    codes = [TestClient(main.app, base_url=BASE).get("/latest").status_code for _ in range(12)]
    assert codes[:10] == [200] * 10 and codes[-1] == 429


def test_over_budget_jarvis_says_so_without_calling_claude(monkeypatch):
    c = visitor()
    def boom(*a, **k):
        raise AssertionError("Claude must not be called over budget")
    monkeypatch.setattr(main.answer, "answer", boom)
    budget._state["total"] = budget.DAILY_USD
    reply = c.post("/ask", json={"question": "where is my helmet"}).json()
    assert "allowance" in reply["answer"]


def test_each_room_has_its_own_allowance():
    a, b = visitor(), visitor()
    a.get("/latest"); b.get("/latest")
    room_a = next(r for r in store._rooms.values())
    budget._state["rooms"][room_a.id] = budget.ROOM_USD
    token = store.use(room_a)
    try:
        with pytest.raises(budget.OverBudget):
            budget.check()
    finally:
        store.reset_current(token)


def test_cost_is_priced_from_usage():
    usd = budget.cost("claude-sonnet-5-5", {"input_tokens": 1_000_000, "output_tokens": 100_000})
    assert usd == pytest.approx(2.0 + 1.0)
    assert budget.cost("claude-haiku-5-5", {"input_tokens": 1_000_000}) == pytest.approx(0.10)


def test_security_headers_and_cookie_flags():
    c = visitor()
    r = c.get("/")
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert "max-age" in r.headers["strict-transport-security"]
    jar = c.cookies.jar
    room = next(k for k in jar if k.name == main.ROOM_COOKIE)
    assert room.secure and room.has_nonstandard_attr("HttpOnly")


def test_idle_rooms_are_deleted(monkeypatch):
    c = visitor()
    send_frame(c)
    room = next(iter(store._rooms.values()))
    assert room.dir.is_dir()
    room.last_used -= store.ROOM_TTL_S + 1
    assert store.evict_expired() == 1
    assert not room.dir.exists() and store.room_count() == 0


def test_forged_forwarded_for_does_not_dodge_ip_limits(monkeypatch):
    monkeypatch.setattr(store, "MAX_ROOMS", 100)
    codes = []
    for i in range(12):   # a new fake "client IP" every time; Railway appends the real one last
        c = TestClient(main.app, base_url=BASE)
        codes.append(c.get("/latest", headers={"x-forwarded-for": f"10.0.0.{i}, 203.0.113.9"}).status_code)
    assert codes[-1] == 429


def test_health_check_needs_no_room():
    assert TestClient(main.app, base_url=BASE).get("/healthz").json() == {"ok": True}
    assert store.room_count() == 0
