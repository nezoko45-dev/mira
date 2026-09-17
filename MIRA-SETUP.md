# Mira — Chrome + Windows backend

Mira now uses Chrome as the UI and `MiraBackend.exe` as the local backend.

## Included
- `index.html` — Luna dating/video-call UI.
- `luna mouth closed.png` — the identity reference for image-to-image variants.
- `luna mouth open.png` — fallback talking frame.
- `backend/server.js` — local Groq + image-variant API.
- `backend/package.json` — Windows EXE build.
- `.github/workflows/build-mira-exe.yml` — builds `Mira-Chrome-EXE.zip`.
- `Start-Mira.bat` — starts the EXE and opens Chrome.

## Runtime
1. Put `MiraBackend.exe`, `index.html`, both Luna PNGs and `Start-Mira.bat` in one folder.
2. Double-click `Start-Mira.bat`.
3. Chrome opens `http://127.0.0.1:47821/`.
4. Enter a Groq API key in the app.
5. Optional: enter a Hugging Face token and use **Generate mouth variants**.

The variant generator uses Hugging Face Inference Providers with an image-to-image model to create multiple Luna mouth states from the closed-mouth reference. Hugging Face documents image-to-image as transforming a source image according to a prompt, and the current JS inference client exposes `imageToImage`.

During calls, Chrome uses camera/microphone access, browser speech recognition and speech synthesis. Luna cycles through the generated mouth images while speaking and can be mirrored. When the call ends, the backend asks Groq for a follow-up question based on the call transcript.
