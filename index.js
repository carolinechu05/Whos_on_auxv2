import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'fs';

// 1) SERVER-SIDE SETUP EXPRESS & SOCKET.IO
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);
app.use(express.static('public'));
app.use(express.json());

// Load music from JSON file
const music = JSON.parse(fs.readFileSync('music.json', 'utf8')).songs;

// lowdb setup
const defaultData = {
  totalVotes: 0,
  totalKeeps: 0,
  totalPasses: 0,
  playerStats: {},
  auxHistory: []
};

const adapter = new JSONFile('db.json');
const db      = new Low(adapter, defaultData);

await db.read();
db.data ||= defaultData;
await db.write();

// Helper functions for the new lowdb API
function getPlayerStats(id) {
  return db.data.playerStats[id];
}

function setPlayerStats(id, data) {
  db.data.playerStats[id] = data;
}

function updatePlayerStat(id, field, updater) {
  if (!db.data.playerStats[id]) return;
  db.data.playerStats[id][field] = updater(db.data.playerStats[id][field] || 0);
}

// Game state variables
const gameState = {
  room: 'main',
  voting: false,
  playing: false,
  rating: false,
  aux: null,
  players: {},
  currentSongs: [] // Track current song selection
};

const votes = new Map();
const voteCounts = new Map();

// Helper: select 5 random songs
function selectRandomSongs() {
  const shuffled = [...music].sort(() => Math.random() - 0.5);
  gameState.currentSongs = shuffled.slice(0, 5);
  // Broadcast new songs to all connected clients
  io.to(gameState.room).emit('init', { music: gameState.currentSongs });
}

// Initialize songs when server starts
selectRandomSongs();

// Helper: recompute vote counts
function recomputeCounts() {
  voteCounts.clear();
  for (const v of votes.values()) if (v) voteCounts.set(v, (voteCounts.get(v) || 0) + 1);
}

// Helper: broadcast full state
function broadcastState() {
  io.to(gameState.room).emit('state', {
    voting: gameState.voting,
    playing: gameState.playing,
    rating: gameState.rating,
    aux: gameState.aux,
    players: gameState.players,
    voteCounts: Object.fromEntries(voteCounts),
    votes: Object.fromEntries(votes)
  });
}

// Socket connection
io.on('connection', socket => {
  const id = socket.id;
  socket.join(gameState.room);
  
  socket.on('requestNewSongs', () => {
    if (gameState.aux?.id !== socket.id) return; // only AUX can trigger
    selectRandomSongs(); // this already emits 'init' with 5 new songs
    io.to(gameState.room).emit('newSongs', { songs: gameState.currentSongs });
  });

  // ── Join with name ──────────────────────────────────────────────
  socket.on('join', async name => {
    name = name.trim().slice(0, 15) || 'Guest';
    gameState.players[id] = { id, name, voted: false };

    // Ensure player entry in DB
    const stats = getPlayerStats(id);
    if (!stats) {
      setPlayerStats(id, {
        name,
        votesReceived: 0,
        timesAux: 0,
        keeps: 0,
        passes: 0
      });
    } else {
      db.data.playerStats[id].name = name;
    }
    await db.write();

    // Send current song selection to new player
    socket.emit('init', { music: gameState.currentSongs });
    broadcastState();
  });

  // ---- CURSOR ----
  socket.on('cursor', pos => {
    if (!gameState.players[id]) return;
    socket.broadcast.emit('cursor', { id, name: gameState.players[id].name, ...pos });
  });

  // START VOTING
  socket.on('startVoting', () => {
    if (gameState.voting || gameState.playing || gameState.rating) return;

    gameState.voting = true;
    votes.clear(); voteCounts.clear();
    for (const p of Object.values(gameState.players)) p.voted = false;

    broadcastState();
    io.to(gameState.room).emit('countdown', { phase: 'voting', seconds: 30 });
    setTimeout(endVoting, 30_000);
  });

  // ---- VOTE ----
  socket.on('vote', async targetId => {
    if (!gameState.voting || gameState.players[id]?.voted) return;
    if (!gameState.players[targetId]) return;

    votes.set(id, targetId);
    gameState.players[id].voted = true;
    recomputeCounts();

    // Persist
    db.data.totalVotes++;
    updatePlayerStat(targetId, 'votesReceived', n => n + 1);
    await db.write();

    broadcastState();
  });

  // ---- PLAY SONG ----
  socket.on('play', song => {
    if (gameState.aux?.id !== id) return;
    io.to(gameState.room).emit('now', { song, timestamp: Date.now() });
  });

  // ---- SHUFFLE SONGS (NEW) ----
  socket.on('shuffle', shuffledSongs => {
    if (gameState.aux?.id !== id) return;
    // Update server's current songs to match what aux shuffled
    gameState.currentSongs = shuffledSongs;
    // Broadcast to all other clients
    socket.broadcast.emit('shuffle', shuffledSongs);
  });

  // Aux-only controls (pause, resume, seek, volume, effect)
  ['pause', 'resume', 'seek', 'volume', 'effect'].forEach(ev => {
    socket.on(ev, data => {
      if (gameState.aux?.id !== id) return;
      if (ev === 'resume') data = { timestamp: Date.now() };
      socket.broadcast.emit(ev, data);
    });
  });

  // RATING
  socket.on('rate', async decision => {
    if (!gameState.rating || gameState.players[id]?.rated || gameState.aux?.id === id) return;

    gameState.players[id].rated = true;
    gameState.players[id].keep  = decision === 'keep';

    if (decision === 'keep') {
      db.data.totalKeeps++;
      updatePlayerStat(gameState.aux.id, 'keeps', n => n + 1);
    } else {
      db.data.totalPasses++;
      updatePlayerStat(gameState.aux.id, 'passes', n => n + 1);
    }
    await db.write();

    broadcastState();
  });

  // REMOVE RATING (NEW)
  socket.on('removeRating', async () => {
    if (!gameState.rating || !gameState.players[id]?.rated || gameState.aux?.id === id) return;

    const wasKeep = gameState.players[id].keep;
    
    // Revert the stats
    if (wasKeep) {
      db.data.totalKeeps = Math.max(0, db.data.totalKeeps - 1);
      updatePlayerStat(gameState.aux.id, 'keeps', n => Math.max(0, n - 1));
    } else {
      db.data.totalPasses = Math.max(0, db.data.totalPasses - 1);
      updatePlayerStat(gameState.aux.id, 'passes', n => Math.max(0, n - 1));
    }
    await db.write();

    // Clear rating
    gameState.players[id].rated = false;
    gameState.players[id].keep = null;

    broadcastState();
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    delete gameState.players[id];
    votes.delete(id);
    recomputeCounts();
    broadcastState();
  });
});

// End voting - pick aux
async function endVoting() {
  gameState.voting = false;

  const counts = Object.fromEntries(voteCounts);
  const max = Math.max(...Object.values(counts), 0);
  const winners = Object.keys(counts).filter(k => counts[k] === max);

  let chosenId = null;

  if (winners.length === 1) {
    chosenId = winners[0];
  } else if (winners.length > 1) {
    chosenId = winners[Math.floor(Math.random() * winners.length)];
    io.to(gameState.room).emit('result', 'tieElection');
  } else {
    const ids = Object.keys(gameState.players);
    if (ids.length) chosenId = ids[Math.floor(Math.random() * ids.length)];
  }

  if (chosenId) {
    const p = gameState.players[chosenId];
    gameState.aux = { id: chosenId, name: p.name };

    updatePlayerStat(chosenId, 'timesAux', n => n + 1);
    db.data.auxHistory.push({ auxId: chosenId, auxName: p.name, timestamp: Date.now() });
    await db.write();

    gameState.playing = true;
    broadcastState();
    // 4 MINUTES = 240 seconds (YOUR PARTNER'S CHANGE - ALREADY IMPLEMENTED)
    io.to(gameState.room).emit('countdown', { phase: 'playing', seconds: 240 });
    setTimeout(startRating, 240_000);
  } else {
    resetGame();
  }
}

function startRating() {
  gameState.playing = false;
  gameState.rating = true;

  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    p.rated = (pid === gameState.aux?.id);
    if (!p.rated) p.keep = null;
  }
  broadcastState();
  io.to(gameState.room).emit('countdown', { phase: 'rating', seconds: 30 });
  setTimeout(decideResult, 30_000);
}

function decideResult() {
  const keeps = Object.values(gameState.players).filter(p => p.keep === true).length;
  const passes = Object.values(gameState.players).filter(p => p.keep === false).length;
  let result = 'draw';

  if (keeps + passes > 0) {
    result = keeps > passes ? 'keep' : passes > keeps ? 'pass' : 'draw';
  }

  io.to(gameState.room).emit('result', result);

  setTimeout(() => {
    if (result === 'keep' || result === 'draw') {
      startPlayingAgain();
    } else {
      startNewVoting();
    }
  }, 2000);
}

function startPlayingAgain() {
  gameState.rating = false;
  gameState.playing = true;
  broadcastState();
  // 4 MINUTES = 240 seconds (YOUR PARTNER'S CHANGE - ALREADY IMPLEMENTED)
  io.to(gameState.room).emit('countdown', { phase: 'playing', seconds: 240 });
  setTimeout(startRating, 240_000);
}

function startNewVoting() {
  gameState.rating = false;
  gameState.voting = true;
  gameState.aux = null;
  votes.clear(); voteCounts.clear();
  for (const p of Object.values(gameState.players)) p.voted = false;
  
  // Refresh song selection for new round
  selectRandomSongs();
  
  broadcastState();
  io.to(gameState.room).emit('countdown', { phase: 'voting', seconds: 30 });
  setTimeout(endVoting, 30_000);
}

function resetGame() {
  gameState.voting = false;
  gameState.playing = false;
  gameState.rating = false;
  gameState.aux = null;
  votes.clear(); voteCounts.clear();
  for (const p of Object.values(gameState.players)) {
    p.voted = false; p.rated = false; p.keep = null;
  }
  broadcastState();
}

// ---------- SERVER ----------
const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
  console.log('Database: db.json (persisted stats)');
});