# Luna OpenVoice V2 backend

The desktop app uses OpenVoice V2 for Luna's spoken replies. OpenVoice V2 is a speech/voice model, not a text-chat LLM, so the desktop app uses Claude for Luna's text generation and OpenVoice V2 for the final spoken audio.

## Voice reference

OpenVoice V2 needs a short clean reference voice sample for tone-color conversion. Put a WAV file here:

`%APPDATA%\LunaGothicCompanion\voice_reference.wav`

A clean 5–15 second voice clip works well. The app does not upload this file; it stays local.

## Model

The build workflow downloads the OpenVoice V2 checkpoints from the `myshell-ai/OpenVoiceV2` Hugging Face model repository and packages the local inference backend with the Windows build.
