import io
import threading

from fastapi.testclient import TestClient
from PIL import Image

from app import MAX_BYTES, create_app


def png():
    output = io.BytesIO()
    Image.new("RGB", (100, 100), "black").save(output, format="PNG")
    return output.getvalue()


def fake_recognition(_engine, _image):
    return {"outcome": "unknown", "players": [], "raw_text": "", "warnings": ["无战绩表"]}


def test_health_body_validation_and_unknown_response():
    with TestClient(create_app(lambda: object(), fake_recognition)) as client:
        assert client.get("/health").json()["status"] == "ready"
        result = client.post("/recognize", content=png(), headers={"Content-Type": "image/png"})
        assert result.status_code == 200
        assert result.json()["outcome"] == "unknown"
        assert client.post("/recognize", content=b"not an image", headers={"Content-Type": "image/png"}).status_code == 422
        assert client.post("/recognize", content=png(), headers={"Content-Type": "image/jpeg"}).status_code == 415
        assert client.post("/recognize", content=png(), headers={"Content-Type": "application/octet-stream"}).status_code == 415
        assert client.post("/recognize", content=b"", headers={"Content-Type": "image/png"}).status_code == 422
        assert client.post("/recognize", content=b"x", headers={"Content-Type": "image/png", "Content-Length": str(MAX_BYTES + 1)}).status_code == 413
        # A false small declared length cannot bypass the streamed body bound.
        assert client.post("/recognize", content=b"x" * (MAX_BYTES + 1),
                           headers={"Content-Type": "image/png", "Content-Length": "1"}).status_code == 413


def test_pixel_limit_is_checked_before_decompression(monkeypatch):
    import app
    import image_input
    monkeypatch.setattr(image_input, "MAX_PIXELS", 100)
    with TestClient(create_app(lambda: object(), fake_recognition)) as client:
        assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 413


def test_service_has_no_unbounded_queue_and_timeout_keeps_worker_occupied(monkeypatch):
    import app
    entered = threading.Event()
    release = threading.Event()
    def slow_recognition(_engine, _image):
        entered.set()
        release.wait(2)
        return fake_recognition(_engine, _image)
    monkeypatch.setattr(app, "TIMEOUT_SECONDS", 0.05)
    with TestClient(create_app(lambda: object(), slow_recognition)) as client:
        assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 504
        assert entered.is_set()
        assert client.get("/health").json()["busy"] is True
        assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 503
        release.set()
