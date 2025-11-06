//References:
// Sound effect: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/createConvolver
// Grok for debugging and research on useful function, i.e., sound effect, aux
    // --- demo songs ---
    const songs = [
      { title:"Silly Love Songs",      artist:"Wings",              coverImage:"./image_file/1976-silly-love-songs.jpg",  by:"Jane" },
      { title:"Tonight’s The Night",   artist:"Rod Stewart",        coverImage:"./image_file/1977-tonights-the-night.jpg", by:"Ryo" },
      { title:"Shadow Dancing",        artist:"Andy Gibb",          coverImage:"./image_file/1978-shadow-dancing.jpg",    by:"Yuna" },
      { title:"My Sharona",            artist:"The Knack",          coverImage:"./image_file/1979-my-sharona.jpg",        by:"Jane" },
      { title:"Call Me",               artist:"Blondie",            coverImage:"./image_file/1980-call-me.jpg",           by:"Ryo" },
      { title:"Bette Davis Eyes",      artist:"Kim Carnes",         coverImage:"./image_file/1981-bette-davis-eyes.jpg",  by:"Jane" },
      { title:"Physical",              artist:"Olivia Newton-John", coverImage:"./image_file/1982-physical.jpg",          by:"Yuna" },
      { title:"Every Breath You Take", artist:"The Police",         coverImage:"./image_file/1983-every-breath-you-take.jpg", by:"Jane" },
      { title:"When Doves Cry",        artist:"Prince",             coverImage:"./image_file/1984-when-doves-cry.jpg",    by:"Ryo" },
      { title:"Careless Whisper",      artist:"George Michael",     coverImage:"./image_file/1985-careless-whisper.jpg",  by:"Yuna" }
    ];

    // --- Elements ---
    const wheel = document.getElementById('wheel');
    const song  = document.getElementById('songName');
    const artist= document.getElementById('artistName');
    const by    = document.getElementById('byLine');
    const vol   = document.getElementById('vol');
    const volV  = document.getElementById('volV');

    // --- Rotating wheel frames counter-rotate to stay upright ---
    const N = songs.length, step = 360 / N;

    function setCenter(s){
      song.textContent   = s.title;
      artist.textContent = s.artist;
      by.textContent     = `Selected by ${s.by}`;
    }

    function buildWheel(active=0){
      wheel.innerHTML = '';
      for (let i = 0; i < N; i++){
        const a = step * i;
        const tile = document.createElement('div');
        tile.className = 'tile' + (i===active ? ' active' : '');
        tile.style.setProperty('--a', a + 'deg');
        tile.innerHTML = `
          <div class="frame">
            <img src="${songs[i].coverImage}" alt="">
          </div>`;
        tile.addEventListener('click', ()=> {
          [...wheel.children].forEach(el=>el.classList.remove('active'));
          tile.classList.add('active');
          setCenter(songs[i]);
        });
        wheel.appendChild(tile);
      }
      setCenter(songs[active]);
    }

    // init
    buildWheel(0);
    vol.addEventListener('input', e=> volV.textContent = `${e.target.value}%`);
    
// 3) CLIENT-SIDE SOCKET CONNECTION
const socket = io();

let myId = null;
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

// Page elements
const p1           = document.getElementById('p1');
const p2           = document.getElementById('p2');
const voteArea     = document.getElementById('voteArea');
const votingPhase  = document.getElementById('votingPhase');
const rateArea     = document.getElementById('rateArea');
const auxControls  = document.getElementById('auxControls');
const auxName      = document.getElementById('auxName');
const resultDiv    = document.getElementById('result');
const countdownDiv = document.getElementById('countdown');
const nowDiv       = document.getElementById('now');
const usersList    = document.getElementById('usersList');

const volumeSlider = document.getElementById('volumeSlider');
const volValue     = document.getElementById('volValue');

// ───── AUX BUTTONS – DECLARE FIRST ───────────────────────────
function safeGet(id) { return document.getElementById(id); }
const pauseBtn  = safeGet('pauseBtn');
const resumeBtn = safeGet('resumeBtn');

// ───── INIT AUDIO FIRST ───────────────────────────────────────
function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0.5;
  gainNode.connect(audioCtx.destination);
}
initAudio();  // CALL IMMEDIATELY

// ───── SINGLE AUDIO + SINGLE SOURCE NODE ──────────────────────
let audio = null;

function ensureAudio() {
  if (audio) return audio;
  audio = document.createElement('audio');
  audio.style.display = 'none';
  document.body.appendChild(audio);

  source = audioCtx.createMediaElementSource(audio);
  source.connect(gainNode);

  return audio;
}

function reconnectAudioGraph() {
  if (!source || !gainNode) return;
  try { source.disconnect(); } catch (_) {}
  source.connect(gainNode);
}

// resume on first interaction
document.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

// ───── JOIN ───────────────────────────────────────────────────
// 4) CLIENT-SIDE "EMIT" EVENT - Join the game
document.getElementById('joinBtn').onclick = () => {
  const name = document.getElementById('nameIn').value.trim();
  if (!name) return;
  socket.emit('join', name);
  p1.classList.remove('active');
  p2.classList.add('active');
};

// ───── VOLUME ─────────────────────────────────────────────────
volumeSlider.oninput = () => {
  const vol = volumeSlider.value / 100;
  if (gainNode) gainNode.gain.value = vol;
  volValue.textContent = volumeSlider.value;
  if (isAux()) socket.emit('volume', vol);
};

// ───── AUX HELPERS ───────────────────────────────────────────
function isAux() { return aux && aux.id === myId; }

// ───── CURSOR ─────────────────────────────────────────────────
// 4) CLIENT-SIDE "EMIT" EVENT - Send cursor position
document.addEventListener('mousemove', e => {
  if (p2.classList.contains('active')) {
    socket.emit('cursor', { x: e.clientX, y: e.clientY });
  }
});

// 7) CLIENT-SIDE "ON" EVENT - Receive cursor from others
socket.on('cursor', d => {
  let c = document.getElementById('c-' + d.id);
  if (!c) {
    c = document.createElement('div');
    c.id = 'c-' + d.id;
    c.className = 'cursor';
    c.innerHTML = `<div class="label">${d.name}</div>`;
    document.body.appendChild(c);
  }
  c.style.left = (d.x - 8) + 'px';
  c.style.top  = (d.y - 8) + 'px';
});

// ───── SONG CAROUSEL ─────────────────────────────────────────
// 7) CLIENT-SIDE "ON" EVENT - Load songs from server
socket.on('init', data => loadSongs(data.music));

function loadSongs(songs) {
  const container = document.getElementById('carousel');
  container.innerHTML = '';
  const radius = 140, step = 360 / 5;
  songs.slice(0, 5).forEach((s, i) => {
    const angle = step * i;
    const div = document.createElement('div');
    div.className = 'album';
    div.style.transform = `rotate(${angle}deg) translate(${radius}px) rotate(-${angle}deg)`;
    div.innerHTML = `<img src="${s.coverImage}" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2NjYyIvPjx0ZXh0IHg9IjUwIiB5PSI1MCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjEyIiBmaWxsPSIjMzMzIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+QXJ0PC90ZXh0Pjwvc3ZnPg=='" /><p>${s.title}</p>`;
    div.onclick = () => isAux() && socket.emit('play', s);
    container.appendChild(div);
  });
}

// ───── PLAYBACK – INSTANT START + LATER SYNC ───────────────────
// 7) CLIENT-SIDE "ON" EVENT - Play song for everyone
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

  nowDiv.textContent = 'Now: ' + song.title;
  setTimeout(() => nowDiv.textContent = '', 4000);
});

// ───── PAUSE / RESUME / SEEK (SYNCED) ─────────────────────────
// 7) CLIENT-SIDE "ON" EVENT - Pause
socket.on('pause', () => {
  ensureAudio().pause();
});

// ───── RESUME – INSTANT & SYNCED (NO DELAY) ───────────────────
// 7) CLIENT-SIDE "ON" EVENT - Resume
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
  ensureAudio().currentTime = time;
});


// ───── VOLUME SYNC ────────────────────────────────────────────
// 7) CLIENT-SIDE "ON" EVENT - Volume change
socket.on('volume', vol => {
  if (!isAux() && gainNode) {
    gainNode.gain.value = vol;
    volumeSlider.value = vol * 100;
    volValue.textContent = Math.round(vol * 100);
  }
});

// ───── AUX CONTROLS ───────────────────────────────────────────

if (pauseBtn) {
  pauseBtn.onclick = () => {
    if (!isAux()) return;
    ensureAudio().pause();
    socket.emit('pause');
  };
}

if (resumeBtn) {
  resumeBtn.onclick = () => {
    if (!isAux()) return;
    const a = ensureAudio();
    a.play().catch(() => {});
    socket.emit('resume');
  };
}

// Seek when Aux scrubs
ensureAudio().addEventListener('seeking', () => {
  if (isAux()) socket.emit('seek', ensureAudio().currentTime);
});

// ───── EFFECTS (SYNCED) ───────────────────────────────────────
function clearEffects() {
  effectNodes.forEach(n => n.disconnect());
  effectNodes = [];
  if (source) {
    try { source.disconnect(); } catch (_) {}
    source.connect(gainNode);
  }
}

function applyReverb() {
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
  clearEffects();
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowshelf';
  filter.frequency.value = 200;
  filter.gain.value = 15;
  effectNodes.push(filter);
  source.connect(filter).connect(gainNode);
}

safeGet('reverbBtn')?.addEventListener('click', () => {
  if (!isAux()) return;
  applyReverb();
  socket.emit('effect', 'reverb');
});
safeGet('echoBtn')?.addEventListener('click', () => {
  if (!isAux()) return;
  applyEcho();
  socket.emit('effect', 'echo');
});
safeGet('bassBtn')?.addEventListener('click', () => {
  if (!isAux()) return;
  applyBass();
  socket.emit('effect', 'bass');
});
safeGet('resetFxBtn')?.addEventListener('click', () => {
  if (!isAux()) return;
  clearEffects();
  socket.emit('effect', 'reset');
});

socket.on('effect', fx => {
  if (fx === 'reverb') applyReverb();
  else if (fx === 'echo') applyEcho();
  else if (fx === 'bass') applyBass();
  else if (fx === 'reset') clearEffects();
});

// ───── STATE HANDLER ──────────────────────────────────────────
socket.on('state', data => {
  myId       = socket.id;
  aux        = data.aux;
  voting     = data.voting;
  playing    = data.playing;
  rating     = data.rating;
  players    = data.players || {};
  voteCounts = data.voteCounts || {};
  votes      = data.votes || {};

  voteArea.style.display    = (!voting && !playing && !rating) ? 'block' : 'none';
  votingPhase.style.display = voting ? 'block' : 'none';
  rateArea.style.display    = rating ? 'block' : 'none';
  auxControls.style.display = isAux() ? 'block' : 'none';
  auxName.textContent       = aux ? `${aux.name} is on aux!` : '';

  if (voting) renderVotingButtons();
  renderPlayers();
  renderRatingButtons();
});

// ───── PLAYER LIST ────────────────────────────────────────────
function renderPlayers() {
  usersList.innerHTML = '';
  const sorted = Object.values(players).sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach(p => {
    const li = document.createElement('li');
    li.className = 'user';
    const count = voteCounts[p.id] || 0;
    if (p.id === myId) {
      li.innerHTML = `<strong>${p.name} (You)</strong> — ${count} vote${count !== 1 ? 's' : ''}`;
      li.style.color = '#ffeb3b';
    } else {
      li.textContent = `${p.name} — ${count} vote${count !== 1 ? 's' : ''}`;
    }
    usersList.appendChild(li);
  });
}

// ───── VOTING UI ──────────────────────────────────────────────
function renderVotingButtons() {
  votingPhase.innerHTML = '<h3>Cast your vote</h3>';
  Object.values(players).forEach(p => {
    if (p.id === myId) return;
    const btn = document.createElement('button');
    btn.className = 'voteBtn';
    btn.dataset.id = p.id;
    updateBtn(btn);
    btn.onclick = () => socket.emit('vote', p.id);
    votingPhase.appendChild(btn);
  });
}

function updateBtn(btn) {
  const cid = btn.dataset.id;
  const player = players[cid];
  if (!player) { btn.textContent = '???' ; return; }
  const count = voteCounts[cid] || 0;
  const selected = votes[myId] === cid;
  btn.classList.toggle('selected', selected);
  btn.textContent = `${player.name} (${count})`;
}

socket.on('state', () => {
  document.querySelectorAll('.voteBtn').forEach(updateBtn);
});

// ───── START VOTING ───────────────────────────────────────────
// 4) CLIENT-SIDE "EMIT" EVENT - Start voting
document.getElementById('startBtn').onclick = () => socket.emit('startVoting');

// ───── RATING UI ──────────────────────────────────────────────
function renderRatingButtons() {
  const keepBtn = document.getElementById('keepBtn');
  const passBtn = document.getElementById('passBtn');
  const rated   = !!players[myId]?.rated;
  const isAuxPlayer = aux?.id === myId;

  keepBtn.className = 'btn';
  passBtn.className = 'btn-red';
  keepBtn.disabled = rated || isAuxPlayer;
  passBtn.disabled = rated || isAuxPlayer;

  if (rated) {
    if (players[myId].keep) keepBtn.className = 'btn selected';
    else passBtn.className = 'btn-red selected';
  }
}

document.getElementById('keepBtn').onclick = () => {
  if (players[myId]?.rated || aux?.id === myId) return;
  socket.emit('rate', 'keep');
};

document.getElementById('passBtn').onclick = () => {
  if (players[myId]?.rated || aux?.id === myId) return;
  socket.emit('rate', 'pass');
};

// ───── COUNTDOWN ──────────────────────────────────────────────
socket.on('countdown', d => {
  let sec = d.seconds;
  const phase = d.phase === 'voting' ? 'Voting'
              : d.phase === 'playing' ? 'Music'
              : 'Rating';
  countdownDiv.textContent = `${phase} ends in ${sec}s`;
  const iv = setInterval(() => {
    sec--;
    countdownDiv.textContent = `${phase} ends in ${sec}s`;
    if (sec <= 0) clearInterval(iv);
  }, 1000);
});

// ───── RESULT ─────────────────────────────────────────────────
socket.on('result', res => {
  let msg = '';
  if (res === 'keep') msg = 'KEEP! Same aux!';
  else if (res === 'pass') msg = 'PASS! New aux!';
  else if (res === 'draw') msg = 'DRAW! Aux gets one more round!';
  else if (res === 'tieElection') msg = 'TIEBREAKER! Random pick!';

  resultDiv.textContent = msg;
  resultDiv.style.color = (res === 'tieElection' || res === 'draw') ? '#ffeb3b' : '#fff';
  setTimeout(() => resultDiv.textContent = '', 3000);
});