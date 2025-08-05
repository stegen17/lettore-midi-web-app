document.addEventListener('DOMContentLoaded', () => {
    // --- RIFERIMENTI AGLI ELEMENTI DEL DOM ---
    const fileInput = document.getElementById('midi-file-input');
    const sf2FileInput = document.getElementById('sf2-file-input');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const progressBar = document.getElementById('progress-bar');
    const mixerContainer = document.getElementById('mixer-container');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');
    const dropZone = document.getElementById('drop-zone');
    const dropMessage = document.querySelector('.drop-message');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const sf2NameEl = document.getElementById('sf2-name');

    // --- STATO DELL'APPLICAZIONE ---
    let midiData = null;
    let players = new Map(); // Conterrà info per ogni traccia
    let isPlaying = false;
    let isSoloing = false;

    // --- SOUNDFONT STATO ---
    let soundfontPlayer = null;
    let activeSoundFont = null;

    // --- GESTIONE CARICAMENTO FILE ---
    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
    sf2FileInput.addEventListener('change', (e) => handleSoundFontFile(e.target.files[0]));
    
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) {
            if (file.name.endsWith('.mid') || file.name.endsWith('.midi')) {
                handleFile(file);
            } else if (file.name.endsWith('.sf2')) {
                handleSoundFontFile(file);
            }
        }
    });

    async function handleFile(file) {
        if (!file) return;
        showLoading('Caricamento file MIDI...');
        try {
            const fileBuffer = await file.arrayBuffer();
            midiData = new Midi(fileBuffer);
            cleanupPrevious();
            await setupMixerAndAudio(midiData);
            dropMessage.classList.add('hidden');
        } catch (error) {
            console.error("Errore nel parsing MIDI:", error);
            alert("Impossibile leggere il file MIDI.");
        } finally {
            hideLoading();
        }
    }

    async function handleSoundFontFile(file) {
        if (!file) return;
        showLoading('Parsing del SoundFont...');
        try {
            const fileBuffer = await file.arrayBuffer();
            activeSoundFont = sf2.parse(new Uint8Array(fileBuffer));
            
            // Crea il player SoundFont
            soundfontPlayer = await WebAudioSoundfontPlayer.createPlayer(Tone.context.rawContext, activeSoundFont);

            sf2NameEl.textContent = file.name;
            console.log("SoundFont caricato:", activeSoundFont);

            // Se un MIDI è già caricato, aggiorna gli strumenti
            if (midiData) {
                updateAllInstrumentSelectors();
            }
        } catch (error) {
            console.error("Errore nel caricamento del SoundFont:", error);
            alert("Impossibile leggere il file SoundFont.");
            soundfontPlayer = null;
            activeSoundFont = null;
            sf2NameEl.textContent = 'Sintetizzatore interno';
        } finally {
            hideLoading();
        }
    }

    // --- SETUP AUDIO E MIXER ---
    async function setupMixerAndAudio(midi) {
        await Tone.start();
        
        midi.tracks.forEach((track, index) => {
            if (track.notes.length === 0) return;

            const channel = new Tone.Channel({ volume: 0, pan: 0, solo: false }).toDestination();
            const strip = createChannelStrip(track, index);
            mixerContainer.appendChild(strip);
            const led = strip.querySelector('.note-led');

            const part = new Tone.Part((time, note) => {
                // DECIDE QUALE PLAYER USARE: SOUNDFONT O SYNTH INTERNO
                if (soundfontPlayer) {
                    const presetId = players.get(index)?.instrumentId ?? track.instrument.number;
                    const gain = note.velocity * 2; // SF player gain è 0-1, velocity 0-1, amplifichiamo un po'
                    soundfontPlayer.play(presetId, time, { gain, duration: note.duration });
                } else {
                    // Fallback al synth interno
                    const { synth } = players.get(index);
                    synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
                }
                
                Tone.Draw.schedule(() => {
                    led.classList.add('active');
                    setTimeout(() => led.classList.remove('active'), 100);
                }, time);

            }, track.notes).start(0);

            // Crea un synth di fallback
            const synth = new Tone.PolySynth(Tone.Synth).connect(channel);

            players.set(index, { 
                synth, 
                channel, 
                part, 
                strip, 
                instrumentId: track.instrument.number, // Memorizza l'ID dello strumento GM
                originalInstrumentName: track.instrument.name || `Traccia ${index + 1}`
            });
        });
        
        updateAllInstrumentSelectors(); // Popola i selettori (con SF2 o default)
        
        const duration = Tone.Transport.seconds = midi.duration;
        totalTimeEl.textContent = formatTime(duration);
        progressBar.max = duration;
        enableGlobalControls();
    }
    
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
                <button class="mute">M</button>
                <button class="solo">S</button>
            </div>
            <select class="instrument-selector"></select>
        `;
        
        strip.querySelector('.volume-fader').addEventListener('input', (e) => players.get(index).channel.volume.value = e.target.value);
        strip.querySelector('.mute').addEventListener('click', (e) => {
            const channel = players.get(index).channel;
            channel.mute = !channel.mute;
            e.target.classList.toggle('active', channel.mute);
            updateSoloMuteState();
        });
        strip.querySelector('.solo').addEventListener('click', () => {
            const player = players.get(index);
            player.channel.solo = !player.channel.solo;
            updateSoloMuteState();
        });
        strip.querySelector('.instrument-selector').addEventListener('change', (e) => {
             // L'ID dello strumento (preset) è il valore dell'opzione
             players.get(index).instrumentId = parseInt(e.target.value, 10);
        });

        return strip;
    }
    
    // --- GESTIONE STRUMENTI DINAMICA ---
    function updateAllInstrumentSelectors() {
        players.forEach((player, index) => {
            const selector = player.strip.querySelector('.instrument-selector');
            selector.innerHTML = ''; // Pulisce le opzioni esistenti

            if (soundfontPlayer && activeSoundFont) {
                // Modalità SoundFont: popola con gli strumenti del file SF2
                activeSoundFont.presets.forEach(preset => {
                    // Ignora i "layer" di strumenti che non hanno un nome
                    if (preset.name.trim() === '' || preset.name.includes('EOP')) return;
                    
                    const option = document.createElement('option');
                    option.value = preset.id;
                    option.textContent = `${preset.id}: ${preset.name}`;
                    selector.appendChild(option);
                });
                // Prova a preselezionare lo strumento corretto basato sul Program Change del MIDI
                selector.value = player.instrumentId;
                 if (!selector.value) { // Se l'ID non esiste nel SF2, seleziona il primo
                     selector.selectedIndex = 0;
                     player.instrumentId = parseInt(selector.value);
                 }
            } else {
                // Modalità Fallback: mostra solo il nome dello strumento originale
                const option = document.createElement('option');
                option.textContent = player.originalInstrumentName;
                option.disabled = true;
                selector.appendChild(option);
            }
        });
    }

    // --- LOGICA DI CONTROLLO (MUTE/SOLO, RIPRODUZIONE) ---
    function updateSoloMuteState() {
        isSoloing = Array.from(players.values()).some(p => p.channel.solo);
        players.forEach(({ channel, strip }) => {
            strip.querySelector('.solo').classList.toggle('active', channel.solo);
            if (isSoloing) {
                channel.mute = !channel.solo;
            } else {
                const isMutedByUser = strip.querySelector('.mute').classList.contains('active');
                channel.mute = isMutedByUser;
            }
        });
    }

    playPauseBtn.addEventListener('click', () => {
        if (isPlaying) {
            Tone.Transport.pause();
            playPauseBtn.innerHTML = '▶️';
        } else {
            Tone.Transport.start();
            playPauseBtn.innerHTML = '⏸️';
        }
        isPlaying = !isPlaying;
    });

    stopBtn.addEventListener('click', () => {
        Tone.Transport.stop();
        playPauseBtn.innerHTML = '▶️';
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
            part.dispose(); synth.dispose(); channel.dispose();
        });
        players.clear();
        mixerContainer.innerHTML = '';
        isPlaying = false;
        playPauseBtn.innerHTML = '▶️';
    }

    function showLoading(message) {
        loadingText.textContent = message;
        loadingOverlay.classList.remove('hidden');
    }
    function hideLoading() { loadingOverlay.classList.add('hidden'); }
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
