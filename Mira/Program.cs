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

JsonObject LoadConfig()
{
    try { return JsonNode.Parse(File.ReadAllText(configFile))?.AsObject() ?? new JsonObject(); }
    catch { return new JsonObject(); }
}
void SaveConfig(JsonObject c) => File.WriteAllText(configFile, c.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

app.MapGet("/api/health", () => Results.Ok(new { ok = true }));

app.MapGet("/api/config", () =>
{
    var c = LoadConfig();
    return Results.Ok(new {
        ready = !string.IsNullOrWhiteSpace(c["deepgramApiKey"]?.ToString()) &&
                !string.IsNullOrWhiteSpace(c["agentId"]?.ToString()),
        hasFal = !string.IsNullOrWhiteSpace(c["falKey"]?.ToString()),
        agentId = c["agentId"]?.ToString() ?? ""
    });
});

app.MapPost("/api/setup", async (HttpRequest request) =>
{
    var body = await JsonSerializer.DeserializeAsync<JsonObject>(request.Body);
    if (body is null) return Results.BadRequest(new { error = "Invalid setup data." });
    var c = LoadConfig();
    foreach (var key in new[] { "deepgramApiKey", "agentId", "falKey" })
        if (body[key] is not null) c[key] = body[key]!.ToString().Trim();
    SaveConfig(c);
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/deepgram-token", async () =>
{
    var key = LoadConfig()["deepgramApiKey"]?.ToString();
    if (string.IsNullOrWhiteSpace(key)) return Results.BadRequest(new { error = "Deepgram API key is missing. Open Setup." });
    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Token", key);
    using var content = new StringContent("{\"ttl_seconds\":300}", Encoding.UTF8, "application/json");
    var response = await http.PostAsync("https://api.deepgram.com/v1/auth/grant", content);
    var text = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) return Results.Content(text, "application/json", Encoding.UTF8, (int)response.StatusCode);
    var token = JsonNode.Parse(text)?["access_token"]?.ToString();
    return string.IsNullOrWhiteSpace(token) ? Results.BadRequest(new { error = "Deepgram did not return a temporary token.", details = text }) : Results.Text(token, "text/plain");
});

app.MapPost("/api/video", async () =>
{
    var key = LoadConfig()["falKey"]?.ToString();
    if (string.IsNullOrWhiteSpace(key)) return Results.BadRequest(new { error = "fal.ai key is missing. Open Setup." });
    var imagePath = Path.Combine(root, "luna mouth closed.png");
    if (!File.Exists(imagePath)) return Results.NotFound(new { error = "luna mouth closed.png was not packaged beside Mira.exe." });
    var dataUri = "data:image/png;base64," + Convert.ToBase64String(await File.ReadAllBytesAsync(imagePath));
    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Key", key);
    var payload = new JsonObject {
        ["prompt"] = "A gothic girl gently talks directly to the camera. Natural blinking, subtle breathing, small head movement, stable identity, realistic facial motion, cinematic gothic romantic atmosphere.",
        ["start_image_url"] = dataUri, ["duration"] = "5"
    };
    var response = await http.PostAsync("https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video",
        new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"));
    var responseText = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) return Results.Content(responseText, "application/json", Encoding.UTF8, (int)response.StatusCode);
    var requestId = JsonNode.Parse(responseText)?["request_id"]?.ToString();
    if (string.IsNullOrWhiteSpace(requestId)) return Results.BadRequest(new { error = "fal.ai did not return a request id.", details = responseText });
    for (var i = 0; i < 90; i++)
    {
        await Task.Delay(2000);
        var status = await http.GetAsync($"https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video/requests/{requestId}/status");
        var statusText = await status.Content.ReadAsStringAsync();
        if (statusText.Contains("COMPLETED", StringComparison.OrdinalIgnoreCase))
        {
            var result = await http.GetAsync($"https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video/requests/{requestId}");
            var resultText = await result.Content.ReadAsStringAsync();
            var url = JsonNode.Parse(resultText)?["video"]?["url"]?.ToString();
            return !string.IsNullOrWhiteSpace(url) ? Results.Ok(new { url }) : Results.BadRequest(new { error = "fal.ai completed but returned no video URL.", details = resultText });
        }
        if (statusText.Contains("FAILED", StringComparison.OrdinalIgnoreCase)) return Results.BadRequest(new { error = "fal.ai video generation failed.", details = statusText });
    }
    return Results.StatusCode(504);
});

app.MapFallback(async context =>
{
    var requestPath = context.Request.Path.Value ?? "/";
    var relative = requestPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
    var full = relative.Length == 0 ? Path.Combine(root, "index.html") : Path.GetFullPath(Path.Combine(root, relative));
    if (!full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { context.Response.StatusCode = 404; return; }
    context.Response.ContentType = Path.GetExtension(full).ToLowerInvariant() switch {
        ".html" => "text/html; charset=utf-8", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg",
        ".css" => "text/css; charset=utf-8", ".js" => "text/javascript; charset=utf-8", _ => "application/octet-stream"
    };
    await context.Response.SendFileAsync(full);
});

var url = "http://127.0.0.1:8787/";
_ = Task.Run(async () =>
{
    await Task.Delay(900);
    try
    {
        var chromeCandidates = new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };
        var chrome = chromeCandidates.FirstOrDefault(File.Exists);
        Process.Start(new ProcessStartInfo { FileName = chrome ?? url, Arguments = chrome is null ? "" : url, UseShellExecute = true });
    } catch { }
});
app.Run();