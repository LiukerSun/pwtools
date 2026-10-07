"""CPU-only, local-model OCR. Uploaded image bytes are never written to disk."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import rapidocr
from PIL import Image
from rapidocr import RapidOCR

from scoreboard import OCRLine, parse_scoreboard


def create_engine(*, cpu_threads: int = 2) -> RapidOCR:
    models = Path(rapidocr.__file__).resolve().parent / "models"
    paths = {
        "Det.model_path": models / "PP-OCRv6_det_small.onnx",
        "Cls.model_path": models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "Rec.model_path": models / "PP-OCRv6_rec_small.onnx",
    }
    for path in paths.values():
        if not path.is_file():
            raise RuntimeError(f"Bundled OCR model missing: {path.name}; rebuild the image")
    return RapidOCR(params={**{key: str(path) for key, path in paths.items()},
                            "Global.log_level": "critical",
                            "EngineConfig.onnxruntime.intra_op_num_threads": cpu_threads,
                            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
                            "EngineConfig.onnxruntime.use_cuda": False,
                            "EngineConfig.onnxruntime.use_dml": False,
                            "EngineConfig.onnxruntime.use_cann": False,
                            "EngineConfig.onnxruntime.use_coreml": False})


def read_lines(engine: RapidOCR, image: np.ndarray) -> list[OCRLine]:
    result = engine(image)
    if result.boxes is None or result.txts is None or result.scores is None:
        return []
    return [OCRLine(box.tolist(), text, float(score))
            for box, text, score in zip(result.boxes, result.txts, result.scores, strict=True)]


def recognize_lines(engine: RapidOCR, image: Image.Image):
    width, height = image.size
    # Cap inference dimensions without changing image geometry proportions.
    scale = min(1.0, 2560 / max(width, height))
    rgb = np.asarray(image.convert("RGB"))
    image_bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if scale < 1:
        image_bgr = cv2.resize(image_bgr, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    lines = read_lines(engine, image_bgr)
    return lines, image_bgr.shape[1], image_bgr.shape[0]


def recognize(engine: RapidOCR, image: Image.Image) -> dict:
    return parse_scoreboard(*recognize_lines(engine, image))


def recognize_build_attributes(engine: RapidOCR, image: Image.Image) -> dict:
    from gun_attributes import parse_gun_attributes
    return parse_gun_attributes(*recognize_lines(engine, image))
