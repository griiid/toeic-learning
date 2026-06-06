// Generic utility functions: array helpers, text-to-speech wrappers.

import { fetchTTS } from './apiProvider.js';
import { state, VOICE_NAMES, OPENAI_VOICE_NAMES } from './state.js';
import { pcmToWavBlob } from './audioCodec.js';

export function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function speakText(text) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
}

export function speakTextPromise(text) {
    return new Promise(resolve => {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        u.rate = 0.9;
        u.onend = resolve;
        u.onerror = resolve;
        window.speechSynthesis.speak(u);
    });
}

function resolveVoiceName() {
    const pool = state.provider === 'openai' ? OPENAI_VOICE_NAMES : VOICE_NAMES;
    if (!state.selectedVoice || state.selectedVoice === 'random' || !pool.includes(state.selectedVoice)) {
        return pool[Math.floor(Math.random() * pool.length)];
    }
    return state.selectedVoice;
}

function playBase64Audio(base64) {
    return new Promise((resolve, reject) => {
        let blob;
        if (base64.startsWith('mp3:')) {
            const raw = atob(base64.slice(4));
            const mp3Bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) mp3Bytes[i] = raw.charCodeAt(i);
            blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });
        } else {
            const bytes = atob(base64);
            const pcm = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) pcm[i] = bytes.charCodeAt(i);
            blob = pcmToWavBlob(pcm, 24000);
        }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio playback error')); };
        audio.play().catch(reject);
    });
}

/**
 * AI TTS with browser Web Speech API fallback.
 * Returns a promise that resolves when audio finishes (awaitable for sequencing).
 */
export async function speakTextAI(text) {
    try {
        const base64 = await fetchTTS(text, resolveVoiceName());
        await playBase64Audio(base64);
    } catch {
        await speakTextPromise(text);
    }
}
