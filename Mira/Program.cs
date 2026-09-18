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
void SaveConfig(JsonObject c) => File.WriteAllText(configFile, c.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

async Task<string> CacheVideoAsync(string url, string prefix)
{
    using var http = new HttpClient();
    using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
    response.EnsureSuccessStatusCode();
    var fileName = prefix + "-" + Guid.NewGuid().ToString("N") + ".mp4";
    var path = Path.Combine(mediaDir, fileName);
    await using var input = await response.Content.ReadAsStreamAsync();
    await using var output = File.Create(path);
    await input.CopyToAsync(output);
    return fileName;
}

async Task<string> UploadReplicateImageAsync(string token, string imagePath)
{
    using var http=new HttpClient();
    http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",token);
    using var form=new MultipartFormDataContent();
    var file=new ByteArrayContent(await File.ReadAllBytesAsync(imagePath));
    file.Headers.ContentType=new MediaTypeHeaderValue("image/png");
    form.Add(file,"content","luna-mouth-closed.png");
    var response=await http.PostAsync("https://api.replicate.com/v1/files",form);
    var text=await response.Content.ReadAsStringAsync();
    if(!response.IsSuccessStatusCode) throw new InvalidOperationException("Replicate image upload failed: "+text);
    var url=JsonNode.Parse(text)?["urls"]?["get"]?.ToString();
    if(string.IsNullOrWhiteSpace(url)) throw new InvalidOperationException("Replicate did not return an image URL.");
    return url;
}
async Task<string> GenerateReplicateVideoAsync(string token,string imageUrl,string prompt)
{
    using var http=new HttpClient();
    http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",token);
    var payload=new JsonObject { ["input"]=new JsonObject {
        ["image"]=imageUrl,["prompt"]=prompt,["resolution"]="480p",["aspect_ratio"]="16:9",
        ["frames"]=81,["fast_mode"]="Balanced",["sample_steps"]=30,["sample_guide_scale"]=5,
        ["negative_prompt"]="face distortion, identity change, extra people, subtitles, text, warped eyes, warped mouth, camera shake"
    }};
    using var response=await http.PostAsync("https://api.replicate.com/v1/models/wavespeedai/wan-2.1-i2v-480p/predictions",
        new StringContent(payload.ToJsonString(),Encoding.UTF8,"application/json"));
    var responseText=await response.Content.ReadAsStringAsync();
    if(!response.IsSuccessStatusCode) throw new InvalidOperationException("Replicate video request failed: "+responseText);
    var id=JsonNode.Parse(responseText)?["id"]?.ToString();
    if(string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("Replicate did not return a prediction id.");
    for(var i=0;i<120;i++){
        var check=await http.GetAsync("https://api.replicate.com/v1/predictions/"+id);
        var checkText=await check.Content.ReadAsStringAsync();
        if(!check.IsSuccessStatusCode) throw new InvalidOperationException("Replicate status request failed: "+checkText);
        var node=JsonNode.Parse(checkText)?.AsObject();
        var status=node?["status"]?.ToString();
        if(string.Equals(status,"succeeded",StringComparison.OrdinalIgnoreCase)){
            var output=node?["output"];
            var url=output is JsonValue ? output.ToString() : output?.AsArray().FirstOrDefault()?.ToString();
            if(string.IsNullOrWhiteSpace(url)) throw new InvalidOperationException("Replicate completed without a video URL.");
            return url;
        }
        if(string.Equals(status,"failed",StringComparison.OrdinalIgnoreCase)||string.Equals(status,"canceled",StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Replicate video generation "+status+": "+checkText);
        await Task.Delay(2000);
    }
    throw new TimeoutException("Replicate video generation timed out.");
}

app.MapGet("/api/media/{name}", (string name) =>
{
    var safe = Path.GetFileName(name);
    if (!string.Equals(safe, name, StringComparison.Ordinal) || !safe.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "Invalid media file." });
    var path = Path.Combine(mediaDir, safe);
    return File.Exists(path) ? Results.File(path, "video/mp4", enableRangeProcessing: true) : Results.NotFound();
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
    return Results.Ok(new {
        ready = !string.IsNullOrWhiteSpace(c["deepgramApiKey"]?.ToString()),
        hasReplicate = !string.IsNullOrWhiteSpace(c["replicateApiKey"]?.ToString()),
        configured = true
    });
});

app.MapPost("/api/setup", async (HttpRequest request) =>
{
    var body = await JsonSerializer.DeserializeAsync<JsonObject>(request.Body);
    if (body is null) return Results.BadRequest(new { error = "Invalid setup data." });
    var c = LoadConfig();
    foreach (var key in new[] { "deepgramApiKey", "replicateApiKey" })
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

app.MapPost("/api/idle-video", async () =>
{
    var key=LoadConfig()["replicateApiKey"]?.ToString();
    if(string.IsNullOrWhiteSpace(key)) return Results.BadRequest(new { error="Replicate API key is missing. Open Setup." });
    var imagePath=Path.Combine(root,"luna mouth closed.png");
    if(!File.Exists(imagePath)) return Results.NotFound(new { error="luna mouth closed.png was not packaged beside Mira.exe." });
    try{
        var imageUrl=await UploadReplicateImageAsync(key,imagePath);
        var videoUrl=await GenerateReplicateVideoAsync(key,imageUrl,"Animate this portrait subtly: gentle breathing, natural blinking, tiny eye movement and slight head movement. Keep exact identity, hair, eyes, fangs, clothing, lighting, background and framing unchanged. No talking, no lip sync, no text.");
        var file=await CacheVideoAsync(videoUrl,"idle");
        return Results.Ok(new { url="/api/media/"+file });
    }catch(Exception ex){return Results.BadRequest(new {error=ex.Message});}
});
app.MapPost("/api/video", async (HttpRequest request) =>
{
    var key=LoadConfig()["replicateApiKey"]?.ToString();
    if(string.IsNullOrWhiteSpace(key)) return Results.BadRequest(new { error="Replicate API key is missing. Open Setup." });
    var body=await JsonSerializer.DeserializeAsync<JsonObject>(request.Body);
    var spoken=body?["text"]?.ToString()?.Trim()??"";
    if(string.IsNullOrWhiteSpace(spoken)) return Results.BadRequest(new {error="Mira reply text is missing."});
    var imagePath=Path.Combine(root,"luna mouth closed.png");
    if(!File.Exists(imagePath)) return Results.NotFound(new {error="luna mouth closed.png was not packaged beside Mira.exe."});
    try{
        var imageUrl=await UploadReplicateImageAsync(key,imagePath);
        var videoUrl=await GenerateReplicateVideoAsync(key,imageUrl,"Mira is speaking naturally. Animate subtle facial acting and mouth movement appropriate for this exact spoken line: "+spoken+". Natural blinking, expressive eyes and gentle head movement. Preserve identity and framing. No subtitles, no text, no extra people, no face distortion.");
        var file=await CacheVideoAsync(videoUrl,"reply");
        return Results.Ok(new {url="/api/media/"+file});
    }catch(Exception ex){return Results.BadRequest(new {error=ex.Message});}
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