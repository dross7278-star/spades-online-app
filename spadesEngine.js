(function (root, factory) {
  const engine = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = engine;
  else root.SpadesEngine = engine;
})(typeof globalThis === 'undefined' ? this : globalThis, function (root) {
  'use strict';
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  function randomIndex(max) {
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      const range = 0x100000000;
      const limit = range - (range % max);
      const sample = new Uint32Array(1);
      do root.crypto.getRandomValues(sample); while (sample[0] >= limit);
      return sample[0] % max;
    }
    if (typeof module === 'object' && module.require) return module.require('node:crypto').randomInt(max);
    throw new Error('A secure random number generator is not available');
  }

  function createDeck(variant = 'standard') {
    if (variant !== 'standard' && variant !== 'jjda') throw new Error('Unknown Spades rules variant');
    const deck = SUITS.flatMap(suit => RANKS.map((rank, value) => ({ suit, rank, value })));
    if (variant === 'standard') return deck;

    const jokerDeck = deck.filter(card => !(card.rank === '2' && (card.suit === '♣' || card.suit === '♦')));
    jokerDeck.find(card => card.suit === '♠' && card.rank === '2').value = 13;
    jokerDeck.push(
      { suit: '♠', rank: 'LJ', value: 14, isJoker: true, name: 'Little Joker' },
      { suit: '♠', rank: 'BJ', value: 15, isJoker: true, name: 'Big Joker' },
    );
    return jokerDeck;
  }
  function shuffle(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  function dealHands(variant = 'standard') {
    const hands = [[], [], [], []];
    shuffle(createDeck(variant)).forEach((card, index) => hands[index % 4].push(card));
    return hands;
  }

  class SpadesGame {
    constructor(playerNames, winningScore = 500, variant = 'standard') {
      if (!Array.isArray(playerNames) || playerNames.length !== 4) throw new Error('Spades requires exactly 4 players');
      if (variant !== 'standard' && variant !== 'jjda') throw new Error('Unknown Spades rules variant');
      this.players = playerNames.map(name => ({ name, hand: [], tricksWon: 0, bid: null, nilBid: false }));
      this.winningScore = winningScore;
      this.variant = variant;
      this.teamScores = [0, 0];
      this.teamBags = [0, 0];
      this.spadesBroken = false;
      this.currentTrick = [];
      this.dealerIndex = 2;
      this.leadPlayerIndex = 0;
      this.currentPlayerIndex = 0;
      this.roundNumber = 0;
      this.roundScored = false;
    }
    startRound() {
      this.roundNumber++;
      this.dealerIndex = (this.dealerIndex + 1) % 4;
      const hands = dealHands(this.variant);
      this.players.forEach((player, index) => {
        player.hand = hands[index]; player.tricksWon = 0; player.bid = null; player.nilBid = false;
      });
      this.spadesBroken = false;
      this.currentTrick = [];
      this.leadPlayerIndex = (this.dealerIndex + 1) % 4;
      this.currentPlayerIndex = this.leadPlayerIndex;
      this.roundScored = false;
    }
    placeBid(playerIndex, bidAmount) {
      const player = this.players[playerIndex];
      if (!player) throw new Error('Invalid player');
      if (!Number.isInteger(bidAmount) || bidAmount < 0 || bidAmount > 13) throw new Error('A bid must be a whole number from 0 to 13');
      if (player.bid !== null) throw new Error(`${player.name} has already bid`);
      player.bid = bidAmount;
      player.nilBid = bidAmount === 0;
    }
    allBidsPlaced() { return this.players.every(player => player.bid !== null); }
    playCard(playerIndex, cardIndex) {
      const player = this.players[playerIndex];
      if (!player) throw new Error('Invalid player');
      if (playerIndex !== this.currentPlayerIndex) throw new Error('It is not this player\'s turn');
      const card = player.hand[cardIndex];
      if (!card) throw new Error('Invalid card index');
      if (!this.isLegalPlay(playerIndex, card)) throw new Error(`Illegal play: ${card.rank}${card.suit}`);
      player.hand.splice(cardIndex, 1);
      this.currentTrick.push({ playerIndex, card });
      if (card.suit === '♠') this.spadesBroken = true;
      if (this.currentTrick.length === 4) return this.resolveTrick();
      this.currentPlayerIndex = (playerIndex + 1) % 4;
      return null;
    }
    isLegalPlay(playerIndex, card) {
      const player = this.players[playerIndex];
      if (!player || !card) return false;
      const leadSuit = this.currentTrick[0]?.card.suit;
      if (!leadSuit) {
        if (card.suit === '♠' && !this.spadesBroken) return player.hand.every(heldCard => heldCard.suit === '♠');
        return true;
      }
      const hasLeadSuit = player.hand.some(heldCard => heldCard.suit === leadSuit);
      return !hasLeadSuit || card.suit === leadSuit;
    }
    resolveTrick() {
      const leadSuit = this.currentTrick[0].card.suit;
      let winningPlay = this.currentTrick[0];
      for (const play of this.currentTrick) {
        const trump = play.card.suit === '♠';
        const winningTrump = winningPlay.card.suit === '♠';
        if (trump && !winningTrump) winningPlay = play;
        else if (trump && winningTrump && play.card.value > winningPlay.card.value) winningPlay = play;
        else if (!trump && !winningTrump && play.card.suit === leadSuit && play.card.value > winningPlay.card.value) winningPlay = play;
      }
      this.players[winningPlay.playerIndex].tricksWon++;
      this.leadPlayerIndex = winningPlay.playerIndex;
      this.currentPlayerIndex = winningPlay.playerIndex;
      this.currentTrick = [];
      return winningPlay.playerIndex;
    }
    isRoundOver() { return this.players.every(player => player.hand.length === 0); }
    scoreRound() {
      if (!this.isRoundOver()) throw new Error('The round is not over');
      if (!this.allBidsPlaced()) throw new Error('All players must bid before scoring');
      if (this.roundScored) throw new Error('This round has already been scored');
      for (let team = 0; team < 2; team++) {
        const players = [this.players[team], this.players[team + 2]];
        const bid = players.reduce((total, player) => total + (player.nilBid ? 0 : player.bid), 0);
        const tricks = players.reduce((total, player) => total + player.tricksWon, 0);
        let score = 0;
        if (tricks >= bid) {
          score += bid * 10;
          const bags = tricks - bid;
          score += bags;
          this.teamBags[team] += bags;
        } else score -= bid * 10;
        players.forEach(player => { if (player.nilBid) score += player.tricksWon === 0 ? 100 : -100; });
        while (this.teamBags[team] >= 10) { score -= 100; this.teamBags[team] -= 10; }
        this.teamScores[team] += score;
      }
      this.roundScored = true;
    }
    isGameOver() { return Math.max(...this.teamScores) >= this.winningScore; }
    getWinningTeam() {
      if (this.teamScores[0] === this.teamScores[1]) return null;
      return this.teamScores[0] > this.teamScores[1] ? 0 : 1;
    }
  }
  return { SpadesGame, createDeck, shuffle, dealHands, SUITS, RANKS };
});
