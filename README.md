# 🗼 Tokyo Cam Bingo

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-orange)
![Prisma](https://img.shields.io/badge/Prisma-ORM-purple)
![Render](https://img.shields.io/badge/Deployed%20on-Render.com-lightgrey)

**A real-time multiplayer bingo game set in Tokyo — spot live events on webcams, claim squares, and compete with friends!**

Players host or join rooms, mark off squares as they see things like “man with umbrella” or “cosplayer spotted,” and race to bingo victory.
Built with **Node.js**, **Express**, **Socket.IO**, and **Prisma**, with a lightweight EJS interface and real-time game logic.

---

## 🎮 Features

* **Multiplayer Modes**

  * **Regular Mode:** up to 10 players, each with a unique 5×5 card
  * **VS Mode:** up to 4 players share one card and claim colored squares
* **Custom Cards:** create your own decks via the built-in Card Builder
* **Flags 🚩 & Voting:** challenge suspicious claims, vote to approve or remove
* **Rerolls 🎲:** refresh tiles, rows, columns, diagonals, or full cards
* **Timers ⏱️:** countdown games with “Most Squares” automatic evaluation
* **Chat 💬:** live in-room chat synced through Socket.IO
* **Streamer Mode 📺:** clean overlay for Twitch or YouTube broadcasts

---

## ⚙️ Tech Stack

| Layer               | Technology                                     | Purpose                               |
| ------------------- | ---------------------------------------------- | ------------------------------------- |
| **Runtime**         | Node.js 18+                                    | Server execution                      |
| **Framework**       | Express 5.x                                    | Routing, middleware, templating       |
| **Realtime Engine** | Socket.IO 4.x                                  | Multiplayer events and live updates   |
| **ORM**             | Prisma 6.x                                     | Database access and schema management |
| **Database**        | PostgreSQL                                     | Persistent game and player data       |
| **Sessions**        | express-session + @quixo3/prisma-session-store | Persistent session handling           |
| **Templating**      | EJS 3.x                                        | Server-rendered UI                    |
| **Chat / Twitch**   | tmi.js 1.x                                     | Optional Twitch integration           |
| **Hosting**         | Render.com                                     | Live deployment (web + DB)            |
| **Env Config**      | dotenv 17.x                                    | Environment variable management       |

---

## 🧹 Architecture

```mermaid
flowchart TD
  subgraph Client["🌐 Browser Client"]
    UI["EJS Views (home, game, card-builder)"]
    SocketClient["Socket.IO Client"]
    JS["Vanilla JS / PWA Assets"]
  end

  subgraph Server["🖥️ Node / Express Server"]
    Express["Express 5.x Routing"]
    Prisma["Prisma ORM"]
    SocketIO["Socket.IO 4.x"]
    GameLogic["Game Logic (cards, timers, flags, votes)"]
    Session["express-session + PrismaSessionStore"]
  end

  subgraph DB["💄 Database (PostgreSQL)"]
    GameTable["Game Model"]
    PlayerTable["Player Model"]
    ItemCollection["ItemCollection Model"]
    ChatMessage["ChatMessage Model"]
  end

  Client <--> |HTTP (EJS views)| Express
  Client <--> |WebSocket Events| SocketIO
  Express --> Session
  Express --> Prisma
  Prisma --> DB
  SocketIO <--> GameLogic
  GameLogic <--> Prisma
```

---

## 💃️ Prisma Data Models

```prisma
model Game {
  id                    Int @id @default(autoincrement())
  code                  String @unique
  mode                  String
  sharedCard            Json?
  customItems           Json?
  rules                 Json
  status                String
  winner                String?
  timerEnabled          Boolean
  timerDuration         Int?
  timerStartedAt        DateTime?
  timerPausedAt         DateTime?
  timerAccumulatedPause Int?
  players               Player[]
  chatMessages          ChatMessage[]
}

model Player {
  id             Int @id @default(autoincrement())
  name           String
  color          String?
  isHost         Boolean
  card           Json?
  stampedSquares Json?
  gameId         Int
  game           Game @relation(fields: [gameId], references: [id])
}

model ItemCollection {
  id    Int @id @default(autoincrement())
  code  String @unique
  name  String
  items Json
}

model ChatMessage {
  id        Int @id @default(autoincrement())
  gameId    Int
  playerId  Int
  content   String
  createdAt DateTime @default(now())
  game      Game    @relation(fields: [gameId], references: [id])
  player    Player  @relation(fields: [playerId], references: [id])
}
```

---

## 🧑‍💻 Developer Setup

### 🛠️ Requirements

* Node.js 18+
* Yarn (recommended) or npm
* PostgreSQL (local or hosted — Neon / Supabase / Render DB)

---

### ⚙️ 1. Clone the Repository

```bash
git clone URL
cd tokyo-cam-bingo
```

### 🔐 2. Configure Environment

Create a `.env` file:

```bash
touch .env
```

Add:

```env
SESSION_SECRET="replace_with_random_string"
PORT=3000
DATABASE_URL=""
ENABLE_SERVICE_WORKER=true
APP_BUILD_VERSION=1.0.0
```

---

### 💃️ 3. Initialize Database

```bash
yarn install
yarn prisma generate
yarn prisma migrate dev --name init
```

(Optional) inspect DB with:

```bash
yarn prisma studio
```

---

### ▶️ 4. Run Locally

```bash
yarn start
```

Open [http://localhost:3000](http://localhost:3000)

---

### 🧩 5. Test Multiplayer

* Tab 1 → Host Game
* Tab 2+ → Join using 6-letter code

All changes sync instantly via Socket.IO rooms.

---

### 🚀 6. Deploy on Render

1. Push repo to GitHub
2. Create a **Web Service** on [Render](https://render.com)
3. Set environment variables (`SESSION_SECRET`, `DATABASE_URL`, etc.)
4. Render automatically builds and runs `node server.js`

Live demo:
🔗 [https://tokyo-cam-bingo.onrender.com](https://tokyo-cam-bingo.onrender.com)


### 🐞 Reporting Bugs / Suggesting Features

Open an [Issue](https://github.com/brandon-lindberg/tokyo-cam-bingo/issues) with:

* Title (`Bug: Timer not pausing`)
* Steps to reproduce
* Screenshots or console output (if relevant)

---

### 💡 Ideas for Future Features

* 🎨 Dark mode toggle
* 🟙️ Live Tokyo webcam thumbnails
* 🔊 Sound effects for stamps and wins
* 🎥 Twitch/YouTube streaming integration
* 🧩 Regional themed decks (Shibuya / Akihabara / Kyoto)

---

### 📜 Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/).
Please be respectful and collaborative in discussions and pull requests.

---

### 🏁 Maintainer

**Yabai Studios**
GitHub: [@brandon-lindberg](https://github.com/brandon-lindberg)

---

### 🔄 License

MIT © Brandon Lindberg
