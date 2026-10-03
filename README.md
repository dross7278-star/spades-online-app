# Spades Online App

A browser-playable partnership Spades game against three computer opponents. Deals use a cryptographic shuffle. Choose Standard Spades or JJDA (Big Joker, Little Joker, 2♠, A♠) and save names for all four seats in the table settings. The rules engine is also available to Node.js tests through `spadesEngine.js`.

Blind Nil is available once per partnership per hand when that team is at least 100 points behind. The bidder commits before seeing their hand: taking no tricks scores +150; taking any trick scores -100.

## Run locally

Start the local server from this folder with Node.js:

```sh
node server.js
```

Then open <http://localhost:8000>.

## Download for Windows

On a Windows x64 machine with Node.js installed, run:

```sh
npm install
npm run build:win
```

The installer and portable `.exe` are written to `release-target/`.

## Firebase accounts and rewards

Accounts and cross-device points require a Firebase project. In Firebase Console:

1. Create a project, add a Web app, and copy its Web API key.
2. Enable **Authentication → Email/Password**.
3. Create a **Firestore Database**.
4. Create a service-account key under **Project settings → Service accounts**.

Copy `.env.example` to `.env`, then set `FIREBASE_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` to the Web API key and the full service-account JSON. Keep `.env` private; it is ignored by Git. Start the app with `npm start`. Configure the same variables in your hosting provider for online accounts and rewards.

Online rewards are recorded in Firestore with one ledger event per achievement: +10 per completed hand, +25 for successful Nil, +50 for successful Blind Nil, and +100 for a match win. The Quick Cup charges 100 points per entry and awards 200 to each winning partner.