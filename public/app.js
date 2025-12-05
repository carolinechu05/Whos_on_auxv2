//References:
// Sound effect: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/createConvolver
// Grok for debugging and research on useful function, i.e., sound effect, aux

// --- Elements from the actual HTML ---
const joinScreen = document.getElementById('joinScreen');
const gameScreen = document.getElementById('gameScreen');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');

const wheel = document.getElementById('wheel');
const song = document.getElementById('songName');
const artist = document.getElementById('artistName');
const by = document.getElementById('byLine');
const auxAvatar = document.getElementById('auxAvatar');
const vol = document.getElementById('vol');
const volV = document.getElementById('volV');
const startBtn = document.getElementById('start');
const rateDock = document.getElementById('rateDock');
const ratingDock = document.getElementById('ratingDock');
const votingPanel = document.getElementById('votingPanel');
const votingButtons = document.getElementById('votingButtons');
const playersList = document.getElementById('playersList');
const countdown = document.getElementById('countdown');
const nowPlaying = document.getElementById('nowPlaying');
const auxInfo = document.getElementById('auxInfo');
const auxControls = document.getElementById('auxControls');
const auxVol = document.getElementById('auxVol');
const auxVolV = document.getElementById('auxVolV');

// 3) CLIENT-SIDE SOCKET CONNECTION
const socket = io();

let myId = null;
let myName = '';
let audioCtx = null;
let source = null;
let gainNode = null;
let effectNodes = [];

let votes = {};
let aux = null;
let voting = false;
let playing = false;
let rating = false;
let players = {};
let voteCounts = {};
let currentSongs = [];
let myRating = null;
let countdownInterval = null;  // Track countdown interval

// ───── CURSOR TRACKING & GLOW ──────────────────────────────────────────────
const otherCursors = new Map();

// Cursor glow element
let cursorGlow = null;

function initCursorGlow() {
  // Don't create if it already exists
  if (cursorGlow) return;
  
  cursorGlow = document.createElement('div');
  cursorGlow.className = 'cursor-glow';
  cursorGlow.style.cssText = `
    position: fixed;
    width: 60px;
    height: 60px;
    pointer-events: none;
    z-index: 99999;
    transform: translate(-50%, -50%);
    filter: blur(12px);
    background: radial-gradient(circle, rgba(54, 84, 255, 0.7) 0%, rgba(54, 84, 255, 0.4) 50%, transparent 100%);
    opacity: 0.8;
    left: -100px;
    top: -100px;
  `;
  document.body.appendChild(cursorGlow);
  console.log('Cursor glow initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCursorGlow);
} else {
  // DOM already loaded
  initCursorGlow();
}

// Update glow position with mouse movement
document.addEventListener('mousemove', (e) => {
  // Try to initialize if it doesn't exist yet
  if (!cursorGlow && document.body) {
    initCursorGlow();
  }
  
  if (cursorGlow) {
    requestAnimationFrame(() => {
      cursorGlow.style.left = e.clientX + 'px';
      cursorGlow.style.top = e.clientY + 'px';
    });
  }
});

// Track and send your cursor position (throttled to reduce network traffic)
let lastCursorSend = 0;
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastCursorSend > 50) { // Send every 50ms max
    lastCursorSend = now;
    socket.emit('cursor', { x: e.clientX, y: e.clientY });
  }
});

// Receive other players' cursor positions
socket.on('cursor', (data) => {
  updateOtherCursor(data);
});

function updateOtherCursor(data) {
  let cursorEl = otherCursors.get(data.id);
  
  if (!cursorEl) {
    // Create new cursor element
    cursorEl = document.createElement('div');
    cursorEl.className = 'other-cursor';
    cursorEl.innerHTML = `
      <img src="aux-cursor.png" alt="">
      <span>${data.name}</span>
    `;
    document.body.appendChild(cursorEl);
    otherCursors.set(data.id, cursorEl);
  }
  
  // Update position
  cursorEl.style.left = data.x + 'px';
  cursorEl.style.top = data.y + 'px';
}

// Clean up cursor when player disconnects
function cleanupDisconnectedCursors(currentPlayers) {
  for (const [id, cursorEl] of otherCursors) {
    if (!currentPlayers[id]) {
      cursorEl.remove();
      otherCursors.delete(id);
    }
  }
}

// ───── HELPER FUNCTIONS ─────────────────────────────────────────────
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}min ${secs < 10 ? '0' : ''}${secs} secs`;
}

// ───── JOIN GAME ────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    alert('Please enter your name');
    return;
  }
  myName = name;
  socket.emit('join', name);
  joinScreen.classList.remove('active');
  gameScreen.classList.add('active');
});

nameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ───── AUX BUTTONS – DECLARE FIRST ───────────────────────────
function safeGet(id) { return document.getElementById(id); }
const pauseBtn  = safeGet('pauseBtn');
const resumeBtn = safeGet('resumeBtn');
const shuffleBtn = safeGet('shuffleBtn');

// ───── INIT AUDIO ───────────────────────────────────────────────────
function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.8;
  gainNode.connect(audioCtx.destination);
}

// Wait for user interaction before initializing audio
document.addEventListener('click', () => {
  if (!audioCtx) {
    initAudio();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}, { once: false });

// ───── AUDIO ELEMENT ────────────────────────────────────────────────
let audio = null;

function ensureAudio() {
  if (audio) return audio;
  if (!audioCtx) initAudio();
  
  audio = document.createElement('audio');
  audio.style.display = 'none';
  audio.crossOrigin = "anonymous";
  document.body.appendChild(audio);

  // Progress bar update
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      const bar = document.getElementById('progressBar');
      const thumb = document.getElementById('progressThumb');
      if (bar) bar.style.width = percent + '%';
      if (thumb) thumb.style.left = percent + '%';
    }
  });

  audio.addEventListener('ended', () => {
    const bar = document.getElementById('progressBar');
    const thumb = document.getElementById('progressThumb');
    if (bar) bar.style.width = '0%';
    if (thumb) thumb.style.left = '0%';
  });

  // Draggable progress bar
  const progressBarContainer = document.getElementById('progressBarContainer');
  const progressThumb = document.getElementById('progressThumb');

  if (progressBarContainer && progressThumb) {
    let dragging = false;
    
    const seek = (x) => {
      if (!isAux() || !audio?.duration) return;
      const rect = progressBarContainer.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((x - rect.left) / rect.width) * 100));
      audio.currentTime = (pct / 100) * audio.duration;
      socket.emit('seek', audio.currentTime);
    };
    
    progressThumb.onmousedown = (e) => {
      if (isAux()) { dragging = true; e.preventDefault(); }
    };
    
    document.onmousemove = (e) => dragging && seek(e.clientX);
    document.onmouseup = () => dragging = false;
    
    progressBarContainer.onclick = (e) => !dragging && seek(e.clientX);
  }

  source = audioCtx.createMediaElementSource(audio);
  source.connect(gainNode);

  return audio;
}

function reconnectAudioGraph() {
  if (!source || !gainNode) return;
  try { source.disconnect(); } catch (_) {}
  source.connect(gainNode);
}

// ───── BUILD WHEEL FROM SERVER SONGS ────────────────────────────────
function buildWheel(songs, activeIndex = 0) {
  if (!wheel) return;
  
  if (!songs || songs.length === 0) {
    wheel.innerHTML = '<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #9fb3ff;"></div>';
    setCenter({ title: 'Loading...', artist: 'Please wait' });
    return;
  }
  
  const N = songs.length;
  const step = 360 / N;
  
  wheel.innerHTML = '';
  
  for (let i = 0; i < N; i++) {
    const a = step * i;
    const tile = document.createElement('div');
    tile.className = 'tile' + (i === activeIndex ? ' active' : '');
    tile.style.setProperty('--a', a + 'deg');
    tile.innerHTML = `
      <div class="frame">
        <img src="${songs[i].coverImage}" alt="${songs[i].title}" 
             onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iIzBiMTIyMCIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjZmZmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+QXJ0PC90ZXh0Pjwvc3ZnPg=='">
      </div>`;
    
    tile.addEventListener('click', () => {
      if (isAux()) {
        [...wheel.children].forEach(el => el.classList.remove('active'));
        tile.classList.add('active');
        setCenter(songs[i]);
        socket.emit('play', songs[i]);
      }
    });
    
    wheel.appendChild(tile);
  }
  
  setCenter(songs[activeIndex]);
}

function setCenter(s) {
  if (!s) return;
  if (song) song.textContent = s.title || '—';
  if (artist) artist.textContent = s.artist || '—';
  if (by) {
    if (aux) {
      by.textContent = `Selected by ${aux.name}`;
    } else {
      by.textContent = 'Click Start to begin';
    }
  }
}

// ───── VOLUME ───────────────────────────────────────────────────────
if (vol && volV) {
  vol.addEventListener('input', e => {
    const value = e.target.value;
    volV.textContent = `${value}%`;
    if (gainNode) {
      gainNode.gain.value = value / 100;
    }
    // Don't emit volume changes from non-aux holders
    if (isAux()) {
      socket.emit('volume', value / 100);
    }
  });
}

// Aux holder volume control
if (auxVol && auxVolV) {
  auxVol.addEventListener('input', e => {
    const value = e.target.value;
    auxVolV.textContent = `${value}%`;
    if (gainNode) {
      gainNode.gain.value = value / 100;
    }
    // Emit volume change to all clients
    socket.emit('volume', value / 100);
  });
}

// Pause button
if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    if (isAux() && audio) {
      audio.pause();
      socket.emit('pause');
    }
  });
}

// Resume button
if (resumeBtn) {
  resumeBtn.addEventListener('click', () => {
    if (isAux() && audio) {
      audio.play().catch(() => {});
      socket.emit('resume', { timestamp: Date.now() });
    }
  });
}

// Shuffle button - requests new random songs from server
if (shuffleBtn) {
  shuffleBtn.addEventListener('click', () => {
    if (!isAux()) return;
    
    // Request new songs from server (which has full music list)
    socket.emit('requestNewSongs');
  });
}

// ───── AUX HELPERS ──────────────────────────────────────────────────
function isAux() { return aux && aux.id === myId; }

// ───── SOCKET EVENTS ────────────────────────────────────────────────
socket.on('connect', () => {
  myId = socket.id;
});

socket.on('init', data => {
  currentSongs = data.music || [];
  buildWheel(currentSongs);
});

// Handle new songs from server
socket.on('newSongs', data => {
  currentSongs = data.songs || [];
  buildWheel(currentSongs);
  showNotification('🔀 New songs loaded!', 2000);
});

// ───── START VOTING ─────────────────────────────────────────────────
if (startBtn) {
  startBtn.addEventListener('click', () => {
    socket.emit('startVoting');
  });
}

// ───── PLAYBACK ─────────────────────────────────────────────────────
socket.on('now', ({ song, timestamp }) => {
  const a = ensureAudio();
  a.src = song.audioUrl;
  a.play().catch(() => {});

  const syncPlayback = () => {
    reconnectAudioGraph();
    const delay = (Date.now() - timestamp) / 1000;
    const target = Math.max(0, delay);
    if (Math.abs(a.currentTime - target) > 0.1) {
      a.currentTime = target;
    }
  };

  a.addEventListener('loadedmetadata', syncPlayback, { once: true });
  setTimeout(syncPlayback, 2000);
  
  setCenter(song);
  if (nowPlaying) nowPlaying.textContent = `♪ ${song.title} - ${song.artist}`;
  
  const songIndex = currentSongs.findIndex(s => s.id === song.id);
  if (songIndex >= 0) {
    document.querySelectorAll('.tile').forEach((tile, i) => {
      tile.classList.toggle('active', i === songIndex);
    });
  }
});

socket.on('pause', () => {
  if (audio) audio.pause();
});

socket.on('resume', ({ timestamp }) => {
  const a = ensureAudio();
  reconnectAudioGraph();
  const delay = (Date.now() - timestamp) / 1000;
  a.currentTime += delay;
  if (a.readyState >= 2) {
    a.play().catch(() => {});
  } else {
    const playWhenReady = () => {
      a.play().catch(() => {});
      a.removeEventListener('canplay', playWhenReady);
    };
    a.addEventListener('canplay', playWhenReady);
  }
});

socket.on('seek', time => {
  if (audio) audio.currentTime = time;
});

socket.on('volume', vol => {
  if (!isAux() && gainNode) {
    gainNode.gain.value = vol;
    if (document.getElementById('vol')) {
      document.getElementById('vol').value = vol * 100;
    }
    if (volV) volV.textContent = Math.round(vol * 100) + '%';
  }
});

// ───── EFFECTS ──────────────────────────────────────────────────────
function clearEffects() {
  effectNodes.forEach(n => {
    try { n.disconnect(); } catch (_) {}
  });
  effectNodes = [];
  if (source && gainNode) {
    try { source.disconnect(); } catch (_) {}
    source.connect(gainNode);
  }
}

function applyReverb() {
  if (!audioCtx) return;
  clearEffects();
  const convolver = audioCtx.createConvolver();
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
  }
  convolver.buffer = buf;
  effectNodes.push(convolver);
  source.connect(convolver).connect(gainNode);
}

function applyEcho() {
  if (!audioCtx) return;
  clearEffects();
  const delay = audioCtx.createDelay();
  delay.delayTime.value = 0.3;
  const fb = audioCtx.createGain();
  fb.gain.value = 0.4;
  effectNodes.push(delay, fb);
  source.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(gainNode);
}

function applyBass() {
  if (!audioCtx) return;
  clearEffects();
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowshelf';
  filter.frequency.value = 200;
  filter.gain.value = 15;
  effectNodes.push(filter);
  source.connect(filter).connect(gainNode);
}

socket.on('effect', fx => {
  if (fx === 'reverb') applyReverb();
  else if (fx === 'echo') applyEcho();
  else if (fx === 'bass') applyBass();
  else if (fx === 'reset') clearEffects();
});

// ───── VOTING ───────────────────────────────────────────────────────
function renderVotingButtons() {
  if (!votingButtons) return;
  votingButtons.innerHTML = '';
  
  Object.values(players).forEach(p => {
    if (p.id === myId) return;
    
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.dataset.id = p.id;
    
    const count = voteCounts[p.id] || 0;
    const selected = votes[myId] === p.id;
    if (selected) btn.classList.add('selected');
    
    btn.textContent = `${p.name} (${count} vote${count !== 1 ? 's' : ''})`;
    
    // Allow vote changes - click to vote or change vote
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!voting) return;
      
      // Remove selection from all buttons first
      votingButtons.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('selected'));
      
      // Add selection to clicked button
      btn.classList.add('selected');
      
      // Send vote to server
      socket.emit('vote', p.id);
    });
    
    votingButtons.appendChild(btn);
  });
}

socket.on('vote', () => {
  renderVotingButtons();
});

// ───── RATING (WITH DESELECT FEATURE) ───────────────────────────────
if (rateDock) {
  const buttons = rateDock.querySelectorAll('button');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!rating || !players[myId] || isAux()) return;
      
      const score = parseInt(btn.dataset.score);
      
      // If clicking the same button, deselect it
      if (myRating === score) {
        myRating = null;
        buttons.forEach(b => {
          b.classList.remove('selected');
          b.style.opacity = '1';
          b.style.transform = 'scale(1)';
        });
        // Notify server to remove rating
        socket.emit('removeRating');
        return;
      }
      
      // Otherwise, select this rating
      myRating = score;
      const decision = score >= 3 ? 'keep' : 'pass';
      socket.emit('rate', decision);
      
      // Update UI - dim others, highlight selected
      buttons.forEach(b => {
        b.classList.remove('selected');
        b.style.opacity = '0.4';
        b.style.transform = 'scale(1)';
      });
      btn.classList.add('selected');
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.2)';
    });
  });
}

// ───── PLAYERS LIST ─────────────────────────────────────────────────
function renderPlayers() {
  if (!playersList) return;
  playersList.innerHTML = '';
  
  const sorted = Object.values(players).sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach(p => {
    const li = document.createElement('li');
    const count = voteCounts[p.id] || 0;
    
    if (p.id === myId) {
      li.classList.add('current-user');
      li.innerHTML = `<strong>${p.name} (You)</strong><br><small>${count} vote${count !== 1 ? 's' : ''}</small>`;
    } else {
      li.textContent = `${p.name} — ${count} vote${count !== 1 ? 's' : ''}`;
    }
    
    if (aux && aux.id === p.id) {
      li.classList.add('is-aux');
    }
    
    playersList.appendChild(li);
  });
}

// ───── STATE HANDLER ────────────────────────────────────────────────
socket.on('state', data => {
  myId = socket.id;
  aux = data.aux;
  voting = data.voting;
  playing = data.playing;
  rating = data.rating;
  players = data.players || {};
  voteCounts = data.voteCounts || {};
  votes = data.votes || {};

  // Clean up cursors for disconnected players
  cleanupDisconnectedCursors(players);

  // Handle countdown for late joiners
  if (data.countdown) {
    startCountdownFromState(data.countdown);
  }

  updateUI();
});

function startCountdownFromState(countdownData) {
  // Clear any existing countdown
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  if (!countdown) return;
  
  let sec = countdownData.secondsRemaining;
  const phase = countdownData.phase === 'voting' ? 'Voting'
              : countdownData.phase === 'playing' ? 'Music'
              : 'Rating';

  // Initial display
  countdown.textContent = `${phase} ends in ${formatTime(sec)}`;

  countdownInterval = setInterval(() => {
    sec--;
    
    if (countdown) {
      countdown.textContent = `${phase} ends in ${formatTime(sec)}`;
    }

    if (sec <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }, 1000);
}

function updateUI() {
  // Update start button
  if (startBtn) {
    if (voting || playing || rating) {
      startBtn.disabled = true;
      startBtn.textContent = voting ? 'Voting...' : playing ? 'Playing...' : 'Rating...';
    } else {
      startBtn.disabled = false;
      startBtn.textContent = 'Start Voting';
    }
  }
  
  // Show/hide aux controls - only show during playing phase
  if (auxControls) {
    if (isAux() && playing) {
      auxControls.style.display = 'block';
    } else {
      auxControls.style.display = 'none';
    }
  }
  
  // Update aux info
  if (auxInfo && aux) {
    auxInfo.textContent = `🎧 ${aux.name} is on AUX`;
  } else if (auxInfo) {
    auxInfo.textContent = '';
  }
  
  // Update avatar
  if (auxAvatar && aux) {
    auxAvatar.textContent = aux.name.substring(0, 2).toUpperCase();
  } else if (auxAvatar) {
    auxAvatar.textContent = '?';
  }
  
  // Show/hide voting panel
  if (votingPanel) {
    if (voting) {
      votingPanel.classList.add('active');
      renderVotingButtons();
    } else {
      votingPanel.classList.remove('active');
    }
  }
  
  // Show/hide rating dock
  if (ratingDock) {
    if (rating && !isAux()) {
      ratingDock.classList.add('active');
      // Reset button states
      if (rateDock) {
        myRating = null;
        rateDock.querySelectorAll('button').forEach(b => {
          b.classList.remove('selected');
          b.style.opacity = '1';
          b.style.transform = 'scale(1)';
        });
      }
    } else {
      ratingDock.classList.remove('active');
    }
  }
  
  // Update players list
  renderPlayers();
  
  // Update center display
  if (aux && currentSongs.length > 0) {
    setCenter(currentSongs[0]);
  }
}

// ───── COUNTDOWN ──────────────────────────────────────────────────────────────
socket.on('countdown', d => {
  // Clear any existing countdown to prevent duplicates
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  
  if (!countdown) return;
  
  let sec = d.seconds;
  const phase = d.phase === 'voting' ? 'Voting'
              : d.phase === 'playing' ? 'Music'
              : 'Rating';

  // Initial display
  countdown.textContent = `${phase} ends in ${formatTime(sec)}`;

  countdownInterval = setInterval(() => {
    sec--;

    if (countdown) {
      countdown.textContent = `${phase} ends in ${formatTime(sec)}`;
    }

    if (sec <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }, 1000);
});

// ───── RESULT ───────────────────────────────────────────────────────
socket.on('result', res => {
  let msg = '';
  if (res === 'keep') msg = '✅ KEEP! Same aux!';
  else if (res === 'pass') msg = '❌ PASS! New aux!';
  else if (res === 'draw') msg = '🤝 DRAW! Aux gets one more round!';
  else if (res === 'tieElection') msg = '🎲 TIEBREAKER! Random pick!';

  showNotification(msg, 3000);
});

// ───── NOTIFICATION SYSTEM ──────────────────────────────────────────
function showNotification(message, duration = 3000) {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();
  
  const notif = document.createElement('div');
  notif.className = 'notification';
  notif.textContent = message;
  notif.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(54, 84, 255, 0.95);
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-weight: bold;
    z-index: 1000;
    border: 2px solid white;
    animation: slideDown 0.3s ease;
  `;
  
  document.body.appendChild(notif);
  
  setTimeout(() => {
    notif.style.animation = 'slideUp 0.3s ease';
    setTimeout(() => notif.remove(), 300);
  }, duration);
}

// ───── AUX LEFT HANDLER ──────────────────────────────────────────────────────
socket.on('auxLeft', data => {
  showNotification(data.message, 3000);
  
  // Stop any playing audio
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
});

// Initialize empty wheel on page load
if (wheel) {
  buildWheel([]);
}