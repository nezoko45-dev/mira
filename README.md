# Luna Chrome + Wav2Lip

This version of Mira runs Luna as a local Chrome application.

## One-click Windows setup

1. Download the repository.
2. Double-click `setup-luna.bat` once.
3. When setup finishes, double-click `start-luna.bat`.
4. Chrome opens Luna automatically.

`setup-luna.bat` installs/checks Python 3.11, Node.js LTS, FFmpeg, downloads the Wav2Lip engine and checkpoints, and installs the Python dependencies.

`start-luna.bat` starts the local Wav2Lip service, starts the Luna Node backend, waits for Wav2Lip to become ready, and opens Chrome.

## Runtime pipeline

```text
Chrome microphone/text
        |
        v
Luna Node backend
        |
        +--> Deepgram STT (voice input)
        |
        +--> Luna reply + Deepgram TTS
        |
        v
Wav2Lip local service
        |
        v
MP4 with Luna lip-sync
        |
        v
Chrome <video> player
```

The backend uses the repository's `luna mouth closed.png` as the Wav2Lip face image. Wav2Lip creates a short MP4 for each reply, and Chrome switches from the still portrait to that MP4 while Luna speaks.

## API endpoints

- `GET /health` — Luna backend status
- `POST /reply` — text reply + TTS + lip-synced MP4
- `POST /voice-turn` — Deepgram STT + reply + TTS + lip-synced MP4
- Wav2Lip service: `http://127.0.0.1:9872/health`
- Wav2Lip service: `POST http://127.0.0.1:9872/lipsync`

## Important

The open-source Wav2Lip project is intended for research/academic/personal use according to its upstream repository. urlWav2Lip upstream repositoryhttps://github.com/Rudrabha/Wav2Lip

A Deepgram API key is still required for speech recognition and speech generation. It is entered in Luna's browser UI and sent to the local backend.
