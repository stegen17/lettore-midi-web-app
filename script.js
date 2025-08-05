document.addEventListener('DOMContentLoaded', () => {
    // --- RIFERIMENTI AGLI ELEMENTI DEL DOM ---
    const fileInput = document.getElementById('midi-file-input');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const progressBar = document.getElementById('progress-bar');
    const mixerContainer = document.getElementById('mixer-container');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');
    const dropZone = document.getElementById('drop-zone');
    const dropMessage = document.querySelector('.drop-message');
    const loadingOverlay = document.getElementById('loading-overlay');

    // --- STATO DELL'APPLICAZIONE ---
    let midiData = null;
    let players = new Map(); // Conterrà { synth, channel, part } per ogni traccia
    let isPlaying = false;
    let isSoloing = false; // Flag per tracciare se qualche canale è in "solo"

    // --- LISTA STRUMENTI (semplificata) ---
    // Per una vera app GM, si userebbe una libreria di suoni campionati (Sampler)
    const INSTRUMENT_MAP = {
        'Acoustic Grand Piano': () => new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'fmtriangle', harmonicity: 0.5, modulationIndex: 1.2 }, envelope: { attack: 0.01, decay: 0.4, sustain: 0.1, release: 1.2 } }).toDestination(),
        'Electric Piano': () => new Tone.PolySynth(Tone.FMSynth, { harmonicity: 3, modulationIndex: 10, envelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 1 } }).toDestination(),
        'Synth Bass': () => new Tone.PolySynth(Tone.MonoSynth, { oscillator: { type: 'fmsawtooth', modulationType: 'sine' }, envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.8 }, filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.2, release: 1, baseFrequency: 200, octaves: 4 } }).toDestination(),
        'Synth Pad': () => new Tone.PolySynth(Tone.AMSynth, { harmonicity: 1.5, envelope: { attack: 0.5, decay: 1, sustain: 0.7, release: 2 }, modulationEnvelope: { attack: 1, decay: 0.5, sustain: 1, release: 2 } }).toDestination(),
        'Percussion': () => new Tone.Sampler({
            urls: { C3: "https://tonejs.github.io/audio/drum-samples/Bongos/conga_bongo_low.mp3", D3: "https://tonejs.github.io/audio/drum-samples/Bongos/conga_bongo_high.mp3", },
            baseUrl: "",
        }).toDestination(),
    };
    const INSTRUMENT_NAMES = Object.keys(INSTRUMENT_MAP);

    // --- GESTIONE CARICAMENTO FILE ---
    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
    
    // Drag and Drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    async function handleFile(file) {
        if (!file || !file.type.includes('midi')) {
            alert('Per favore, carica un file MIDI valido (.mid).');
            return;
        }
        
        loadingOverlay.classList.remove('hidden');
        
        try {
            const fileBuffer = await file.arrayBuffer();
            midiData = new Midi(fileBuffer);
            cleanupPrevious();
            await setupMixerAndAudio(midiData);
            dropMessage.classList.add('hidden');
        } catch (error) {
            console.error("Errore nel parsing del file MIDI:", error);
            alert("Impossibile leggere il file MIDI. Potrebbe essere corrotto.");
        } finally {
            loadingOverlay.classList.add('hidden');
        }
    }

    // --- SETUP AUDIO E MIXER ---
    async function setupMixerAndAudio(midi) {
        // Avvia il contesto audio dopo interazione utente
        await Tone.start();
        console.log("AudioContext avviato.");
        
        midi.tracks.forEach((track, index) => {
            // Ignora le tracce senza note
            if (track.notes.length === 0) return;

            // 1. Crea il Synth e il Channel per il controllo del volume/pan
            const synth = INSTRUMENT_MAP[INSTRUMENT_NAMES[0]](); // Default al primo strumento
            const channel = new Tone.Channel({ volume: 0, pan: 0, solo: false }).toDestination();
            synth.connect(channel);

            // 2. Crea la UI per la channel strip
            const strip = createChannelStrip(track, index);
            mixerContainer.appendChild(strip);
            const led = strip.querySelector('.note-led');

            // 3. Crea una Tone.Part per schedulare le note
            const part = new Tone.Part((time, note) => {
                synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
                
                // Feedback visivo LED
                Tone.Draw.schedule(() => {
                    led.classList.add('active');
                    setTimeout(() => led.classList.remove('active'), 100);
                }, time);

            }, track.notes).start(0);

            // 4. Salva tutto nella nostra mappa
            players.set(index, { synth, channel, part, strip });
        });
        
        // Imposta la durata del brano e abilita i controlli
        const duration = Tone.Transport.seconds = midi.duration;
        totalTimeEl.textContent = formatTime(duration);
        progressBar.max = duration;
        enableGlobalControls();
    }

    // --- CREAZIONE UI DINAMICA ---
    function createChannelStrip(track, index) {
        const strip = document.createElement('div');
        strip.className = 'channel-strip';
        strip.dataset.trackIndex = index;

        const instrumentName = track.instrument.name || `Traccia ${index + 1}`;

        strip.innerHTML = `
            <div class="track-name" title="${instrumentName}">${instrumentName}</div>
            <div class="note-led"></div>
            <div class="fader-container">
                <input type="range" min="-40" max="6" value="0" step="0.5" class="volume-fader" orient="vertical">
            </div>
            <div class="channel-buttons">
                <button class="mute" data-track-index="${index}">M</button>
                <button class="solo" data-track-index="${index}">S</button>
            </div>
            <select class="instrument-selector" data-track-index="${index}">
                ${INSTRUMENT_NAMES.map(name => `<option value="${name}">${name}</option>`).join('')}
            </select>
        `;
        
        // Aggiungi event listeners ai controlli della strip
        strip.querySelector('.volume-fader').addEventListener('input', (e) => {
            players.get(index).channel.volume.value = e.target.value;
        });

        strip.querySelector('.mute').addEventListener('click', (e) => {
            const channel = players.get(index).channel;
            channel.mute = !channel.mute;
            e.target.classList.toggle('active', channel.mute);
            updateSoloMuteState();
        });

        strip.querySelector('.solo').addEventListener('click', (e) => {
            const channel = players.get(index).channel;
            channel.solo = !channel.solo;
            updateSoloMuteState();
        });

        strip.querySelector('.instrument-selector').addEventListener('change', (e) => {
            changeInstrument(index, e.target.value);
        });

        return strip;
    }
    
    // --- LOGICA DI CONTROLLO (MUTE/SOLO, STRUMENTI) ---
    function updateSoloMuteState() {
        isSoloing = Array.from(players.values()).some(p => p.channel.solo);

        players.forEach(({ channel, strip }, index) => {
            // Aggiorna lo stato visivo del pulsante Solo
            strip.querySelector('.solo').classList.toggle('active', channel.solo);

            if (isSoloing) {
                // Se c'è almeno un canale in solo, silenzia tutti quelli non in solo
                channel.mute = !channel.solo;
            } else {
                // Altrimenti, ripristina lo stato di mute originale dell'utente
                const isMutedByUser = strip.querySelector('.mute').classList.contains('active');
                channel.mute = isMutedByUser;
            }
        });
    }

    function changeInstrument(trackIndex, instrumentName) {
        const player = players.get(trackIndex);
        if (!player) return;

        // Disconnetti e distruggi il vecchio synth per liberare memoria
        player.synth.disconnect();
        player.synth.dispose();
        
        // Crea e connetti il nuovo synth
        const newSynth = INSTRUMENT_MAP[instrumentName]();
        newSynth.connect(player.channel);
        
        // Aggiorna il synth nella nostra mappa
        player.synth = newSynth;
        
        // Riassegna la callback della part al nuovo synth
        player.part.callback = (time, note) => {
            newSynth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
            
            // Feedback visivo LED (ri-aggiunto qui)
            Tone.Draw.schedule(() => {
                player.strip.querySelector('.note-led').classList.add('active');
                setTimeout(() => player.strip.querySelector('.note-led').classList.remove('active'), 100);
            }, time);
        };
    }

    // --- CONTROLLI DI RIPRODUZIONE GLOBALI ---
    playPauseBtn.addEventListener('click', () => {
        if (isPlaying) {
            Tone.Transport.pause();
            playPauseBtn.textContent = '▶️ Play';
        } else {
            Tone.Transport.start();
            playPauseBtn.textContent = '⏸️ Pausa';
        }
        isPlaying = !isPlaying;
    });

    stopBtn.addEventListener('click', () => {
        Tone.Transport.stop();
        playPauseBtn.textContent = '▶️ Play';
        isPlaying = false;
        progressBar.value = 0;
        currentTimeEl.textContent = formatTime(0);
    });

    progressBar.addEventListener('input', (e) => {
        const newTime = e.target.value;
        Tone.Transport.seconds = newTime;
        currentTimeEl.textContent = formatTime(newTime);
    });

    // --- FUNZIONI DI UTILITÀ E PULIZIA ---
    function cleanupPrevious() {
        Tone.Transport.stop();
        Tone.Transport.cancel();
        
        players.forEach(({ synth, channel, part }) => {
            part.dispose();
            synth.dispose();
            channel.dispose();
        });
        
        players.clear();
        mixerContainer.innerHTML = '';
        isPlaying = false;
        playPauseBtn.textContent = '▶️ Play';
    }

    function enableGlobalControls() {
        playPauseBtn.disabled = false;
        stopBtn.disabled = false;
        progressBar.disabled = false;
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${minutes}:${secs}`;
    }
    
    // Aggiorna la progress bar e il tempo durante la riproduzione
    function animationLoop() {
        if (midiData) {
            const currentTime = Tone.Transport.seconds;
            progressBar.value = currentTime;
            currentTimeEl.textContent = formatTime(currentTime);
        }
        requestAnimationFrame(animationLoop);
    }
    
    requestAnimationFrame(animationLoop);
});