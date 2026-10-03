'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { SpadesGame } = require('./spadesEngine');

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '0.0.0.0';
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/api/firebase-config') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ apiKey: process.env.FIREBASE_API_KEY || '', accountsEnabled: firebaseConfigured() }));
    return;
  }

  if (pathname === '/api/account') {
    if (request.method !== 'GET') {
      response.writeHead(405).end('Method not allowed');
      return;
    }
    try {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) {
        response.writeHead(401).end(JSON.stringify({ error: 'Sign in to view your points.' }));
        return;
      }
      const user = await verifyFirebaseToken(token);
      const wallet = await getOrCreateWallet(user.uid, user.email || '');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ uid: user.uid, email: user.email || '', points: wallet.points }));
    } catch (error) {
      response.writeHead(error.statusCode || 503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.statusCode ? error.message : 'Firebase account storage is not configured.' }));
    }
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  });
});

const webSockets = new WebSocketServer({ server, maxPayload: 2048 });
const rooms = new Map();
const assignedSeats = new Map();

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}

function safeName(value) {
  if (typeof value !== 'string') return 'Player';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20) || 'Player';
}

function safeChatText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
}

function safeChatText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
}

let firebaseServices;
function firebaseConfigured() {
  return Boolean(process.env.FIREBASE_API_KEY && process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

function getFirebaseServices() {
  if (!firebaseConfigured()) throw Object.assign(new Error('Firebase account storage is not configured.'), { statusCode: 503 });
  if (!firebaseServices) {
    const { cert, getApps, initializeApp } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { FieldValue, getFirestore } = require('firebase-admin/firestore');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
    firebaseServices = { auth: getAuth(app), db: getFirestore(app), FieldValue };
  }
  return firebaseServices;
}

async function verifyFirebaseToken(token) {
  try {
    return await getFirebaseServices().auth.verifyIdToken(token);
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error('Your account session is invalid. Sign in again.'), { statusCode: 401 });
  }
}

async function getOrCreateWallet(userId, email) {
  const { db, FieldValue } = getFirebaseServices();
  const profile = db.collection('spadesPointWallets').doc(userId);
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(profile);
    if (!snapshot.exists) {
      transaction.set(profile, { email, points: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return { points: 0 };
    }
    transaction.set(profile, { email, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { points: Number(snapshot.get('points')) || 0 };
  });
  return result;
}

async function applyPoints(userId, email, eventId, amount, reason) {
  const { db, FieldValue } = getFirebaseServices();
  const profile = db.collection('spadesPointWallets').doc(userId);
  const event = profile.collection('events').doc(eventId);
  return db.runTransaction(async transaction => {
    const profileSnapshot = await transaction.get(profile);
    const eventSnapshot = await transaction.get(event);
    const balance = Number(profileSnapshot.get('points')) || 0;
    if (eventSnapshot.exists) return { points: balance, applied: false };
    if (balance + amount < 0) throw new Error('Not enough points for this tournament entry.');
    const nextBalance = balance + amount;
    transaction.set(profile, { email, points: nextBalance, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.create(event, { amount, reason, createdAt: FieldValue.serverTimestamp() });
    return { points: nextBalance, applied: true };
  });
}

async function awardRoomPoints(room, seatIndex, award, reason) {
  const seat = room.seats[seatIndex];
  if (!seat?.userId) return;
  const eventId = `${room.matchId}-${room.game.roundNumber}-${award}-${seat.userId}`;
  try {
    const result = await applyPoints(seat.userId, seat.email, eventId, reason.amount, reason.label);
    seat.pointsBalance = result.points;
    if (result.applied) seat.lastReward = { id: eventId, amount: reason.amount, label: reason.label };
  } catch (error) {
    console.error(`Could not award ${award} points:`, error.message);
  }
}

async function awardCompletedHand(room) {
  const game = room.game;
  for (let seatIndex = 0; seatIndex < room.seats.length; seatIndex++) {
    const player = game.players[seatIndex];
    if (!room.seats[seatIndex]?.userId) continue;
    await awardRoomPoints(room, seatIndex, 'hand-complete', { amount: 10, label: 'Completed hand' });
    if (player.nilBid && player.tricksWon === 0) {
      const amount = player.blindNil ? 50 : 25;
      await awardRoomPoints(room, seatIndex, 'nil-success', { amount, label: player.blindNil ? 'Successful Blind Nil' : 'Successful Nil' });
    }
  }

  if (room.phase !== 'game-over') return;
  const winningTeam = game.getWinningTeam();
  if (winningTeam === null) return;
  for (let seatIndex = winningTeam; seatIndex < game.players.length; seatIndex += 2) {
    if (!room.seats[seatIndex]?.userId) continue;
    await awardRoomPoints(room, seatIndex, 'match-win', { amount: 100, label: 'Won a match' });
    if (room.tournament) {
      await awardRoomPoints(room, seatIndex, 'quickcup-win', { amount: room.tournament.prizePool / 2, label: 'Quick Cup prize' });
    }
  }
}

function newRoomCode() {
  let code;
  do code = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  while (rooms.has(code));
  return code;
}

function assignSocket(socket, room, seatIndex, name, token, accountUser, wallet) {
  const seat = room.seats[seatIndex];
  if (seat?.socket && seat.socket !== socket) {
    assignedSeats.delete(seat.socket);
    seat.socket.close(4001, 'Seat reconnected');
  }
  room.seats[seatIndex] = {
    name, token, socket,
    handRevealed: seat?.handRevealed || false,
    userId: accountUser?.uid || seat?.userId || null,
    email: accountUser?.email || seat?.email || '',
    pointsBalance: wallet?.points ?? seat?.pointsBalance ?? null,
    lastReward: seat?.lastReward || null,
  };
  assignedSeats.set(socket, { room, seatIndex });
  if (!room.game && room.seats.every(Boolean)) {
    room.game = new SpadesGame(room.seats.map(player => player.name), room.winningScore, room.variant);
    room.game.startRound();
    room.phase = 'bidding';
    room.message = 'Four players are seated. Place your bids.';
  }
  send(socket, { type: 'joined', roomCode: room.code, seatIndex, token, variant: room.variant, winningScore: room.winningScore, tournament: room.tournament || null, pointsBalance: room.seats[seatIndex].pointsBalance });
  broadcastRoom(room);
}

async function joinRoom(socket, message) {
  const action = message.action;
  let accountUser = null;
  if (typeof message.idToken === 'string' && message.idToken) {
    accountUser = await verifyFirebaseToken(message.idToken);
  }

  let room;
  let newRoom = false;
  if (action === 'create' || action === 'tournament-create') {
    if (action === 'tournament-create' && !accountUser) return sendError(socket, 'Sign in to enter the Quick Cup.');
    const variant = message.variant === 'jjda' ? 'jjda' : 'standard';
    const requestedTarget = Number(message.winningScore);
    const winningScore = [200, 300, 500].includes(requestedTarget) ? requestedTarget : 500;
    room = {
      code: newRoomCode(),
      matchId: randomUUID(),
      variant,
      winningScore,
      tournament: action === 'tournament-create' ? { name: 'Quick Cup', entryFee: 100, prizePool: 400 } : null,
      chat: [],
      roundNilSuccesses: [],
      seats: [null, null, null, null],
      phase: 'lobby',
      game: null,
      message: 'Waiting for three more players.',
    };
    newRoom = true;
  } else if (action === 'join') {
    const code = typeof message.roomCode === 'string' ? message.roomCode.trim().toUpperCase() : '';
    room = rooms.get(code);
    if (!room) return sendError(socket, 'Room not found. Check the code and try again.');
  } else {
    return sendError(socket, 'Choose create or join to enter a room.');
  }

  const token = typeof message.token === 'string' ? message.token : '';
  let seatIndex = token ? room.seats.findIndex(seat => seat?.token === token) : -1;
  if (seatIndex < 0) seatIndex = room.seats.findIndex(seat => !seat || !seat.socket || seat.socket.readyState !== WebSocket.OPEN);
  if (seatIndex < 0) return sendError(socket, 'That room already has four connected players.');
  if (room.tournament && !accountUser) return sendError(socket, 'Sign in to enter the Quick Cup.');
  if (accountUser && room.seats.some((seat, index) => index !== seatIndex && seat?.userId === accountUser.uid)) {
    return sendError(socket, 'That account already has a seat in this room.');
  }

  const existingSeat = room.seats[seatIndex];
  const reconnecting = Boolean(existingSeat && token === existingSeat.token && (!accountUser || accountUser.uid === existingSeat.userId));
  let wallet = accountUser ? await getOrCreateWallet(accountUser.uid, accountUser.email || '') : null;
  if (room.tournament && !reconnecting) {
    try {
      wallet = await applyPoints(accountUser.uid, accountUser.email || '', `quickcup-entry-${room.matchId}-${accountUser.uid}`, -room.tournament.entryFee, 'Quick Cup entry');
    } catch (error) {
      return sendError(socket, error.message);
    }
  }

  if (newRoom) rooms.set(room.code, room);
  const name = safeName(message.name);
  const seatToken = token || randomUUID();
  assignSocket(socket, room, seatIndex, name, seatToken, accountUser, wallet);
}

function stateFor(room, seatIndex) {
  const game = room.game;
  const seat = room.seats[seatIndex];
  const canBlindNil = Boolean(game && room.phase === 'bidding' && !seat?.handRevealed && game.canPlaceBlindNil(seatIndex));
  const handHidden = canBlindNil;
  const ownHand = game && !handHidden ? game.players[seatIndex].hand : [];
  const legalIndices = game && room.phase === 'play' && game.currentPlayerIndex === seatIndex
    ? ownHand.reduce((indices, card, index) => game.isLegalPlay(seatIndex, card) ? [...indices, index] : indices, [])
    : [];
  return {
    type: 'state',
    roomCode: room.code,
    variant: room.variant,
    winningScore: room.winningScore,
    phase: room.phase,
    message: room.message,
    seatIndex,
    accountPoints: seat?.pointsBalance ?? null,
    tournament: room.tournament || null,
    chat: room.chat || [],
    roundNilSuccesses: room.roundNilSuccesses || [],
    lastReward: seat?.lastReward || null,
    canBlindNil,
    handHidden,
    players: room.seats.map((seat, index) => ({
      name: game?.players[index].name || seat?.name || 'Open seat',
      connected: Boolean(seat?.socket && seat.socket.readyState === WebSocket.OPEN),
      bid: game?.players[index].bid ?? null,
      blindNil: game?.players[index].blindNil || false,
      tricksWon: game?.players[index].tricksWon || 0,
    })),
    hand: ownHand,
    legalIndices,
    dealerIndex: game?.dealerIndex ?? null,
    leadPlayerIndex: game?.leadPlayerIndex ?? null,
    currentPlayerIndex: game?.currentPlayerIndex ?? null,
    currentTrick: game?.currentTrick || [],
    teamScores: game?.teamScores || [0, 0],
    teamBags: game?.teamBags || [0, 0],
    spadesBroken: game?.spadesBroken || false,
    roundNumber: game?.roundNumber || 0,
  };
}

function broadcastRoom(room) {
  room.seats.forEach((seat, seatIndex) => {
    if (seat?.socket) send(seat.socket, stateFor(room, seatIndex));
  });
}

async function handleAction(socket, message) {
  const assignment = assignedSeats.get(socket);
  if (!assignment) return sendError(socket, 'Join a room before taking an action.');
  const { room, seatIndex } = assignment;
  const game = room.game;

  if (message.action === 'chat') {
    const text = safeChatText(message.text);
    if (!text) return sendError(socket, 'Write a message before sending.');
    room.chat.push({ id: randomUUID(), name: room.seats[seatIndex].name, seatIndex, text, sentAt: Date.now() });
    room.chat = room.chat.slice(-30);
    broadcastRoom(room);
    return;
  }

  if (!game) return sendError(socket, 'Waiting for all four players to join.');

  if (message.action === 'bid') {
    if (room.phase !== 'bidding') return sendError(socket, 'Bidding is not open.');
    if (game.canPlaceBlindNil(seatIndex) && !room.seats[seatIndex].handRevealed) {
      return sendError(socket, 'Reveal your hand before placing a regular bid, or choose Blind Nil.');
    }
    game.placeBid(seatIndex, Number(message.amount));
    room.seats[seatIndex].handRevealed = true;
    if (game.allBidsPlaced()) {
      room.phase = 'play';
      room.message = `${game.players[game.currentPlayerIndex].name} leads.`;
    } else room.message = `${game.players[seatIndex].name} placed a bid.`;
  } else if (message.action === 'reveal-hand') {
    if (room.phase !== 'bidding') return sendError(socket, 'The hand can only be revealed during bidding.');
    if (!game.canPlaceBlindNil(seatIndex)) return sendError(socket, 'Blind Nil is not available for this seat.');
    if (room.seats[seatIndex].handRevealed) return sendError(socket, 'The hand is already revealed.');
    room.seats[seatIndex].handRevealed = true;
    room.message = `${game.players[seatIndex].name} revealed their hand to bid.`;
  } else if (message.action === 'blind-nil') {
    if (room.phase !== 'bidding') return sendError(socket, 'Blind Nil is only available during bidding.');
    if (room.seats[seatIndex].handRevealed) return sendError(socket, 'Blind Nil must be declared before revealing your hand.');
    game.placeBlindNil(seatIndex);
    room.seats[seatIndex].handRevealed = true;
    if (game.allBidsPlaced()) {
      room.phase = 'play';
      room.message = `${game.players[game.currentPlayerIndex].name} leads.`;
    } else room.message = `${game.players[seatIndex].name} bid Blind Nil.`;
  } else if (message.action === 'play') {
    if (room.phase !== 'play') return sendError(socket, 'Cards cannot be played right now.');
    const winner = game.playCard(seatIndex, Number(message.cardIndex));
    if (winner !== null) room.message = `${game.players[winner].name} takes the trick.`;
    if (game.isRoundOver()) {
      game.scoreRound();
      room.roundNilSuccesses = game.players.flatMap((player, index) => player.nilBid && player.tricksWon === 0
        ? [{ seatIndex: index, name: player.name, blind: player.blindNil, bonus: player.blindNil ? 150 : 100 }]
        : []);
      room.phase = game.isGameOver() ? 'game-over' : 'round-over';
      room.message = room.phase === 'game-over'
        ? `${game.players[game.getWinningTeam()].name}'s team wins the match.`
        : `Hand ${game.roundNumber} is complete.`;
      await awardCompletedHand(room);
    }
  } else if (message.action === 'next-hand') {
    if (room.phase !== 'round-over') return sendError(socket, 'The current hand is not complete.');
    room.roundNilSuccesses = [];
    room.seats.forEach(seat => { if (seat) seat.handRevealed = false; });
    game.startRound();
    room.phase = 'bidding';
    room.message = 'New hand dealt. Place your bids.';
  } else if (message.action === 'new-match') {
    if (room.phase !== 'game-over') return sendError(socket, 'The match is still in progress.');
    room.roundNilSuccesses = [];
    game.teamScores = [0, 0];
    game.teamBags = [0, 0];
    game.roundNumber = 0;
    room.matchId = randomUUID();
    room.seats.forEach(seat => { if (seat) seat.handRevealed = false; });
    room.phase = 'bidding';
    game.startRound();
    room.message = 'New match. Place your bids.';
  } else {
    return sendError(socket, 'Unknown game action.');
  }
  broadcastRoom(room);
}

webSockets.on('connection', socket => {
  socket.on('message', async rawMessage => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      sendError(socket, 'Invalid message format.');
      return;
    }
    try {
      if (message.type === 'join') await joinRoom(socket, message);
      else if (message.type === 'action') await handleAction(socket, message);
      else sendError(socket, 'Unknown message type.');
    } catch (error) {
      sendError(socket, error.message);
    }
  });
  socket.on('close', () => {
    const assignment = assignedSeats.get(socket);
    assignedSeats.delete(socket);
    if (!assignment) return;
    const seat = assignment.room.seats[assignment.seatIndex];
    if (seat?.socket === socket) seat.socket = null;
    broadcastRoom(assignment.room);
  });
});

server.listen(port, host, () => {
  console.log(`Spades app ready at http://localhost:${server.address().port}`);
});

module.exports = { server };
