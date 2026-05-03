"""小二对决 — Web game server (P2P architecture).

Server is stateless:
  - WebSocket /signal/{room_id} : pairs the first 2 peers, relays raw messages
                                  for WebRTC handshake.
  - POST /api/judge              : proxies spell-judge calls to ZhipuAI
                                  (called only by the host browser).

Game state lives entirely in the browser (host runs BattleState in JS).
"""

import json
import os

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from judge import judge_spell

app = FastAPI(title="小二对决")


# Disable caching for static + html so updates take effect immediately
@app.middleware("http")
async def no_cache_middleware(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ── AI judge HTTP endpoint (host-only) ────────────────────────────────────────

class JudgeRequest(BaseModel):
    spell: str
    field_effects: list = []


@app.post("/api/judge")
async def api_judge(req: JudgeRequest):
    if not req.spell.strip():
        raise HTTPException(400, "spell empty")
    return await judge_spell(req.spell.strip()[:200], req.field_effects)


# ── WebSocket signaling: pair 2 peers, blindly relay messages ─────────────────

class Room:
    __slots__ = ("peers",)
    def __init__(self):
        self.peers: list[WebSocket] = []


_rooms: dict[str, Room] = {}


@app.websocket("/signal/{room_id}")
async def ws_signal(ws: WebSocket, room_id: str):
    await ws.accept()

    room = _rooms.setdefault(room_id, Room())
    if len(room.peers) >= 2:
        await ws.send_text(json.dumps({"type": "error", "message": "房间已满"}))
        await ws.close()
        return

    room.peers.append(ws)
    my_index = len(room.peers) - 1   # 0 = host, 1 = joiner

    await ws.send_text(json.dumps({
        "type": "joined",
        "is_host": my_index == 0,
        "peer_count": len(room.peers),
    }))

    # When 2 peers are present, both get "ready". The joiner initiates the WebRTC offer.
    if len(room.peers) == 2:
        for i, p in enumerate(room.peers):
            try:
                await p.send_text(json.dumps({
                    "type": "ready",
                    "is_host": i == 0,
                }))
            except Exception:
                pass

    try:
        async for raw in ws.iter_text():
            for p in room.peers:
                if p is ws:
                    continue
                try:
                    await p.send_text(raw)
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        if ws in room.peers:
            room.peers.remove(ws)
        for p in room.peers:
            try:
                await p.send_text(json.dumps({"type": "peer_left"}))
            except Exception:
                pass
        if not room.peers:
            _rooms.pop(room_id, None)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    print(f"🎮 小二对决 running at http://localhost:{port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
