import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import { Database } from 'quickmongo';

// 1) SERVER-SIDE SETUP EXPRESS & SOCKET.IO
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);
app.use(express.static('public'));
app.use(express.json());

// QuickMongo setup
const db = new Database(process.env.MONGODB_URI || "mongodb+srv://auxwheel_user:connectionlabfinalproject@cluster0.vfgcm2z.mongodb.net/?appName=Cluster0");

// Load music from JSON file
const music = JSON.parse(fs.readFileSync('music.json', 'utf8')).songs;

// Helper functions for MongoDB
async function getPlayerStats(id) {
  const stats = await db.get(`playerStats.${id}`);
  return stats;
}

async function setPlayerStats(id, data) {
  await db.set(`playerStats.${id}`, data);
}

async function updatePlayerStat(id, field, value) {
  const currentValue = await db.get(`playerStats.${id}.${field}`) || 0;
  await db.set(`playerStats.${id}.${field}`, value(currentValue));
}

async function incrementTotal(field) {
  const current = await db.get(field) || 0;
  await db.set(field, current + 1);
}

async function decrementTotal(field) {
  const current = await db.get(field) || 0;
  await db.set(field, Math.max(0, current - 1));
}

async function pushAuxHistory(data) {
  await db.push('auxHistory', data);
}

// Game state variables
const gameState = {
  room: 'main',
  voting: false,
  playing: false,
  rating: false,
  aux: null,
  players: {},
  currentSongs: [],
  countdownEnd: null,  // Track when countdown ends
  currentPhase: null   // Track current phase
};

const votes = new Map();
const voteCounts = new Map();

// Helper: select 5 random songs
function selectRandomSongs() {
  const shuffled = [...music].sort(() => Math.random() - 0.5);
  gameState.currentSongs = shuffled.slice(0, 5);
  io.to(gameState.room).emit('init', { music: gameState.currentSongs });
}

// Helper: recompute vote counts
function recomputeCounts() {
  voteCounts.clear();
  for (const v of votes.values()) if (v) voteCounts.set(v, (voteCounts.get(v) || 0) + 1);
}

// Helper: broadcast full state
// Helper: broadcast full state
function broadcastState() {
  const stateData = {
    voting: gameState.voting,
    playing: gameState.playing,
    rating: gameState.rating,
    aux: gameState.aux,
    players: gameState.players,
    voteCounts: Object.fromEntries(voteCounts),
    votes: Object.fromEntries(votes)
  };
  
  // Add countdown info if active
  if (gameState.countdownEnd) {
    const remaining = Math.max(0, Math.ceil((gameState.countdownEnd - Date.now()) / 1000));
    stateData.countdown = {
      phase: gameState.currentPhase,
      secondsRemaining: remaining
    };
  }
  
  io.to(gameState.room).emit('state', stateData);
}

// Connect to database and start server
db.on("ready", () => {
  console.log("✅ Connected to MongoDB");
  
  // Initialize songs when database is ready
  selectRandomSongs();
  
  // Start server
  const PORT = 3000;
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log('📊 Database: MongoDB (persisted stats)');
  });
});

db.connect();

// Socket connection
io.on('connection', socket => {
  const id = socket.id;
  socket.join(gameState.room);
  
  socket.on('requestNewSongs', () => {
    if (gameState.aux?.id !== socket.id) return;
    selectRandomSongs();
    io.to(gameState.room).emit('newSongs', { songs: gameState.currentSongs });
  });

  // ── Join with name ──
  socket.on('join', async name => {
    name = name.trim().slice(0, 15) || 'Guest';
    gameState.players[id] = { id, name, voted: false };

    // Ensure player entry in DB
    const stats = await getPlayerStats(id);
    if (!stats) {
      await setPlayerStats(id, {
        name,
        votesReceived: 0,
        timesAux: 0,
        keeps: 0,
        passes: 0
      });
    } else {
      await db.set(`playerStats.${id}.name`, name);
    }

    socket.emit('init', { music: gameState.currentSongs });
    broadcastState();
  });

  // ── CURSOR ──
  socket.on('cursor', pos => {
    if (!gameState.players[id]) return;
    socket.broadcast.emit('cursor', { id, name: gameState.players[id].name, ...pos });
  });

  // START VOTING
  // START VOTING
  socket.on('startVoting', () => {
    if (gameState.voting || gameState.playing || gameState.rating) return;

    gameState.voting = true;
    gameState.currentPhase = 'voting';
    gameState.countdownEnd = Date.now() + 30000;
    
    votes.clear(); 
    voteCounts.clear();
    for (const p of Object.values(gameState.players)) p.voted = false;

    broadcastState();
    io.to(gameState.room).emit('countdown', { phase: 'voting', seconds: 30 });
    setTimeout(endVoting, 30_000);
  });

// ── VOTE ──
  socket.on('vote', async targetId => {
    if (!gameState.voting) return;
    if (!gameState.players[targetId]) return;

    // Allow vote changes - just update the vote
    const previousVote = votes.get(id);
    votes.set(id, targetId);
    gameState.players[id].voted = true;
    recomputeCounts();

    // Broadcast state immediately for instant feedback
    broadcastState();

    // Persist to database (async, doesn't block)
    // Only increment total votes if this is a new vote (not a change)
    if (!previousVote) {
      incrementTotal('totalVotes').catch(err => console.error('Vote persist error:', err));
    }
    
    // Update vote counts for both old and new targets
    if (previousVote && previousVote !== targetId) {
      updatePlayerStat(previousVote, 'votesReceived', n => Math.max(0, n - 1)).catch(err => console.error('Vote stat error:', err));
    }
    updatePlayerStat(targetId, 'votesReceived', n => n + 1).catch(err => console.error('Vote stat error:', err));
  });

  // ── PLAY SONG ──
  socket.on('play', song => {
    if (gameState.aux?.id !== id) return;
    io.to(gameState.room).emit('now', { song, timestamp: Date.now() });
  });

  // Aux-only controls
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
    if (!gameState.aux) return; // Safety check

    gameState.players[id].rated = true;
    gameState.players[id].keep  = decision === 'keep';

    if (decision === 'keep') {
      await incrementTotal('totalKeeps');
      await updatePlayerStat(gameState.aux.id, 'keeps', n => n + 1);
    } else {
      await incrementTotal('totalPasses');
      await updatePlayerStat(gameState.aux.id, 'passes', n => n + 1);
    }

    broadcastState();
  });

  // REMOVE RATING
  socket.on('removeRating', async () => {
    if (!gameState.rating || !gameState.players[id]?.rated || gameState.aux?.id === id) return;
    if (!gameState.aux) return; // Safety check

    const wasKeep = gameState.players[id].keep;
    
    if (wasKeep) {
      await decrementTotal('totalKeeps');
      await updatePlayerStat(gameState.aux.id, 'keeps', n => Math.max(0, n - 1));
    } else {
      await decrementTotal('totalPasses');
      await updatePlayerStat(gameState.aux.id, 'passes', n => Math.max(0, n - 1));
    }

    gameState.players[id].rated = false;
    gameState.players[id].keep = null;

    broadcastState();
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const wasAux = gameState.aux?.id === id;
    
    delete gameState.players[id];
    votes.delete(id);
    recomputeCounts();
    
    // Scenario 1: If no players left, reset the entire game
    if (Object.keys(gameState.players).length === 0) {
      console.log('All players left - resetting game');
      resetGame();
      selectRandomSongs();
      return;
    }
    
    // Scenario 2: If aux left during playing/rating phase, trigger new voting
    if (wasAux && (gameState.playing || gameState.rating)) {
      console.log('Aux holder left - starting new voting');
      io.to(gameState.room).emit('auxLeft', { message: 'The AUX holder has left! Voting for a new AUX...' });
      
      // Wait 2 seconds to show message, then start new voting
      setTimeout(() => {
        startNewVoting();
      }, 2000);
    } else {
      broadcastState();
    }
  });
});

// End voting - pick aux
async function endVoting() {
  gameState.voting = false;
  gameState.countdownEnd = null;
  gameState.currentPhase = null;

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

    await updatePlayerStat(chosenId, 'timesAux', n => n + 1);
    await pushAuxHistory({ 
      auxId: chosenId, 
      auxName: p.name, 
      timestamp: Date.now() 
    });

    gameState.playing = true;
    gameState.currentPhase = 'playing';
    gameState.countdownEnd = Date.now() + 240000;
    
    broadcastState();
    io.to(gameState.room).emit('countdown', { phase: 'playing', seconds: 240 });
    setTimeout(startRating, 240_000);
  } else {
    resetGame();
  }
}

function startRating() {
  gameState.playing = false;
  gameState.rating = true;
  gameState.currentPhase = 'rating';
  gameState.countdownEnd = Date.now() + 30000;

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
  gameState.countdownEnd = null;
  gameState.currentPhase = null;
  
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
  gameState.currentPhase = 'playing';
  gameState.countdownEnd = Date.now() + 240000;
  
  broadcastState();
  io.to(gameState.room).emit('countdown', { phase: 'playing', seconds: 240 });
  setTimeout(startRating, 240_000);
}

function startNewVoting() {
  gameState.rating = false;
  gameState.voting = true;
  gameState.aux = null;
  gameState.currentPhase = 'voting';
  gameState.countdownEnd = Date.now() + 30000;
  
  votes.clear(); 
  voteCounts.clear();
  for (const p of Object.values(gameState.players)) p.voted = false;
  
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
  gameState.countdownEnd = null;
  gameState.currentPhase = null;
  
  votes.clear(); 
  voteCounts.clear();
  for (const p of Object.values(gameState.players)) {
    p.voted = false; p.rated = false; p.keep = null;
  }
  broadcastState();
}