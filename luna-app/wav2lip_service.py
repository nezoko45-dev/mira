import http.server
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WAV2LIP_DIR = ROOT / "wav2lip"
CHECKPOINT = WAV2LIP_DIR / "checkpoints" / "wav2lip.pth"
INFERENCE = WAV2LIP_DIR / "inference.py"
PORT = int(os.environ.get("WAV2LIP_PORT", "9872"))
MAX_REQUEST = 64 * 1024 * 1024


def parse_multipart(content_type, body):
    """Small dependency-free multipart parser for the two files Luna sends."""
    marker = "boundary="
    if marker not in content_type:
        raise ValueError("Content-Type must be multipart/form-data with a boundary.")
    boundary = content_type.split(marker, 1)[1].strip()
    if boundary.startswith('"') and boundary.endswith('"'):
        boundary = boundary[1:-1]
    if not boundary:
        raise ValueError("Multipart boundary is missing.")

    delim = b"--" + boundary.encode("utf-8")
    fields = {}
    for part in body.split(delim):
        part = part.strip(b"\r\n-")
        if not part or b"\r\n\r\n" not in part:
            continue
        header_bytes, data = part.split(b"\r\n\r\n", 1)
        headers = header_bytes.decode("utf-8", "replace").split("\r\n")
        disposition = next((h for h in headers if h.lower().startswith("content-disposition:")), "")
        name = None
        filename = None
        for token in disposition.split(";"):
            token = token.strip()
            if token.startswith("name="):
                name = token[5:].strip().strip('"')
            elif token.startswith("filename="):
                filename = token[9:].strip().strip('"')
        if name:
            fields[name] = (filename, data)
    return fields


class Handler(http.server.BaseHTTPRequestHandler):
    def send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("[Wav2Lip] " + (fmt % args), flush=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            ready = INFERENCE.exists() and CHECKPOINT.exists()
            self.send_json(200, {
                "ok": True,
                "ready": ready,
                "checkpoint": CHECKPOINT.exists(),
                "inference": INFERENCE.exists(),
            })
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

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_json(400, {"error": "Bad request: empty request body."})
            return
        if length > MAX_REQUEST:
            self.send_json(413, {"error": "Request is too large."})
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self.send_json(400, {"error": "Bad request: expected multipart/form-data."})
            return

        try:
            body = self.rfile.read(length)
            fields = parse_multipart(content_type, body)
            face = fields.get("face")
            audio = fields.get("audio")
            if not face or not face[1]:
                raise ValueError("Missing multipart field 'face'.")
            if not audio or not audio[1]:
                raise ValueError("Missing multipart field 'audio'.")
        except Exception as exc:
            self.send_json(400, {"error": f"Bad request: {exc}"})
            return

        with tempfile.TemporaryDirectory(prefix="luna_wav2lip_") as tmp:
            tmp = Path(tmp)
            face_path = tmp / "face.png"
            audio_path = tmp / "speech.mp3"
            output_path = tmp / "luna.mp4"
            face_path.write_bytes(face[1])
            audio_path.write_bytes(audio[1])

            cmd = [
                sys.executable, str(INFERENCE),
                "--checkpoint_path", str(CHECKPOINT),
                "--face", str(face_path),
                "--audio", str(audio_path),
                "--outfile", str(output_path),
                "--static", "True",
                "--fps", "25",
                "--pads", "0", "20", "0", "0",
                "--resize_factor", "2",
                "--nosmooth",
            ]
            print("[Wav2Lip] Generating MP4...", flush=True)
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=str(WAV2LIP_DIR),
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
            except subprocess.TimeoutExpired:
                self.send_json(504, {"error": "Wav2Lip timed out after 180 seconds."})
                return
            except Exception as exc:
                self.send_json(500, {"error": f"Could not start Wav2Lip: {exc}"})
                return

            if proc.returncode != 0 or not output_path.exists():
                details = (proc.stderr or proc.stdout or "Wav2Lip failed")[-6000:]
                self.send_json(500, {"error": "Wav2Lip inference failed.", "details": details})
                return

            data = output_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            print("[Wav2Lip] MP4 ready: %.1f KB" % (len(data) / 1024), flush=True)


if __name__ == "__main__":
    print(f"Wav2Lip service listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"Checkpoint: {CHECKPOINT}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
