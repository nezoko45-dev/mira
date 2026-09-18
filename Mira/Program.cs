using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:8787");
var app = builder.Build();

var root = AppContext.BaseDirectory;
var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mira");
Directory.CreateDirectory(dataDir);
var configFile = Path.Combine(dataDir, "config.json");
var mediaDir = Path.Combine(dataDir, "media");
Directory.CreateDirectory(mediaDir);

JsonObject LoadConfig()
{
    try { return JsonNode.Parse(File.ReadAllText(configFile))?.AsObject() ?? new JsonObject(); }
    catch { return new JsonObject(); }
}

void SaveConfig(JsonObject c) =>
    File.WriteAllText(configFile, c.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

string WanDir() => Path.Combine(dataDir, "Wan2GP");

string FindPython()
{
    var candidates = new[]
    {
        Path.Combine(dataDir, "python", "python.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Python", "Python312", "python.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Python", "Python311", "python.exe")
    };
    return candidates.FirstOrDefault(File.Exists) ?? "python";
}

async Task<bool> WaitForLocalVideoEngineAsync(string baseUrl, int timeoutSeconds = 90)
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            using var response = await http.GetAsync(baseUrl + "/config");
            if (response.IsSuccessStatusCode) return true;
        }
        catch { }

        await Task.Delay(1000);
    }

    return false;
}

async Task<bool> StartWanEngineAsync()
{
    var wanDir = WanDir();
    var script = Path.Combine(wanDir, "wgp.py");
    if (!File.Exists(script)) return false;

    var endpoint = "http://127.0.0.1:7861";

    // Do not start a second Wan2GP process if one is already running.
    if (await WaitForLocalVideoEngineAsync(endpoint, 2))
        return true;

    try
    {
        var start = new ProcessStartInfo
        {
            FileName = FindPython(),
            WorkingDirectory = wanDir,
            Arguments = "wgp.py --i2v --server-name 127.0.0.1 --server-port 7861",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.Environment["PYTHONUNBUFFERED"] = "1";

        var process = Process.Start(start);
        if (process is null) return false;

        _ = Task.Run(async () =>
        {
            try
            {
                while (!process.HasExited)
                {
                    await process.StandardOutput.ReadLineAsync();
                }
            }
            catch { }
        });

        _ = Task.Run(async () =>
        {
            try
            {
                while (!process.HasExited)
                {
                    await process.StandardError.ReadLineAsync();
                }
            }
            catch { }
        });

        return await WaitForLocalVideoEngineAsync(endpoint, 90);
    }
    catch
    {
        return false;
    }
}

app.MapGet("/api/media/{name}", (string name) =>
{
    var safe = Path.GetFileName(name);
    if (!string.Equals(safe, name, StringComparison.Ordinal) ||
        !safe.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "Invalid media file." });

    var path = Path.Combine(mediaDir, safe);
    return File.Exists(path)
        ? Results.File(path, "video/mp4", enableRangeProcessing: true)
        : Results.NotFound();
});

app.MapGet("/api/mira-image", () =>
{
    var candidates = new[]
    {
        Path.Combine(root, "luna mouth closed.png"),
        Path.Combine(root, "images", "luna", "luna mouth closed.png"),
        Path.Combine(dataDir, "luna mouth closed.png"),
        Path.Combine(dataDir, "images", "luna mouth closed.png")
    };

    var image = candidates.FirstOrDefault(File.Exists);
    return image is null
        ? Results.NotFound(new { error = "Mira image is missing. Put 'luna mouth closed.png' beside Mira.exe or in %LOCALAPPDATA%\\Mira." })
        : Results.File(image, "image/png");
});

app.MapGet("/api/health", () => Results.Ok(new { ok = true }));

app.MapGet("/api/config", () =>
{
    var c = LoadConfig();
    return Results.Ok(new
    {
        ready = !string.IsNullOrWhiteSpace(c["deepgramApiKey"]?.ToString()),
        hasLocalVideoEngine = File.Exists(Path.Combine(WanDir(), "wgp.py")),
        videoEngine = "Wan2GP local",
        configured = true
    });
});

app.MapPost("/api/setup", async (HttpRequest request) =>
{
    var body = await JsonSerializer.DeserializeAsync<JsonObject>(request.Body);
    if (body is null) return Results.BadRequest(new { error = "Invalid setup data." });

    var c = LoadConfig();
    if (body["deepgramApiKey"] is not null)
        c["deepgramApiKey"] = body["deepgramApiKey"]!.ToString().Trim();

    SaveConfig(c);
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/deepgram-token", async () =>
{
    var key = LoadConfig()["deepgramApiKey"]?.ToString();
    if (string.IsNullOrWhiteSpace(key))
        return Results.BadRequest(new { error = "Deepgram API key is missing. Open Setup." });

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Token", key);

    using var content = new StringContent(
        "{\"ttl_seconds\":300}",
        Encoding.UTF8,
        "application/json");

    var response = await http.PostAsync("https://api.deepgram.com/v1/auth/grant", content);
    var text = await response.Content.ReadAsStringAsync();

    if (!response.IsSuccessStatusCode)
        return Results.Content(text, "application/json", Encoding.UTF8, (int)response.StatusCode);

    var token = JsonNode.Parse(text)?["access_token"]?.ToString();

    return string.IsNullOrWhiteSpace(token)
        ? Results.BadRequest(new { error = "Deepgram did not return a temporary token.", details = text })
        : Results.Text(token, "text/plain");
});

app.MapGet("/api/video-engine", () =>
{
    var installed = File.Exists(Path.Combine(WanDir(), "wgp.py"));
    return Results.Ok(new
    {
        installed,
        path = WanDir(),
        endpoint = "http://127.0.0.1:7861"
    });
});

app.MapPost("/api/video-engine/start", async () =>
{
    var ok = await StartWanEngineAsync();
    return ok
        ? Results.Ok(new { ok = true, engine = "Wan2GP" })
        : Results.BadRequest(new
        {
            ok = false,
            error = "Wan2GP is not installed in %LOCALAPPDATA%\\Mira\\Wan2GP."
        });
});

app.MapPost("/api/idle-video", async () =>
{
    if (!File.Exists(Path.Combine(WanDir(), "wgp.py")))
        return Results.BadRequest(new { error = "Local Wan2GP video engine is not installed yet." });

    var ok = await StartWanEngineAsync();
    return ok
        ? Results.Ok(new { pending = true, engine = "Wan2GP" })
        : Results.BadRequest(new { error = "Wan2GP could not be started." });
});

app.MapPost("/api/video", async (HttpRequest request) =>
{
    if (!File.Exists(Path.Combine(WanDir(), "wgp.py")))
        return Results.BadRequest(new { error = "Local Wan2GP video engine is not installed yet." });

    var body = await JsonSerializer.DeserializeAsync<JsonObject>(request.Body);
    var spoken = body?["text"]?.ToString()?.Trim() ?? "";

    if (string.IsNullOrWhiteSpace(spoken))
        return Results.BadRequest(new { error = "Mira reply text is missing." });

    var ok = await StartWanEngineAsync();
    return ok
        ? Results.Ok(new { pending = true, engine = "Wan2GP", spoken })
        : Results.BadRequest(new { error = "Wan2GP could not be started." });
});

app.MapFallback(async context =>
{
    var requestPath = context.Request.Path.Value ?? "/";
    var relative = requestPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
    var full = relative.Length == 0
        ? Path.Combine(root, "index.html")
        : Path.GetFullPath(Path.Combine(root, relative));

    if (!full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) ||
        !File.Exists(full))
    {
        context.Response.StatusCode = 404;
        return;
    }

    context.Response.ContentType = Path.GetExtension(full).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        _ => "application/octet-stream"
    };

    await context.Response.SendFileAsync(full);
});

var url = "http://127.0.0.1:8787/";

_ = Task.Run(async () =>
{
    await Task.Delay(900);

    try
    {
        var chromeCandidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };

        var chrome = chromeCandidates.FirstOrDefault(File.Exists);

        Process.Start(new ProcessStartInfo
        {
            FileName = chrome ?? url,
            Arguments = chrome is null ? "" : url,
            UseShellExecute = true
        });
    }
    catch { }
});

app.Run();
