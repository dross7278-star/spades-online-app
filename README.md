# Spades Online App

A browser-playable partnership Spades game against three computer opponents. Deals use a cryptographic shuffle. Choose Standard Spades or JJDA (Big Joker, Little Joker, 2♠, A♠) and save names for all four seats in the table settings. The rules engine is also available to Node.js tests through `spadesEngine.js`.

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

The installer and portable `.exe` are written to `release/`.