const assert = require('node:assert/strict');
const { SpadesGame, createDeck, dealHands, shuffle } = require('./spadesEngine');

const cardKey = card => `${card.rank}:${card.suit}`;
const standardDeck = createDeck();
assert.equal(standardDeck.length, 52);
assert.equal(new Set(standardDeck.map(cardKey)).size, 52);

const dealtHands = dealHands();
assert(dealtHands.every(hand => hand.length === 13));
assert.equal(new Set(dealtHands.flat().map(cardKey)).size, 52);

for (const target of [200, 300, 500]) {
	const targetGame = new SpadesGame(['Alice', 'Bob', 'Carol', 'Dave'], target);
	assert.equal(targetGame.winningScore, target);
	targetGame.teamScores[0] = target;
	assert.equal(targetGame.isGameOver(), true);
}
assert.throws(() => new SpadesGame(['Alice', 'Bob', 'Carol', 'Dave'], 250), /Winning score/);

function createBlindNilTestGame(scoreGap) {
	const blindGame = new SpadesGame(['You', 'West', 'Partner', 'East']);
	blindGame.teamScores = [0, scoreGap];
	blindGame.startRound();
	return blindGame;
}

const blindNilSuccess = createBlindNilTestGame(100);
assert.equal(blindNilSuccess.canPlaceBlindNil(0), true);
blindNilSuccess.placeBlindNil(0);
assert.equal(blindNilSuccess.players[0].blindNil, true);
assert.equal(blindNilSuccess.canPlaceBlindNil(2), false, 'only one teammate can bid Blind Nil');
blindNilSuccess.placeBid(1, 1);
blindNilSuccess.placeBid(2, 1);
blindNilSuccess.placeBid(3, 1);
blindNilSuccess.players.forEach(player => { player.hand = []; });
blindNilSuccess.players[2].tricksWon = 1;
blindNilSuccess.scoreRound();
assert.equal(blindNilSuccess.teamScores[0], 160, 'one contract point plus 150 successful Blind Nil points');

const blindNilFailure = createBlindNilTestGame(100);
blindNilFailure.placeBlindNil(0);
blindNilFailure.placeBid(1, 1);
blindNilFailure.placeBid(2, 1);
blindNilFailure.placeBid(3, 1);
blindNilFailure.players.forEach(player => { player.hand = []; });
blindNilFailure.players[0].tricksWon = 1;
blindNilFailure.scoreRound();
assert.equal(blindNilFailure.teamScores[0], -90, 'one contract point less the 100-point failed Blind Nil penalty');
assert.equal(createBlindNilTestGame(99).canPlaceBlindNil(0), false);

const rotationGame = new SpadesGame(['Alice', 'Bob', 'Carol', 'Dave']);
const dealerRotation = [];
const leaderRotation = [];
for (let hand = 0; hand < 5; hand++) {
	rotationGame.startRound();
	dealerRotation.push(rotationGame.dealerIndex);
	leaderRotation.push(rotationGame.leadPlayerIndex);
}
assert.deepEqual(dealerRotation, [3, 0, 1, 2, 3]);
assert.deepEqual(leaderRotation, [0, 1, 2, 3, 0]);

const originalMathRandom = Math.random;
Math.random = () => { throw new Error('Shuffle must not use Math.random'); };
try {
	assert.equal(shuffle(standardDeck).length, 52);
} finally {
	Math.random = originalMathRandom;
}

const jjdaDeck = createDeck('jjda');
assert.equal(jjdaDeck.length, 52);
assert.equal(new Set(jjdaDeck.map(cardKey)).size, 52);
assert.equal(jjdaDeck.filter(card => card.isJoker).length, 2);
assert(!jjdaDeck.some(card => card.rank === '2' && (card.suit === '♣' || card.suit === '♦')));
assert.equal(jjdaDeck.find(card => card.rank === '2' && card.suit === '♠').value, 13);
assert.equal(jjdaDeck.find(card => card.rank === 'LJ').value, 14);
assert.equal(jjdaDeck.find(card => card.rank === 'BJ').value, 15);

const game = new SpadesGame(['Alice', 'Bob', 'Carol', 'Dave'], 500, 'jjda');
game.currentTrick = [
	{ playerIndex: 0, card: { suit: '♥', rank: 'A', value: 12 } },
	{ playerIndex: 1, card: { suit: '♠', rank: '2', value: 13 } },
	{ playerIndex: 2, card: { suit: '♠', rank: 'LJ', value: 14 } },
	{ playerIndex: 3, card: { suit: '♠', rank: 'BJ', value: 15 } },
];
assert.equal(game.resolveTrick(), 3, 'Big Joker beats Little Joker and 2 of spades');

console.log('Passed: secure shuffle path, 52-card standard/JJDA packs, 13-card hands, and JJDA trump order.');
