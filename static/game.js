/* 小二对决 — Pure-JS port of battle.py
 * Runs in the host browser; both peers render from the broadcasted state. */

const BASE_STATS = {
  '体力': 100, '灵智': 30, '想象': 30,
  '灵魂': 30, '创造': 30, '灵活': 50,
};

function calcCombatStats(s) {
  return {
    hp:     s['体力']*0.8 + s['灵魂']*0.2,
    matk:   s['灵智']*0.6,
    mdef:   s['灵智']*0.4,
    satk:   s['想象']*0.6 + s['创造']*0.6,
    sdef:   s['想象']*0.4,
    shield: s['灵魂']*0.5 + s['创造']*0.4,
    speed:  s['灵魂']*0.3 + s['灵活']*0.7,
    dodge:  s['灵活']*0.3,
  };
}

class BattleState {
  constructor(p1Id, p1Name, p2Id, p2Name) {
    this.p1 = { id: p1Id, name: p1Name };
    this.p2 = { id: p2Id, name: p2Name };

    const s1 = calcCombatStats(BASE_STATS);
    const s2 = calcCombatStats(BASE_STATS);

    this.p1Hp = s1.hp;  this.p1MaxHp = s1.hp;
    this.p1Shield = s1.shield;
    this.p1Combat = s1;

    this.p2Hp = s2.hp;  this.p2MaxHp = s2.hp;
    this.p2Shield = s2.shield;
    this.p2Combat = s2;

    this.currentTurn = s1.speed >= s2.speed ? p1Id : p2Id;
    this.turnCount = 0;
    this.fieldEffects = [];
    this.finished = false;
    this.winnerId = null;
    this.winnerName = null;
  }

  getCurrentPlayer() { return this.currentTurn === this.p1.id ? this.p1 : this.p2; }
  getOpponent()      { return this.currentTurn === this.p1.id ? this.p2 : this.p1; }
  getCurrentCombat() { return this.currentTurn === this.p1.id ? this.p1Combat : this.p2Combat; }

  getAtkModifier(uid) {
    let mod = 1.0;
    for (const e of this.fieldEffects) {
      const m = e.magnitude || 0;
      if (e.kind === 'buff_atk'   && e.caster_id === uid) mod += m;
      if (e.kind === 'debuff_atk' && e.target_id === uid) mod -= m;
    }
    return Math.max(0.3, mod);
  }
  getDefModifier(uid) {
    let mod = 1.0;
    for (const e of this.fieldEffects) {
      const m = e.magnitude || 0;
      if (e.kind === 'buff_def'   && e.caster_id === uid) mod += m;
      if (e.kind === 'debuff_def' && e.target_id === uid) mod -= m;
    }
    return Math.max(0.3, mod);
  }
  isFieldBlocked(uid) {
    return this.fieldEffects.some(e => e.kind === 'seal' && e.target_id === uid);
  }
  isBound(uid) {
    return this.fieldEffects.some(e => e.bind_target === uid && (e.bind_hp || 0) > 0);
  }
  getBindEffect(uid) {
    return this.fieldEffects.find(e => e.bind_target === uid && (e.bind_hp || 0) > 0);
  }

  applyDamage(targetId, rawDamage) {
    const attackerId = targetId === this.p1.id ? this.p2.id : this.p1.id;
    rawDamage *= this.getAtkModifier(attackerId);

    const isP1   = targetId === this.p1.id;
    const combat = isP1 ? this.p1Combat : this.p2Combat;

    const dodgeChance = combat.dodge / 300;
    if (Math.random() < dodgeChance) return { dmg: 0, desc: '闪避！' };

    const defense = (combat.mdef + combat.sdef) / 2 * this.getDefModifier(targetId);
    let reduced = Math.max(rawDamage - defense * 0.3, rawDamage * 0.2);

    if (isP1) {
      if (this.p1Shield > 0) {
        const absorbed = Math.min(this.p1Shield, reduced);
        this.p1Shield -= absorbed; reduced -= absorbed;
        if (reduced > 0) this.p1Hp -= reduced;
        return { dmg: absorbed + reduced, desc: `护盾吸收 ${Math.round(absorbed)}，受到 ${Math.round(reduced)} 伤害` };
      }
      this.p1Hp -= reduced;
      return { dmg: reduced, desc: `受到 ${Math.round(reduced)} 伤害` };
    } else {
      if (this.p2Shield > 0) {
        const absorbed = Math.min(this.p2Shield, reduced);
        this.p2Shield -= absorbed; reduced -= absorbed;
        if (reduced > 0) this.p2Hp -= reduced;
        return { dmg: absorbed + reduced, desc: `护盾吸收 ${Math.round(absorbed)}，受到 ${Math.round(reduced)} 伤害` };
      }
      this.p2Hp -= reduced;
      return { dmg: reduced, desc: `受到 ${Math.round(reduced)} 伤害` };
    }
  }

  addFieldEffect(desc, casterId, opts = {}) {
    const { kind = 'generic', magnitude = 0, target_id = null, isBind = false } = opts;
    const e = { desc, kind, turns_left: 4, caster_id: casterId, magnitude };
    if (target_id) e.target_id = target_id;
    if (isBind) {
      e.kind = 'bind';
      e.bind_hp = 15;
      e.bind_target = casterId === this.p2.id ? this.p1.id : this.p2.id;
    }
    this.fieldEffects.push(e);
    if (this.fieldEffects.length > 5) this.fieldEffects = this.fieldEffects.slice(-5);
  }

  attackBind(uid, damage) {
    const e = this.getBindEffect(uid);
    if (!e) return { broke: false, remaining: 0, desc: '没有束缚可以攻击' };
    e.bind_hp -= damage;
    if (e.bind_hp <= 0) {
      this.fieldEffects = this.fieldEffects.filter(x => x !== e);
      return { broke: true, remaining: 0, desc: `挣脱了「${e.desc}」！` };
    }
    return { broke: false, remaining: e.bind_hp, desc: `攻击束缚物，剩余 ${Math.round(e.bind_hp)} HP` };
  }

  nextTurn() {
    this.turnCount += 1;
    const dotEvents = [];

    for (const e of this.fieldEffects) {
      if (e.kind !== 'dot') continue;
      const tid = e.target_id;
      const mag = e.magnitude || 0;
      if (!tid || mag <= 0) continue;
      if (tid === this.p1.id) {
        const actual = Math.min(mag, Math.max(0, this.p1Hp));
        this.p1Hp = Math.max(0, this.p1Hp - mag);
        dotEvents.push({ target_name: this.p1.name, dmg: actual, desc: e.desc });
      } else {
        const actual = Math.min(mag, Math.max(0, this.p2Hp));
        this.p2Hp = Math.max(0, this.p2Hp - mag);
        dotEvents.push({ target_name: this.p2.name, dmg: actual, desc: e.desc });
      }
    }

    for (const e of this.fieldEffects) e.turns_left -= 1;
    this.fieldEffects = this.fieldEffects.filter(e => e.turns_left > 0);

    this.currentTurn = this.currentTurn === this.p1.id ? this.p2.id : this.p1.id;
    this.checkWinner();
    return { dots: dotEvents };
  }

  checkWinner() {
    if (this.p1Hp <= 0) {
      this.finished = true;
      this.winnerId = this.p2.id; this.winnerName = this.p2.name;
      return this.p2.name;
    }
    if (this.p2Hp <= 0) {
      this.finished = true;
      this.winnerId = this.p1.id; this.winnerName = this.p1.name;
      return this.p1.name;
    }
    return null;
  }

  toJSON() {
    return {
      p1: { id: this.p1.id, name: this.p1.name, hp: Math.max(0, this.p1Hp), max_hp: this.p1MaxHp, shield: Math.max(0, this.p1Shield) },
      p2: { id: this.p2.id, name: this.p2.name, hp: Math.max(0, this.p2Hp), max_hp: this.p2MaxHp, shield: Math.max(0, this.p2Shield) },
      current_turn: this.currentTurn,
      turn_count: this.turnCount,
      field_effects: this.fieldEffects.map(e => ({
        desc: e.desc, kind: e.kind, turns_left: e.turns_left,
        bind_hp: e.bind_hp, target_id: e.target_id, bind_target: e.bind_target,
        caster_id: e.caster_id,
      })),
      finished: this.finished,
      winner_id: this.winnerId,
      winner_name: this.winnerName,
    };
  }
}


// ── Game flow: process a spell on the host side ───────────────────────────────
// Returns { logs: [...], stateChanged: true } and mutates `battle`.
async function processSpell(battle, casterId, spellText) {
  const current  = battle.getCurrentPlayer();
  const opponent = battle.getOpponent();
  const logs = [];

  // Call AI judge via HTTP endpoint
  let result;
  try {
    const resp = await fetch('api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spell: spellText, field_effects: battle.fieldEffects }),
    });
    result = await resp.json();
  } catch (err) {
    console.error('judge API error', err);
    result = { power: 15, type: 'attack', description: '普通攻击', is_foul: false };
  }

  const appendDots = (turnRes) => {
    for (const ev of turnRes.dots || []) {
      logs.push(`🔥 ${ev.target_name} 受到 ${ev.desc} 的 ${Math.round(ev.dmg)} HP 持续伤害`);
    }
  };

  if (result.is_foul) {
    const turnRes = battle.nextTurn();
    logs.push(`⚠️ 犯规！${result.description || '违规操作'}`);
    logs.push(`${current.name} 的回合被跳过`);
    appendDots(turnRes);
    return { logs };
  }

  const type = result.type || 'attack';

  if (type === 'field') {
    if (battle.isFieldBlocked(casterId)) {
      const turnRes = battle.nextTurn();
      logs.push(`🚫 ${current.name} 尝试释放变化技，但被封印了！`);
      appendDots(turnRes);
      return { logs };
    }
    let kind = result.field_kind || 'dot';
    const power = result.power || 15;
    const desc  = result.description || '场地变化';
    let magnitude, targetId, kindLabel;

    if (kind === 'dot') {
      magnitude = Math.max(3, Math.min(10, Math.round(power / 3)));
      targetId  = opponent.id;
      kindLabel = `持续伤害（每回合 ${magnitude} HP）`;
    } else if (kind === 'debuff_atk' || kind === 'debuff_def') {
      magnitude = Math.max(0.10, Math.min(0.25, power / 100));
      targetId  = opponent.id;
      kindLabel = `削弱对手${kind === 'debuff_atk' ? '攻击' : '防御'} ${Math.floor(magnitude * 100)}%`;
    } else if (kind === 'buff_atk' || kind === 'buff_def') {
      magnitude = Math.max(0.10, Math.min(0.25, power / 100));
      targetId  = casterId;
      kindLabel = `强化自身${kind === 'buff_atk' ? '攻击' : '防御'} ${Math.floor(magnitude * 100)}%`;
    } else if (kind === 'seal') {
      magnitude = 0;
      targetId  = opponent.id;
      kindLabel = '封印对手变化技';
    } else {
      kind = 'generic';
      magnitude = 0; targetId = null;
      kindLabel = '场地变化';
    }
    battle.addFieldEffect(desc, casterId, { kind, magnitude, target_id: targetId });
    const turnRes = battle.nextTurn();
    logs.push(`🌀 ${current.name} 释放了变化技：${desc}（${kindLabel}，4回合）`);
    appendDots(turnRes);
    return { logs };
  }

  if (type === 'heal') {
    const heal = Math.min(result.power || 10, 20);
    if (casterId === battle.p1.id) battle.p1Hp = Math.min(battle.p1Hp + heal, battle.p1MaxHp);
    else                            battle.p2Hp = Math.min(battle.p2Hp + heal, battle.p2MaxHp);
    const turnRes = battle.nextTurn();
    logs.push(`💚 ${current.name}：${result.description || '治疗'}（恢复 ${Math.round(heal)} HP）`);
    appendDots(turnRes);
    return { logs };
  }

  if (type === 'bind') {
    battle.addFieldEffect(result.description || '束缚', casterId, { isBind: true });
    const turnRes = battle.nextTurn();
    logs.push(`🔗 ${current.name} 对 ${opponent.name} 施加了束缚：${result.description || '束缚'}（15HP，4回合）`);
    logs.push('被束缚时只能攻击束缚物或挣脱！');
    appendDots(turnRes);
    return { logs };
  }

  if (type === 'break' || battle.isBound(casterId)) {
    const bind = battle.getBindEffect(casterId);
    if (bind) {
      const combat = battle.getCurrentCombat();
      const stat   = (combat.matk + combat.satk) / 2 * 0.4;
      const raw    = (result.power || 0) + stat;
      const r      = battle.attackBind(casterId, raw);
      const turnRes = battle.nextTurn();
      const icon   = r.broke ? '💥' : '🔗';
      logs.push(`${icon} ${current.name}：${result.description || (r.broke ? '挣脱' : '攻击束缚')} — ${r.desc}`);
      appendDots(turnRes);
      return { logs };
    }
  }

  // Normal attack
  const combat = battle.getCurrentCombat();
  const stat   = (combat.matk + combat.satk) / 2 * 0.4;
  const raw    = (result.power || 15) + stat;
  const r      = battle.applyDamage(opponent.id, raw);
  const desc   = result.description || '攻击';
  logs.push(`⚔️ ${current.name} — ${desc}`);
  logs.push(`${r.dmg === 0 ? '💨' : '💥'} ${opponent.name} ${r.desc}`);

  const winner = battle.checkWinner();
  if (winner) return { logs };

  const turnRes = battle.nextTurn();
  appendDots(turnRes);
  return { logs };
}

// Expose for app.js
window.GameLogic = { BattleState, processSpell };
