"""小二对决 — Web game server"""

import asyncio
import json
import os
import random
import string
import time
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from battle import BattleState
from judge import judge_spell

app = FastAPI(title="小二对决")

# ── Static files ──────────────────────────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ── Room management ───────────────────────────────────────────────────────────

def gen_room_id() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=5))


class Connection:
    def __init__(self, ws: WebSocket, player_id: str, name: str):
        self.ws = ws
        self.player_id = player_id
        self.name = name

    async def send(self, msg: dict):
        try:
            await self.ws.send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            pass


class Room:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.connections: list[Connection] = []
        self.battle: Optional[BattleState] = None
        self.created_at = time.time()

    @property
    def is_full(self) -> bool:
        return len(self.connections) >= 2

    @property
    def is_empty(self) -> bool:
        return len(self.connections) == 0

    async def broadcast(self, msg: dict):
        for conn in list(self.connections):
            await conn.send(msg)

    async def broadcast_state(self, logs: list[str] | None = None):
        if not self.battle:
            return
        state = self.battle.to_state_dict()
        await self.broadcast({
            "type": "state",
            "state": state,
            "logs": logs or [],
        })

    def get_conn(self, player_id: str) -> Optional[Connection]:
        for c in self.connections:
            if c.player_id == player_id:
                return c
        return None


# Global rooms store
_rooms: dict[str, Room] = {}


def get_or_create_room(room_id: str) -> Room:
    if room_id not in _rooms:
        _rooms[room_id] = Room(room_id)
    return _rooms[room_id]


# ── WebSocket handler ─────────────────────────────────────────────────────────

@app.websocket("/ws/{room_id}/{player_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str, player_id: str):
    await websocket.accept()
    room = get_or_create_room(room_id)

    # Check capacity
    if room.is_full and not room.get_conn(player_id):
        await websocket.send_text(json.dumps({
            "type": "error", "message": "房间已满，无法加入"
        }, ensure_ascii=False))
        await websocket.close()
        return

    conn = Connection(websocket, player_id, player_id)
    room.connections.append(conn)

    try:
        async for raw in websocket.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "join":
                conn.name = msg.get("name", player_id)[:16]
                await room.broadcast({
                    "type": "player_joined",
                    "player_id": player_id,
                    "name": conn.name,
                    "count": len(room.connections),
                })
                if room.is_full and not room.battle:
                    # Start battle
                    c1, c2 = room.connections[0], room.connections[1]
                    room.battle = BattleState(c1.player_id, c1.name, c2.player_id, c2.name)
                    first = room.battle.get_current_player()
                    await room.broadcast_state([
                        "⚔️ 对决开始！",
                        f"⚡ {first['name']} 速度更快，先手出招！",
                    ])

            elif mtype == "spell":
                if not room.battle or room.battle.finished:
                    continue

                battle = room.battle
                text = (msg.get("text") or "").strip()[:200]
                if not text:
                    continue

                # Only current turn player can act
                if player_id != battle.current_turn:
                    await conn.send({"type": "error", "message": "现在不是你的回合"})
                    continue

                current = battle.get_current_player()
                opponent = battle.get_opponent()
                logs: list[str] = []

                # Judge the spell
                result = await judge_spell(text, battle.field_effects)

                if result.get("is_foul"):
                    turn_res = battle.next_turn()
                    logs.append(f"⚠️ 犯规！{result.get('description', '违规操作')}")
                    logs.append(f"{current['name']} 的回合被跳过")
                    _append_dot_logs(logs, turn_res)
                    await _finish_or_continue(room, logs)
                    continue

                spell_type = result.get("type", "attack")

                if spell_type == "field":
                    if battle.is_field_blocked(player_id):
                        turn_res = battle.next_turn()
                        logs.append(f"🚫 {current['name']} 尝试释放变化技，但被封印了！")
                        _append_dot_logs(logs, turn_res)
                        await _finish_or_continue(room, logs)
                        continue

                    kind = result.get("field_kind") or "dot"
                    power = result.get("power", 15)
                    desc = result.get("description", "场地变化")

                    if kind == "dot":
                        magnitude = max(3, min(10, round(power / 3)))
                        target_id = opponent["id"]
                        kind_label = f"持续伤害（每回合 {magnitude} HP）"
                    elif kind in ("debuff_atk", "debuff_def"):
                        magnitude = max(0.10, min(0.25, power / 100))
                        target_id = opponent["id"]
                        stat_label = "攻击" if kind == "debuff_atk" else "防御"
                        kind_label = f"削弱对手{stat_label} {int(magnitude*100)}%"
                    elif kind in ("buff_atk", "buff_def"):
                        magnitude = max(0.10, min(0.25, power / 100))
                        target_id = player_id
                        stat_label = "攻击" if kind == "buff_atk" else "防御"
                        kind_label = f"强化自身{stat_label} {int(magnitude*100)}%"
                    elif kind == "seal":
                        magnitude = 0.0
                        target_id = opponent["id"]
                        kind_label = "封印对手变化技"
                    else:
                        kind = "generic"
                        magnitude = 0.0
                        target_id = None
                        kind_label = "场地变化"

                    battle.add_field_effect(
                        desc, player_id,
                        kind=kind, magnitude=magnitude, target_id=target_id
                    )
                    turn_res = battle.next_turn()
                    logs.append(f"🌀 {current['name']} 释放了变化技：{desc}（{kind_label}，4回合）")
                    _append_dot_logs(logs, turn_res)
                    await _finish_or_continue(room, logs)
                    continue

                if spell_type == "heal":
                    heal = min(result.get("power", 10), 20)
                    if player_id == battle.p1["id"]:
                        battle.p1_hp = min(battle.p1_hp + heal, battle.p1_max_hp)
                    else:
                        battle.p2_hp = min(battle.p2_hp + heal, battle.p2_max_hp)
                    turn_res = battle.next_turn()
                    logs.append(f"💚 {current['name']}：{result.get('description', '治疗')}（恢复 {heal:.0f} HP）")
                    _append_dot_logs(logs, turn_res)
                    await _finish_or_continue(room, logs)
                    continue

                if spell_type == "bind":
                    battle.add_field_effect(
                        result.get("description", "束缚"), player_id, is_bind=True
                    )
                    turn_res = battle.next_turn()
                    logs.append(f"🔗 {current['name']} 对 {opponent['name']} 施加了束缚：{result.get('description', '束缚')}（15HP，4回合）")
                    logs.append("被束缚时只能攻击束缚物或挣脱！")
                    _append_dot_logs(logs, turn_res)
                    await _finish_or_continue(room, logs)
                    continue

                # break / bound attack
                if spell_type == "break" or battle.is_bound(player_id):
                    bind = battle.get_bind_effect(player_id)
                    if bind:
                        combat = battle.get_current_combat()
                        stat_bonus = (combat["matk"] + combat["satk"]) / 2 * 0.4
                        raw = result["power"] + stat_bonus
                        broke_free, remaining, bdesc = battle.attack_bind(player_id, raw)
                        turn_res = battle.next_turn()
                        icon = "💥" if broke_free else "🔗"
                        logs.append(f"{icon} {current['name']}：{result.get('description', '挣脱')} — {bdesc}")
                        _append_dot_logs(logs, turn_res)
                        await _finish_or_continue(room, logs)
                        continue

                # Normal attack
                combat = battle.get_current_combat()
                stat_bonus = (combat["matk"] + combat["satk"]) / 2 * 0.4
                raw = result["power"] + stat_bonus
                actual_dmg, dmg_desc = battle.apply_damage(opponent["id"], raw)
                desc = result.get("description", "攻击")

                if actual_dmg == 0:
                    logs.append(f"⚔️ {current['name']} — {desc}")
                    logs.append(f"💨 {opponent['name']} {dmg_desc}")
                else:
                    logs.append(f"⚔️ {current['name']} — {desc}")
                    logs.append(f"💥 {opponent['name']} {dmg_desc}")

                winner = battle.check_winner()
                if winner:
                    await room.broadcast_state(logs)
                    await room.broadcast({"type": "battle_end", "winner": winner})
                    continue

                turn_res = battle.next_turn()
                _append_dot_logs(logs, turn_res)
                await _finish_or_continue(room, logs)

            elif mtype == "surrender":
                if room.battle and not room.battle.finished:
                    winner = room.battle.get_opponent()
                    room.battle.finished = True
                    room.battle.winner_id = winner["id"]
                    room.battle.winner_name = winner["name"]
                    await room.broadcast_state([f"🏳️ {conn.name} 认输了！{winner['name']} 获胜！"])
                    await room.broadcast({"type": "battle_end", "winner": winner["name"]})

            elif mtype == "rematch":
                # Reset for a rematch (swap first player)
                if room.is_full:
                    c1, c2 = room.connections[0], room.connections[1]
                    room.battle = BattleState(c1.player_id, c1.name, c2.player_id, c2.name)
                    first = room.battle.get_current_player()
                    await room.broadcast_state([
                        "🔄 再来一局！",
                        f"⚡ {first['name']} 先手出招！",
                    ])

    except WebSocketDisconnect:
        pass
    finally:
        room.connections = [c for c in room.connections if c.player_id != player_id]
        if room.is_empty:
            _rooms.pop(room_id, None)
        else:
            await room.broadcast({
                "type": "player_left",
                "player_id": player_id,
                "name": conn.name,
            })


def _append_dot_logs(logs: list[str], turn_res: dict):
    for ev in turn_res.get("dots", []):
        logs.append(f"🔥 {ev['target_name']} 受到 {ev['desc']} 的 {ev['dmg']:.0f} HP 持续伤害")


async def _finish_or_continue(room: Room, logs: list[str]):
    battle = room.battle
    if not battle:
        return
    winner = battle.check_winner()
    await room.broadcast_state(logs)
    if winner:
        await room.broadcast({"type": "battle_end", "winner": winner})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    print(f"🎮 小二对决 running at http://localhost:{port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
