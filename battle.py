"""Battle logic for 小二对决 web game — adapted from xiaoer-qq-bot/bot/battle.py"""

import random
from typing import Optional, Tuple

BASE_STATS = {
    "体力": 100, "灵智": 30, "想象": 30,
    "灵魂": 30, "创造": 30, "灵活": 50,
}


def calc_combat_stats(stats: dict) -> dict:
    return {
        "hp": stats["体力"] * 0.8 + stats["灵魂"] * 0.2,
        "matk": stats["灵智"] * 0.6,
        "mdef": stats["灵智"] * 0.4,
        "satk": stats["想象"] * 0.6 + stats["创造"] * 0.6,
        "sdef": stats["想象"] * 0.4,
        "shield": stats["灵魂"] * 0.5 + stats["创造"] * 0.4,
        "speed": stats["灵魂"] * 0.3 + stats["灵活"] * 0.7,
        "dodge": stats["灵活"] * 0.3,
    }


DEFAULT_COMBAT = calc_combat_stats(BASE_STATS)


class BattleState:
    def __init__(self, p1_id: str, p1_name: str, p2_id: str, p2_name: str):
        self.p1 = {"id": p1_id, "name": p1_name}
        self.p2 = {"id": p2_id, "name": p2_name}

        s1 = calc_combat_stats(BASE_STATS)
        s2 = calc_combat_stats(BASE_STATS)

        self.p1_hp = s1["hp"]
        self.p1_shield = s1["shield"]
        self.p1_combat = s1
        self.p1_max_hp = s1["hp"]

        self.p2_hp = s2["hp"]
        self.p2_shield = s2["shield"]
        self.p2_combat = s2
        self.p2_max_hp = s2["hp"]

        # First turn: higher speed goes first
        if s1["speed"] >= s2["speed"]:
            self.current_turn = p1_id
        else:
            self.current_turn = p2_id

        self.turn_count = 0
        self.field_effects: list = []
        self.finished = False
        self.winner_id: Optional[str] = None
        self.winner_name: Optional[str] = None

    def get_current_player(self) -> dict:
        return self.p1 if self.current_turn == self.p1["id"] else self.p2

    def get_opponent(self) -> dict:
        return self.p2 if self.current_turn == self.p1["id"] else self.p1

    def get_current_combat(self) -> dict:
        return self.p1_combat if self.current_turn == self.p1["id"] else self.p2_combat

    def get_opponent_combat(self) -> dict:
        return self.p2_combat if self.current_turn == self.p1["id"] else self.p1_combat

    def get_atk_modifier(self, user_id: str) -> float:
        mod = 1.0
        for e in self.field_effects:
            kind = e.get("kind")
            mag = e.get("magnitude", 0)
            if kind == "buff_atk" and e.get("caster_id") == user_id:
                mod += mag
            elif kind == "debuff_atk" and e.get("target_id") == user_id:
                mod -= mag
        return max(0.3, mod)

    def get_def_modifier(self, user_id: str) -> float:
        mod = 1.0
        for e in self.field_effects:
            kind = e.get("kind")
            mag = e.get("magnitude", 0)
            if kind == "buff_def" and e.get("caster_id") == user_id:
                mod += mag
            elif kind == "debuff_def" and e.get("target_id") == user_id:
                mod -= mag
        return max(0.3, mod)

    def is_field_blocked(self, user_id: str) -> bool:
        return any(
            e.get("kind") == "seal" and e.get("target_id") == user_id
            for e in self.field_effects
        )

    def is_bound(self, user_id: str) -> bool:
        return any(
            e.get("bind_target") == user_id and e.get("bind_hp", 0) > 0
            for e in self.field_effects
        )

    def get_bind_effect(self, user_id: str) -> Optional[dict]:
        for e in self.field_effects:
            if e.get("bind_target") == user_id and e.get("bind_hp", 0) > 0:
                return e
        return None

    def apply_damage(self, target_id: str, raw_damage: float) -> Tuple[float, str]:
        attacker_id = self.p2["id"] if target_id == self.p1["id"] else self.p1["id"]
        raw_damage = raw_damage * self.get_atk_modifier(attacker_id)

        is_p1 = target_id == self.p1["id"]
        combat = self.p1_combat if is_p1 else self.p2_combat

        dodge_chance = combat["dodge"] / 300
        if random.random() < dodge_chance:
            return (0, "闪避！")

        defense = (combat["mdef"] + combat["sdef"]) / 2 * self.get_def_modifier(target_id)
        reduced = max(raw_damage - defense * 0.3, raw_damage * 0.2)

        if is_p1:
            if self.p1_shield > 0:
                absorbed = min(self.p1_shield, reduced)
                self.p1_shield -= absorbed
                reduced -= absorbed
                if reduced > 0:
                    self.p1_hp -= reduced
                return (absorbed + reduced, f"护盾吸收 {absorbed:.0f}，受到 {reduced:.0f} 伤害")
            else:
                self.p1_hp -= reduced
                return (reduced, f"受到 {reduced:.0f} 伤害")
        else:
            if self.p2_shield > 0:
                absorbed = min(self.p2_shield, reduced)
                self.p2_shield -= absorbed
                reduced -= absorbed
                if reduced > 0:
                    self.p2_hp -= reduced
                return (absorbed + reduced, f"护盾吸收 {absorbed:.0f}，受到 {reduced:.0f} 伤害")
            else:
                self.p2_hp -= reduced
                return (reduced, f"受到 {reduced:.0f} 伤害")

    def add_field_effect(self, desc: str, caster_id: str, *,
                         kind: str = "generic", magnitude: float = 0,
                         target_id: Optional[str] = None, is_bind: bool = False):
        effect: dict = {
            "desc": desc,
            "kind": kind,
            "turns_left": 4,
            "caster_id": caster_id,
            "magnitude": magnitude,
        }
        if target_id:
            effect["target_id"] = target_id
        if is_bind:
            effect["kind"] = "bind"
            effect["bind_hp"] = 15.0
            effect["bind_target"] = self.p1["id"] if caster_id == self.p2["id"] else self.p2["id"]
        self.field_effects.append(effect)
        if len(self.field_effects) > 5:
            self.field_effects = self.field_effects[-5:]

    def attack_bind(self, user_id: str, damage: float) -> Tuple[bool, float, str]:
        effect = self.get_bind_effect(user_id)
        if not effect:
            return (False, 0, "没有束缚可以攻击")
        effect["bind_hp"] -= damage
        if effect["bind_hp"] <= 0:
            self.field_effects.remove(effect)
            return (True, 0, f"挣脱了「{effect['desc']}」！")
        return (False, effect["bind_hp"], f"攻击束缚物，剩余 {effect['bind_hp']:.0f} HP")

    def next_turn(self) -> dict:
        self.turn_count += 1
        dot_events = []

        for e in self.field_effects:
            if e.get("kind") != "dot":
                continue
            target_id = e.get("target_id")
            mag = e.get("magnitude", 0)
            if not target_id or mag <= 0:
                continue
            if target_id == self.p1["id"]:
                actual = min(mag, max(0, self.p1_hp))
                self.p1_hp = max(0, self.p1_hp - mag)
                dot_events.append({"target_name": self.p1["name"], "dmg": actual, "desc": e["desc"]})
            else:
                actual = min(mag, max(0, self.p2_hp))
                self.p2_hp = max(0, self.p2_hp - mag)
                dot_events.append({"target_name": self.p2["name"], "dmg": actual, "desc": e["desc"]})

        for e in self.field_effects:
            e["turns_left"] -= 1
        self.field_effects = [e for e in self.field_effects if e["turns_left"] > 0]

        self.current_turn = self.p2["id"] if self.current_turn == self.p1["id"] else self.p1["id"]

        return {"dots": dot_events}

    def check_winner(self) -> Optional[str]:
        if self.p1_hp <= 0:
            self.finished = True
            self.winner_id = self.p2["id"]
            self.winner_name = self.p2["name"]
            return self.p2["name"]
        if self.p2_hp <= 0:
            self.finished = True
            self.winner_id = self.p1["id"]
            self.winner_name = self.p1["name"]
            return self.p1["name"]
        return None

    def to_state_dict(self) -> dict:
        """Serialize state for sending to clients."""
        return {
            "p1": {
                "id": self.p1["id"],
                "name": self.p1["name"],
                "hp": max(0, self.p1_hp),
                "max_hp": self.p1_max_hp,
                "shield": max(0, self.p1_shield),
            },
            "p2": {
                "id": self.p2["id"],
                "name": self.p2["name"],
                "hp": max(0, self.p2_hp),
                "max_hp": self.p2_max_hp,
                "shield": max(0, self.p2_shield),
            },
            "current_turn": self.current_turn,
            "turn_count": self.turn_count,
            "field_effects": [
                {
                    "desc": e["desc"],
                    "kind": e.get("kind", "generic"),
                    "turns_left": e["turns_left"],
                    "bind_hp": e.get("bind_hp"),
                    "target_id": e.get("target_id"),
                    "bind_target": e.get("bind_target"),
                    "caster_id": e.get("caster_id"),
                }
                for e in self.field_effects
            ],
            "finished": self.finished,
            "winner_id": self.winner_id,
            "winner_name": self.winner_name,
        }
