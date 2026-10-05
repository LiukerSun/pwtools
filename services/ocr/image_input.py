"""Image validation shared by HTTP and the desktop pipe worker."""
from __future__ import annotations

import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 40_000_000
MIME_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageInputError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def decode_image(data: bytes, mime: str) -> Image.Image:
    if mime not in MIME_FORMATS:
        raise ImageInputError(415, "Content-Type 必须为 image/png、image/jpeg 或 image/webp")
    if not data:
        raise ImageInputError(422, "图片内容不能为空")
    if len(data) > MAX_BYTES:
        raise ImageInputError(413, "图片不能超过 12 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != MIME_FORMATS[mime]:
                    raise ImageInputError(415, "图片格式与 Content-Type 不一致")
                width, height = image.size
                if width < 1 or height < 1 or width * height > MAX_PIXELS:
                    raise ImageInputError(413, "图片不能超过 4000 万像素")
                if getattr(image, "n_frames", 1) != 1:
                    raise ImageInputError(415, "请上传单帧图片")
                image.load()
                return ImageOps.exif_transpose(image).convert("RGB")
    except ImageInputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ImageInputError(413, "图片不能超过 4000 万像素") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ImageInputError(422, "无法解码图片，请上传完整的 PNG、JPEG 或 WebP") from error
