import cgi
import http.server
import io
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WAV2LIP_DIR = ROOT / "wav2lip"
CHECKPOINT = WAV2LIP_DIR / "checkpoints" / "wav2lip.pth"
INFERENCE = WAV2LIP_DIR / "inference.py"
PORT = int(os.environ.get("WAV2LIP_PORT", "9872"))

class Handler(http.server.BaseHTTPRequestHandler):
    def send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("[Wav2Lip] " + (fmt % args))

    def do_GET(self):
        if self.path == "/health":
            ready = INFERENCE.exists() and CHECKPOINT.exists()
            self.send_json(200, {"ok": True, "ready": ready, "checkpoint": CHECKPOINT.exists()})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/lipsync":
            self.send_json(404, {"error": "Not found"})
            return
        if not INFERENCE.exists():
            self.send_json(503, {"error": "Wav2Lip is not installed. Run setup-luna.bat first."})
            return
        if not CHECKPOINT.exists():
            self.send_json(503, {"error": "Wav2Lip checkpoint is missing. Run setup-luna.bat first."})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 64 * 1024 * 1024:
            self.send_json(400, {"error": "Invalid request size."})
            return
        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        env = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(length)}
        form = cgi.FieldStorage(fp=io.BytesIO(body), headers=self.headers, environ=env)
        face = form["face"] if "face" in form else None
        audio = form["audio"] if "audio" in form else None
        if not face or not audio:
            self.send_json(400, {"error": "Expected multipart fields: face and audio."})
            return

        with tempfile.TemporaryDirectory(prefix="luna_wav2lip_") as tmp:
            tmp = Path(tmp)
            face_path = tmp / "face.png"
            audio_path = tmp / "speech.mp3"
            output_path = tmp / "luna.mp4"
            face_path.write_bytes(face.file.read())
            audio_path.write_bytes(audio.file.read())
            cmd = [
                "python", str(INFERENCE),
                "--checkpoint_path", str(CHECKPOINT),
                "--face", str(face_path),
                "--audio", str(audio_path),
                "--outfile", str(output_path),
                "--static", "True",
                "--fps", "25",
                "--pads", "0", "20", "0", "0",
                "--resize_factor", "2",
                "--nosmooth"
            ]
            print("[Wav2Lip] Generating MP4...")
            try:
                proc = subprocess.run(cmd, cwd=str(WAV2LIP_DIR), capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired:
                self.send_json(504, {"error": "Wav2Lip timed out after 180 seconds."})
                return
            if proc.returncode != 0 or not output_path.exists():
                details = (proc.stderr or proc.stdout or "Wav2Lip failed")[-4000:]
                self.send_json(500, {"error": "Wav2Lip inference failed.", "details": details})
                return
            data = output_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            print("[Wav2Lip] MP4 ready: %.1f KB" % (len(data) / 1024))

if __name__ == "__main__":
    print(f"Wav2Lip service listening on http://127.0.0.1:{PORT}")
    print(f"Checkpoint: {CHECKPOINT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
