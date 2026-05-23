// Owns the single shared <audio> element used for previewing. Centralises
// start/stop, the inter-song handoff, and detection of "some other audio
// just started — get out of its way". Pub/sub keeps ProgressScope and
// PreviewLoop loosely coupled to playback state:
//   'play'      (file, host)   — audio is actually flowing (not just loading).
//   'stop'      (reason)       — any state-clear: manual stop, end, error,
//                                song switch, play() rejected, external audio
//                                override. Listeners use this for cleanup.
//   'completed' (file)         — natural 'ended' only. Drives the single-play
//                                gate so a clip won't immediately replay.
export class AudioController {
    constructor({ apiBase, pluginName }) {
        this._apiBase = apiBase;
        this._pluginName = pluginName;
        this._audio = null;
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
        this._externalAudioActive = false;
        this._playListenerInstalled = false;
        this._listeners = { play: [], stop: [], completed: [] };

        // Cross-tab live update from Slopsmith's mixer. Same-tab drags
        // don't fire 'storage' — we also re-read on every start() so the
        // next hover picks up the new value.
        this._onStorage = (e) => { if (e.key === 'volume') this._applyVolume(); };
        window.addEventListener('storage', this._onStorage);

        // 'play' doesn't bubble — capture-phase document listener catches
        // anything else (host, another plugin) starting audio. Installed
        // lazily alongside the <audio> element so destroy() can pair them.
        this._onDocumentPlay = (e) => {
            if (e.target !== this._audio) {
                this.stop('external-audio');
                this._externalAudioActive = true;
            }
        };
    }

    on(event, cb) {
        if (!this._listeners[event]) throw new Error(`unknown event: ${event}`);
        this._listeners[event].push(cb);
    }

    _emit(event, ...args) {
        for (const cb of this._listeners[event]) cb(...args);
    }

    isActive() { return !!(this._loadingFile || this._playingFile); }
    currentFile() { return this._playingFile || this._loadingFile; }
    activeHost() { return this._activeHost; }
    audioElement() { return this._audio; }
    isExternalAudioActive() { return this._externalAudioActive; }
    clearExternalAudio() { this._externalAudioActive = false; }

    // Slopsmith's mixer persists the Song channel as localStorage['volume']
    // (0..100). audio-mixer.js exposes window.slopsmith.audio.readSongVolume()
    // which also covers the in-memory fallback used in sandboxed contexts.
    _getSongVolume() {
        try {
            const api = window.slopsmith && window.slopsmith.audio;
            if (api && typeof api.readSongVolume === 'function') {
                const v = api.readSongVolume();
                if (Number.isFinite(v)) return Math.min(100, Math.max(0, v)) / 100;
            }
            const stored = parseFloat(localStorage.getItem('volume'));
            if (Number.isFinite(stored)) return Math.min(100, Math.max(0, stored)) / 100;
        } catch (_) { /* ignore */ }
        return 0.8;
    }

    _applyVolume() {
        if (this._audio) this._audio.volume = this._getSongVolume();
    }

    _ensureAudio() {
        if (this._audio) return this._audio;
        const audio = document.createElement('audio');
        audio.preload = 'none';
        document.body.appendChild(audio);

        audio.addEventListener('playing', () => {
            if (this._loadingFile) {
                this._playingFile = this._loadingFile;
                this._loadingFile = null;
            }
            // Listeners (ProgressScope) attach only once audio is flowing,
            // so the perimeter ring doesn't paint a flat line during the
            // initial fetch/transcode.
            this._emit('play', this._playingFile, this._activeHost);
        });
        audio.addEventListener('ended', () => {
            const finished = this._playingFile || this._loadingFile;
            this._clear();
            this._emit('stop', 'ended');
            this._emit('completed', finished);
        });
        audio.addEventListener('error', () => {
            // Cancelling via audio.src = '' resolves the empty string to
            // the page URL, which the decoder rejects and surfaces as a
            // spurious 'error' with no active file. Ignore that.
            const active = this._loadingFile || this._playingFile;
            if (!active) return;
            console.warn(`[${this._pluginName}] audio error for`, active);
            this._clear();
            this._emit('stop', 'error');
        });

        if (!this._playListenerInstalled) {
            document.addEventListener('play', this._onDocumentPlay, true);
            this._playListenerInstalled = true;
        }

        this._audio = audio;
        return audio;
    }

    _clear() {
        this._loadingFile = null;
        this._playingFile = null;
        this._activeHost = null;
    }

    start(filename, host) {
        if (this._loadingFile === filename || this._playingFile === filename) return;
        const audio = this._ensureAudio();

        // Cut off whatever was playing before. Emit stop so the old scope
        // detaches; the new one attaches on the upcoming 'play' event.
        if (this.isActive()) {
            audio.pause();
            audio.src = '';
            this._clear();
            this._emit('stop', 'switch');
        }

        this._loadingFile = filename;
        this._activeHost = host || null;
        this._applyVolume();

        audio.src = `${this._apiBase}/audio?file=${encodeURIComponent(filename)}`;
        audio.play().catch((e) => {
            // play() often rejects because the user already moved on. Only
            // clear state if this filename is still the active one.
            if (this._loadingFile === filename || this._playingFile === filename) {
                console.warn(`[${this._pluginName}] play() rejected:`, e);
                this._clear();
                this._emit('stop', 'play-rejected');
            }
        });
    }

    stop(reason = 'stop') {
        if (!this.isActive()) return;
        const audio = this._audio;
        // pause() alone leaves a partially-buffered stream that can keep
        // leaking audio. removeAttribute('src') + load() aborts any pending
        // fetch and fully resets the element.
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (_) { /* paranoia */ }
        this._clear();
        this._emit('stop', reason);
    }

    destroy() {
        if (this.isActive()) this.stop('destroy');
        window.removeEventListener('storage', this._onStorage);
        if (this._playListenerInstalled) {
            document.removeEventListener('play', this._onDocumentPlay, true);
            this._playListenerInstalled = false;
        }
        if (this._audio) {
            try {
                this._audio.pause();
                this._audio.removeAttribute('src');
                this._audio.load();
                this._audio.remove();
            } catch (_) {}
            this._audio = null;
        }
        this._externalAudioActive = false;
        for (const k of Object.keys(this._listeners)) this._listeners[k].length = 0;
    }
}
