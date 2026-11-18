"""Access key: tunnel requests need this run's key (from the QR link, then a cookie); the laptop doesn't."""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import main  # noqa: E402

TUNNEL = {"cf-ray": "8f00-YYZ", "cf-connecting-ip": "203.0.113.7"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "ACCESS_KEY", "s3cret-key")
    return TestClient(main.app)


def test_laptop_needs_no_key(client):
    assert client.get("/latest").status_code == 200
    assert client.get("/").status_code == 200


def test_tunnel_without_key_is_locked_out(client):
    assert client.get("/latest", headers=TUNNEL).status_code == 403
    page = client.get("/capture.html", headers={**TUNNEL, "accept": "text/html"})
    assert page.status_code == 403 and "Scan the QR code" in page.text
    assert client.post("/reset", headers=TUNNEL).status_code == 403


def test_wrong_key_is_locked_out(client):
    assert client.get("/capture.html?k=guess", headers=TUNNEL).status_code == 403


def test_qr_link_lets_the_phone_in_and_the_cookie_keeps_it_in(client):
    first = client.get("/capture.html?k=s3cret-key", headers=TUNNEL)
    assert first.status_code == 200
    assert "jarvis_key=s3cret-key" in first.headers["set-cookie"]
    assert "HttpOnly" in first.headers["set-cookie"] and "Secure" in first.headers["set-cookie"]
    # The page's own requests carry the cookie, not the ?k= link.
    assert client.get("/latest", headers=TUNNEL, cookies={"jarvis_key": "s3cret-key"}).status_code == 200


def test_no_key_configured_means_open(monkeypatch):
    monkeypatch.setattr(main, "ACCESS_KEY", "")
    assert TestClient(main.app).get("/latest", headers=TUNNEL).status_code == 200
