(() => {
  'use strict';
  const { SpadesGame } = window.SpadesEngine;
  const defaultNames = ['You', 'Mara', 'Jonah', 'Nia'];
  const settingsStorageKey = 'spades-table-settings';
  const byId = id => document.getElementById(id);
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(settingsStorageKey));
      if (!saved || !Array.isArray(saved.names) || saved.names.length !== 4) return null;
      return {
        names: saved.names.map((name, index) => String(name).trim().slice(0, 20) || defaultNames[index]),
        variant: saved.variant === 'jjda' ? 'jjda' : 'standard',
        winningScore: [200, 300, 500].includes(Number(saved.winningScore)) ? Number(saved.winningScore) : 500,
        photo: typeof saved.photo === 'string' && /^data:image\/jpeg;base64,/.test(saved.photo) ? saved.photo : '',
      };
    } catch {
      return null;
    }
  }
  const initialSettings = loadSettings();
  let names = initialSettings?.names || [...defaultNames];
  let variant = initialSettings?.variant || 'jjda';
  let winningScore = initialSettings?.winningScore || 500;
  let profilePhoto = initialSettings?.photo || '';
  const game = new SpadesGame(names, winningScore, variant);
  const suitOrder = { '♥': 0, '♣': 1, '♦': 2, '♠': 3 };
  const seatIds = { 1: 'seat-1', 2: 'seat-2', 3: 'seat-3' };
  let phase = 'bidding';
  let lastTrick = null;
  let computerTimer = null;
  let dealAnimationTimer = null;
  let handRevealed = true;
  let animatedOnlineRound = 0;
  const hand = byId('player-hand');
  const bidForm = byId('bid-form');
  const bidInput = byId('bid-input');
  const settingsDialog = byId('settings-dialog');
  const settingsForm = byId('settings-form');
  const onlineDialog = byId('online-dialog');
  let mode = 'local';
  let onlineSocket = null;
  let onlineRoomCode = '';
  let onlineSeatIndex = -1;
  let onlineState = null;
  let activeView = 'match-view';

  function connectOnline(action) {
    const roomCode = byId('room-code-input').value.trim().toUpperCase();
    if (action === 'join' && !/^[A-F0-9]{6}$/.test(roomCode)) {
      byId('room-feedback').textContent = 'Enter the six-character room code.';
      return;
    }
    if (onlineSocket && onlineSocket.readyState < WebSocket.CLOSING) onlineSocket.close();
    byId('room-feedback').textContent = action === 'create' ? 'Creating your room…' : 'Joining the table…';
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}`);
    onlineSocket = socket;
    socket.addEventListener('open', () => {
      const token = action === 'join' ? localStorage.getItem(`spades-room-${roomCode}`) : null;
      socket.send(JSON.stringify({ type: 'join', action, roomCode, name: names[0], variant, winningScore, token }));
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'joined') {
        onlineRoomCode = message.roomCode;
        onlineSeatIndex = message.seatIndex;
        variant = message.variant;
        winningScore = message.winningScore;
        byId('room-code-input').value = onlineRoomCode;
        byId('room-code-display').textContent = onlineRoomCode;
        byId('room-share').hidden = false;
        byId('leave-room').hidden = false;
        localStorage.setItem(`spades-room-${onlineRoomCode}`, message.token);
        byId('room-feedback').textContent = `You are seated. Share the code with the other players.`;
      } else if (message.type === 'state') {
        onlineState = message;
        mode = 'online';
        const connected = message.players.filter(player => player.connected).length;
        byId('room-feedback').textContent = message.phase === 'lobby'
          ? `Room ${message.roomCode}: waiting for players (${connected}/4).`
          : `Room ${message.roomCode}: ${connected}/4 connected.`;
        render();
      } else if (message.type === 'error') {
        byId('room-feedback').textContent = message.message;
      }
    });
    socket.addEventListener('close', () => {
      if (onlineSocket === socket && mode === 'online') {
        byId('room-feedback').textContent = 'Connection closed. Rejoin with the room code to resume your seat.';
      }
    });
    socket.addEventListener('error', () => {
      byId('room-feedback').textContent = 'Could not reach the multiplayer server.';
    });
  }

  function sendOnlineAction(action, details = {}) {
    if (!onlineSocket || onlineSocket.readyState !== WebSocket.OPEN) {
      byId('room-feedback').textContent = 'You are disconnected. Rejoin using the room code.';
      return;
    }
    onlineSocket.send(JSON.stringify({ type: 'action', action, ...details }));
  }

  function leaveOnline() {
    if (onlineSocket) onlineSocket.close();
    onlineSocket = null;
    onlineState = null;
    onlineRoomCode = '';
    onlineSeatIndex = -1;
    mode = 'local';
    render();
  }

  function startRound() {
    clearTimeout(computerTimer);
    game.startRound();
    handRevealed = !game.canPlaceBlindNil(0);
    phase = 'bidding';
    lastTrick = null;
    byId('game-status').textContent = `Opening lead: ${names[game.leadPlayerIndex]}. Place your bid.`;
    byId('score-note').textContent = 'Your partnership is seated North–South.';
    render();
    animateDeal();
  }
  function animateDeal() {
    const tableSurface = document.querySelector('.table-surface');
    tableSurface.classList.remove('is-shuffling');
    hand.classList.remove('is-dealing');
    void tableSurface.offsetWidth;
    tableSurface.classList.add('is-shuffling');
    hand.classList.add('is-dealing');
    clearTimeout(dealAnimationTimer);
    dealAnimationTimer = setTimeout(() => {
      tableSurface.classList.remove('is-shuffling');
      hand.classList.remove('is-dealing');
    }, 1500);
  }
  function estimateBid(cards) {
    let strength = 0;
    const suits = ['♠', '♥', '♦', '♣'];
    const counts = Object.fromEntries(suits.map(suit => [suit, cards.filter(card => card.suit === suit).length]));
    for (const card of cards) {
      if (card.isJoker) strength += 1.35;
      else if (card.suit === '♠') strength += card.value >= 13 ? 1.2 : card.value >= 11 ? 1 : card.value >= 8 ? .65 : .25;
      else if (card.value === 12) strength++;
      else if (card.value === 11) strength += counts[card.suit] >= 3 ? .7 : .4;
      else if (card.value === 10 && counts[card.suit] >= 4) strength += .25;
    }
    return Math.max(1, Math.min(7, Math.round(strength)));
  }
  function playCard(playerIndex, cardIndex) {
    const before = game.currentTrick.slice();
    const card = game.players[playerIndex].hand[cardIndex];
    const winner = game.playCard(playerIndex, cardIndex);
    if (winner !== null) {
      lastTrick = [...before, { playerIndex, card }];
      byId('game-status').textContent = `${names[winner]} takes the trick.`;
      if (game.isRoundOver()) {
        game.scoreRound();
        phase = game.isGameOver() ? 'game-over' : 'round-over';
        if (phase === 'game-over') byId('game-status').textContent = game.getWinningTeam() === 0 ? 'Game. Your partnership wins.' : 'Game. Mara and Nia win.';
        else byId('game-status').textContent = `Hand ${game.roundNumber} is complete.`;
      }
      render();
      computerTimer = setTimeout(() => {
        lastTrick = null;
        render();
        if (phase === 'play' && game.currentPlayerIndex !== 0) scheduleComputerTurn();
      }, 1000);
      return;
    }
    byId('game-status').textContent = playerIndex === 0 ? 'Card played.' : `${names[playerIndex]} played.`;
    render();
    if (phase === 'play' && game.currentPlayerIndex !== 0) scheduleComputerTurn();
  }
  function scheduleComputerTurn() {
    clearTimeout(computerTimer);
    if (phase !== 'play' || game.currentPlayerIndex === 0) return;
    computerTimer = setTimeout(() => {
      const playerIndex = game.currentPlayerIndex;
      const legal = game.players[playerIndex].hand.map((card, index) => ({ card, index })).filter(item => game.isLegalPlay(playerIndex, item.card));
      const choice = chooseComputerCard(playerIndex, legal);
      playCard(playerIndex, choice.index);
    }, 620);
  }
  function chooseComputerCard(playerIndex, legal) {
    const winner = findTrickWinner(game.currentTrick);
    const partnerWinning = winner !== null && winner % 2 === playerIndex % 2;
    const leadSuit = game.currentTrick[0]?.card.suit;
    const ascending = [...legal].sort((a, b) => a.card.value - b.card.value);
    if (!leadSuit) return ascending.find(item => item.card.suit !== '♠') || ascending[0];
    if (partnerWinning) return ascending[0];
    const winningCard = game.currentTrick.find(play => play.playerIndex === winner)?.card;
    return ascending.find(item => beats(item.card, winningCard)) || ascending[0];
  }
  function beats(card, best) {
    if (!best) return true;
    if (card.suit === '♠' && best.suit !== '♠') return true;
    if (card.suit !== '♠' && best.suit === '♠') return false;
    return card.suit === best.suit && card.value > best.value;
  }
  function findTrickWinner(plays) {
    if (!plays.length) return null;
    const leadSuit = plays[0].card.suit;
    let best = plays[0];
    for (const play of plays.slice(1)) {
      const card = play.card;
      const top = best.card;
      if ((card.suit === '♠' && top.suit !== '♠') || (card.suit === '♠' && top.suit === '♠' && card.value > top.value) || (top.suit !== '♠' && card.suit === leadSuit && top.suit === leadSuit && card.value > top.value)) best = play;
    }
    return best.playerIndex;
  }
  function render() {
    if (mode === 'online' && onlineState) {
      renderOnline();
      return;
    }
    byId('round-label').textContent = `HAND ${String(game.roundNumber).padStart(2, '0')}`;
    byId('score-team-0').textContent = game.teamScores[0];
    byId('score-team-1').textContent = game.teamScores[1];
    byId('bags-team-0').textContent = game.teamBags[0];
    byId('bags-team-1').textContent = game.teamBags[1];
    byId('team-names-0').textContent = `${names[0]} + ${names[2]}`;
    byId('team-names-1').textContent = `${names[1]} + ${names[3]}`;
    byId('hand-count').textContent = `${game.players[0].hand.length} cards`;
    byId('trump-state').innerHTML = `<span class="trump-icon">♠</span> ${variant === 'jjda' ? 'JJDA · ' : ''}Spades ${game.spadesBroken ? 'broken' : 'unbroken'}`;
    const completedTricks = game.players.reduce((total, player) => total + player.tricksWon, 0);
    byId('trick-caption').textContent = `${completedTricks} OF 13 TRICKS PLAYED`;
    renderLivePanels(game.players, game.teamScores, game.teamBags, game.roundNumber, phase, game.winningScore);
    renderMySeat(game.players[0], phase === 'play' && game.currentPlayerIndex === 0, game.dealerIndex, game.leadPlayerIndex);
    renderSeats(); renderTrick(); renderHand(); renderControls();
  }
  function renderOnline() {
    const state = onlineState;
    names = state.players.map(player => player.name);
    variant = state.variant;
    winningScore = state.winningScore;
    hand.hidden = Boolean(state.handHidden);
    byId('blind-nil-notice').hidden = !state.canBlindNil;
    byId('round-label').textContent = `HAND ${String(state.roundNumber).padStart(2, '0')}`;
    byId('score-team-0').textContent = state.teamScores[0];
    byId('score-team-1').textContent = state.teamScores[1];
    byId('bags-team-0').textContent = state.teamBags[0];
    byId('bags-team-1').textContent = state.teamBags[1];
    byId('team-names-0').textContent = `${names[0]} + ${names[2]}`;
    byId('team-names-1').textContent = `${names[1]} + ${names[3]}`;
    byId('hand-count').textContent = `${state.hand.length} cards`;
    byId('trump-state').innerHTML = `<span class="trump-icon">♠</span> ${variant === 'jjda' ? 'JJDA · ' : ''}Spades ${state.spadesBroken ? 'broken' : 'unbroken'}`;
    byId('trick-caption').textContent = `${state.players.reduce((total, player) => total + player.tricksWon, 0)} OF 13 TRICKS PLAYED`;
    byId('game-status').textContent = state.message;
    renderLivePanels(state.players, state.teamScores, state.teamBags, state.roundNumber, state.phase, state.winningScore);
    renderMySeat(state.players[onlineSeatIndex], state.phase === 'play' && state.currentPlayerIndex === onlineSeatIndex, state.dealerIndex, state.leadPlayerIndex);
    state.players.forEach((player, index) => {
      if (index === onlineSeatIndex) return;
      const active = state.phase === 'play' && state.currentPlayerIndex === index;
      const bid = player.bid === null ? 'Waiting to bid' : player.blindNil ? 'Blind Nil' : `Bid ${player.bid === 0 ? 'Nil' : player.bid}`;
      const color = index === 1 ? 'avatar-coral' : index === 2 ? 'avatar-gold' : 'avatar-blue';
      const roles = seatRoleBadges(index, state.dealerIndex, state.leadPlayerIndex);
      byId(seatIds[index]).innerHTML = `<span class="seat-avatar ${color}">${escapeHtml(player.name[0])}</span><span class="seat-copy"><strong>${escapeHtml(player.name)}</strong><small>${player.connected ? bid : 'Disconnected'} · ${player.tricksWon} tricks</small>${roles}</span><span class="turn-indicator ${active ? 'is-active' : ''}"></span>`;
    });
    const positions = { 0: 'played-south', 1: 'played-west', 2: 'played-north', 3: 'played-east' };
    byId('trick-cards').innerHTML = state.currentTrick.map(play => `<div class="played-card ${positions[play.playerIndex]} ${isRed(play.card.suit) ? 'red-suit' : ''}"><span>${escapeHtml(play.card.rank)}</span><span>${escapeHtml(play.card.suit)}</span></div>`).join('');
    const legalIndices = new Set(state.legalIndices);
    const cards = state.hand.map((card, index) => ({ card, index })).sort((a, b) => suitOrder[a.card.suit] - suitOrder[b.card.suit] || a.card.value - b.card.value);
    hand.innerHTML = cards.map(({ card, index }, order) => {
      const legal = legalIndices.has(index);
      const label = `${cardDisplayName(card)}${legal ? ', play card' : ''}`;
      return `<button class="playing-card ${isRed(card.suit) ? 'red-suit' : ''} ${state.phase === 'play' && state.currentPlayerIndex === onlineSeatIndex && !legal ? 'is-illegal' : ''}" type="button" data-card-index="${index}" aria-label="${label}" title="${label}" style="--card-order:${order}" ${legal ? '' : 'disabled'}><span class="card-rank">${escapeHtml(card.rank)}</span><span class="card-suit">${escapeHtml(card.suit)}</span><span class="card-corner" aria-hidden="true">${escapeHtml(card.rank)}<br>${escapeHtml(card.suit)}</span></button>`;
    }).join('');
    bidForm.hidden = state.phase !== 'bidding' || state.players[onlineSeatIndex].bid !== null || state.handHidden;
    byId('next-hand-button').hidden = state.phase !== 'round-over';
    byId('new-match-button').hidden = state.phase !== 'game-over';
    if (state.roundNumber > 0 && state.roundNumber !== animatedOnlineRound) {
      animatedOnlineRound = state.roundNumber;
      animateDeal();
    }
    const myTurn = state.currentPlayerIndex === onlineSeatIndex;
    byId('action-hint').textContent = state.phase === 'lobby' ? 'Waiting for four players to join.'
      : state.phase === 'bidding' ? (state.players[onlineSeatIndex].bid === null ? 'Place your bid.' : 'Waiting for the other bids.')
        : state.phase === 'play' ? (myTurn ? 'Your turn. Follow suit when you can.' : `${names[state.currentPlayerIndex]} is playing.`)
          : state.phase === 'round-over' ? 'The hand is scored. Deal the next hand when ready.' : 'The match is decided.';
  }
  function renderLivePanels(players, scores, bags, roundNumber, currentPhase, targetScore) {
    const ownIndex = mode === 'online' ? onlineSeatIndex : 0;
    const ownTeam = ownIndex % 2;
    const partner = players[(ownIndex + 2) % 4];
    const player = players[ownIndex];
    const partnerBid = partner?.bid;
    const playerBid = player?.bid;
    const bidsPlaced = playerBid !== null && playerBid !== undefined && partnerBid !== null && partnerBid !== undefined;
    const contractBids = bidsPlaced ? [playerBid, partnerBid].filter(bid => bid > 0) : [];
    const contractValue = contractBids.reduce((total, bid) => total + bid, 0);
    const contractLabel = !bidsPlaced ? 'Pending'
      : contractValue === 0 ? 'Nil bids'
        : `${contractValue}${[playerBid, partnerBid].includes(0) ? ' + Nil' : ''}`;
    const teamTricks = bidsPlaced ? player.tricksWon + partner.tricksWon : 0;
    const played = players.reduce((total, entry) => total + entry.tricksWon, 0);
    const phaseLabels = { lobby: 'Waiting for players', bidding: 'Bidding', play: 'In play', 'round-over': 'Hand complete', 'game-over': 'Match complete' };
    const leadingPlayer = [...players].sort((first, second) => second.tricksWon - first.tricksWon)[0];
    const leaderTeam = scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
    const teamNames = [`${names[0]} + ${names[2]}`, `${names[1]} + ${names[3]}`];

    byId('match-target-label').textContent = `FIRST TO ${targetScore}`;
    byId('leader-target').textContent = targetScore;
    byId('footer-target').textContent = `FOUR PLAYERS · ONE DECK · ${targetScore} POINTS`;
    byId('metric-team-score').textContent = `${scores[0]} — ${scores[1]}`;
    byId('metric-score-target').textContent = `${scores[ownTeam]} / ${targetScore}`;
    byId('metric-score-progress').style.width = `${Math.min(100, Math.max(0, scores[ownTeam] / targetScore * 100))}%`;
    byId('metric-player-tricks').textContent = player?.tricksWon ?? 0;
    byId('metric-contract').textContent = contractLabel;
    byId('metric-contract-detail').textContent = bidsPlaced
      ? `${teamTricks} made · ${bags[ownTeam]} bags`
      : 'Bids not placed';
    byId('metric-tricks-played').innerHTML = `${played} <i>/ 13</i>`;
    byId('metric-match-phase').textContent = `Hand ${String(roundNumber).padStart(2, '0')} · ${phaseLabels[currentPhase] || 'Ready'}`;
    byId('tracker-count').textContent = `${played} / 13 tricks`;
    byId('trick-track').innerHTML = Array.from({ length: 13 }, (_, index) => `<span class="trick-step ${index < played ? 'is-complete' : ''} ${index === played && played < 13 ? 'is-next' : ''}"></span>`).join('');
    byId('tracker-leader').textContent = played === 0
      ? 'First trick up for grabs'
      : `${leadingPlayer.name} leads with ${leadingPlayer.tricksWon} ${leadingPlayer.tricksWon === 1 ? 'trick' : 'tricks'}`;
    byId('tracker-contract').textContent = bidsPlaced ? `${teamTricks} of ${contractValue || 'Nil'} bid tricks` : 'Partnership contract pending';

    const onlineCount = players.filter(entry => entry.connected).length;
    const lobbyStatus = mode === 'online'
      ? `${onlineCount}/4 players connected`
      : 'Practice table ready';
    byId('lobby-status-text').textContent = lobbyStatus;
    byId('lobby-room-status').textContent = mode === 'online'
      ? `ROOM ${onlineRoomCode} · ${onlineCount}/4 CONNECTED`
      : 'No private room connected';
    byId('practice-roster').innerHTML = players.map((entry, index) => `<span class="roster-player ${index === 0 ? 'is-you' : ''}"><i></i>${escapeHtml(entry.name)}</span>`).join('');

    byId('leader-top-player').textContent = played === 0 ? '—' : leadingPlayer.name;
    byId('leader-top-player-detail').textContent = played === 0
      ? 'No tricks won yet'
      : `${leadingPlayer.tricksWon} ${leadingPlayer.tricksWon === 1 ? 'trick' : 'tricks'} this hand`;
    byId('leader-top-team').textContent = leaderTeam === null ? 'Tied game' : teamNames[leaderTeam];
    byId('leader-top-team-detail').textContent = `${scores[0]} — ${scores[1]} · first to ${targetScore}`;
    byId('leader-count').textContent = mode === 'online' ? `${onlineCount}/4 connected` : '4 players';
    const rows = players.map((entry, index) => ({ ...entry, index }))
      .sort((first, second) => second.tricksWon - first.tricksWon || first.index - second.index);
    byId('leaderboard-rows').innerHTML = rows.map((entry, rank) => {
      const bid = entry.bid === null || entry.bid === undefined ? '—' : entry.blindNil ? 'Blind Nil' : entry.bid === 0 ? 'Nil' : entry.bid;
      const seatLabel = mode === 'online'
        ? (entry.connected ? 'Online' : 'Disconnected')
        : entry.index === 0 ? 'You' : 'CPU';
      return `<tr class="${entry.index === ownIndex ? 'is-current-player' : ''}"><td><span class="rank-number ${rank === 0 && played ? 'is-leading' : ''}">${String(rank + 1).padStart(2, '0')}</span></td><td><strong>${escapeHtml(entry.name)}</strong>${entry.index === ownIndex ? '<small class="you-tag">YOU</small>' : ''}</td><td>${escapeHtml(teamNames[entry.index % 2])}</td><td>${bid}</td><td><strong class="leader-trick-count">${entry.tricksWon}</strong></td><td><span class="seat-state ${seatLabel === 'Disconnected' ? 'is-disconnected' : ''}">${seatLabel}</span></td></tr>`;
    }).join('');
  }

  function setActiveView(viewId) {
    activeView = viewId;
    document.querySelectorAll('[data-view-target]').forEach(button => {
      const isActive = button.dataset.viewTarget === viewId;
      button.classList.toggle('is-active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-app-view]').forEach(view => {
      view.hidden = view.id !== viewId;
    });
  }

  function renderSeats() {
    for (const index of [1, 2, 3]) {
      const player = game.players[index];
      const active = phase === 'play' && game.currentPlayerIndex === index;
      const bid = player.bid === null ? 'Waiting to bid' : player.blindNil ? 'Blind Nil' : `Bid ${player.bid === 0 ? 'Nil' : player.bid}`;
      const color = index === 1 ? 'avatar-coral' : index === 2 ? 'avatar-gold' : 'avatar-blue';
      const roles = seatRoleBadges(index, game.dealerIndex, game.leadPlayerIndex);
      byId(seatIds[index]).innerHTML = `<span class="seat-avatar ${color}">${escapeHtml(player.name[0])}</span><span class="seat-copy"><strong>${escapeHtml(player.name)}</strong><small>${bid} · ${player.tricksWon} tricks</small>${roles}</span><span class="turn-indicator ${active ? 'is-active' : ''}"></span>`;
    }
  }
  function renderMySeat(player, active, dealerIndex = null, leadPlayerIndex = null) {
    if (!player) return;
    const initial = escapeHtml(player.name.trim().charAt(0).toUpperCase() || '?');
    const avatar = profilePhoto
      ? `<img class="avatar-photo" src="${profilePhoto}" alt="">`
      : `<span class="avatar-initial">${initial}</span>`;
    const bid = player.bid === null ? 'Waiting to bid' : player.blindNil ? 'Blind Nil' : `Bid ${player.bid === 0 ? 'Nil' : player.bid}`;
    const trickLabel = player.tricksWon === 1 ? '1 trick won' : `${player.tricksWon} tricks won`;
    const roles = seatRoleBadges(mode === 'online' ? onlineSeatIndex : 0, dealerIndex, leadPlayerIndex);
    byId('seat-0').innerHTML = `<button class="seat-photo-button ${profilePhoto ? 'has-photo' : ''}" id="seat-photo-button" type="button" aria-label="${profilePhoto ? 'Change' : 'Add'} ${escapeHtml(player.name)}'s photo">${avatar}</button><span class="seat-copy"><strong>${escapeHtml(player.name)}</strong><small>${bid} · ${trickLabel}</small>${roles}</span><span class="turn-indicator ${active ? 'is-active' : ''}"></span>`;
  }
  function seatRoleBadges(seatIndex, dealerIndex, leadPlayerIndex) {
    const badges = [];
    if (seatIndex === dealerIndex) badges.push('<span class="seat-role is-dealer">DEALER</span>');
    if (seatIndex === leadPlayerIndex) badges.push('<span class="seat-role is-leader">LEADS</span>');
    return badges.length ? `<span class="seat-roles">${badges.join('')}</span>` : '';
  }
  function renderTrick() {
    const plays = game.currentTrick.length ? game.currentTrick : (lastTrick || []);
    const positions = { 0: 'played-south', 1: 'played-west', 2: 'played-north', 3: 'played-east' };
    byId('trick-cards').innerHTML = plays.map(play => `<div class="played-card ${positions[play.playerIndex]} ${isRed(play.card.suit) ? 'red-suit' : ''}"><span>${play.card.rank}</span><span>${play.card.suit}</span></div>`).join('');
  }
  function renderHand() {
    const blindAvailable = mode === 'local' && phase === 'bidding' && !handRevealed && game.canPlaceBlindNil(0);
    hand.hidden = blindAvailable;
    byId('blind-nil-notice').hidden = !blindAvailable;
    if (blindAvailable) {
      hand.innerHTML = '';
      return;
    }
    const humanTurn = phase === 'play' && game.currentPlayerIndex === 0;
    const cards = game.players[0].hand.map((card, index) => ({ card, index })).sort((a, b) => suitOrder[a.card.suit] - suitOrder[b.card.suit] || a.card.value - b.card.value);
    hand.innerHTML = cards.map(({ card, index }, order) => {
      const legal = humanTurn && game.isLegalPlay(0, card);
      const label = `${cardDisplayName(card)}${legal ? ', play card' : ''}`;
      return `<button class="playing-card ${isRed(card.suit) ? 'red-suit' : ''} ${humanTurn && !legal ? 'is-illegal' : ''}" type="button" data-card-index="${index}" aria-label="${label}" title="${label}" style="--card-order:${order}" ${legal ? '' : 'disabled'}><span class="card-rank">${card.rank}</span><span class="card-suit">${card.suit}</span><span class="card-corner" aria-hidden="true">${card.rank}<br>${card.suit}</span></button>`;
    }).join('');
  }
  function renderControls() {
    const blindAvailable = phase === 'bidding' && !handRevealed && game.canPlaceBlindNil(0);
    bidForm.hidden = phase !== 'bidding' || blindAvailable;
    byId('blind-nil-notice').hidden = !blindAvailable;
    byId('next-hand-button').hidden = phase !== 'round-over';
    byId('new-match-button').hidden = phase !== 'game-over';
    const humanTurn = phase === 'play' && game.currentPlayerIndex === 0;
    if (phase === 'bidding') byId('action-hint').textContent = 'A nil bid means you expect to take no tricks.';
    else if (humanTurn) byId('action-hint').textContent = 'Your turn. Follow suit when you can.';
    else if (phase === 'play') byId('action-hint').textContent = `${names[game.currentPlayerIndex]} is thinking…`;
    else if (phase === 'round-over') byId('action-hint').textContent = 'The hand is scored. Ready for the next deal?';
    else byId('action-hint').textContent = 'The match is decided.';
  }
  function isRed(suit) { return suit === '♥' || suit === '♦'; }
  function suitName(suit) { return ({ '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' })[suit]; }
  function cardDisplayName(card) {
    if (card.rank === 'BJ') return 'Big Joker';
    if (card.rank === 'LJ') return 'Little Joker';
    return `${card.rank} of ${suitName(card.suit)}`;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function showSettings() {
    if (mode === 'online') {
      byId('room-feedback').textContent = 'Leave the online room before changing player names or rules.';
      onlineDialog.showModal();
      return;
    }
    settingsForm.querySelectorAll('[data-player-index]').forEach(input => {
      input.value = names[Number(input.dataset.playerIndex)];
    });
    byId('variant-input').value = variant;
    byId('target-score-input').value = String(winningScore);
    renderPhotoPreview();
    settingsDialog.showModal();
  }

  function renderPhotoPreview() {
    const image = byId('photo-preview-image');
    image.hidden = !profilePhoto;
    image.src = profilePhoto;
    byId('photo-preview-initial').hidden = Boolean(profilePhoto);
    byId('photo-preview-initial').textContent = names[0].trim().charAt(0).toUpperCase() || '?';
    byId('remove-photo').hidden = !profilePhoto;
  }

  async function saveSelectedPhoto(file) {
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      byId('photo-status').textContent = 'Choose an image under 8 MB.';
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      profilePhoto = canvas.toDataURL('image/jpeg', 0.78);
      localStorage.setItem(settingsStorageKey, JSON.stringify({ names, variant, photo: profilePhoto }));
      byId('photo-status').textContent = 'Photo saved on this device.';
      renderPhotoPreview();
      render();
    } catch {
      byId('photo-status').textContent = 'Could not save that image. Try another photo.';
    }
  }

  settingsForm.addEventListener('submit', event => {
    event.preventDefault();
    const inputs = [...settingsForm.querySelectorAll('[data-player-index]')];
    const updatedNames = inputs.map(input => input.value.trim());
    const blankIndex = updatedNames.findIndex(name => !name);
    if (blankIndex >= 0) {
      inputs[blankIndex].setCustomValidity('Enter a name for this seat.');
      inputs[blankIndex].reportValidity();
      return;
    }
    inputs.forEach(input => input.setCustomValidity(''));
    const selectedWinningScore = Number(byId('target-score-input').value);
    if (![200, 300, 500].includes(selectedWinningScore)) {
      byId('target-score-input').setCustomValidity('Choose a 200, 300, or 500 point target.');
      byId('target-score-input').reportValidity();
      return;
    }
    names = updatedNames;
    names.forEach((name, index) => { game.players[index].name = name; });
    variant = byId('variant-input').value;
    game.variant = variant;
    winningScore = selectedWinningScore;
    game.winningScore = winningScore;
    game.teamScores = [0, 0];
    game.teamBags = [0, 0];
    game.dealerIndex = 2;
    game.roundNumber = 0;
    try {
      localStorage.setItem(settingsStorageKey, JSON.stringify({ names, variant, winningScore, photo: profilePhoto }));
    } catch {
      byId('score-note').textContent = 'Names are set for this match; browser storage is unavailable.';
    }
    settingsDialog.close();
    startRound();
    if (new URLSearchParams(location.search).has('room')) showOnlineDialog();
  });

  bidForm.addEventListener('submit', event => {
    event.preventDefault();
    const amount = Number(bidInput.value);
    if (!Number.isInteger(amount) || amount < 0 || amount > 13) {
      bidInput.setCustomValidity('Enter a whole number from 0 to 13.'); bidInput.reportValidity(); return;
    }
    bidInput.setCustomValidity('');
    if (mode === 'online') {
      sendOnlineAction('bid', { amount });
      return;
    }
    try {
      game.placeBid(0, amount);
      [1, 2, 3].forEach(index => game.placeBid(index, estimateBid(game.players[index].hand)));
      phase = 'play';
      byId('game-status').textContent = `You bid ${amount === 0 ? 'Nil' : amount}. ${names[game.currentPlayerIndex]} leads.`;
      render();
      if (game.currentPlayerIndex !== 0) scheduleComputerTurn();
    } catch (error) { byId('game-status').textContent = error.message; }
  });
  byId('reveal-hand-button').addEventListener('click', () => {
    if (mode === 'online') {
      sendOnlineAction('reveal-hand');
      return;
    }
    handRevealed = true;
    render();
  });
  byId('blind-nil-button').addEventListener('click', () => {
    if (mode === 'online') {
      sendOnlineAction('blind-nil');
      return;
    }
    try {
      game.placeBlindNil(0);
      [1, 2, 3].forEach(index => game.placeBid(index, estimateBid(game.players[index].hand)));
      phase = 'play';
      handRevealed = true;
      byId('game-status').textContent = 'You bid Blind Nil. The hand is now revealed.';
      render();
      if (game.currentPlayerIndex !== 0) scheduleComputerTurn();
    } catch (error) {
      byId('game-status').textContent = error.message;
    }
  });
  hand.addEventListener('click', event => {
    const button = event.target.closest('[data-card-index]');
    if (!button) return;
    if (mode === 'online') {
      sendOnlineAction('play', { cardIndex: Number(button.dataset.cardIndex) });
      return;
    }
    if (phase === 'play' && game.currentPlayerIndex === 0) playCard(0, Number(button.dataset.cardIndex));
  });
  byId('next-hand-button').addEventListener('click', () => {
    if (mode === 'online') sendOnlineAction('next-hand');
    else startRound();
  });
  function resetMatch() {
    if (mode === 'online') {
      sendOnlineAction('new-match');
      return;
    }
    game.teamScores = [0, 0]; game.teamBags = [0, 0]; game.dealerIndex = 2; game.roundNumber = 0; startRound();
  }
  byId('new-match-button').addEventListener('click', resetMatch);
  byId('new-game-button').addEventListener('click', resetMatch);
  byId('settings-button').addEventListener('click', showSettings);
  document.querySelectorAll('[data-open-settings]').forEach(button => {
    button.addEventListener('click', showSettings);
  });
  document.querySelectorAll('[data-view-target]').forEach(button => {
    button.addEventListener('click', () => setActiveView(button.dataset.viewTarget));
  });
  document.querySelectorAll('[data-open-room]').forEach(button => {
    button.addEventListener('click', () => {
      showOnlineDialog();
      if (button.dataset.roomAction === 'join') byId('room-code-input').focus();
    });
  });
  byId('practice-table-button').addEventListener('click', () => {
    if (mode === 'online') leaveOnline();
    setActiveView('match-view');
  });
  byId('lobby-settings-button').addEventListener('click', showSettings);
  byId('seat-0').addEventListener('click', event => {
    if (event.target.closest('#seat-photo-button')) showSettings();
  });
  byId('choose-photo').addEventListener('click', () => byId('photo-input').click());
  byId('photo-preview').addEventListener('click', () => byId('photo-input').click());
  byId('photo-input').addEventListener('change', event => {
    saveSelectedPhoto(event.target.files[0]);
    event.target.value = '';
  });
  byId('remove-photo').addEventListener('click', () => {
    profilePhoto = '';
    try {
      localStorage.setItem(settingsStorageKey, JSON.stringify({ names, variant, photo: '' }));
      byId('photo-status').textContent = 'Photo removed.';
    } catch {
      byId('photo-status').textContent = 'Could not update browser storage.';
    }
    renderPhotoPreview();
    render();
  });
  byId('close-settings').addEventListener('click', () => settingsDialog.close());
  byId('cancel-settings').addEventListener('click', () => settingsDialog.close());
  function showOnlineDialog() {
    onlineDialog.showModal();
    const inviteCode = new URLSearchParams(location.search).get('room');
    if (inviteCode) byId('room-code-input').value = inviteCode.toUpperCase();
  }
  byId('online-button').addEventListener('click', showOnlineDialog);
  byId('close-online').addEventListener('click', () => onlineDialog.close());
  byId('create-room').addEventListener('click', () => connectOnline('create'));
  byId('join-room').addEventListener('click', () => connectOnline('join'));
  byId('room-code-input').addEventListener('input', event => {
    event.target.value = event.target.value.replace(/[^a-fA-F0-9]/g, '').slice(0, 6).toUpperCase();
  });
  byId('copy-room-link').addEventListener('click', async () => {
    const invite = new URL(location.href);
    invite.searchParams.set('room', onlineRoomCode);
    try {
      await navigator.clipboard.writeText(invite.href);
      byId('room-feedback').textContent = 'Invite link copied.';
    } catch {
      byId('room-feedback').textContent = `Share room code ${onlineRoomCode}.`;
    }
  });
  byId('leave-room').addEventListener('click', leaveOnline);
  startRound();
  if (!initialSettings) showSettings();
  else if (new URLSearchParams(location.search).has('room')) showOnlineDialog();
})();
