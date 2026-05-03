/* 小二对决 — Frontend Game Logic */

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  ws: null,
  roomId: null,
  playerId: null,
  playerName: null,
  gameState: null,
  isMyTurn: false,
};

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function showLobbyError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function setThinking(on) {
  document.getElementById('thinking-overlay').style.display = on ? 'flex' : 'none';
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect(roomId, playerId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/${roomId}/${playerId}`;
  const ws = new WebSocket(url);
  S.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name: S.playerName }));
  };

  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch (_) {}
  };

  ws.onclose = () => {
    if (document.getElementById('screen-battle').classList.contains('active') ||
        document.getElementById('screen-waiting').classList.contains('active')) {
      addLog('⚠️ 连接断开', 'log-system');
    }
  };

  ws.onerror = () => {
    showLobbyError('连接失败，请检查网络');
    showScreen('screen-lobby');
  };
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
  }
}

// ── Message Handling ──────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'player_joined':
      onPlayerJoined(msg);
      break;
    case 'player_left':
      addLog(`${msg.name} 离开了房间`, 'log-system');
      break;
    case 'state':
      onStateUpdate(msg.state, msg.logs || []);
      break;
    case 'battle_end':
      onBattleEnd(msg.winner);
      break;
    case 'error':
      // Show inline error, don't interrupt game
      addLog(`⚠️ ${msg.message}`, 'log-foul');
      break;
  }
}

// ── Lobby Handlers ────────────────────────────────────────────────────────────
function onPlayerJoined(msg) {
  // Update waiting room player list
  const list = document.getElementById('waiting-players');
  const existing = document.getElementById(`chip-${msg.player_id}`);
  if (!existing) {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.id = `chip-${msg.player_id}`;
    chip.innerHTML = `<span class="player-chip-dot"></span><span>${escHtml(msg.name)}</span>`;
    list.appendChild(chip);
  }

  if (msg.count >= 2) {
    // Battle will start — server sends state next
    showScreen('screen-battle');
    clearLog();
  }
}

// ── State Update ──────────────────────────────────────────────────────────────
function onStateUpdate(state, logs) {
  S.gameState = state;

  // Resolve which player is which
  const amP1 = state.p1.id === S.playerId;
  const self = amP1 ? state.p1 : state.p2;
  const opp  = amP1 ? state.p2 : state.p1;

  // Names
  document.getElementById('self-name').textContent = self.name;
  document.getElementById('opp-name').textContent  = opp.name;

  // HP bars
  updateHpBar('self', self.hp, self.max_hp, true);
  updateHpBar('opp',  opp.hp,  opp.max_hp,  false);

  // Shield
  updateShield('self', self.shield);
  updateShield('opp',  opp.shield);

  // Field effects
  updateEffects('self', self.id, opp.id, state.field_effects);
  updateEffects('opp',  opp.id,  self.id, state.field_effects);

  // Turn indicator
  S.isMyTurn = state.current_turn === S.playerId && !state.finished;
  const selfBadge = document.getElementById('self-turn-badge');
  const oppBadge  = document.getElementById('opp-turn-badge');

  if (!state.finished) {
    if (S.isMyTurn) {
      selfBadge.style.display = 'inline-flex';
      oppBadge.classList.remove('visible');
    } else {
      selfBadge.style.display = 'none';
      oppBadge.classList.add('visible');
    }
  } else {
    selfBadge.style.display = 'none';
    oppBadge.classList.remove('visible');
  }

  // Spell input
  const inputRow  = document.getElementById('spell-input-row');
  const spellHint = document.getElementById('spell-hint');
  if (S.isMyTurn) {
    inputRow.style.display  = 'flex';
    spellHint.style.display = 'none';
    document.getElementById('input-spell').focus();
  } else if (!state.finished) {
    inputRow.style.display  = 'none';
    const oppName = opp.name;
    const isBound = state.field_effects.some(
      e => e.bind_target === S.playerId && (e.bind_hp || 0) > 0
    );
    spellHint.style.display = 'block';
    spellHint.textContent   = isBound
      ? '⛓️ 你被束缚了！等待下回合挣脱…'
      : `等待 ${oppName} 出招…`;
  }

  setThinking(false);

  // Append logs
  if (logs.length) {
    const hasDivider = document.querySelector('#battle-log .log-divider:last-child');
    if (!hasDivider && document.getElementById('battle-log').children.length > 0) {
      addDivider();
    }
    logs.forEach(line => addLog(line, classifyLog(line)));
  }

  scrollLog();
}

function classifyLog(line) {
  if (line.startsWith('⚔️') || line.startsWith('🌀') || line.startsWith('🔗') || line.startsWith('💥'))
    return 'log-action';
  if (line.includes('伤害') || line.includes('闪避'))
    return 'log-damage';
  if (line.includes('恢复') || line.startsWith('💚'))
    return 'log-heal';
  if (line.startsWith('🌀') || line.includes('变化技') || line.includes('场地'))
    return 'log-field';
  if (line.startsWith('⚠️') || line.includes('犯规'))
    return 'log-foul';
  if (line.startsWith('🏆') || line.startsWith('⚡') || line.startsWith('⚔️ 对决') ||
      line.startsWith('🔄') || line.startsWith('🏳️'))
    return 'log-system';
  return '';
}

function updateHpBar(who, hp, maxHp, isSelf) {
  const pct  = Math.max(0, Math.min(100, hp / maxHp * 100));
  const bar  = document.getElementById(`${who}-hp-bar`);
  const text = document.getElementById(`${who}-hp-text`);
  bar.style.width = `${pct}%`;
  bar.className = `hp-bar${isSelf ? ' hp-bar-self' : ''}`;
  if (pct <= 25)       bar.classList.add('low');
  else if (pct <= 55)  bar.classList.add('medium');
  text.textContent = `${Math.ceil(hp)}/${Math.ceil(maxHp)}`;
}

function updateShield(who, shield) {
  const row  = document.getElementById(`${who}-shield-row`);
  const text = document.getElementById(`${who}-shield-text`);
  text.textContent = Math.ceil(shield);
  row.className = `shield-row${shield <= 0 ? ' empty' : ''}`;
}

function updateEffects(who, selfId, _oppId, effects) {
  const row = document.getElementById(`${who}-effects`);
  row.innerHTML = '';

  effects.forEach(e => {
    const isTarget = e.target_id === selfId || e.bind_target === selfId;
    const isCaster = e.caster_id === selfId;
    const kind = e.kind || 'generic';

    // Only show effects that apply to this player
    if (kind === 'dot' && !isTarget) return;
    if ((kind === 'debuff_atk' || kind === 'debuff_def' || kind === 'seal') && !isTarget) return;
    if ((kind === 'buff_atk' || kind === 'buff_def') && !isCaster) return;
    if (kind === 'bind' && !isTarget) return;
    if (kind === 'generic') return; // show on both? skip for now

    let cls = 'effect-generic';
    if (kind === 'dot')    cls = 'effect-dot';
    else if (kind.includes('debuff')) cls = 'effect-debuff';
    else if (kind.includes('buff'))   cls = 'effect-buff';
    else if (kind === 'seal')  cls = 'effect-seal';
    else if (kind === 'bind')  cls = 'effect-bind';

    const bindHpStr = e.bind_hp ? ` 🔗${Math.ceil(e.bind_hp)}` : '';
    const chip = document.createElement('span');
    chip.className = `effect-chip ${cls}`;
    chip.textContent = `${e.desc}(${e.turns_left}回合)${bindHpStr}`;
    row.appendChild(chip);
  });
}

// ── Battle End ────────────────────────────────────────────────────────────────
function onBattleEnd(winnerName) {
  const amWinner = winnerName === S.playerName;

  document.getElementById('result-icon').textContent  = amWinner ? '🏆' : '💀';
  document.getElementById('result-title').textContent = amWinner ? '胜利！' : '败北…';
  document.getElementById('result-sub').textContent   = amWinner
    ? `${S.playerName} 赢得了对决！`
    : `${winnerName} 赢得了对决！`;

  // Small delay for dramatic effect
  setTimeout(() => showScreen('screen-result'), 800);
}

// ── Log ───────────────────────────────────────────────────────────────────────
function addLog(text, cls = '') {
  const log = document.getElementById('battle-log');
  const el = document.createElement('div');
  el.className = `log-entry ${cls}`;
  el.textContent = text;
  log.appendChild(el);
}

function addDivider() {
  const log = document.getElementById('battle-log');
  const el = document.createElement('div');
  el.className = 'log-divider';
  log.appendChild(el);
}

function clearLog() {
  document.getElementById('battle-log').innerHTML = '';
}

function scrollLog() {
  const log = document.getElementById('battle-log');
  log.scrollTop = log.scrollHeight;
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Event Listeners ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Create room
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('input-name').value.trim();
    if (!name) { showLobbyError('请先输入名字'); return; }

    S.playerName = name;
    S.playerId   = genId();
    S.roomId     = document.getElementById('input-room').value.trim().toUpperCase() ||
                   Math.random().toString(36).slice(2, 7).toUpperCase();

    document.getElementById('display-room-id').textContent = S.roomId;
    document.getElementById('waiting-players').innerHTML = '';
    showScreen('screen-waiting');
    connect(S.roomId, S.playerId);
  });

  // Join room
  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('input-room').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  });

  function joinRoom() {
    const name   = document.getElementById('input-name').value.trim();
    const roomId = document.getElementById('input-room').value.trim().toUpperCase();
    if (!name)   { showLobbyError('请先输入名字'); return; }
    if (!roomId) { showLobbyError('请输入房间码'); return; }

    S.playerName = name;
    S.playerId   = genId();
    S.roomId     = roomId;

    document.getElementById('display-room-id').textContent = roomId;
    document.getElementById('waiting-players').innerHTML = '';
    showScreen('screen-waiting');
    connect(roomId, S.playerId);
  }

  // Copy room code
  document.getElementById('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(S.roomId).then(() => {
      const btn = document.getElementById('btn-copy');
      const orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = orig, 1500);
    });
  });

  // Cast spell
  document.getElementById('btn-spell').addEventListener('click', castSpell);
  document.getElementById('input-spell').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      castSpell();
    }
  });

  function castSpell() {
    if (!S.isMyTurn) return;
    const input = document.getElementById('input-spell');
    const text = input.value.trim();
    if (!text) return;

    send({ type: 'spell', text });
    input.value = '';
    setThinking(true);
    S.isMyTurn = false;
    document.getElementById('spell-input-row').style.display  = 'none';
    document.getElementById('spell-hint').style.display = 'block';
    document.getElementById('spell-hint').textContent = '裁判判定中…';
  }

  // Surrender
  document.getElementById('btn-surrender').addEventListener('click', () => {
    if (!S.gameState || S.gameState.finished) return;
    if (confirm('确认认输？')) {
      send({ type: 'surrender' });
    }
  });

  // Rematch
  document.getElementById('btn-rematch').addEventListener('click', () => {
    send({ type: 'rematch' });
    showScreen('screen-battle');
    clearLog();
    setThinking(false);
  });

  // Leave
  document.getElementById('btn-leave').addEventListener('click', () => {
    if (S.ws) S.ws.close();
    S.ws = null;
    S.gameState = null;
    S.isMyTurn = false;
    showScreen('screen-lobby');
  });

  // Auto-grow spell textarea
  const spellInput = document.getElementById('input-spell');
  spellInput.addEventListener('input', () => {
    spellInput.style.height = 'auto';
    spellInput.style.height = Math.min(spellInput.scrollHeight, 100) + 'px';
  });
});
