from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite
import numpy as np
import sounddevice as sd
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.requests import Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "sketchbook.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

_rec_lock = threading.Lock()
_rec_state: dict = {"active": False, "stream": None, "frames": [], "samplerate": 44100}

AUDIO_EXTS = {".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"}


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as c:
        await c.executescript("""
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                x REAL DEFAULT 0,
                y REAL DEFAULT 0,
                width REAL DEFAULT 320,
                height REAL DEFAULT 260,
                title TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                filename TEXT,
                original_name TEXT,
                waveform_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS links (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                link_type TEXT NOT NULL,
                path TEXT NOT NULL,
                label TEXT DEFAULT '',
                FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
            );
        """)
        await c.commit()


@app.on_event("startup")
async def startup() -> None:
    await init_db()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/canvas")
async def get_canvas() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as c:
        c.row_factory = aiosqlite.Row
        async with c.execute("SELECT * FROM items ORDER BY created_at") as cur:
            items = [dict(r) for r in await cur.fetchall()]
        for item in items:
            async with c.execute("SELECT * FROM links WHERE item_id = ?", (item["id"],)) as cur:
                item["links"] = [dict(r) for r in await cur.fetchall()]
            item["waveform"] = json.loads(item["waveform_data"]) if item.get("waveform_data") else []
            del item["waveform_data"]
    return items


def _compute_waveform(filepath: Path, n: int = 600) -> list[float]:
    try:
        data, _ = sf.read(str(filepath), always_2d=True)
        mono = data.mean(axis=1)
    except Exception:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(filepath), "-ac", "1", "-ar", "22050", tmp.name],
                capture_output=True,
                check=True,
            )
            data, _ = sf.read(tmp.name, always_2d=True)
            mono = data.mean(axis=1)
        finally:
            Path(tmp.name).unlink(missing_ok=True)

    chunk = max(1, len(mono) // n)
    peaks = [float(np.max(np.abs(mono[i : i + chunk]))) for i in range(0, len(mono), chunk)]
    mx = max(peaks) if peaks else 1.0
    return [p / mx for p in peaks[:n]]


@app.post("/api/upload")
async def upload_audio(
    file: UploadFile = File(...),
    x: float = 100,
    y: float = 100,
) -> dict:
    file_id = str(uuid.uuid4())
    ext = Path(file.filename).suffix.lower()
    filename = f"{file_id}{ext}"
    filepath = AUDIO_DIR / filename
    filepath.write_bytes(await file.read())

    waveform = await asyncio.to_thread(_compute_waveform, filepath)

    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute(
            "INSERT INTO items (id, type, x, y, title, filename, original_name, waveform_data)"
            " VALUES (?, 'audio', ?, ?, ?, ?, ?, ?)",
            (file_id, x, y, Path(file.filename).stem, filename, file.filename, json.dumps(waveform)),
        )
        await c.commit()

    return {
        "id": file_id,
        "type": "audio",
        "x": x,
        "y": y,
        "width": 320,
        "height": 260,
        "title": Path(file.filename).stem,
        "notes": "",
        "filename": filename,
        "original_name": file.filename,
        "waveform": waveform,
        "links": [],
    }


@app.get("/api/audio/{item_id}")
async def serve_audio(item_id: str) -> FileResponse:
    async with aiosqlite.connect(DB_PATH) as c:
        c.row_factory = aiosqlite.Row
        async with c.execute("SELECT filename FROM items WHERE id = ?", (item_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    return FileResponse(str(AUDIO_DIR / row["filename"]))


class ItemPatch(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    title: Optional[str] = None
    notes: Optional[str] = None


@app.patch("/api/items/{item_id}")
async def patch_item(item_id: str, patch: ItemPatch) -> dict:
    fields = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not fields:
        return {"ok": True}
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute(f"UPDATE items SET {set_clause} WHERE id = ?", [*fields.values(), item_id])
        await c.commit()
    return {"ok": True}


@app.delete("/api/items/{item_id}")
async def delete_item(item_id: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as c:
        c.row_factory = aiosqlite.Row
        async with c.execute("SELECT filename FROM items WHERE id = ?", (item_id,)) as cur:
            row = await cur.fetchone()
        if row and row["filename"]:
            (AUDIO_DIR / row["filename"]).unlink(missing_ok=True)
        await c.execute("DELETE FROM links WHERE item_id = ?", (item_id,))
        await c.execute("DELETE FROM items WHERE id = ?", (item_id,))
        await c.commit()
    return {"ok": True}


class NoteCreate(BaseModel):
    x: float
    y: float
    title: str = ""
    notes: str = ""


@app.post("/api/notes")
async def create_note(n: NoteCreate) -> dict:
    nid = str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute(
            "INSERT INTO items (id, type, x, y, title, notes)"
            " VALUES (?, 'note', ?, ?, ?, ?)",
            (nid, n.x, n.y, n.title, n.notes),
        )
        await c.commit()
    return {
        "id": nid,
        "type": "note",
        "x": n.x,
        "y": n.y,
        "width": 280,
        "height": 200,
        "title": n.title,
        "notes": n.notes,
        "waveform": [],
        "links": [],
    }


class LinkAdd(BaseModel):
    link_type: str
    path: str
    label: str = ""


@app.post("/api/items/{item_id}/links")
async def add_link(item_id: str, link: LinkAdd) -> dict:
    lid = str(uuid.uuid4())
    label = link.label or Path(link.path).name
    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute(
            "INSERT INTO links (id, item_id, link_type, path, label) VALUES (?, ?, ?, ?, ?)",
            (lid, item_id, link.link_type, link.path, label),
        )
        await c.commit()
    return {"id": lid, "item_id": item_id, "link_type": link.link_type, "path": link.path, "label": label}


@app.delete("/api/links/{link_id}")
async def delete_link(link_id: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute("DELETE FROM links WHERE id = ?", (link_id,))
        await c.commit()
    return {"ok": True}


@app.post("/api/items/{item_id}/copy")
async def copy_to_clipboard(item_id: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as c:
        c.row_factory = aiosqlite.Row
        async with c.execute("SELECT filename FROM items WHERE id = ?", (item_id,)) as cur:
            row = await cur.fetchone()
    if not row or not row["filename"]:
        raise HTTPException(404, "No audio file for this item")
    filepath = (AUDIO_DIR / row["filename"]).resolve()
    if not filepath.exists():
        raise HTTPException(404, "Audio file missing")
    script = f'set the clipboard to (POSIX file "{filepath}")'
    result = subprocess.run(["osascript", "-e", script], capture_output=True)
    if result.returncode != 0:
        raise HTTPException(500, result.stderr.decode())
    return {"ok": True}


@app.get("/backup")
async def backup() -> Response:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in DATA_DIR.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(DATA_DIR))
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="audio-sketchbook-{ts}.zip"'},
    )


@app.post("/restore")
async def restore(file: UploadFile = File(...)) -> dict:
    content = await file.read()
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            for name in zf.namelist():
                if ".." in name or name.startswith("/"):
                    raise HTTPException(400, f"Unsafe path in archive: {name}")
            zf.extractall(DATA_DIR)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")
    return {"ok": True}


@app.post("/api/launch")
async def launch_path(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        raise HTTPException(400, f"Path not found: {path}")
    subprocess.Popen(["open", str(p)])
    return {"ok": True}


@app.get("/api/browse")
async def browse_fs(path: str = "~") -> dict:
    target = Path(path).expanduser().resolve()
    if not target.is_dir():
        raise HTTPException(400, "Not a directory")
    entries = []
    try:
        for e in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if e.name.startswith("."):
                continue
            entries.append({
                "name": e.name,
                "path": str(e),
                "is_dir": e.is_dir(),
                "is_audio": e.suffix.lower() in AUDIO_EXTS,
                "is_ableton": e.suffix.lower() in {".als", ".alp"},
            })
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    return {"path": str(target), "parent": str(target.parent), "entries": entries}


@app.get("/api/devices")
async def list_devices() -> list[dict]:
    devs = sd.query_devices()
    return [
        {
            "id": i,
            "name": d["name"],
            "channels": int(d["max_input_channels"]),
            "samplerate": int(d["default_samplerate"]),
        }
        for i, d in enumerate(devs)
        if d["max_input_channels"] > 0
    ]


@app.post("/api/record/start")
async def start_rec(device_id: int, samplerate: int = 44100) -> dict:
    with _rec_lock:
        if _rec_state["active"]:
            raise HTTPException(400, "Already recording")
        _rec_state["frames"] = []
        _rec_state["active"] = True
        _rec_state["samplerate"] = samplerate

        def cb(indata, frames, time, status):
            if _rec_state["active"]:
                _rec_state["frames"].append(indata.copy())

        stream = sd.InputStream(device=device_id, channels=1, samplerate=samplerate, callback=cb)
        stream.start()
        _rec_state["stream"] = stream

    return {"ok": True}


@app.post("/api/record/stop")
async def stop_rec(x: float = 200, y: float = 200) -> dict:
    with _rec_lock:
        if not _rec_state["active"]:
            raise HTTPException(400, "Not recording")
        _rec_state["active"] = False
        _rec_state["stream"].stop()
        _rec_state["stream"].close()
        _rec_state["stream"] = None
        frames = list(_rec_state["frames"])
        _rec_state["frames"] = []
        sr = _rec_state["samplerate"]

    if not frames:
        raise HTTPException(400, "No audio captured")

    audio = np.concatenate(frames)
    file_id = str(uuid.uuid4())
    filename = f"{file_id}.wav"
    filepath = AUDIO_DIR / filename
    sf.write(str(filepath), audio, sr)

    waveform = await asyncio.to_thread(_compute_waveform, filepath)
    title = f"rec-{file_id[:8]}"

    async with aiosqlite.connect(DB_PATH) as c:
        await c.execute(
            "INSERT INTO items (id, type, x, y, title, filename, original_name, waveform_data)"
            " VALUES (?, 'audio', ?, ?, ?, ?, ?, ?)",
            (file_id, x, y, title, filename, f"{title}.wav", json.dumps(waveform)),
        )
        await c.commit()

    return {
        "id": file_id,
        "type": "audio",
        "x": x,
        "y": y,
        "width": 320,
        "height": 260,
        "title": title,
        "notes": "",
        "filename": filename,
        "original_name": f"{title}.wav",
        "waveform": waveform,
        "links": [],
    }
