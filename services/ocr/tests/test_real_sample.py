import os
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import create_app


@pytest.mark.skipif(not os.environ.get("OCR_SAMPLE_IMAGE"), reason="set OCR_SAMPLE_IMAGE to the local screenshot; no image fixture is committed")
def test_real_user_scoreboard():
    with TestClient(create_app()) as client:
        response = client.post("/recognize", content=Path(os.environ["OCR_SAMPLE_IMAGE"]).read_bytes(),
                               headers={"Content-Type": "image/png"})
        assert response.status_code == 200
        result = response.json()
        blank = io.BytesIO()
        Image.new("RGB", (640, 360), "black").save(blank, format="PNG")
        unknown = client.post("/recognize", content=blank.getvalue(), headers={"Content-Type": "image/png"})
        assert unknown.status_code == 200
        assert unknown.json()["outcome"] == "unknown"
        assert unknown.json()["players"] == []
    assert [player["amount"] for player in result["players"]] == [3314221, 1867449, 97593]
    assert all(player["outcome"] == "success" for player in result["players"])
    assert result["outcome"] == "success"
