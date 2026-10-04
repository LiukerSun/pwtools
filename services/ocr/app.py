from __future__ import annotations

import asyncio
import io
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from PIL import Image, ImageOps, UnidentifiedImageError

from engine import create_engine, recognize

MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 40_000_000
TIMEOUT_SECONDS = 30
MIME_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def decode_image(data: bytes, mime: str) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format != MIME_FORMATS[mime]:
                raise HTTPException(415, "图片格式与 Content-Type 不一致")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_PIXELS:
                raise HTTPException(413, "图片不能超过 4000 万像素")
            if getattr(image, "n_frames", 1) != 1:
                raise HTTPException(415, "请上传单帧图片")
            image.load()
            return ImageOps.exif_transpose(image).convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(413, "图片不能超过 4000 万像素") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(422, "无法解码图片，请上传完整的 PNG、JPEG 或 WebP") from error


def create_app(engine_factory=create_engine, recognition=recognize) -> FastAPI:
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-ocr")

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        loop = asyncio.get_running_loop()
        application.state.engine = await loop.run_in_executor(executor, engine_factory)
        application.state.busy = asyncio.Lock()
        yield
        executor.shutdown(wait=True, cancel_futures=True)

    application = FastAPI(title="PW Tools local scoreboard OCR", docs_url=None, redoc_url=None,
                          openapi_url=None, lifespan=lifespan)

    @application.get("/health")
    async def health():
        return {"status": "ready", "engine": "rapidocr-onnx-cpu", "busy": application.state.busy.locked()}

    @application.post("/recognize")
    async def recognize_image(request: Request):
        mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if mime not in MIME_FORMATS:
            raise HTTPException(415, "Content-Type 必须为 image/png、image/jpeg 或 image/webp")
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 1:
                    raise HTTPException(422, "图片内容不能为空")
                if int(length) > MAX_BYTES:
                    raise HTTPException(413, "图片不能超过 12 MiB")
            except ValueError as error:
                raise HTTPException(400, "Content-Length 无效") from error
        lock = application.state.busy
        if lock.locked():
            raise HTTPException(503, "识别服务正忙，请稍后重试", headers={"Retry-After": "2"})
        await lock.acquire()
        release_here = True
        try:
            chunks: list[bytes] = []
            size = 0
            async with asyncio.timeout(TIMEOUT_SECONDS):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "图片不能超过 12 MiB")
                    chunks.append(chunk)
            if not size:
                raise HTTPException(422, "图片内容不能为空")
            data = b"".join(chunks)
            # Decode and inference share the only worker; rejected requests never queue behind it.
            def work():
                decoded = decode_image(data, mime)
                try:
                    return recognition(application.state.engine, decoded)
                finally:
                    decoded.close()
            future = asyncio.get_running_loop().run_in_executor(executor, work)
            try:
                return await asyncio.wait_for(asyncio.shield(future), TIMEOUT_SECONDS)
            except (TimeoutError, asyncio.CancelledError):
                release_here = False
                # A thread cannot safely be killed. Retain the slot until the native job ends.
                def completed(done):
                    if not done.cancelled():
                        done.exception()
                    lock.release()
                future.add_done_callback(completed)
                raise
        except TimeoutError as error:
            raise HTTPException(504, "识别超时，请裁剪战绩区域后重试") from error
        except HTTPException:
            raise
        except Exception as error:
            # Avoid including image data, OCR text, filesystem paths or native exception details.
            raise HTTPException(503, "本地识别暂时不可用，请稍后重试") from error
        finally:
            if release_here:
                lock.release()

    return application


app = create_app()
