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

async Task<bool> WaitForLocalVideoEngineAsync(string u,int t=90){using var x=new HttpClient{Timeout=TimeSpan.FromSeconds(3)};var e=DateTime.UtcNow.AddSeconds(t);while(DateTime.UtcNow<e){try{if((await x.GetAsync(u+"/config")).IsSuccessStatusCode)return true;}catch{}await Task.Delay(1000);}return false;}
string FindPython(){var a=new[]{Path.Combine(dataDir,"python","python.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Python","Python312","python.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Python","Python311","python.exe")};return a.FirstOrDefault(File.Exists)??"python";}
string WanDir()=>Path.Combine(dataDir,"Wan2GP");
async Task<bool> StartWanEngineAsync(){var d=WanDir();if(!File.Exists(Path.Combine(d,"wgp.py")))return false;try{var p=new ProcessStartInfo{FileName=FindPython(),WorkingDirectory=d,Arguments="wgp.py --i2v --server-name 127.0.0.1 --server-port 7861",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};p.Environment["PYTHONUNBUFFERED"]="1";Process.Start(p);return await WaitForLocalVideoEngineAsync("http://127.0.0.1:7861");}catch{return false;}}
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
app.Run()app.MapGet("/api/config",()=>{var c=LoadConfig();return Results.Ok(new{ready=!string.IsNullOrWhiteSpace(c["deepgramApiKey"]?.ToString()),hasLocalVideoEngine=File.Exists(Path.Combine(WanDir(),"wgp.py")),videoEngine="Wan2GP local",configured=true});});
app.MapPost("/api/setup",async(HttpRequest r)=>{var x=await JsonSerializer.DeserializeAsync<JsonObject>(r.Body);if(x is null)return Results.BadRequest(new{error="Invalid setup data."});var c=LoadConfig();if(x["deepgramApiKey"] is not null)c["deepgramApiKey"]=x["deepgramApiKey"]!.ToString().Trim();SaveConfig(c);return Results.Ok(new{ok=true});});
app.MapGet("/api/deepgram-token",async()=>{var k=LoadConfig()["deepgramApiKey"]?.ToString();if(string.IsNullOrWhiteSpace(k))return Results.BadRequest(new{error="Deepgram API key is missing. Open Setup."});using var h=new HttpClient();h.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Token",k);using var x=new StringContent("{\"ttl_seconds\":300}",Encoding.UTF8,"application/json");var r=await h.PostAsync("https://api.deepgram.com/v1/auth/grant",x);var t=await r.Content.ReadAsStringAsync();if(!r.IsSuccessStatusCode)return Results.Content(t,"application/json",Encoding.UTF8,(int)r.StatusCode);var q=JsonNode.Parse(t)?["access_token"]?.ToString();return string.IsNullOrWhiteSpace(q)?Results.BadRequest(new{error="Deepgram did not return a temporary token.",details=t}):Results.Text(q,"text/plain");});
app.MapGet("/api/video-engine",()=>Results.Ok(new{installed=File.Exists(Path.Combine(WanDir(),"wgp.py")),path=WanDir(),endpoint="http://127.0.0.1:7861"}));
app.MapPost("/api/video-engine/start",async()=>{var ok=await StartWanEngineAsync();return ok?Results.Ok(new{ok=true,engine="Wan2GP"}):Results.BadRequest(new{ok=false,error="Wan2GP is not installed in %LOCALAPPDATA%\\Mira\\Wan2GP."});});
app.MapPost("/api/idle-video",async()=>{if(!File.Exists(Path.Combine(WanDir(),"wgp.py")))return Results.BadRequest(new{error="Local Wan2GP video engine is not installed yet."});return await StartWanEngineAsync()?Results.Ok(new{pending=true,engine="Wan2GP"}):Results.BadRequest(new{error="Wan2GP could not be started."});});
app.MapPost("/api/video",async(HttpRequest r)=>{if(!File.Exists(Path.Combine(WanDir(),"wgp.py")))return Results.BadRequest(new{error="Local Wan2GP video engine is not installed yet."});var x=await JsonSerializer.DeserializeAsync<JsonObject>(r.Body);var spoken=x?["text"]?.ToString()?.Trim()??"";if(string.IsNullOrWhiteSpace(spoken))return Results.BadRequest(new{error="Mira reply text is missing."});return await StartWanEngineAsync()?Results.Ok(new{pending=true,engine="Wan2GP",spoken}):Results.BadRequest(new{error="Wan2GP could not be started."});});
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