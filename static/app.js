/* 小二对决 — Frontend (P2P architecture)
 *
 * Roles:
 *   - Host (room creator): owns the canonical BattleState, calls /api/judge,
 *     processes every spell, broadcasts new state over WebRTC DataChannel.
 *   - Joiner: sends spell text to host, renders state from incoming messages.
 *
 * Phases:
 *   lobby → waiting (signaling WS open) → handshake (WebRTC) → battle → result
 */

const { BattleState, processSpell } = window.GameLogic;

// ── App state ─────────────────────────────────────────────────────────────────
const S = {
  signalWs: null,
  pc: null,           // RTCPeerConnection
  dc: null,           // RTCDataChannel
  iceQueue: [],       // ICE candidates received before remote description set
  remoteSet: false,
  isHost: null,
  roomId: null,
  playerId: null,
  playerName: null,
  battle: null,       // BattleState (host only)
  gameState: null,    // last rendered state (both)
  isMyTurn: false,
};

// STUN servers (mix of public + Chinese-friendly)
const ICE_SERVERS = [
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ── Utils ─────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function genId() { return Math.random().toString(36).slice(2, 10); }
function genRoom() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

function setThinking(on) { $('thinking-overlay').style.display = on ? 'flex' : 'none'; }

function pathPrefix() {
  const p = location.pathname;
  return p.endsWith('/') ? p.slice(0, -1) : p.substring(0, p.lastIndexOf('/'));
}

// ── Signaling WebSocket ───────────────────────────────────────────────────────
function openSignaling(roomId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}${pathPrefix()}/signal/${roomId}`;
  const ws = new WebSocket(url);
  S.signalWs = ws;

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    handleSignal(msg);
  };
  ws.onerror = () => {
    showLobbyError('信令服务器连接失败');
    showScreen('screen-lobby');
  };
  ws.onclose = () => {
    if (!S.dc || S.dc.readyState !== 'open') {
      // closed before P2P established
      console.warn('signaling closed before P2P ready');
    }
  };
}

function sendSignal(obj) {
  if (S.signalWs && S.signalWs.readyState === WebSocket.OPEN) {
    S.signalWs.send(JSON.stringify(obj));
  }
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined':
      S.isHost = msg.is_host;
      $('display-room-id').textContent = S.roomId;
      $('waiting-players').innerHTML = '';
      addPlayerChip(S.playerId, S.playerName);
      break;

    case 'ready':
      // Both peers now in room — joiner initiates WebRTC offer
      addPlayerChip('peer', '对手已加入');
      await setupPeerConnection();
      if (!S.isHost) {
        // joiner creates offer
        S.dc = S.pc.createDataChannel('game', { ordered: true });
        wireDataChannel(S.dc);
        const offer = await S.pc.createOffer();
        await S.pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer });
      }
      break;

    case 'offer':
      await S.pc.setRemoteDescription(msg.sdp);
      S.remoteSet = true;
      flushIceQueue();
      const answer = await S.pc.createAnswer();
      await S.pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
      break;

    case 'answer':
      await S.pc.setRemoteDescription(msg.sdp);
      S.remoteSet = true;
      flushIceQueue();
      break;

    case 'ice':
      if (S.remoteSet) {
        try { await S.pc.addIceCandidate(msg.candidate); } catch (_) {}
      } else {
        S.iceQueue.push(msg.candidate);
      }
      break;

    case 'peer_left':
      addLog('对手离开了房间', 'log-system');
      break;

    case 'error':
      showLobbyError(msg.message);
      showScreen('screen-lobby');
      break;
  }
}

function flushIceQueue() {
  while (S.iceQueue.length) {
    const c = S.iceQueue.shift();
    S.pc.addIceCandidate(c).catch(() => {});
  }
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
async function setupPeerConnection() {
  if (S.pc) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  S.pc = pc;
  S.remoteSet = false;
  S.iceQueue = [];

  pc.onicecandidate = e => {
    if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    console.log('pc state:', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      addLog('⚠️ 与对手的连接断开', 'log-system');
    }
  };
  pc.ondatachannel = e => {
    // Host receives DataChannel from joiner
    S.dc = e.channel;
    wireDataChannel(S.dc);
  };
}

function wireDataChannel(dc) {
  dc.onopen = () => {
    console.log('DataChannel open');
    // Close signaling — no longer needed
    if (S.signalWs) { try { S.signalWs.close(); } catch (_) {} }

    if (S.isHost) {
      // Host kicks off the battle
      const peerName = '对手';   // placeholder — we'll exchange names via dc
      // Actually, exchange names first
      dc.send(JSON.stringify({ type: 'hello', name: S.playerName, id: S.playerId }));
    } else {
      // Joiner sends hello
      dc.send(JSON.stringify({ type: 'hello', name: S.playerName, id: S.playerId }));
    }
  };

  dc.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    handlePeer(msg);
  };

  dc.onclose  = () => addLog('⚠️ 连接断开', 'log-system');
  dc.onerror  = err => console.warn('dc error', err);
}

function sendPeer(obj) {
  if (S.dc && S.dc.readyState === 'open') {
    S.dc.send(JSON.stringify(obj));
  }
}

// ── Peer protocol ─────────────────────────────────────────────────────────────
const _hello = { localSent: false, remoteRecv: null };

function startBattleIfReady() {
  if (!_hello.remoteRecv) return;
  if (!S.isHost) return;   // only host starts
  // Host has its own info + remote info
  const me   = { id: S.playerId, name: S.playerName };
  const them = _hello.remoteRecv;
  S.battle = new BattleState(me.id, me.name, them.id, them.name);
  showScreen('screen-battle');
  clearLog();
  addLog('⚔️ 对决开始！', 'log-system');
  const first = S.battle.getCurrentPlayer();
  addLog(`⚡ ${first.name} 速度更快，先手出招！`, 'log-system');
  broadcastState();
}

function broadcastState(extraLogs = []) {
  if (!S.isHost) return;
  const state = S.battle.toJSON();
  S.gameState = state;
  // Send to peer
  sendPeer({ type: 'state', state, logs: extraLogs });
  // Render on host side
  renderState(state, extraLogs);
}

async function handlePeer(msg) {
  switch (msg.type) {
    case 'hello':
      _hello.remoteRecv = { id: msg.id, name: msg.name };
      // Render lobby chip update
      const oppChip = $('chip-peer');
      if (oppChip) oppChip.querySelector('span:last-child').textContent = msg.name;
      startBattleIfReady();
      // Joiner: switch to battle screen on first state
      if (!S.isHost) showScreen('screen-battle');
      break;

    case 'state':
      renderState(msg.state, msg.logs || []);
      break;

    case 'spell':
      // Only host should receive 'spell' from joiner
      if (!S.isHost || !S.battle || S.battle.finished) return;
      // Validate it's the joiner's turn
      if (S.battle.currentTurn !== msg.from) {
        sendPeer({ type: 'error', message: '现在不是你的回合' });
        return;
      }
      try {
        const { logs } = await processSpell(S.battle, msg.from, msg.text);
        broadcastState(logs);
        if (S.battle.finished) {
          sendPeer({ type: 'end', winner: S.battle.winnerName });
          renderResult(S.battle.winnerName);
        }
      } catch (err) {
        console.error(err);
        sendPeer({ type: 'error', message: '处理失败' });
      }
      break;

    case 'end':
      renderResult(msg.winner);
      break;

    case 'surrender':
      if (!S.isHost) return;
      // joiner surrendered → host wins
      S.battle.finished = true;
      S.battle.winnerName = S.playerName;
      S.battle.winnerId   = S.playerId;
      broadcastState([`🏳️ 对手认输了！${S.playerName} 获胜！`]);
      sendPeer({ type: 'end', winner: S.playerName });
      renderResult(S.playerName);
      break;

    case 'rematch_request':
      if (S.isHost) {
        // Reset battle
        const me   = { id: S.playerId, name: S.playerName };
        const them = _hello.remoteRecv;
        S.battle = new BattleState(me.id, me.name, them.id, them.name);
        clearLog();
        showScreen('screen-battle');
        addLog('🔄 再来一局！', 'log-system');
        const first = S.battle.getCurrentPlayer();
        addLog(`⚡ ${first.name} 先手出招！`, 'log-system');
        broadcastState();
      }
      break;

    case 'error':
      addLog(`⚠️ ${msg.message}`, 'log-foul');
      break;
  }
}

// ── Render / UI ───────────────────────────────────────────────────────────────
function renderState(state, logs) {
  S.gameState = state;
  const amP1 = state.p1.id === S.playerId;
  const me   = amP1 ? state.p1 : state.p2;
  const opp  = amP1 ? state.p2 : state.p1;

  $('self-name').textContent = me.name;
  $('opp-name').textContent  = opp.name;

  updateHpBar('self', me.hp, me.max_hp, true);
  updateHpBar('opp',  opp.hp, opp.max_hp, false);

  updateShield('self', me.shield);
  updateShield('opp',  opp.shield);

  updateEffects('self', me.id, opp.id, state.field_effects);
  updateEffects('opp',  opp.id, me.id, state.field_effects);

  S.isMyTurn = state.current_turn === S.playerId && !state.finished;
  const selfBadge = $('self-turn-badge');
  const oppBadge  = $('opp-turn-badge');
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

  const inputRow = $('spell-input-row');
  const hint     = $('spell-hint');
  if (S.isMyTurn) {
    inputRow.style.display = 'flex';
    hint.style.display = 'none';
    $('input-spell').focus();
  } else if (!state.finished) {
    inputRow.style.display = 'none';
    hint.style.display = 'block';
    const isBound = state.field_effects.some(e => e.bind_target === S.playerId && (e.bind_hp || 0) > 0);
    hint.textContent = isBound ? '⛓️ 你被束缚了！等待下回合挣脱…' : `等待 ${opp.name} 出招…`;
  }

  setThinking(false);

  if (logs && logs.length) {
    const log = $('battle-log');
    if (log.children.length > 0 && !log.lastElementChild.classList.contains('log-divider')) {
      addDivider();
    }
    logs.forEach(line => addLog(line, classifyLog(line)));
  }
  scrollLog();
}

function renderResult(winnerName) {
  const amWinner = winnerName === S.playerName;
  $('result-icon').textContent  = amWinner ? '🏆' : '💀';
  $('result-title').textContent = amWinner ? '胜利！' : '败北…';
  $('result-sub').textContent   = `${winnerName} 赢得了对决！`;
  setTimeout(() => showScreen('screen-result'), 800);
}

function classifyLog(line) {
  if (line.startsWith('⚔️') || line.startsWith('🌀') || line.startsWith('🔗') || line.startsWith('💥')) return 'log-action';
  if (line.includes('伤害') || line.includes('闪避'))  return 'log-damage';
  if (line.includes('恢复') || line.startsWith('💚'))  return 'log-heal';
  if (line.includes('变化技') || line.includes('场地')) return 'log-field';
  if (line.startsWith('⚠️') || line.includes('犯规'))  return 'log-foul';
  if (line.startsWith('🏆') || line.startsWith('⚡') || line.startsWith('⚔️ 对决') ||
      line.startsWith('🔄') || line.startsWith('🏳️')) return 'log-system';
  return '';
}

function updateHpBar(who, hp, max, isSelf) {
  const pct = Math.max(0, Math.min(100, hp / max * 100));
  const bar = $(`${who}-hp-bar`);
  bar.style.width = `${pct}%`;
  bar.className = `hp-bar${isSelf ? ' hp-bar-self' : ''}`;
  if (pct <= 25)      bar.classList.add('low');
  else if (pct <= 55) bar.classList.add('medium');
  $(`${who}-hp-text`).textContent = `${Math.ceil(hp)}/${Math.ceil(max)}`;
}
function updateShield(who, shield) {
  const row = $(`${who}-shield-row`);
  $(`${who}-shield-text`).textContent = Math.ceil(shield);
  row.className = `shield-row${shield <= 0 ? ' empty' : ''}`;
}
function updateEffects(who, selfId, _oppId, effects) {
  const row = $(`${who}-effects`);
  row.innerHTML = '';
  for (const e of effects) {
    const isTarget = e.target_id === selfId || e.bind_target === selfId;
    const isCaster = e.caster_id === selfId;
    const kind = e.kind || 'generic';
    if (kind === 'dot' && !isTarget) continue;
    if ((kind === 'debuff_atk' || kind === 'debuff_def' || kind === 'seal') && !isTarget) continue;
    if ((kind === 'buff_atk' || kind === 'buff_def') && !isCaster) continue;
    if (kind === 'bind' && !isTarget) continue;
    if (kind === 'generic') continue;

    let cls = 'effect-generic';
    if (kind === 'dot') cls = 'effect-dot';
    else if (kind.includes('debuff')) cls = 'effect-debuff';
    else if (kind.includes('buff'))   cls = 'effect-buff';
    else if (kind === 'seal') cls = 'effect-seal';
    else if (kind === 'bind') cls = 'effect-bind';

    const bindHpStr = e.bind_hp ? ` 🔗${Math.ceil(e.bind_hp)}` : '';
    const chip = document.createElement('span');
    chip.className = `effect-chip ${cls}`;
    chip.textContent = `${e.desc}(${e.turns_left}回合)${bindHpStr}`;
    row.appendChild(chip);
  }
}

function addPlayerChip(id, name) {
  const list = $('waiting-players');
  if ($(`chip-${id}`)) return;
  const chip = document.createElement('div');
  chip.className = 'player-chip';
  chip.id = `chip-${id}`;
  chip.innerHTML = `<span class="player-chip-dot"></span><span>${escHtml(name)}</span>`;
  list.appendChild(chip);
}

function addLog(text, cls = '') {
  const log = $('battle-log');
  const el = document.createElement('div');
  el.className = `log-entry ${cls}`;
  el.textContent = text;
  log.appendChild(el);
}
function addDivider() {
  const el = document.createElement('div');
  el.className = 'log-divider';
  $('battle-log').appendChild(el);
}
function clearLog() { $('battle-log').innerHTML = ''; }
function scrollLog() {
  const log = $('battle-log');
  log.scrollTop = log.scrollHeight;
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    if (!name) { showLobbyError('请先输入名字'); return; }
    S.playerName = name;
    S.playerId   = genId();
    S.roomId     = $('input-room').value.trim().toUpperCase() || genRoom();
    showScreen('screen-waiting');
    openSignaling(S.roomId);
  });

  $('btn-join').addEventListener('click', joinRoom);
  $('input-room').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  });
  function joinRoom() {
    const name   = $('input-name').value.trim();
    const roomId = $('input-room').value.trim().toUpperCase();
    if (!name)   { showLobbyError('请先输入名字'); return; }
    if (!roomId) { showLobbyError('请输入房间码'); return; }
    S.playerName = name;
    S.playerId   = genId();
    S.roomId     = roomId;
    showScreen('screen-waiting');
    openSignaling(roomId);
  }

  $('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(S.roomId).then(() => {
      const b = $('btn-copy'); const o = b.textContent;
      b.textContent = '已复制';
      setTimeout(() => b.textContent = o, 1500);
    });
  });

  $('btn-spell').addEventListener('click', castSpell);
  $('input-spell').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); castSpell(); }
  });
  async function castSpell() {
    if (!S.isMyTurn) return;
    const input = $('input-spell');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    setThinking(true);
    S.isMyTurn = false;
    $('spell-input-row').style.display = 'none';
    $('spell-hint').style.display = 'block';
    $('spell-hint').textContent = '裁判判定中…';

    if (S.isHost) {
      // Process locally
      const { logs } = await processSpell(S.battle, S.playerId, text);
      broadcastState(logs);
      if (S.battle.finished) {
        sendPeer({ type: 'end', winner: S.battle.winnerName });
        renderResult(S.battle.winnerName);
      }
    } else {
      // Send to host
      sendPeer({ type: 'spell', from: S.playerId, text });
    }
  }

  $('btn-surrender').addEventListener('click', () => {
    if (!S.gameState || S.gameState.finished) return;
    if (!confirm('确认认输？')) return;
    if (S.isHost) {
      // Host surrenders → joiner wins
      const opp = S.battle.p1.id === S.playerId ? S.battle.p2 : S.battle.p1;
      S.battle.finished = true;
      S.battle.winnerName = opp.name;
      S.battle.winnerId   = opp.id;
      broadcastState([`🏳️ ${S.playerName} 认输了！${opp.name} 获胜！`]);
      sendPeer({ type: 'end', winner: opp.name });
      renderResult(opp.name);
    } else {
      sendPeer({ type: 'surrender' });
    }
  });

  $('btn-rematch').addEventListener('click', () => {
    if (S.isHost) {
      const me   = { id: S.playerId, name: S.playerName };
      const them = _hello.remoteRecv;
      S.battle = new BattleState(me.id, me.name, them.id, them.name);
      clearLog();
      showScreen('screen-battle');
      addLog('🔄 再来一局！', 'log-system');
      const first = S.battle.getCurrentPlayer();
      addLog(`⚡ ${first.name} 先手出招！`, 'log-system');
      broadcastState();
    } else {
      sendPeer({ type: 'rematch_request' });
      showScreen('screen-battle');
      clearLog();
    }
  });

  $('btn-leave').addEventListener('click', () => {
    if (S.dc) try { S.dc.close(); } catch (_) {}
    if (S.pc) try { S.pc.close(); } catch (_) {}
    if (S.signalWs) try { S.signalWs.close(); } catch (_) {}
    S.dc = null; S.pc = null; S.signalWs = null;
    S.battle = null; S.gameState = null; S.isMyTurn = false;
    _hello.remoteRecv = null; _hello.localSent = false;
    showScreen('screen-lobby');
  });

  // Auto-grow spell textarea
  const inp = $('input-spell');
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 100) + 'px';
  });
});
