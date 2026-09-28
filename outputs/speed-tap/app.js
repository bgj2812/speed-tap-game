(() => {
  const screen = document.querySelector('#screen');
  const toast = document.querySelector('#toast');
  const connectionLabel = document.querySelector('#connection-label');
  const headerCenter = document.querySelector('.header-center');
  const socketUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const playerKey = getPlayerKey();
  let socket;
  let retryTimer;
  let reconnectAttempt = 0;
  let lastHeartbeatAt = Date.now();
  let toastTimer;
  let game = null;
  let notice = '';
  let clockOffset = 0;
  let tapSentForRound = null;
  let restoredSession = readSession();
  let draftCode = restoredSession?.code || '';

  function getPlayerKey() {
    try {
      let key = sessionStorage.getItem('speedtap-player-key');
      if (!key) {
        key = crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem('speedtap-player-key', key);
      }
      return key;
    } catch (_) { return `p-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  }

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem('speedtap-session') || 'null'); } catch (_) { return null; }
  }

  function saveSession(session) {
    restoredSession = session;
    try {
      if (session) sessionStorage.setItem('speedtap-session', JSON.stringify(session));
      else sessionStorage.removeItem('speedtap-session');
    } catch (_) { /* The game still works without local storage. */ }
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    socket = new WebSocket(socketUrl);
    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      lastHeartbeatAt = Date.now();
      setConnection(true);
      if (restoredSession) send({ type: 'join', ...restoredSession, playerKey });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'heartbeat') {
        lastHeartbeatAt = Date.now();
        return;
      }
      if (message.type === 'state') {
        clockOffset = (message.serverNow || Date.now()) - Date.now();
        game = message.room;
        const me = game.players.find((player) => player.playerKey === playerKey);
        if (me) saveSession({ name: me.name, code: game.code });
        draftCode = game.code;
        notice = '';
        tapSentForRound = null;
        render();
      } else if (message.type === 'error') {
        notice = message.message || 'Something went wrong. Please try again.';
        render();
      } else if (message.type === 'left') {
        game = null;
        render();
      }
    });
    socket.addEventListener('close', () => {
      setConnection(false);
      clearTimeout(retryTimer);
      const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      retryTimer = setTimeout(connect, delay);
    });
    socket.addEventListener('error', () => socket.close());
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else showToast('Reconnecting… one moment.');
  }

  function setConnection(isOnline) {
    connectionLabel.textContent = isOnline ? 'Connected' : 'Reconnecting';
    headerCenter.classList.toggle('is-online', isOnline);
    screen.querySelectorAll('[data-action="create"], [data-action="join"]').forEach((button) => { button.disabled = !isOnline; });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2100);
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function initials(name) {
    const words = String(name || '?').trim().split(/\s+/);
    return escapeHTML((words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase());
  }

  function avatar(name, index, extra = '') {
    return `<span class="avatar tone-${index % 4} ${extra}">${initials(name)}</span>`;
  }

  function playerInputName() {
    return (document.querySelector('#player-name')?.value || '').trim();
  }

  function render() {
    if (!game) return renderHome();
    if (game.phase === 'lobby') return renderLobby();
    if (game.phase === 'finished') return renderFinal();
    return renderPlay();
  }

  function renderHome() {
    const savedName = (() => { try { return localStorage.getItem('speedtap-name') || ''; } catch (_) { return ''; } })();
    screen.innerHTML = `
      <section class="home-layout" aria-label="Join a Speed Tap game">
        <div class="hero-copy">
          <div class="eyebrow"><span class="spark">✳</span> THE FRIENDLY REFLEX TEST</div>
          <h1>Beat the<br /><span class="italic-word">blink.</span> Take<br />the bragging<br />rights.</h1>
          <p>Five quick rounds. One glowing target. Tap the second it appears and see who has the fastest fingers in the group.</p>
          <div class="hero-rule">A little skill. A little luck. A lot of rematches.</div>
        </div>
        <div class="join-panel">
          <div class="panel-topline"><h2>Jump into a game</h2><span class="panel-note">NO SIGN-UP</span></div>
          <label class="field-label" for="player-name">Your name</label>
          <input class="text-input" id="player-name" name="name" maxlength="18" autocomplete="nickname" placeholder="What should we call you?" value="${escapeHTML(savedName)}" />
          <button class="primary-button create-button" data-action="create" ${!isConnected() ? 'disabled' : ''}>Create a room <span class="button-arrow">↗</span></button>
          <div class="divider"><span>OR JOIN YOUR FRIEND</span></div>
          <label class="field-label" for="room-code-input">Room code</label>
          <div class="join-row"><input class="text-input code-input" id="room-code-input" maxlength="5" autocomplete="off" autocapitalize="characters" placeholder="ABCDE" aria-label="Five character room code" value="${escapeHTML(draftCode)}" /><button class="join-button" data-action="join" ${!isConnected() ? 'disabled' : ''}>Join room <span class="button-arrow">↗</span></button></div>
          <div class="panel-footnote"><span>✳</span> Just pick a name and you’re in. Up to 8 players.</div>
          ${notice ? `<div class="error-banner" role="alert">${escapeHTML(notice)}</div>` : ''}
        </div>
      </section>`;
    const roomInput = screen.querySelector('#room-code-input');
    roomInput?.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); draftCode = roomInput.value; });
  }

  function sortedPlayers() {
    return [...(game?.players || [])].sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  }

  function isMe(player) { return player.playerKey === playerKey; }

  function playerListMarkup() {
    const people = game.players.map((player, index) => `
      <div class="player-row">
        ${avatar(player.name, index)}
        <div class="player-name">${escapeHTML(player.name)}${player.isHost ? '<span class="player-caption">Room host</span>' : ''}</div>
        <span class="player-tag ${player.connected ? (player.ready ? 'ready' : '') : 'offline'}">${player.connected ? (player.ready ? 'Ready ✓' : 'Here') : 'Offline'}</span>
      </div>`).join('');
    return people || '<div class="waiting-copy">Waiting for players…</div>';
  }

  function roomHeading(subtitle) {
    return `<div class="room-heading"><div><div class="eyebrow"><span class="spark">✳</span> YOUR PRIVATE GAME</div><h1>Room ${escapeHTML(game.code)}</h1><p>${subtitle}</p></div><div class="room-code-block"><span class="room-code-label">INVITE YOUR FRIENDS</span><button class="room-code-button" data-action="copy-code" aria-label="Copy room code ${escapeHTML(game.code)}">${escapeHTML(game.code)} <small>⧉ copy</small></button></div></div>`;
  }

  function renderLobby() {
    const me = game.players.find(isMe);
    const allReady = game.connectedCount >= 2 && game.players.filter((p) => p.connected).every((p) => p.ready);
    const ready = !!me?.ready;
    screen.innerHTML = `<section class="room-wrap">${roomHeading('Share the code. When everyone’s ready, the first round begins.')}
      <div class="game-grid">
        <section class="surface lobby-main">
          <div class="surface-kicker"><span>THE LINEUP</span><span class="seat-count">${game.connectedCount} / 8 PLAYERS</span></div>
          <h2>Good company. Fast hands.</h2>
          <p>Send the room code to your crew. Everyone gets five chances to claim the fastest-finger title.</p>
          <div class="player-list">${playerListMarkup()}</div>
          <div class="lobby-actions">
            <button class="primary-button" data-action="ready" ${game.connectedCount < 2 ? 'disabled' : ''}>${ready ? 'You’re ready ✓' : 'I’m ready'} <span class="button-arrow">→</span></button>
            <div class="lobby-helper">${game.connectedCount < 2 ? 'Waiting for at least one more player to join.' : allReady ? 'Ready when you are…' : ready ? 'Waiting for the rest of the crew.' : 'Round one starts when everyone is ready.'}</div>
          </div>
          ${notice ? `<div class="error-banner" role="alert">${escapeHTML(notice)}</div>` : ''}
        </section>
        <aside class="lobby-side" aria-label="How to play">
          <section class="surface rules-card"><h3>Three things to know</h3>
            <div class="rule-step"><span class="rule-number">01</span><div class="rule-copy"><b>Wait for the green</b>Stay sharp. The target appears after a surprise pause.</div></div>
            <div class="rule-step"><span class="rule-number">02</span><div class="rule-copy"><b>Tap it first</b>Hit the big button as soon as you see it.</div></div>
            <div class="rule-step"><span class="rule-number">03</span><div class="rule-copy"><b>Win a point</b>The first tap the server receives scores. Early taps don’t count.</div></div>
            <div class="mini-rounds" aria-label="Five rounds">${Array.from({ length: 5 }, () => '<span></span>').join('')}</div><p class="rules-foot">5 ROUNDS · 1 POINT EACH</p>
          </section>
          <section class="surface waiting-card"><span class="waiting-icon">⌁</span><div class="waiting-copy"><b>Share the moment</b>No accounts, no setup. Just a room code and a friendly rivalry.</div></section>
        </aside>
      </div></section>`;
  }

  function scoreListMarkup() {
    return sortedPlayers().map((player, index) => `
      <div class="score-row ${isMe(player) ? 'me' : ''} ${player.connected ? '' : 'offline'}">
        <span class="score-rank">${String(index + 1).padStart(2, '0')}</span>
        <span class="score-avatar tone-${index % 4}">${initials(player.name)}</span>
        <span class="score-name">${escapeHTML(player.name)}${isMe(player) ? '<span class="you-tag"> · you</span>' : ''}${player.connected ? '' : '<span class="offline-tag"> · offline</span>'}</span>
        <span class="score-value">${player.score}<small>pt</small></span>
      </div>`).join('');
  }

  function scoreboardMarkup() {
    return `<section class="surface score-card"><div class="score-head"><h3>Scoreboard</h3><span>SERVER SYNCED</span></div><div class="score-list">${scoreListMarkup()}</div><p class="score-note"><strong>1 point</strong> for the first tap. Five rounds decide the champion.</p></section><div class="side-tip"><b>Pro tip <span>✳</span></b>Keep your thumb close. The pause is different every round.</div>`;
  }

  function progressMarkup() {
    return `<div class="round-progress" aria-label="Round ${game.round} of 5">${Array.from({ length: 5 }, (_, i) => `<span class="${i + 1 < game.round ? 'done' : i + 1 === game.round ? 'current' : ''}"></span>`).join('')}</div>`;
  }

  function arenaMarkup() {
    if (game.stage === 'active') {
      const alreadySent = tapSentForRound === game.round;
      return `<section class="surface arena-card is-active" id="arena-card"><div class="arena-overline"><span class="status-spark">✳</span> NOW. NOW. NOW.</div><h2 class="arena-title">Go go go!</h2><p class="arena-subtitle">Tap the target before anyone else.</p><div class="arena-target-wrap"><span class="target-crosshair" aria-hidden="true"></span><button id="target-button" class="target-button" data-action="tap" ${alreadySent ? 'disabled' : ''} aria-label="Tap the glowing target now"> <span class="target-word">${alreadySent ? 'SENT!' : 'TAP!'}</span><span class="target-caption">${alreadySent ? 'response received' : 'tap as fast as you can'}</span></button></div><span id="round-clock" class="result-next"></span></section>`;
    }
    if (game.stage === 'result') {
      const winner = game.winner;
      return `<section class="surface arena-card is-result"><div class="arena-overline"><span class="status-spark">✳</span> ROUND ${game.round} RESULT</div><h2 class="arena-title">${winner ? `${escapeHTML(winner.name)} got it!` : 'No one got it.'}</h2><p class="arena-subtitle">${winner ? 'That was quick.' : 'The target timed out this round.'}</p><div class="result-medal ${winner ? '' : 'empty'}">${winner ? '✦' : '—'}</div><div class="result-caption">${winner ? 'First tap wins this round' : 'Better luck on the next one'}</div>${winner ? `<div class="result-react"><span>${winner.reactionMs} ms</span> reaction</div>` : ''}<span class="result-next">${game.round < 5 ? 'NEXT ROUND COMING UP' : 'ADDING UP THE FINAL SCORES'}</span></section>`;
    }
    return `<section class="surface arena-card"><div class="arena-overline"><span class="status-spark">✳</span> ROUND ${game.round} OF 5</div><h2 class="arena-title">${game.round === 1 ? 'Get ready…' : 'Eyes up, everyone'}</h2><p class="arena-subtitle">The target shows up after a surprise pause<span class="watching-word"></span></p><span class="result-medal empty" aria-hidden="true">⌁</span><div class="result-caption">Stay sharp. Don’t jump the gun.</div><span class="result-next">WAITING FOR THE SIGNAL</span></section>`;
  }

  function renderPlay() {
    screen.innerHTML = `<section class="play-layout">
      <div class="play-topline"><div class="round-mark"><span class="round-mark-label">THE QUICK-FINGER CUP</span><span class="round-pill">ROUND ${game.round} / 5</span></div>${progressMarkup()}</div>
      <div class="play-grid"><div class="play-main">${arenaMarkup()}</div><aside class="lobby-side">${scoreboardMarkup()}</aside></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="exit-button" data-action="leave">Leave room</button></div>
    </section>`;
  }

  function renderFinal() {
    const players = sortedPlayers();
    const topScore = players[0]?.score || 0;
    const champions = players.filter((p) => p.score === topScore);
    const championText = topScore === 0 || champions.length !== 1 ? (topScore === 0 ? 'No points this time' : 'It’s a tie!') : `${escapeHTML(champions[0].name)} wins!`;
    const me = players.find(isMe);
    const connected = game.players.filter((p) => p.connected);
    const readyCount = connected.filter((p) => p.ready).length;
    const ready = !!me?.ready;
    const leaderRows = players.map((player, index) => {
      const rank = index > 0 && player.score === players[index - 1].score ? players[index - 1].rank : index + 1;
      player.rank = rank;
      const place = rank === 1 ? '1st place' : rank === 2 ? '2nd place' : rank === 3 ? '3rd place' : `${rank}th place`;
      const tags = [isMe(player) ? 'YOU' : '', player.connected ? '' : 'OFFLINE', place.toUpperCase()].filter(Boolean).join(' · ');
      return `<div class="leader-row ${index === 0 && topScore > 0 ? 'champion' : ''} ${player.connected ? '' : 'offline'}"><span class="leader-rank">${String(index + 1).padStart(2, '0')}</span><span class="leader-avatar tone-${index % 4}">${initials(player.name)}</span><span class="leader-name">${escapeHTML(player.name)}<small>${tags}</small></span><span class="leader-points">${player.score}<span>${player.score === 1 ? 'point' : 'points'}</span></span></div>`;
    }).join('');
    screen.innerHTML = `<section class="final-wrap">
      <div class="final-hero"><div class="final-hero-copy"><div class="eyebrow"><span class="spark">✳</span> THAT’S A WRAP · ROOM ${escapeHTML(game.code)}</div><h1>${championText}</h1><p>Five rounds down. Here’s how those lightning-fast fingers stacked up.</p></div><div class="champion-chip"><span class="champion-icon">✦</span><span class="champion-copy">${topScore > 0 && champions.length === 1 ? 'TOP OF THE TABLE' : 'FINAL RESULT'}<b>${champions.map((p) => escapeHTML(p.name)).join(' & ')}</b></span></div></div>
      <div class="final-grid"><section class="surface leaderboard-card"><div class="leaderboard-top"><h2>Final leaderboard</h2><span>5 ROUNDS COMPLETE</span></div>${leaderRows}</section>
        <aside class="final-side"><section class="surface rematch-card"><span class="rematch-symbol">↻</span><h3>One more round?</h3><p>Same crew, fresh random pauses. The room stays open for rematches.</p><button class="primary-button" data-action="rematch" ${connected.length < 2 ? 'disabled' : ''}>${ready ? 'You’re in ✓' : 'Play again'} <span class="button-arrow">→</span></button><div class="rematch-progress"><span class="ready-count">${readyCount} / ${connected.length}</span><span>${readyCount === connected.length && connected.length >= 2 ? 'Starting…' : 'ready for another match'}</span></div></section><div class="surface rules-card final-rules"><b>How the points worked</b><br />First valid tap received by the server wins one point. Early taps are ignored. Five rounds, highest score wins.</div></aside>
      </div><div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="exit-button" data-action="leave">Leave room</button></div>
      ${notice ? `<div class="error-banner" role="alert">${escapeHTML(notice)}</div>` : ''}</section>`;
  }

  function dispatchAction(action) {
    if (action === 'create') {
      const name = playerInputName();
      if (!name) return showToast('Add your name first.');
      rememberName(name);
      saveSession({ name });
      send({ type: 'create', name, playerKey });
    } else if (action === 'join') {
      const name = playerInputName();
      const code = (screen.querySelector('#room-code-input')?.value || '').trim().toUpperCase();
      if (!name) return showToast('Add your name first.');
      if (!code || code.length !== 5) return showToast('Enter the 5-letter room code.');
      rememberName(name);
      draftCode = code;
      saveSession({ name, code });
      send({ type: 'join', name, code, playerKey });
    } else if (action === 'ready') {
      send({ type: 'ready', ready: !game.players.find(isMe)?.ready });
    } else if (action === 'rematch') {
      send({ type: 'rematch', ready: !game.players.find(isMe)?.ready });
    } else if (action === 'tap') {
      if (!game || game.stage !== 'active' || tapSentForRound === game.round) return;
      tapSentForRound = game.round;
      send({ type: 'tap', round: game.round });
      const button = screen.querySelector('#target-button');
      if (button) {
        button.disabled = true;
        button.querySelector('.target-word').textContent = 'SENT!';
        button.querySelector('.target-caption').textContent = 'response received';
      }
    } else if (action === 'copy-code') {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(game.code).then(() => showToast(`Room code ${game.code} copied.`)).catch(() => showToast(`Share room code: ${game.code}`));
      } else {
        showToast(`Share room code: ${game.code}`);
      }
    } else if (action === 'leave') {
      send({ type: 'leave' });
      saveSession(null);
      draftCode = '';
      game = null;
      notice = '';
      render();
    } else if (action === 'home') {
      if (game) return;
      renderHome();
    }
  }

  function rememberName(name) {
    try { localStorage.setItem('speedtap-name', name.slice(0, 18)); } catch (_) { /* optional */ }
  }

  screen.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && !button.disabled) dispatchAction(button.dataset.action);
  });
  screen.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'room-code-input') dispatchAction('join');
  });

  function isConnected() { return socket && socket.readyState === WebSocket.OPEN; }

  setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (Date.now() - lastHeartbeatAt > 45000) {
        socket.close();
      } else {
        send({ type: 'heartbeat' });
      }
    }
  }, 20000);

  setInterval(() => {
    const clock = screen.querySelector('#round-clock');
    if (!clock || !game || game.stage !== 'active') return;
    const ms = Math.max(0, (game.deadlineAt || 0) - (Date.now() + clockOffset));
    clock.textContent = `${(ms / 1000).toFixed(1)} SEC LEFT`;
  }, 100);

  connect();
  render();
})();
