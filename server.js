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

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
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

function newRoomCode() {
  let code;
  do code = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  while (rooms.has(code));
  return code;
}

function assignSocket(socket, room, seatIndex, name, token) {
  const seat = room.seats[seatIndex];
  if (seat?.socket && seat.socket !== socket) {
    assignedSeats.delete(seat.socket);
    seat.socket.close(4001, 'Seat reconnected');
  }
  room.seats[seatIndex] = { name, token, socket };
  assignedSeats.set(socket, { room, seatIndex });
  if (!room.game && room.seats.every(Boolean)) {
    room.game = new SpadesGame(room.seats.map(player => player.name), 500, room.variant);
    room.game.startRound();
    room.phase = 'bidding';
    room.message = 'Four players are seated. Place your bids.';
  }
  send(socket, { type: 'joined', roomCode: room.code, seatIndex, token, variant: room.variant });
  broadcastRoom(room);
}

function joinRoom(socket, message) {
  const action = message.action;
  let room;
  if (action === 'create') {
    const variant = message.variant === 'jjda' ? 'jjda' : 'standard';
    room = { code: newRoomCode(), variant, seats: [null, null, null, null], phase: 'lobby', game: null, message: 'Waiting for three more players.' };
    rooms.set(room.code, room);
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

  const name = safeName(message.name);
  const seatToken = token || randomUUID();
  assignSocket(socket, room, seatIndex, name, seatToken);
}

function stateFor(room, seatIndex) {
  const game = room.game;
  const ownHand = game ? game.players[seatIndex].hand : [];
  const legalIndices = game && room.phase === 'play' && game.currentPlayerIndex === seatIndex
    ? ownHand.reduce((indices, card, index) => game.isLegalPlay(seatIndex, card) ? [...indices, index] : indices, [])
    : [];
  return {
    type: 'state',
    roomCode: room.code,
    variant: room.variant,
    phase: room.phase,
    message: room.message,
    seatIndex,
    players: room.seats.map((seat, index) => ({
      name: game?.players[index].name || seat?.name || 'Open seat',
      connected: Boolean(seat?.socket && seat.socket.readyState === WebSocket.OPEN),
      bid: game?.players[index].bid ?? null,
      tricksWon: game?.players[index].tricksWon || 0,
    })),
    hand: ownHand,
    legalIndices,
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

function handleAction(socket, message) {
  const assignment = assignedSeats.get(socket);
  if (!assignment) return sendError(socket, 'Join a room before taking an action.');
  const { room, seatIndex } = assignment;
  const game = room.game;
  if (!game) return sendError(socket, 'Waiting for all four players to join.');

  if (message.action === 'bid') {
    if (room.phase !== 'bidding') return sendError(socket, 'Bidding is not open.');
    game.placeBid(seatIndex, Number(message.amount));
    if (game.allBidsPlaced()) {
      room.phase = 'play';
      room.message = `${game.players[game.currentPlayerIndex].name} leads.`;
    } else room.message = `${game.players[seatIndex].name} placed a bid.`;
  } else if (message.action === 'play') {
    if (room.phase !== 'play') return sendError(socket, 'Cards cannot be played right now.');
    const winner = game.playCard(seatIndex, Number(message.cardIndex));
    if (winner !== null) room.message = `${game.players[winner].name} takes the trick.`;
    if (game.isRoundOver()) {
      game.scoreRound();
      room.phase = game.isGameOver() ? 'game-over' : 'round-over';
      room.message = room.phase === 'game-over'
        ? `${game.players[game.getWinningTeam()].name}'s team wins the match.`
        : `Hand ${game.roundNumber} is complete.`;
    }
  } else if (message.action === 'next-hand') {
    if (room.phase !== 'round-over') return sendError(socket, 'The current hand is not complete.');
    game.startRound();
    room.phase = 'bidding';
    room.message = 'New hand dealt. Place your bids.';
  } else if (message.action === 'new-match') {
    if (room.phase !== 'game-over') return sendError(socket, 'The match is still in progress.');
    game.teamScores = [0, 0];
    game.teamBags = [0, 0];
    game.roundNumber = 0;
    room.phase = 'bidding';
    game.startRound();
    room.message = 'New match. Place your bids.';
  } else {
    return sendError(socket, 'Unknown game action.');
  }
  broadcastRoom(room);
}

webSockets.on('connection', socket => {
  socket.on('message', rawMessage => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      sendError(socket, 'Invalid message format.');
      return;
    }
    try {
      if (message.type === 'join') joinRoom(socket, message);
      else if (message.type === 'action') handleAction(socket, message);
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
